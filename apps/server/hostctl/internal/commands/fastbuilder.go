package commands

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	fcNamespace       = "orchard-fc-builders"
	fcNodeLabel       = "orchard-fc-builder"
	fcVMOverheadMiB   = 1536
	fcHostReserveMiB  = 2048
	fcRequestCPU      = "250m"
	fcRequestMemory   = "256Mi"
	fcDefaultRouting  = "all"
	fcStorageSizePath = "fcBuilder.storage.size"
	fcStorageClass    = "fcBuilder.storage.storageClass"
)

var fcRoutingModes = []string{"all", "per_app", "off", "flag"}

var fcEnableFlags = []string{
	"--vcpus", "--memory", "--max-vms", "--min-free", "--cache-size", "--storage-size",
	"--storage-class", "--cpu-limit", "--memory-limit", "--routing", "--node",
}

type fcFacts struct {
	MemoryMiB    int
	AvailableMiB int
	Cores        int
	FreeDiskGiB  int
}

type fcSizing struct {
	VCPUs      int
	MemoryMiB  int
	MaxVMs     int
	MinFreeMiB int
	StorageGiB int
	CacheGiB   int
}

type fcOptions struct {
	Overrides      fcSizing
	StorageClass   *string
	CPULimit       string
	MemoryLimitMiB int
	Routing        string
	Node           string
}

type fcHost struct {
	KVM               string
	CgroupControllers string
	Meminfo           string
	StorageDirs       []string
	Cores             func() int
	FreeDisk          func(string) (uint64, bool)
	Hostname          func() (string, error)
	Capture           func(string, ...string) (string, error)
	Run               func(string, ...string) error
}

func realFCHost(c *cli.Context) fcHost {
	return fcHost{
		KVM:               "/dev/kvm",
		CgroupControllers: "/sys/fs/cgroup/cgroup.controllers",
		Meminfo:           "/proc/meminfo",
		StorageDirs:       []string{"/var/lib/rancher/k3s/storage", "/var/lib/rancher", "/"},
		Cores:             runtime.NumCPU,
		FreeDisk: func(path string) (uint64, bool) {
			d, ok := statDisk(path)
			return d.free, ok
		},
		Hostname: os.Hostname,
		Capture:  c.Capture,
		Run:      c.Run,
	}
}

func orDefault(override, computed int) int {
	if override > 0 {
		return override
	}
	return computed
}

func sizeFastBuilder(f fcFacts, o fcSizing) (fcSizing, error) {
	available := f.AvailableMiB
	if available <= 0 || available > f.MemoryMiB {
		available = f.MemoryMiB
	}
	s := fcSizing{
		VCPUs:      orDefault(o.VCPUs, clamp(f.Cores/2, 1, 8)),
		MinFreeMiB: orDefault(o.MinFreeMiB, clamp(f.MemoryMiB*15/100, 1024, 32768)),
		StorageGiB: orDefault(o.StorageGiB, clamp(f.FreeDiskGiB*40/100, 20, 1024)),
	}
	budget := available - s.MinFreeMiB
	s.MemoryMiB = orDefault(o.MemoryMiB, clamp(min(f.MemoryMiB/4, budget-fcVMOverheadMiB)/256*256, 2048, 16384))
	s.CacheGiB = orDefault(o.CacheGiB, clamp(s.StorageGiB/4, 10, 50))
	perVM := s.MemoryMiB + fcVMOverheadMiB
	if need := s.MinFreeMiB + perVM; available < need {
		return s, fmt.Errorf("this machine has %d MiB of memory free right now (%d MiB in total), and the fast builder needs %d MiB free to start one VM: "+
			"%d MiB kept free for apps, %d MiB for the VM and %d MiB for Firecracker and its cache disk. "+
			"Free some memory or add more, or pass a smaller --memory and --min-free if your apps can spare it",
			available, f.MemoryMiB, need, s.MinFreeMiB, s.MemoryMiB, fcVMOverheadMiB)
	}
	s.MaxVMs = orDefault(o.MaxVMs, clamp(budget/perVM, 1, 6))
	return s, nil
}

