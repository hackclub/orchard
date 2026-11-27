package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	hostDefaultsPath    = "hostDefaults"
	hostDefaultsVersion = 5
	smallBoxMemMB       = 7500

	cnpgOperatorNamespaceEnv = "CNPG_OPERATOR_NAMESPACE"
	installerCnpgNamespace   = "cnpg-system"

	releaseImageRegistry   = "ghcr.io"
	releaseImageRepository = "hackclub/orchard"
)

type storedState int

const (
	storedUnknown storedState = iota
	storedNone
	storedPresent
)

type hostFacts struct {
	MemMB         int
	DiskGB        int
	ObjectStorage storedState
	ReleaseChart  bool
}

func resources(cpuReq, memReq, cpuLim, memLim string) map[string]any {
	return map[string]any{
		"requests": map[string]any{"cpu": cpuReq, "memory": memReq},
		"limits":   map[string]any{"cpu": cpuLim, "memory": memLim},
	}
}

func clamp(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func defaultsRound(values *cli.Values) int {
	switch n := values.Get(hostDefaultsPath).(type) {
	case int:
		return n
	case float64:
		return int(n)
	case string:
		parsed, _ := strconv.Atoi(n)
		return parsed
	}
	return 0
}

func stringAt(values *cli.Values, path string) string {
	s, _ := values.Get(path).(string)
	return strings.TrimSpace(s)
}

func objectStorageInValues(values *cli.Values) bool {
	for _, name := range []string{"R2_ENDPOINT", "R2_ACCOUNT_ID", "R2_BACKUP_BUCKET"} {
		if values.EnvValue(serverEnvPath, name) != "" {
			return true
		}
	}
	return len(values.List("server.envFrom")) > 0 || stringAt(values, "r2Proxy.upstream.endpoint") != ""
}

func applyHostDefaults(values *cli.Values, facts hostFacts) []string {
	round := defaultsRound(values)
	if round >= hostDefaultsVersion {
		return nil
	}
	var changes []string
	if round < 1 {
		changes = applyFirstRound(values, facts)
	}
	if round < 2 && values.EnvValue(serverEnvPath, cnpgOperatorNamespaceEnv) == "" {
		values.SetEnv(serverEnvPath, cnpgOperatorNamespaceEnv, installerCnpgNamespace)
		changes = append(changes, cnpgOperatorNamespaceEnv+" = "+installerCnpgNamespace+" (lets the database operator reach database pods)")
	}
	if round < 3 && facts.ReleaseChart {
		changes = append(changes, dropLatestImageTags(values)...)
	}
	if round < 4 {
		changes = append(changes, dropAlwaysPullPolicy(values)...)
	}
	if round < 5 && values.Get("gateway.enabled") == true {
		values.Unset("gateway.enabled")
		changes = append(changes, "gateway.enabled removed (Orchard routes apps with Ingress and creates no Gateway API routes, so the chart's Gateway objects carried no traffic)")
	}
	_ = values.Put(hostDefaultsPath, hostDefaultsVersion)
	return changes
}

func dropLatestImageTags(values *cli.Values) []string {
	if registry := stringAt(values, "image.registry"); registry != "" && registry != releaseImageRegistry {
		return nil
	}
	if repository := stringAt(values, "image.repository"); repository != "" && repository != releaseImageRepository {
		return nil
	}
	var dropped []string
	for _, component := range []string{"server", "frontend"} {
		if stringAt(values, component+".image.tag") != "latest" {
			continue
		}
		values.Unset(component + ".image.tag")
		if image, ok := values.Get(component + ".image").(map[string]any); ok && len(image) == 0 {
			values.Unset(component + ".image")
		}
		dropped = append(dropped, component+".image.tag")
	}
	if len(dropped) == 0 {
		return nil
	}
	return []string{strings.Join(dropped, " and ") + " removed (it was latest, so a pod restart could pull a release the chart doesn't match; the images now follow the chart version, which orchardctl update moves)"}
}

func dropAlwaysPullPolicy(values *cli.Values) []string {
	if stringAt(values, "image.pullPolicy") != "Always" {
		return nil
	}
	for _, component := range []string{"server", "frontend", "mcp", "r2Proxy", "fcBuilder"} {
		if stringAt(values, component+".image.tag") == "latest" {
			return nil
		}
	}
	values.Unset("image.pullPolicy")
	return []string{"image.pullPolicy removed (it was Always, so every pod start waited on the registry; release versions don't move, so the chart's IfNotPresent starts pods from the image already on the node)"}
}

func releaseChart(ref string) bool {
	info, err := os.Stat(ref)
	return err != nil || !info.IsDir()
}

func applyFirstRound(values *cli.Values, facts hostFacts) []string {
	var changes []string
	fill := func(path string, value any, note string) {
		if values.Get(path) != nil {
			return
		}
		if err := values.Put(path, value); err != nil {
			return
		}
		if note == "" {
			note = fmt.Sprintf("%s = %s", path, cli.Render(value))
		}
		changes = append(changes, note)
	}
	small := facts.MemMB > 0 && facts.MemMB < smallBoxMemMB

	class := stringAt(values, "postgres.storage.storageClass")
	if class == "" {
		class = stringAt(values, "tenant.storageClass")
	}
	if class != "" {
		fill("logs.victorialogs.storage.storageClass", class, "")
		fill("metrics.victoriametrics.storage.storageClass", class, "")
		fill("trivy.storage.storageClass", class, "")
	}

	if values.Get("metrics.enabled") == false {
		_ = values.Put("metrics.enabled", true)
		changes = append(changes, "metrics.enabled = true (it was off; orchardctl config set metrics.enabled false --apply turns it back off)")
	}
	fill("trivy.enabled", true, "trivy.enabled = true (the Orchard image scanner)")

	if facts.DiskGB > 0 {
		fill("logs.maxDiskSpaceUsage", fmt.Sprintf("%dGiB", clamp(facts.DiskGB/10, 5, 20)*4/5), "")
	}
	if small {
		trimmed := "trimmed for a server under 8G of RAM"
		fill("metrics.victoriametrics.resources", resources("50m", "96Mi", "1", "384Mi"), "metrics.victoriametrics.resources "+trimmed)
		fill("metrics.vmagent.resources", resources("20m", "64Mi", "500m", "256Mi"), "metrics.vmagent.resources "+trimmed)
		fill("metrics.kubeStateMetrics.resources", resources("10m", "32Mi", "200m", "128Mi"), "metrics.kubeStateMetrics.resources "+trimmed)
		fill("metrics.nodeExporter.resources", resources("10m", "16Mi", "200m", "64Mi"), "metrics.nodeExporter.resources "+trimmed)
		fill("logs.retention", "7d", "")
		fill("logs.victorialogs.resources", resources("50m", "96Mi", "1", "384Mi"), "logs.victorialogs.resources "+trimmed)
		fill("logs.vector.resources", resources("20m", "64Mi", "500m", "256Mi"), "logs.vector.resources "+trimmed)
		fill("logs.vector.bufferEvents", 5000, "")
		fill("trivy.resources", resources("50m", "256Mi", "2", "1Gi"), "trivy.resources "+trimmed)
		fill("trivy.maxConcurrentScans", 1, "")
	}

	if values.Get("objectStorage.local.enabled") == nil {
		switch {
		case objectStorageInValues(values):
			changes = append(changes, "object storage is already configured in the values file, so backups stay where they are")
		case facts.ObjectStorage == storedPresent:
			changes = append(changes, "object storage is configured under Instance admin, so backups stay where they are")
		case facts.ObjectStorage == storedUnknown:
			changes = append(changes, "couldn't read Instance admin settings, so local object storage for backups was left off; turn it on with:\n    orchardctl config set objectStorage.local.enabled true\n    orchardctl config set r2Proxy.enabled true --apply")
		default:
			fill("objectStorage.local.enabled", true, "objectStorage.local.enabled = true (database backups go to an S3 store on this server, which doesn't protect you if the server is lost)")
			if class != "" {
				fill("objectStorage.local.storage.storageClass", class, "")
			}
			if facts.DiskGB > 0 {
				fill("objectStorage.local.storage.size", fmt.Sprintf("%dGi", clamp(facts.DiskGB/5, 5, 50)), "")
			}
			if values.Get("r2Proxy.enabled") != true {
				_ = values.Put("r2Proxy.enabled", true)
				changes = append(changes, "r2Proxy.enabled = true (each database gets credentials for its own backups only)")
			}
			fill("r2Proxy.replicas", 1, "")
			fill("r2Proxy.resources", resources("20m", "32Mi", "1", "512Mi"), "")
		}
	}

	return changes
}

func memoryMB() int {
	return memTotalMiB("/proc/meminfo")
}

func memTotalMiB(path string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, _ := strconv.Atoi(fields[1])
			return kb / 1024
		}
	}
	return 0
}

