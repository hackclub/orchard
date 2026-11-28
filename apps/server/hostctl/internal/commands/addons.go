package commands

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
	"gopkg.in/yaml.v3"
)

type addon struct {
	release            string
	namespace          string
	chart              string
	repo               string
	crds               bool
	values             []string
	settings           []string
	securityCrossMinor bool
	why                string
	osv                []osvPackage
}

var addons = []addon{
	{
		release:   "traefik",
		namespace: "traefik",
		chart:     "traefik",
		repo:      "https://traefik.github.io/charts",
		crds:      true,
		settings:  []string{"providers.kubernetesGateway.enabled=false"},
		osv:       []osvPackage{{ecosystem: "Go", name: "github.com/traefik/traefik", majorSuffix: true}},
		why:       "an operator: routes every request, and a minor version can change its CRDs",
	},
	{
		release:   "cnpg",
		namespace: "cnpg-system",
		chart:     "cloudnative-pg",
		repo:      "https://cloudnative-pg.github.io/charts",
		values:    []string{"config.data.ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true"},
		osv:       []osvPackage{{ecosystem: "Go", name: "github.com/cloudnative-pg/cloudnative-pg"}},
		why:       "an operator: runs every database, and a minor version can change its CRDs and the instances",
	},
	{
		release:   "cert-manager",
		namespace: "cert-manager",
		chart:     "cert-manager",
		repo:      "https://charts.jetstack.io",
		osv:       []osvPackage{{ecosystem: "Go", name: "github.com/cert-manager/cert-manager"}},
		why:       "an operator: issues every certificate, and a minor version can change its CRDs",
	},
}

const chartIndexTimeout = 60 * time.Second

type installedChart struct {
	version    string
	appVersion string
}

func addonInstalledVersion(listing []byte, release, chart string) (installedChart, bool, error) {
	var releases []struct {
		Name       string `json:"name"`
		Chart      string `json:"chart"`
		AppVersion string `json:"app_version"`
	}
	if err := json.Unmarshal(listing, &releases); err != nil {
		return installedChart{}, false, err
	}
	for _, r := range releases {
		if r.Name == release {
			version, ok := strings.CutPrefix(r.Chart, chart+"-")
			if !ok {
				return installedChart{}, false, fmt.Errorf("%s runs chart %s, not %s", release, r.Chart, chart)
			}
			return installedChart{version: version, appVersion: r.AppVersion}, true, nil
		}
	}
	return installedChart{}, false, nil
}

type chartRelease struct {
	version    string
	appVersion string
	created    time.Time
}

func parseChartIndex(raw []byte, chart string) ([]chartRelease, error) {
	var index struct {
		Entries map[string][]struct {
			Version    string `yaml:"version"`
			AppVersion string `yaml:"appVersion"`
			Created    string `yaml:"created"`
		} `yaml:"entries"`
	}
	if err := yaml.Unmarshal(raw, &index); err != nil {
		return nil, err
	}
	entries, ok := index.Entries[chart]
	if !ok || len(entries) == 0 {
		return nil, fmt.Errorf("the chart repository doesn't list %s", chart)
	}
	out := make([]chartRelease, 0, len(entries))
	for _, e := range entries {
		created, _ := time.Parse(time.RFC3339Nano, e.Created)
		out = append(out, chartRelease{version: e.Version, appVersion: e.AppVersion, created: created})
	}
	return out, nil
}

func fetchChartIndex(repo string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, strings.TrimSuffix(repo, "/")+"/index.yaml", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := (&http.Client{Timeout: chartIndexTimeout}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", req.URL.Host, res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 64<<20))
}

func chartCandidate(version, appVersion string) (candidate, bool) {
	tag, ok := parseImageTag(version)
	if !ok {
		return candidate{}, false
	}
	app, hasApp := parseImageTag(appVersion)
	return candidate{tag: tag, app: app, hasApp: hasApp}, true
}

type addonPlan struct {
	current   candidate
	decision  decision
	ahead     *candidate
	published map[string]chartRelease
}

func planAddon(gate *updateGate, a addon, installed installedChart, releases []chartRelease) (addonPlan, error) {
	byVersion := map[string]chartRelease{}
	appVersion := installed.appVersion
	for _, r := range releases {
		byVersion[r.version] = r
		if r.version == installed.version && r.appVersion != "" {
			appVersion = r.appVersion
		}
	}
	current, ok := chartCandidate(installed.version, appVersion)
	if !ok {
		return addonPlan{}, fmt.Errorf("chart version %q isn't a version", installed.version)
	}
	plan := addonPlan{current: current, published: byVersion}
	var candidates []candidate
	for _, r := range releases {
		next, ok := chartCandidate(r.version, r.appVersion)
		if !ok || next.tag.prefix != current.tag.prefix || next.tag.suffix != current.tag.suffix || !next.tag.newerThan(current.tag) {
			continue
		}
		reachable, securityOnly := reaches(current.tag, next.tag, a.securityCrossMinor)
		if current.hasApp && next.hasApp {
			appReachable, appSecurityOnly := reaches(current.app, next.app, a.securityCrossMinor)
			reachable, securityOnly = reachable && appReachable, securityOnly || appSecurityOnly
		}
		if !reachable || securityOnly {
			if plan.ahead == nil || next.tag.newerThan(plan.ahead.tag) {
				ahead := next
				plan.ahead = &ahead
			}
		}
		if !reachable {
			continue
		}
		next.securityOnly = securityOnly
		candidates = append(candidates, next)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[j].tag.newerThan(candidates[i].tag) })
	plan.decision = gate.plan(a.osv, current, candidates, plan.ahead, func(r candidate) (time.Time, error) {
		entry, ok := byVersion[r.tag.raw]
		if !ok || entry.created.IsZero() {
			return time.Time{}, fmt.Errorf("the chart repository has no date for %s", r.tag.raw)
		}
		return entry.created, nil
	})
	return plan, nil
}