func parseSize(raw string, units map[string]int, bare int) (int, error) {
	s := strings.TrimSpace(raw)
	scale := bare
	for _, suffix := range []string{"Ti", "Gi", "Mi", "T", "G", "M"} {
		if trimmed, ok := strings.CutSuffix(s, suffix); ok {
			mult, known := units[suffix]
			if !known {
				return 0, fmt.Errorf("takes a plain number or one of %s, not %q", unitList(units), raw)
			}
			s, scale = trimmed, mult
			break
		}
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("takes a plain number or one of %s, not %q", unitList(units), raw)
	}
	return n * scale, nil
}

func unitList(units map[string]int) string {
	var names []string
	for _, suffix := range []string{"Mi", "M", "Gi", "G", "Ti", "T"} {
		if _, ok := units[suffix]; ok {
			names = append(names, suffix)
		}
	}
	return strings.Join(names, ", ")
}

func parseMiB(raw string) (int, error) {
	return parseSize(raw, map[string]int{"Mi": 1, "M": 1, "Gi": 1024, "G": 1024}, 1)
}

func parseGiB(raw string) (int, error) {
	return parseSize(raw, map[string]int{"Gi": 1, "G": 1, "Ti": 1024, "T": 1024}, 1)
}

func formatMiB(n int) string {
	if n%1024 == 0 {
		return fmt.Sprintf("%dGi", n/1024)
	}
	return fmt.Sprintf("%dMi", n)
}

func positiveInt(raw string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("takes a whole number above 0, not %q", raw)
	}
	return n, nil
}

func parseFastBuilderFlags(args []string) (fcOptions, error) {
	o := fcOptions{Routing: fcDefaultRouting}
	for i := 0; i < len(args); i += 2 {
		flag := args[i]
		if !slices.Contains(fcEnableFlags, flag) {
			return o, fmt.Errorf("unknown option %s; see orchardctl fast-builder --help", flag)
		}
		if i+1 >= len(args) {
			return o, fmt.Errorf("%s needs a value", flag)
		}
		value := args[i+1]
		var err error
		switch flag {
		case "--vcpus":
			o.Overrides.VCPUs, err = positiveInt(value)
		case "--max-vms":
			o.Overrides.MaxVMs, err = positiveInt(value)
		case "--memory":
			o.Overrides.MemoryMiB, err = parseMiB(value)
		case "--min-free":
			o.Overrides.MinFreeMiB, err = parseMiB(value)
		case "--memory-limit":
			o.MemoryLimitMiB, err = parseMiB(value)
		case "--cache-size":
			o.Overrides.CacheGiB, err = parseGiB(value)
		case "--storage-size":
			o.Overrides.StorageGiB, err = parseGiB(value)
		case "--storage-class":
			class := strings.TrimSpace(value)
			o.StorageClass = &class
		case "--cpu-limit":
			o.CPULimit = strings.TrimSpace(value)
		case "--routing":
			if !slices.Contains(fcRoutingModes, value) {
				err = fmt.Errorf("takes one of %s, not %q", strings.Join(fcRoutingModes, ", "), value)
			}
			o.Routing = value
		case "--node":
			o.Node = strings.TrimSpace(value)
		}
		if err != nil {
			return o, fmt.Errorf("%s %w", flag, err)
		}
	}
	return o, nil
}

func checkKVM(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err == nil {
		f.Close()
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%s doesn't exist, so this machine can't run Firecracker VMs. "+
			"Turn on virtualization (VT-x or AMD-V) in the firmware settings, or on a cloud VM choose a type with nested virtualization, "+
			"then load the kvm_intel or kvm_amd module", path)
	}
	return fmt.Errorf("%s exists but can't be opened for reading and writing (%v). Run this with sudo", path, err)
}

func fastBuilderPreflight(h fcHost) error {
	if err := checkKVM(h.KVM); err != nil {
		return err
	}
	if _, err := os.Stat(h.CgroupControllers); err != nil {
		return fmt.Errorf("this machine doesn't use cgroup v2 (%s is missing), and the fast builder needs it to cap each VM's memory. "+
			"Current distributions use it by default; on an older one, boot with systemd.unified_cgroup_hierarchy=1", h.CgroupControllers)
	}
	return nil
}