func freeDiskGB(path string) int {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	return int(uint64(st.Bavail) * uint64(st.Bsize) >> 30)
}

func storedObjectStorageState(out string, err error) storedState {
	if err != nil {
		return storedUnknown
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return storedNone
	}
	fields := map[string]any{}
	if json.Unmarshal([]byte(out), &fields) != nil {
		return storedPresent
	}
	for _, value := range fields {
		if s, ok := value.(string); ok && strings.TrimSpace(s) == "" {
			continue
		}
		if value == nil {
			continue
		}
		return storedPresent
	}
	return storedNone
}

func storedObjectStorage(c *cli.Context, values *cli.Values) storedState {
	cluster := envOr(stringAt(values, "postgres.name"), "orchard-db")
	database := envOr(stringAt(values, "postgres.database"), "orchard")
	pod := ""
	for _, selector := range []string{"cnpg.io/instanceRole=primary", "role=primary"} {
		out, err := c.KubectlOut("get", "pod", "-l", "cnpg.io/cluster="+cluster+","+selector, "-o", "jsonpath={.items[0].metadata.name}")
		if err == nil && strings.TrimSpace(out) != "" {
			pod = strings.TrimSpace(out)
			break
		}
	}
	if pod == "" {
		return storedUnknown
	}
	out, err := c.KubectlOut("exec", pod, "-c", "postgres", "--", "psql", "-d", database, "-tAc",
		"select value from instance_settings where key = 'object_storage'")
	return storedObjectStorageState(out, err)
}

