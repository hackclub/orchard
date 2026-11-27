package commands

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func TestSizeFastBuilder(t *testing.T) {
	cases := []struct {
		name  string
		facts fcFacts
		over  fcSizing
		want  fcSizing
	}{
		{
			name:  "8 GiB, 4 cores",
			facts: fcFacts{MemoryMiB: 8192, Cores: 4, FreeDiskGiB: 200},
			want:  fcSizing{VCPUs: 2, MemoryMiB: 2048, MaxVMs: 1, MinFreeMiB: 1228, StorageGiB: 80, CacheGiB: 20},
		},
		{
			name:  "a real 8 GB box reports less than 8 GiB",
			facts: fcFacts{MemoryMiB: 7800, Cores: 4, FreeDiskGiB: 60},
			want:  fcSizing{VCPUs: 2, MemoryMiB: 2048, MaxVMs: 1, MinFreeMiB: 1170, StorageGiB: 24, CacheGiB: 10},
		},
		{
			name:  "an 8 GB box where Orchard already uses 2.5 GiB still boots a VM",
			facts: fcFacts{MemoryMiB: 7751, AvailableMiB: 5235, Cores: 4, FreeDiskGiB: 40},
			want:  fcSizing{VCPUs: 2, MemoryMiB: 2048, MaxVMs: 1, MinFreeMiB: 1162, StorageGiB: 20, CacheGiB: 10},
		},
		{
			name:  "VM count comes from free memory, not total",
			facts: fcFacts{MemoryMiB: 65536, AvailableMiB: 30000, Cores: 32, FreeDiskGiB: 1000},
			want:  fcSizing{VCPUs: 8, MemoryMiB: 16384, MaxVMs: 1, MinFreeMiB: 9830, StorageGiB: 400, CacheGiB: 50},
		},
		{
			name:  "16 GiB, 8 cores",
			facts: fcFacts{MemoryMiB: 16384, Cores: 8, FreeDiskGiB: 500},
			want:  fcSizing{VCPUs: 4, MemoryMiB: 4096, MaxVMs: 2, MinFreeMiB: 2457, StorageGiB: 200, CacheGiB: 50},
		},
		{
			name:  "64 GiB, 32 cores",
			facts: fcFacts{MemoryMiB: 65536, Cores: 32, FreeDiskGiB: 1000},
			want:  fcSizing{VCPUs: 8, MemoryMiB: 16384, MaxVMs: 3, MinFreeMiB: 9830, StorageGiB: 400, CacheGiB: 50},
		},
		{
			name:  "256 GiB, 64 cores",
			facts: fcFacts{MemoryMiB: 262144, Cores: 64, FreeDiskGiB: 10000},
			want:  fcSizing{VCPUs: 8, MemoryMiB: 16384, MaxVMs: 6, MinFreeMiB: 32768, StorageGiB: 1024, CacheGiB: 50},
		},
		{
			name:  "one core still gets a vCPU and a tiny disk gets the minimum",
			facts: fcFacts{MemoryMiB: 8192, Cores: 1, FreeDiskGiB: 10},
			want:  fcSizing{VCPUs: 1, MemoryMiB: 2048, MaxVMs: 1, MinFreeMiB: 1228, StorageGiB: 20, CacheGiB: 10},
		},
		{
			name:  "flags win over the machine",
			facts: fcFacts{MemoryMiB: 16384, Cores: 8, FreeDiskGiB: 500},
			over:  fcSizing{VCPUs: 2, MemoryMiB: 8192, MinFreeMiB: 4096, StorageGiB: 100, CacheGiB: 15},
			want:  fcSizing{VCPUs: 2, MemoryMiB: 8192, MaxVMs: 1, MinFreeMiB: 4096, StorageGiB: 100, CacheGiB: 15},
		},
		{
			name:  "an explicit VM count is taken as given",
			facts: fcFacts{MemoryMiB: 16384, Cores: 8, FreeDiskGiB: 500},
			over:  fcSizing{MaxVMs: 5},
			want:  fcSizing{VCPUs: 4, MemoryMiB: 4096, MaxVMs: 5, MinFreeMiB: 2457, StorageGiB: 200, CacheGiB: 50},
		},
		{
			name:  "a 4 GiB box fits once both memory flags shrink",
			facts: fcFacts{MemoryMiB: 4096, Cores: 2, FreeDiskGiB: 100},
			over:  fcSizing{MemoryMiB: 1024, MinFreeMiB: 1024},
			want:  fcSizing{VCPUs: 1, MemoryMiB: 1024, MaxVMs: 1, MinFreeMiB: 1024, StorageGiB: 40, CacheGiB: 10},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := sizeFastBuilder(tc.facts, tc.over)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

func TestSizeFastBuilderRefusesAMachineTooSmallForOneVM(t *testing.T) {
	cases := map[string]struct {
		facts fcFacts
		over  fcSizing
	}{
		"defaults":          {fcFacts{MemoryMiB: 4096, Cores: 2, FreeDiskGiB: 100}, fcSizing{}},
		"only --min-free":   {fcFacts{MemoryMiB: 4096, Cores: 2, FreeDiskGiB: 100}, fcSizing{MinFreeMiB: 1024}},
		"overrides too big": {fcFacts{MemoryMiB: 4096, Cores: 2, FreeDiskGiB: 100}, fcSizing{MemoryMiB: 2048, MinFreeMiB: 2048}},
		"a busy 16 GiB box": {fcFacts{MemoryMiB: 16384, AvailableMiB: 4096, Cores: 8, FreeDiskGiB: 100}, fcSizing{}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := sizeFastBuilder(tc.facts, tc.over)
			if err == nil {
				t.Fatal("one VM can't fit in the free memory with these sizes; this should refuse")
			}
			if !strings.Contains(err.Error(), "4096 MiB of memory free") || !strings.Contains(err.Error(), "MiB free to start one VM") {
				t.Fatalf("the refusal should say how much memory is needed, got %v", err)
			}
		})
	}
}

func TestParseFastBuilderFlags(t *testing.T) {
	o, err := parseFastBuilderFlags([]string{
		"--vcpus", "3", "--memory", "4Gi", "--min-free", "3072", "--max-vms", "2",
		"--cache-size", "20G", "--storage-size", "1Ti", "--storage-class", "", "--cpu-limit", "8",
		"--memory-limit", "32Gi", "--routing", "per_app",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := fcSizing{VCPUs: 3, MemoryMiB: 4096, MaxVMs: 2, MinFreeMiB: 3072, StorageGiB: 1024, CacheGiB: 20}
	if o.Overrides != want {
		t.Fatalf("got %+v", o.Overrides)
	}
	if o.StorageClass == nil || *o.StorageClass != "" {
		t.Fatal("an explicit empty --storage-class means the cluster default and must be kept apart from no flag")
	}
	if o.CPULimit != "8" || o.MemoryLimitMiB != 32768 || o.Routing != "per_app" {
		t.Fatalf("got %+v", o)
	}

	defaults, err := parseFastBuilderFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if defaults.Routing != "all" || defaults.StorageClass != nil {
		t.Fatalf("got %+v", defaults)
	}

	for _, bad := range [][]string{
		{"--routing", "sometimes"},
		{"--memory", "lots"},
		{"--memory", "4Ti"},
		{"--vcpus", "0"},
		{"--max-vm", "3"},
		{"--memory"},
	} {
		if _, err := parseFastBuilderFlags(bad); err == nil {
			t.Fatalf("%v should be refused", bad)
		}
	}
}

func TestPickNode(t *testing.T) {
	if got, err := pickNode("node/box\n", "whatever"); err != nil || got != "box" {
		t.Fatalf("a single node is this one, got %q %v", got, err)
	}
	if got, err := pickNode("node/a\nnode/box\n", "Box.example.com"); err != nil || got != "box" {
		t.Fatalf("k3s names the node after the lowercased short hostname, got %q %v", got, err)
	}
	if _, err := pickNode("node/a\nnode/b\n", "c"); err == nil || !strings.Contains(err.Error(), "--node") {
		t.Fatalf("an unknown machine should point at --node, got %v", err)
	}
	if _, err := pickNode("", "c"); err == nil {
		t.Fatal("no nodes should fail")
	}
}

const installerValues = `builders:
  enabled: true
  platform: linux/amd64
  harbor:
    username: orchard
    password: "pw"
    hosts:
      - zot.orchard.svc.cluster.local:5000
  httpRegistries:
    - zot.orchard.svc.cluster.local:5000
  registryEgress:
    - namespace: orchard
      podLabels:
        app: zot
      ports:
        - port: 5000
  localCache:
    enabled: true
    size: 50Gi
    storageClass: local-path
    evict:
      maxGiB: 50
`

type fcFixture struct {
	c      *cli.Context
	host   fcHost
	values string
	calls  *[]string
}

func newFCFixture(t *testing.T, body string, memKiB int, cores int, freeGiB uint64) fcFixture {
	t.Helper()
	dir := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	valuesPath := write("values.yaml", body)
	storage := filepath.Join(dir, "storage")
	if err := os.Mkdir(storage, 0o755); err != nil {
		t.Fatal(err)
	}
	calls := &[]string{}
	out := discard(t)
	return fcFixture{
		c:      &cli.Context{Env: cli.Env{Values: valuesPath, Namespace: "orchard"}, Stdout: out, Stderr: out},
		values: valuesPath,
		calls:  calls,
		host: fcHost{
			KVM:               write("kvm", ""),
			CgroupControllers: write("cgroup.controllers", "cpu memory\n"),
			Meminfo:           write("meminfo", "MemTotal:       "+strconv.Itoa(memKiB)+" kB\nMemFree: 1 kB\n"),
			StorageDirs:       []string{filepath.Join(dir, "missing"), storage},
			Cores:             func() int { return cores },
			FreeDisk:          func(string) (uint64, bool) { return freeGiB << 30, true },
			Hostname:          func() (string, error) { return "box", nil },
			Capture: func(name string, args ...string) (string, error) {
				*calls = append(*calls, name+" "+strings.Join(args, " "))
				return "node/box\n", nil
			},
			Run: func(name string, args ...string) error {
				*calls = append(*calls, name+" "+strings.Join(args, " "))
				return nil
			},
		},
	}
}

func (f fcFixture) load(t *testing.T) *cli.Values {
	t.Helper()
	values, err := cli.LoadValues(f.values)
	if err != nil {
		t.Fatal(err)
	}
	return values
}

func TestEnableFastBuilderWritesValuesSizedToTheHost(t *testing.T) {
	f := newFCFixture(t, installerValues, 16*1024*1024, 8, 500)
	if err := enableFastBuilder(f.c, f.host, nil); err != nil {
		t.Fatal(err)
	}
	values := f.load(t)

	want := map[string]any{
		"fcBuilder.enabled":              true,
		"fcBuilder.serverEnabled":        true,
		"fcBuilder.replicas":             1,
		"fcBuilder.routing":              "all",
		"fcBuilder.vm.vcpus":             4,
		"fcBuilder.vm.memoryMiB":         4096,
		"fcBuilder.vm.maxVms":            2,
		"fcBuilder.vm.minNodeFreeMiB":    2457,
		"fcBuilder.vm.cacheSize":         "50G",
		"fcBuilder.storage.size":         "200Gi",
		"fcBuilder.storage.storageClass": "local-path",
		"fcBuilder.registry.upstream":    "http://zot.orchard.svc.cluster.local:5000",
		"fcBuilder.resources.requests":   map[string]any{"cpu": "250m", "memory": "256Mi"},
	}
	for path, value := range want {
		if got := values.Get(path); !reflect.DeepEqual(got, value) {
			t.Fatalf("%s = %#v, want %#v", path, got, value)
		}
	}

	resources, _ := values.Get("fcBuilder.resources").(map[string]any)
	if limits, present := resources["limits"]; !present || limits != nil {
		t.Fatalf("limits must be written as null so helm drops the chart's 32 CPU / 108Gi default, got %#v (present %t)", limits, present)
	}

	if !reflect.DeepEqual(values.List("fcBuilder.registryEgress"), values.List("builders.registryEgress")) {
		t.Fatalf("registryEgress should copy the builders' one, got %#v", values.List("fcBuilder.registryEgress"))
	}

	if !slices.Contains(*f.calls, "kubectl label node box orchard-fc-builder=true --overwrite") {
		t.Fatalf("the node should be labelled, calls = %v", *f.calls)
	}

	raw, err := os.ReadFile(f.values)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "limits: null") {
		t.Fatalf("values file should carry limits: null, got\n%s", raw)
	}
}

func TestEnableFastBuilderFlagsOverride(t *testing.T) {
	f := newFCFixture(t, installerValues, 16*1024*1024, 8, 500)
	args := []string{
		"--vcpus", "2", "--memory", "6Gi", "--max-vms", "1", "--min-free", "3Gi",
		"--cache-size", "30", "--storage-size", "120Gi", "--storage-class", "fast-ssd",
		"--memory-limit", "16Gi", "--routing", "flag",
	}
	if err := enableFastBuilder(f.c, f.host, args); err != nil {
		t.Fatal(err)
	}
	values := f.load(t)
	want := map[string]any{
		"fcBuilder.routing":              "flag",
		"fcBuilder.vm.vcpus":             2,
		"fcBuilder.vm.memoryMiB":         6144,
		"fcBuilder.vm.maxVms":            1,
		"fcBuilder.vm.minNodeFreeMiB":    3072,
		"fcBuilder.vm.cacheSize":         "30G",
		"fcBuilder.storage.size":         "120Gi",
		"fcBuilder.storage.storageClass": "fast-ssd",
		"fcBuilder.resources.limits":     map[string]any{"cpu": nil, "memory": "16Gi"},
	}
	for path, value := range want {
		if got := values.Get(path); !reflect.DeepEqual(got, value) {
			t.Fatalf("%s = %#v, want %#v", path, got, value)
		}
	}
}

func TestEnableFastBuilderUsesHTTPSForARegistryNotListedAsHTTP(t *testing.T) {
	body := "builders:\n  harbor:\n    hosts: [registry.example.com]\n"
	f := newFCFixture(t, body, 16*1024*1024, 8, 500)
	if err := enableFastBuilder(f.c, f.host, nil); err != nil {
		t.Fatal(err)
	}
	values := f.load(t)
	if got := values.Get("fcBuilder.registry.upstream"); got != "https://registry.example.com" {
		t.Fatalf("got %v", got)
	}
	if got := values.Get("fcBuilder.storage.storageClass"); got != "" {
		t.Fatalf("no local cache class means the cluster default, got %#v", got)
	}
	if values.Get("fcBuilder.registryEgress") != nil {
		t.Fatal("no builders.registryEgress should leave the chart's alone")
	}
}

func TestEnableFastBuilderLeavesUpstreamAloneWithoutHarborHosts(t *testing.T) {
	body := "fcBuilder:\n  registry:\n    upstream: http://mine.example:5000\n"
	f := newFCFixture(t, body, 16*1024*1024, 8, 500)
	if err := enableFastBuilder(f.c, f.host, nil); err != nil {
		t.Fatal(err)
	}
	if got := f.load(t).Get("fcBuilder.registry.upstream"); got != "http://mine.example:5000" {
		t.Fatalf("got %v", got)
	}
}

func TestEnableFastBuilderKeepsTheCacheVolumeOnRerun(t *testing.T) {
	f := newFCFixture(t, installerValues, 16*1024*1024, 8, 500)
	if err := enableFastBuilder(f.c, f.host, nil); err != nil {
		t.Fatal(err)
	}
	f.host.FreeDisk = func(string) (uint64, bool) { return 100 << 30, true }
	if err := enableFastBuilder(f.c, f.host, []string{"--memory", "2Gi"}); err != nil {
		t.Fatal(err)
	}
	values := f.load(t)
	if got := values.Get("fcBuilder.storage.size"); got != "200Gi" {
		t.Fatalf("a StatefulSet can't change its volume template, so the size must stick, got %v", got)
	}
	if got := values.Get("fcBuilder.vm.memoryMiB"); got != 2048 {
		t.Fatalf("everything else is sized again, got %v", got)
	}
	if got := values.Get("fcBuilder.vm.maxVms"); got != 3 {
		t.Fatalf("smaller VMs fit more of them, got %v", got)
	}

	if err := enableFastBuilder(f.c, f.host, []string{"--storage-size", "300"}); err != nil {
		t.Fatal(err)
	}
	if got := f.load(t).Get("fcBuilder.storage.size"); got != "300Gi" {
		t.Fatalf("an explicit flag still wins, got %v", got)
	}
}

func TestEnableFastBuilderRefusesWithoutKVMOrCgroupV2(t *testing.T) {
	f := newFCFixture(t, installerValues, 16*1024*1024, 8, 500)
	f.host.KVM = filepath.Join(t.TempDir(), "kvm")
	err := enableFastBuilder(f.c, f.host, nil)
	if err == nil || !strings.Contains(err.Error(), "doesn't exist") {
		t.Fatalf("got %v", err)
	}

	f = newFCFixture(t, installerValues, 16*1024*1024, 8, 500)
	f.host.CgroupControllers = filepath.Join(t.TempDir(), "cgroup.controllers")
	err = enableFastBuilder(f.c, f.host, nil)
	if err == nil || !strings.Contains(err.Error(), "cgroup v2") {
		t.Fatalf("got %v", err)
	}
	if len(*f.calls) != 0 {
		t.Fatalf("a failed preflight must not touch the cluster, calls = %v", *f.calls)
	}
	if f.load(t).Get("fcBuilder") != nil {
		t.Fatal("a failed preflight must not write values")
	}
}

func TestEnableFastBuilderRefusesASmallMachineBeforeChangingAnything(t *testing.T) {
	f := newFCFixture(t, installerValues, 4*1024*1024, 2, 100)
	if err := enableFastBuilder(f.c, f.host, nil); err == nil {
		t.Fatal("4 GiB can't hold one VM with the defaults")
	}
	if len(*f.calls) != 0 || f.load(t).Get("fcBuilder") != nil {
		t.Fatal("a refusal must not label the node or write values")
	}
	if err := enableFastBuilder(f.c, f.host, []string{"--memory", "1024", "--min-free", "1Gi"}); err != nil {
		t.Fatalf("overrides that fit should be accepted: %v", err)
	}
}

func TestEnableFastBuilderRefusesAMemoryLimitThatHoldsNoVM(t *testing.T) {
	f := newFCFixture(t, installerValues, 16*1024*1024, 8, 500)
	err := enableFastBuilder(f.c, f.host, []string{"--memory-limit", "4Gi"})
	if err == nil || !strings.Contains(err.Error(), "--memory-limit") {
		t.Fatalf("fc-host exits when its limit can't hold one VM; got %v", err)
	}
}

func TestDisableFastBuilderKeepsTheSizes(t *testing.T) {
	f := newFCFixture(t, installerValues, 16*1024*1024, 8, 500)
	if err := enableFastBuilder(f.c, f.host, nil); err != nil {
		t.Fatal(err)
	}
	if err := disableFastBuilder(f.c); err != nil {
		t.Fatal(err)
	}
	values := f.load(t)
	if values.Get("fcBuilder.enabled") != false || values.Get("fcBuilder.serverEnabled") != false {
		t.Fatalf("both switches should be off, got %v %v", values.Get("fcBuilder.enabled"), values.Get("fcBuilder.serverEnabled"))
	}
	for path, value := range map[string]any{
		"fcBuilder.vm.maxVms":    2,
		"fcBuilder.storage.size": "200Gi",
		"fcBuilder.routing":      "all",
	} {
		if got := values.Get(path); got != value {
			t.Fatalf("%s should survive disable, got %v", path, got)
		}
	}
}

func TestFastBuilderStatusIgnoresAMissingCluster(t *testing.T) {
	f := newFCFixture(t, installerValues, 16*1024*1024, 8, 500)
	f.host.Capture = func(string, ...string) (string, error) { return "", os.ErrNotExist }
	if err := fastBuilderStatus(f.c, f.host); err != nil {
		t.Fatal(err)
	}
}

func TestFastBuilderIsRegistered(t *testing.T) {
	for _, c := range All() {
		if c.Name == "fast-builder" {
			return
		}
	}
	t.Fatal("fast-builder is not in the registry")
}

func TestVMRoomLine(t *testing.T) {
	if got := vmRoomLine(5235, 2048, 2048); !strings.Contains(got, "no (5235 MiB free, a VM needs 5632 MiB)") {
		t.Fatalf("the box this was found on should say no, got %q", got)
	}
	if got := vmRoomLine(5235, 2048, 1162); !strings.HasPrefix(got, "new VM right now: yes") {
		t.Fatalf("after resizing it should say yes, got %q", got)
	}
	if got := vmRoomLine(0, 2048, 1162); got != "new VM right now: unknown" {
		t.Fatalf("got %q", got)
	}
}