func meminfoMiB(path, key string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == key {
			kb, _ := strconv.Atoi(fields[1])
			return kb / 1024
		}
	}
	return 0
}

func valueInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case string:
		i, _ := strconv.Atoi(n)
		return i
	}
	return 0
}

func vmRoomLine(availableMiB, memoryMiB, minFreeMiB int) string {
	if availableMiB <= 0 || memoryMiB <= 0 {
		return "new VM right now: unknown"
	}
	need := memoryMiB + fcVMOverheadMiB + minFreeMiB
	if availableMiB >= need {
		return fmt.Sprintf("new VM right now: yes (%d MiB free, a VM needs %d MiB)", availableMiB, need)
	}
	return fmt.Sprintf("new VM right now: no (%d MiB free, a VM needs %d MiB), so builds that can't use a running VM go to the standard builder. "+
		"Lower --memory or --min-free, or free some memory", availableMiB, need)
}

func readFastBuilderFacts(h fcHost) (fcFacts, string) {
	facts := fcFacts{
		MemoryMiB:    memTotalMiB(h.Meminfo),
		AvailableMiB: meminfoMiB(h.Meminfo, "MemAvailable:"),
		Cores:        h.Cores(),
	}
	for _, dir := range h.StorageDirs {
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		if free, ok := h.FreeDisk(dir); ok {
			facts.FreeDiskGiB = int(free >> 30)
			return facts, dir
		}
	}
	return facts, ""
}

func pickNode(listing, hostname string) (string, error) {
	var names []string
	for _, line := range strings.Fields(listing) {
		names = append(names, strings.TrimPrefix(line, "node/"))
	}
	if len(names) == 1 {
		return names[0], nil
	}
	host := strings.ToLower(strings.TrimSpace(hostname))
	short, _, _ := strings.Cut(host, ".")
	for _, name := range names {
		if name == host || name == short {
			return name, nil
		}
	}
	if len(names) == 0 {
		return "", fmt.Errorf("kubectl listed no nodes, so there is nothing to run the fast builder on")
	}
	return "", fmt.Errorf("couldn't tell which of %s is this machine; pass --node <name>", strings.Join(names, ", "))
}

func fastBuilderNode(h fcHost, explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	listing, err := h.Capture("kubectl", "get", "nodes", "-o", "name")
	if err != nil {
		return "", fmt.Errorf("couldn't list the cluster's nodes: %w", err)
	}
	hostname, _ := h.Hostname()
	return pickNode(listing, hostname)
}

func fastBuilderUpstream(values *cli.Values) string {
	hosts := values.List("builders.harbor.hosts")
	if len(hosts) == 0 {
		return ""
	}
	host, _ := hosts[0].(string)
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	for _, item := range values.List("builders.httpRegistries") {
		if s, _ := item.(string); strings.TrimSpace(s) == host {
			return "http://" + host
		}
	}
	return "https://" + host
}

func fastBuilderResources(o fcOptions) map[string]any {
	resources := map[string]any{
		"requests": map[string]any{"cpu": fcRequestCPU, "memory": fcRequestMemory},
		"limits":   nil,
	}
	if o.CPULimit != "" || o.MemoryLimitMiB > 0 {
		limits := map[string]any{"cpu": nil, "memory": nil}
		if o.CPULimit != "" {
			limits["cpu"] = o.CPULimit
		}
		if o.MemoryLimitMiB > 0 {
			limits["memory"] = formatMiB(o.MemoryLimitMiB)
		}
		resources["limits"] = limits
	}
	return resources
}

type valuePut struct {
	path  string
	value any
}

type fcPlan struct {
	Sizing       fcSizing
	Options      fcOptions
	StorageClass string
	KeepSize     bool
	KeepClass    bool
	Upstream     string
}

