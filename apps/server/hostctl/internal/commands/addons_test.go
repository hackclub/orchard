package commands

import (
	"strings"
	"testing"
	"time"
)

func TestAddonInstalledVersionReadsTheChart(t *testing.T) {
	listing := []byte(`[{"name":"traefik","chart":"traefik-42.3.0","app_version":"v3.7.17"},{"name":"other","chart":"other-1.0.0"}]`)
	installed, found, err := addonInstalledVersion(listing, "traefik", "traefik")
	if err != nil || !found || installed.version != "42.3.0" || installed.appVersion != "v3.7.17" {
		t.Fatalf("got %+v %v %v", installed, found, err)
	}
	if _, found, err := addonInstalledVersion(listing, "cnpg", "cloudnative-pg"); err != nil || found {
		t.Fatalf("a missing release should be skipped: %v %v", found, err)
	}
	if _, _, err := addonInstalledVersion(listing, "other", "traefik"); err == nil {
		t.Fatal("a release from a different chart should not be upgraded")
	}
}

const cnpgIndex = `apiVersion: v1
entries:
  cloudnative-pg:
  - appVersion: 1.30.1
    created: "2026-11-14T16:56:41.882270061Z"
    name: cloudnative-pg
    version: 0.28.1
  - appVersion: 1.29.3
    created: "2026-11-13T10:00:00Z"
    name: cloudnative-pg
    version: 0.27.3
  - appVersion: 1.29.2
    created: "2026-11-01T10:00:00Z"
    name: cloudnative-pg
    version: 0.27.2
  - appVersion: 1.29.1
    created: "2026-10-01T10:00:00Z"
    name: cloudnative-pg
    version: 0.27.1
  - appVersion: 1.30.0-rc1
    name: cloudnative-pg
    version: 0.28.0-rc1
  plugin-barman-cloud:
  - appVersion: 0.5.0
    version: 0.3.0
`

func TestParseChartIndex(t *testing.T) {
	releases, err := parseChartIndex([]byte(cnpgIndex), "cloudnative-pg")
	if err != nil || len(releases) != 5 {
		t.Fatalf("got %d %v", len(releases), err)
	}
	if releases[0].version != "0.28.1" || releases[0].appVersion != "1.30.1" || !releases[0].created.Equal(time.Date(2026, 11, 14, 16, 56, 41, 882270061, time.UTC)) {
		t.Errorf("got %+v", releases[0])
	}
	if !releases[4].created.IsZero() {
		t.Errorf("a missing date should stay empty: %+v", releases[4])
	}
	if _, err := parseChartIndex([]byte(cnpgIndex), "traefik"); err == nil {
		t.Error("a chart the repository doesn't list should fail")
	}
}

func TestAddonPlanStaysInTheMinorBelowOne(t *testing.T) {
	releases, err := parseChartIndex([]byte(cnpgIndex), "cloudnative-pg")
	if err != nil {
		t.Fatal(err)
	}
	gate := &updateGate{now: func() time.Time { return fixedNow }, soak: 7 * day}
	plan, err := planAddon(gate, addons[1], installedChart{version: "0.27.1"}, releases)
	if err != nil {
		t.Fatal(err)
	}
	if plan.decision.target.tag.raw != "0.27.2" {
		t.Errorf("target %s", plan.decision.target.tag.raw)
	}
	if plan.decision.waiting == nil || plan.decision.waiting.tag.raw != "0.27.3" {
		t.Errorf("waiting %v", plan.decision.waiting)
	}
	if plan.ahead == nil || plan.ahead.tag.raw != "0.28.1" {
		t.Errorf("ahead %v", plan.ahead)
	}
	if plan.current.app.raw != "1.29.1" {
		t.Errorf("the app version should come from the index: %+v", plan.current)
	}
}

func TestAddonPlanFastTracksAnAdvisory(t *testing.T) {
	releases, err := parseChartIndex([]byte(cnpgIndex), "cloudnative-pg")
	if err != nil {
		t.Fatal(err)
	}
	osv := newFakeOSV(t, map[string][]string{
		"github.com/cloudnative-pg/cloudnative-pg@1.29.1": {"GHSA-c"},
		"github.com/cloudnative-pg/cloudnative-pg@1.29.2": {"GHSA-c"},
	})
	gate, _ := gateWithOSV(osv.server.URL)
	plan, err := planAddon(gate, addons[1], installedChart{version: "0.27.1"}, releases)
	if err != nil {
		t.Fatal(err)
	}
	if plan.decision.target.tag.raw != "0.27.3" || !plan.decision.early {
		t.Errorf("target %s early %v", plan.decision.target.tag.raw, plan.decision.early)
	}
	notes, _ := plan.decision.messages(plan.current, chartName("cloudnative-pg"), gate.soak)
	if len(notes) == 0 || notes[0] != "security update: GHSA-c affects cloudnative-pg 0.27.1, moving to cloudnative-pg 0.27.3" {
		t.Errorf("notes %q", notes)
	}
}