func chartName(chart string) func(candidate) string {
	return func(r candidate) string { return chart + " " + r.tag.raw }
}

func addonUpgradeArgs(a addon, version string) []string {
	args := []string{
		"upgrade", a.release, a.chart,
		"--repo", a.repo,
		"--namespace", a.namespace,
		"--version", version,
		"--reset-then-reuse-values",
		"--wait",
		"--timeout", "5m",
	}
	for _, value := range a.values {
		args = append(args, "--set-string", value)
	}
	for _, setting := range a.settings {
		args = append(args, "--set", setting)
	}
	return args
}

func upgradeAddon(c *cli.Context, gate *updateGate, a addon, rollback []string) error {
	listing, err := c.Capture("helm", "list", "--namespace", a.namespace, "--filter", "^"+a.release+"$", "-o", "json")
	if err != nil {
		return err
	}
	installed, found, err := addonInstalledVersion([]byte(listing), a.release, a.chart)
	if err != nil || !found {
		return err
	}
	raw, err := fetchChartIndex(a.repo)
	if err != nil {
		return fmt.Errorf("couldn't read the chart repository: %w", err)
	}
	releases, err := parseChartIndex(raw, a.chart)
	if err != nil {
		return err
	}
	plan, err := planAddon(gate, a, installed, releases)
	if err != nil {
		return err
	}
	notes, warnings := plan.decision.messages(plan.current, chartName(a.chart), gate.soak)
	for _, note := range notes {
		c.Printf("%s\n", note)
	}
	for _, warning := range warnings {
		c.Warnf("%s\n", warning)
	}
	if plan.ahead != nil {
		c.Warnf("note: %s %s is out, and a new major version needs a person. Current: %s. Read its upgrade notes, then re-run the installer.\n", a.chart, plan.ahead.tag.raw, installed.version)
	}
	if !plan.decision.moves(plan.current) {
		return nil
	}
	latest := plan.decision.target.tag.raw

	c.Printf("%s: %s to %s\n", a.release, installed.version, latest)
	args := addonUpgradeArgs(a, latest)
	args = append(args, rollback...)
	args = append(args, clientSideApply(c)...)

	if a.crds {
		crds, err := c.Capture("helm", "show", "crds", a.chart, "--repo", a.repo, "--version", latest)
		if err != nil {
			return fmt.Errorf("couldn't read the %s CRDs: %w", a.chart, err)
		}
		if strings.TrimSpace(crds) != "" {
			if _, err := c.CaptureWithInput(crds, "kubectl", "apply", "--server-side", "--force-conflicts", "-f", "-"); err != nil {
				return fmt.Errorf("couldn't apply the %s CRDs: %w", a.chart, err)
			}
		}
	}
	return c.Run("helm", args...)
}

func helmRollbackFlag(c *cli.Context) []string {
	version, err := c.Capture("helm", "version", "--short")
	if err == nil && strings.HasPrefix(strings.TrimSpace(version), "v4.") {
		return []string{"--rollback-on-failure"}
	}
	return []string{"--atomic"}
}

func upgradeAddons(c *cli.Context) {
	if c.Env.AddonUpdates == "off" {
		return
	}
	rollback := helmRollbackFlag(c)
	gate := gateFor(c)
	for _, a := range addons {
		if err := upgradeAddon(c, gate, a, rollback); err != nil {
			c.Warnf("note: %s wasn't updated: %s\n", a.release, err)
		}
	}
}