func planFastBuilder(values *cli.Values, facts fcFacts, o fcOptions) (fcPlan, error) {
	p := fcPlan{Options: o}
	overrides := o.Overrides
	if overrides.StorageGiB == 0 {
		if existing := stringAt(values, fcStorageSizePath); existing != "" {
			if n, err := parseGiB(existing); err == nil {
				overrides.StorageGiB = n
				p.KeepSize = true
			}
		}
	}
	sizing, err := sizeFastBuilder(facts, overrides)
	if err != nil {
		return p, err
	}
	p.Sizing = sizing
	if o.MemoryLimitMiB > 0 {
		if need := sizing.MemoryMiB + fcVMOverheadMiB + fcHostReserveMiB; o.MemoryLimitMiB < need {
			return p, fmt.Errorf("--memory-limit %s can't hold one %d MiB VM; the fast builder needs at least %s with that VM size",
				formatMiB(o.MemoryLimitMiB), sizing.MemoryMiB, formatMiB(need))
		}
	}
	switch {
	case o.StorageClass != nil:
		p.StorageClass = *o.StorageClass
	case values.Get(fcStorageClass) != nil:
		p.StorageClass = stringAt(values, fcStorageClass)
		p.KeepClass = true
	default:
		p.StorageClass = stringAt(values, "builders.localCache.storageClass")
	}
	p.Upstream = fastBuilderUpstream(values)
	return p, nil
}

func writeFastBuilder(values *cli.Values, p fcPlan) error {
	s := p.Sizing
	puts := []valuePut{
		{"fcBuilder.enabled", true},
		{"fcBuilder.serverEnabled", true},
		{"fcBuilder.replicas", 1},
		{"fcBuilder.routing", p.Options.Routing},
		{"fcBuilder.resources", fastBuilderResources(p.Options)},
		{"fcBuilder.vm.vcpus", s.VCPUs},
		{"fcBuilder.vm.memoryMiB", s.MemoryMiB},
		{"fcBuilder.vm.maxVms", s.MaxVMs},
		{"fcBuilder.vm.minNodeFreeMiB", s.MinFreeMiB},
		{"fcBuilder.vm.cacheSize", fmt.Sprintf("%dG", s.CacheGiB)},
	}
	if !p.KeepClass {
		puts = append(puts, valuePut{fcStorageClass, p.StorageClass})
	}
	if !p.KeepSize {
		puts = append(puts, valuePut{fcStorageSizePath, fmt.Sprintf("%dGi", s.StorageGiB)})
	}
	if p.Upstream != "" {
		puts = append(puts, valuePut{"fcBuilder.registry.upstream", p.Upstream})
	}
	for _, put := range puts {
		if err := values.Put(put.path, put.value); err != nil {
			return err
		}
	}
	if egress := values.List("builders.registryEgress"); len(egress) > 0 {
		values.SetList("fcBuilder.registryEgress", append([]any(nil), egress...))
	}
	return nil
}

func enableFastBuilder(c *cli.Context, h fcHost, args []string) error {
	o, err := parseFastBuilderFlags(args)
	if err != nil {
		return err
	}
	if err := fastBuilderPreflight(h); err != nil {
		return err
	}
	facts, diskDir := readFastBuilderFacts(h)
	if facts.MemoryMiB == 0 {
		return fmt.Errorf("couldn't read this machine's memory from %s", h.Meminfo)
	}

	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	plan, err := planFastBuilder(values, facts, o)
	if err != nil {
		return err
	}

	node, err := fastBuilderNode(h, o.Node)
	if err != nil {
		return err
	}
	if err := h.Run("kubectl", "label", "node", node, fcNodeLabel+"=true", "--overwrite"); err != nil {
		return fmt.Errorf("couldn't label node %s, so nothing was changed: %w", node, err)
	}

	if err := writeFastBuilder(values, plan); err != nil {
		return err
	}
	if err := values.Save(); err != nil {
		return err
	}

	printFastBuilderPlan(c, plan, facts, diskDir)
	return nil
}