func TestAddonPlanAboveOne(t *testing.T) {
	releases := []chartRelease{
		{version: "v1.21.3", appVersion: "v1.21.3", created: fixedNow.Add(-20 * day)},
		{version: "v1.22.0", appVersion: "v1.22.0", created: fixedNow.Add(-10 * day)},
		{version: "v2.0.0", appVersion: "v2.0.0", created: fixedNow.Add(-10 * day)},
	}
	gate := &updateGate{now: func() time.Time { return fixedNow }, soak: 7 * day}
	plan, err := planAddon(gate, addons[2], installedChart{version: "v1.21.3"}, releases)
	if err != nil {
		t.Fatal(err)
	}
	if plan.decision.target.tag.raw != "v1.22.0" || plan.ahead == nil || plan.ahead.tag.raw != "v2.0.0" {
		t.Errorf("target %s ahead %v", plan.decision.target.tag.raw, plan.ahead)
	}
	if _, err := planAddon(gate, addons[2], installedChart{version: "garbage"}, releases); err == nil {
		t.Error("an unreadable version should fail")
	}
}

func TestAddonPlanTreatsANewAppMajorAsMajor(t *testing.T) {
	releases := []chartRelease{
		{version: "42.3.0", appVersion: "v3.7.17", created: fixedNow.Add(-20 * day)},
		{version: "42.4.0", appVersion: "v4.0.0", created: fixedNow.Add(-10 * day)},
	}
	gate := &updateGate{now: func() time.Time { return fixedNow }, soak: 7 * day}
	plan, err := planAddon(gate, addons[0], installedChart{version: "42.3.0"}, releases)
	if err != nil {
		t.Fatal(err)
	}
	if plan.decision.moves(plan.current) || plan.ahead == nil || plan.ahead.tag.raw != "42.4.0" {
		t.Errorf("target %s ahead %v", plan.decision.target.tag.raw, plan.ahead)
	}
}

func TestEveryAddonNamesItsChart(t *testing.T) {
	for _, a := range addons {
		if a.release == "" || a.namespace == "" || a.chart == "" || a.repo == "" || len(a.osv) == 0 {
			t.Errorf("incomplete add-on: %+v", a)
		}
		for _, p := range a.osv {
			if p.ecosystem == "" || !strings.Contains(p.name, "/") {
				t.Errorf("%s: bad OSV package %+v", a.release, p)
			}
		}
	}
}

func TestAnOperatorDoesNotCrossAMinorForASecurityFix(t *testing.T) {
	releases, err := parseChartIndex([]byte(cnpgIndex), "cloudnative-pg")
	if err != nil {
		t.Fatal(err)
	}
	osv := newFakeOSV(t, map[string][]string{
		"github.com/cloudnative-pg/cloudnative-pg@1.29.1": {"GHSA-c"},
		"github.com/cloudnative-pg/cloudnative-pg@1.29.2": {"GHSA-c"},
		"github.com/cloudnative-pg/cloudnative-pg@1.29.3": {"GHSA-c"},
	})
	gate, _ := gateWithOSV(osv.server.URL)
	plan, err := planAddon(gate, addons[1], installedChart{version: "0.27.1"}, releases)
	if err != nil {
		t.Fatal(err)
	}
	if plan.decision.target.tag.minor != 27 || plan.decision.early || len(plan.decision.fixed) != 0 {
		t.Errorf("target %s early %v", plan.decision.target.tag.raw, plan.decision.early)
	}
	_, warns := plan.decision.messages(plan.current, chartName("cloudnative-pg"), gate.soak)
	if len(warns) != 1 || !strings.Contains(warns[0], "cloudnative-pg 0.28.1 fixes GHSA-c and needs a person") {
		t.Errorf("warnings %q", warns)
	}
}

func TestTraefikUpgradeTurnsOffTheGatewayProvider(t *testing.T) {
	args := strings.Join(addonUpgradeArgs(addons[0], "42.4.0"), " ")
	if !strings.Contains(args, "--reset-then-reuse-values") || !strings.Contains(args, "--set providers.kubernetesGateway.enabled=false") {
		t.Errorf("got %s", args)
	}
	if strings.Contains(args, "--set-string providers.kubernetesGateway") {
		t.Errorf("the switch has to stay a boolean: %s", args)
	}
	cnpg := strings.Join(addonUpgradeArgs(addons[1], "0.27.2"), " ")
	if strings.Contains(cnpg, "kubernetesGateway") || !strings.Contains(cnpg, "--set-string config.data.ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true") {
		t.Errorf("got %s", cnpg)
	}
}
