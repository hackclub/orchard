package commands

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
	"github.com/hackclub/orchard/orchardctl/internal/release"
)

// Aliases are the hyphenated names linked next to orchardctl. Each is the same
// binary; it decides what to do from the name it was called by.
//
// orchard-sync-commands is deliberately absent: it is the shell bootstrap that
// install.sh reads out of the image before anything is installed, and linking
// it to this binary would replace the one thing that can recover a host with no
// orchardctl on it.
// A change here has to be made in apps/server/hostbin/orchard-sync-commands as
// well, which links the same names from shell. sync_test pins the two lists
// together, because the failure is silent: the alias never appears on the host
// and the command looks like it was never shipped.
var Aliases = []string{
	"orchard-update",
	"orchard-config",
	"orchard-registry",
	"orchard-policies",
	"orchard-mcp",
	"orchard-public-ip",
	"orchard-claim",
	"orchard-login",
	"orchard-password",
	"orchard-hostname",
	"orchard-stop",
	"orchard-start",
	"orchard-restart",
	"orchard-graft",
	"orchard-k3s",
	"orchard-images",
	"orchard-uninstall",
}

// All is the registry, in the order it is listed by help. main.go is a
// one-liner over this so a test can ask what actually ships.
func All() []*cli.Command {
	return []*cli.Command{
		Update(),
		Harden(),
		Config(),
		Env(),
		Registry(),
		Policies(),
		Mcp(),
		FastBuilder(),
		Graft(),
		PublicIP(),
		Hostname(),
		AppsDomain(),
		LetsEncryptEmail(),
		Claim(),
		Login(),
		Password(),
		Backups(),
		Stop(),
		Start(),
		Restart(),
		Logs(),
		Status(),
		K3s(),
		ImageGC(),
		Images(),
		Sync(),
		Uninstall(),
		Licenses(),
	}
}

func Sync() *cli.Command {
	return &cli.Command{
		Name:    "sync",
		Summary: "refresh these commands from the deployed image",
		Root:    true,
		Usage: `orchardctl sync - refresh the host commands

Copies orchardctl out of the running server image, which is where it ships
from, and re-links the hyphenated aliases. That is how you pick up a command
added or fixed in a later release without re-running the installer.

The download is validated before it replaces the live binary: a truncated
copy would leave the host with no way to upgrade itself, which is the worst
thing this command could do. Its signature is checked too, because this binary
runs as root and the pod it comes from is not trusted. A copy that fails, or an
older release, leaves the current commands in place.

Images you build yourself are unsigned. To use them, set
ORCHARD_ALLOW_UNSIGNED_COMMANDS=true in /etc/orchard/env.

orchardctl update runs this for you at the end.
`,
		Run: func(c *cli.Context, args []string) error { return syncCommands(c) },
	}
}

var errOlderRelease = errors.New("older release")

var releaseVersion = regexp.MustCompile(`^\d+\.\d+\.\d+`)

func verifyHostCommand(c *cli.Context, name string, data []byte) error {
	if len(release.PublicKeys) == 0 || c.Env.AllowUnsignedCommands {
		return nil
	}
	manifest, err := c.KubectlOut("exec", "deploy/server", "--", "cat", "/app/hostbin/"+release.ManifestFile)
	if err != nil {
		return fmt.Errorf("the server image has no release manifest: %w", err)
	}
	signature, err := c.KubectlOut("exec", "deploy/server", "--", "cat", "/app/hostbin/"+release.SignatureFile)
	if err != nil {
		return fmt.Errorf("the server image has no release signature: %w", err)
	}
	m, err := release.Verify(release.PublicKeys, []byte(manifest), signature, name, data)
	if err != nil {
		return err
	}
	if releaseVersion.MatchString(release.Version) && versionLess(m.Version, release.Version) {
		return fmt.Errorf("%w: the image has %s, this host has %s", errOlderRelease, m.Version, release.Version)
	}
	return nil
}

func syncCommands(c *cli.Context) error {
	// The server image carries one binary per architecture; take the one that
	// matches this host rather than assuming amd64.
	name := fmt.Sprintf("orchardctl-linux-%s", runtime.GOARCH)
	remote := "/app/hostbin/" + name
	target := filepath.Join(c.Env.Bin, "orchardctl")

	out, err := c.KubectlOut("exec", "deploy/server", "--", "cat", remote)
	if err != nil {
		return fmt.Errorf("couldn't read %s from the server image: %w", remote, err)
	}
	data := []byte(out)

	// Validated before it replaces anything: an empty or truncated file here
	// leaves the host unmanageable.
	if len(data) < 1024 {
		return fmt.Errorf("refusing to install a %d byte orchardctl", len(data))
	}
	if !(data[0] == 0x7f && data[1] == 'E' && data[2] == 'L' && data[3] == 'F') {
		return fmt.Errorf("refusing to install orchardctl: not an ELF binary")
	}
	if err := verifyHostCommand(c, name, data); err != nil {
		if errors.Is(err, errOlderRelease) {
			c.Printf("keeping the current host commands: %s\n", err)
			return nil
		}
		return fmt.Errorf("refusing to install orchardctl: %w", err)
	}

	if current, err := os.ReadFile(target); err == nil && string(current) == string(data) {
		c.Printf("host commands already current\n")
		return nil
	}

	// Written beside the target and renamed, so a failure part-way through
	// leaves the working copy in place rather than a half-written one.
	tmp := target + ".new"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		os.Remove(tmp)
		return err
	}
	c.Printf("updated orchardctl\n")

	for _, alias := range Aliases {
		path := filepath.Join(c.Env.Bin, alias)
		os.Remove(path)
		if err := os.Symlink(target, path); err != nil {
			c.Warnf("couldn't link %s: %s\n", alias, err)
		}
	}
	return nil
}