func printFastBuilderPlan(c *cli.Context, p fcPlan, facts fcFacts, diskDir string) {
	s := p.Sizing
	class := p.StorageClass
	if class == "" {
		class = "the cluster's default StorageClass"
	}
	size := fmt.Sprintf("%dGi", s.StorageGiB)
	c.Printf("fast builder on, sized for %d CPUs and %d MiB of memory, %d MiB of it free now:\n", facts.Cores, facts.MemoryMiB, facts.AvailableMiB)
	c.Printf("  up to %d VMs at once, each %d vCPUs and %d MiB\n", s.MaxVMs, s.VCPUs, s.MemoryMiB)
	c.Printf("  %d MiB kept free for apps; no new VM starts below that\n", s.MinFreeMiB)
	c.Printf("  %s for build caches on %s, up to %dG per app\n", size, class, s.CacheGiB)
	if p.Options.CPULimit != "" || p.Options.MemoryLimitMiB > 0 {
		c.Printf("  limits: cpu %s, memory %s\n", orNone(p.Options.CPULimit), orNone(limitText(p.Options.MemoryLimitMiB)))
	}
	if p.Upstream != "" {
		c.Printf("  pushes to %s\n", p.Upstream)
	}
	c.Printf("  routing: %s\n", p.Options.Routing)
	if p.KeepSize || p.KeepClass {
		c.Printf("kept the cache disk's size and StorageClass from last time, because the volume can't change once it exists\n")
	}
	if diskDir == "" {
		c.Warnf("couldn't read free disk space, so the cache disk is the 20Gi minimum\n")
	} else if !p.KeepSize && s.StorageGiB > facts.FreeDiskGiB {
		c.Warnf("%s has %dGi free, less than the %s cache disk\n", diskDir, facts.FreeDiskGiB, size)
	}
	c.Printf("\nchange any of it by running enable again with flags, e.g. --memory 8Gi --max-vms 2,\n")
	c.Printf("or one value with: orchardctl config set fcBuilder.vm.maxVms 3\n")
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

func limitText(mib int) string {
	if mib <= 0 {
		return ""
	}
	return formatMiB(mib)
}

func disableFastBuilder(c *cli.Context) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	for _, path := range []string{"fcBuilder.enabled", "fcBuilder.serverEnabled"} {
		if err := values.Put(path, false); err != nil {
			return err
		}
	}
	if err := values.Save(); err != nil {
		return err
	}
	c.Printf("fast builder off. builds go back to the standard builder.\n")
	c.Printf("the sizes stay in the values file, so enable starts from them next time.\n")
	c.Printf("the next upgrade removes the %s namespace with every build cache in it,\n", fastBuilderNamespace(values))
	c.Printf("so the first build of each app after enabling again starts with an empty cache.\n")
	return nil
}

func fastBuilderNamespace(values *cli.Values) string {
	if ns := stringAt(values, "fcBuilder.namespace"); ns != "" {
		return ns
	}
	return fcNamespace
}

func fastBuilderStatus(c *cli.Context, h fcHost) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	enabled := values.Get("fcBuilder.enabled") == true
	server := values.Get("fcBuilder.serverEnabled") == true
	switch {
	case enabled && server:
		c.Printf("fast builder: on\n")
	case enabled:
		c.Printf("fast builder: hosts deployed, but the server doesn't send builds to them (fcBuilder.serverEnabled is false)\n")
	default:
		c.Printf("fast builder: off. turn it on with: orchardctl fast-builder enable --apply\n")
	}
	for _, row := range []struct{ label, path string }{
		{"routing", "fcBuilder.routing"},
		{"vcpus per VM", "fcBuilder.vm.vcpus"},
		{"memory per VM (MiB)", "fcBuilder.vm.memoryMiB"},
		{"VMs at once", "fcBuilder.vm.maxVms"},
		{"kept free (MiB)", "fcBuilder.vm.minNodeFreeMiB"},
		{"cache per app", "fcBuilder.vm.cacheSize"},
		{"cache disk", fcStorageSizePath},
		{"storage class", fcStorageClass},
		{"registry", "fcBuilder.registry.upstream"},
	} {
		value := values.Get(row.path)
		if value == nil {
			continue
		}
		text := cli.Render(value)
		if text == "" && row.path == fcStorageClass {
			text = "cluster default"
		}
		c.Printf("  %-20s %s\n", row.label, text)
	}
	if limits, ok := values.Get("fcBuilder.resources.limits").(map[string]any); ok && len(limits) > 0 {
		var parts []string
		for _, key := range []string{"cpu", "memory"} {
			if v, ok := limits[key]; ok && v != nil {
				parts = append(parts, key+" "+cli.Render(v))
			}
		}
		if len(parts) > 0 {
			c.Printf("  %-20s %s\n", "limits", strings.Join(parts, ", "))
		}
	}

	if err := checkKVM(h.KVM); err != nil {
		c.Printf("\n/dev/kvm: not usable. %v\n", err)
	} else {
		c.Printf("\n/dev/kvm: usable\n")
	}
	if enabled {
		c.Printf("%s\n", vmRoomLine(meminfoMiB(h.Meminfo, "MemAvailable:"), valueInt(values.Get("fcBuilder.vm.memoryMiB")), valueInt(values.Get("fcBuilder.vm.minNodeFreeMiB"))))
	}

	if out, err := h.Capture("kubectl", "-n", fastBuilderNamespace(values), "get", "pods"); err == nil && strings.TrimSpace(out) != "" {
		c.Printf("\n%s", out)
		if !strings.HasSuffix(out, "\n") {
			c.Printf("\n")
		}
	}
	return nil
}