type statefulVolume struct {
	statefulSet string
	claim       string
	classPath   string
}

var statefulVolumes = []statefulVolume{
	{"victorialogs", "data-victorialogs-0", "logs.victorialogs.storage.storageClass"},
	{"victoriametrics", "data-victoriametrics-0", "metrics.victoriametrics.storage.storageClass"},
}

func reconcileStatefulVolumes(c *cli.Context, values *cli.Values) bool {
	ns := envOr(stringAt(values, "metrics.namespace"), "orchard-metrics")
	changed := false
	for _, vol := range statefulVolumes {
		live, err := c.Capture("kubectl", "-n", ns, "get", "statefulset", vol.statefulSet, "--ignore-not-found",
			"-o", "jsonpath={.metadata.name}|{.spec.volumeClaimTemplates[0].spec.storageClassName}")
		if err != nil {
			continue
		}
		name, liveClass, found := strings.Cut(strings.TrimSpace(live), "|")
		if !found || name == "" {
			continue
		}
		want := stringAt(values, vol.classPath)
		if liveClass == want {
			continue
		}
		phase, err := c.Capture("kubectl", "-n", ns, "get", "pvc", vol.claim, "--ignore-not-found", "-o", "jsonpath={.status.phase}")
		if err != nil {
			continue
		}
		phase = strings.TrimSpace(phase)
		if phase == "Bound" {
			if liveClass == "" {
				values.Unset(vol.classPath)
			} else {
				_ = values.Put(vol.classPath, liveClass)
			}
			changed = true
			c.Printf("%s keeps StorageClass %q: its volume already holds data, and a StatefulSet can't change class in place\n", vol.statefulSet, liveClass)
			continue
		}
		if phase != "" && phase != "Pending" {
			continue
		}
		c.Printf("%s never got a volume (StorageClass %q isn't usable here); recreating it on %q\n", vol.statefulSet, liveClass, envOr(want, "the cluster default"))
		if err := c.Run("kubectl", "-n", ns, "delete", "statefulset", vol.statefulSet, "--wait=true"); err != nil {
			c.Warnf("note: couldn't remove %s: %s\n", vol.statefulSet, err)
			continue
		}
		if phase == "Pending" {
			if err := c.Run("kubectl", "-n", ns, "delete", "pvc", vol.claim, "--ignore-not-found", "--wait=false"); err != nil {
				c.Warnf("note: couldn't remove the unbound claim %s: %s\n", vol.claim, err)
			}
		}
	}
	return changed
}

func migrateValues(c *cli.Context) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	facts := hostFacts{MemMB: memoryMB(), DiskGB: freeDiskGB("/var/lib"), ReleaseChart: releaseChart(c.Env.Chart)}
	if defaultsRound(values) < 1 && values.Get("objectStorage.local.enabled") == nil && !objectStorageInValues(values) {
		facts.ObjectStorage = storedObjectStorage(c, values)
	}
	changes := applyHostDefaults(values, facts)
	changes = append(changes, retrofitInstallMode(values)...)
	_, zotErr := c.KubectlOut("get", "svc", "zot", "-o", "name")
	changes = append(changes, retrofitZotEgress(values, c.Env.Namespace, zotErr == nil)...)
	volumes := reconcileStatefulVolumes(c, values)
	if len(changes) == 0 && !volumes {
		return nil
	}
	if err := values.Save(); err != nil {
		return err
	}
	if len(changes) > 0 {
		c.Printf("turning on what this release does by default (%s):\n", c.Env.Values)
		for _, change := range changes {
			c.Printf("  %s\n", change)
		}
	}
	return nil
}