func FastBuilder() *cli.Command {
	return &cli.Command{
		Name:    "fast-builder",
		Args:    "...",
		Summary: "the experimental Firecracker fast builder",
		Root:    true,
		Usage: `orchardctl fast-builder - the experimental Firecracker fast builder

The fast builder runs each build in a Firecracker microVM that stays up between
builds and keeps the app's build cache warm. It needs /dev/kvm and cgroup v2.

  orchardctl fast-builder status     show what is set and whether it runs
  orchardctl fast-builder enable     size it to this machine and turn it on
  orchardctl fast-builder disable    turn it off, keeping the sizes

enable checks /dev/kvm and cgroup v2, reads this machine's memory, CPUs and
free disk, sizes the fast builder to fit, points it at the registry your builds
already push to, and labels this node orchard-fc-builder=true so it runs here.

Every size has a default from this machine and a flag to override it:

  --vcpus <n>             CPUs per VM           half the CPUs, 1 to 8
  --memory <size>         memory per VM         a quarter of memory if free, 2Gi to 16Gi
  --min-free <size>       memory kept for apps  15% of memory, 1Gi to 32Gi
  --max-vms <n>           VMs at once           as many as free memory fits, 1 to 6
  --storage-size <size>   disk for all caches   40% of free disk, 20Gi to 1Ti
  --cache-size <size>     cache per app         a quarter of that disk, 10G to 50G
  --storage-class <name>  StorageClass for it   builders.localCache.storageClass
  --cpu-limit <cpu>       pod CPU limit         none
  --memory-limit <size>   pod memory limit      none
  --routing <mode>        which builds use it   all | per_app | off | flag
  --node <name>           node to label         this machine

Memory sizes take a number of MiB or a size such as 8Gi. Disk sizes take a
number of GiB or a size such as 100Gi. Each VM also uses about 1.5Gi on top of
its memory. Without limits the pod still can't take over the machine: each VM
has its own memory cap, and no new VM starts if it would leave less free than
--min-free.

Running enable again sizes everything you don't pass a flag for from scratch,
so pass the same flags again, or change single values with
  orchardctl config set fcBuilder.vm.maxVms 3
The cache disk's size and StorageClass are the exception: once the volume
exists they can't change, so enable keeps them unless you pass the flag.

Changes are written but not deployed. Add --apply to upgrade afterwards, or
run orchardctl update yourself.

  orchardctl fast-builder enable --memory 8Gi --max-vms 2 --apply

disable removes the orchard-fc-builders namespace at the next upgrade, with
every build cache in it. The sizes stay in the values file.
`,
		Run: func(c *cli.Context, args []string) error {
			args, apply := splitApply(args)
			action := "status"
			if len(args) > 0 {
				action, args = args[0], args[1:]
			}
			h := realFCHost(c)

			switch action {
			case "status":
				return fastBuilderStatus(c, h)
			case "enable":
				if err := enableFastBuilder(c, h, args); err != nil {
					return err
				}
			case "disable":
				if len(args) > 0 {
					return fmt.Errorf("disable takes no options besides --apply")
				}
				if err := disableFastBuilder(c); err != nil {
					return err
				}
			default:
				return fmt.Errorf("unknown fast-builder command: %s", action)
			}

			if !apply {
				c.Printf("\nnot deployed yet: run orchardctl update, or add --apply next time\n")
			}
			return maybeApply(c, apply)
		},
	}
}
