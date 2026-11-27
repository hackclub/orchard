package cmd

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

var imageUpdateBlockers = map[string]string{
	"no_image":    "the app has no image",
	"source":      "the app builds from source; redeploy it to pick up changes",
	"platform":    "the image was built by Orchard; redeploy to rebuild it",
	"digest":      "the image is pinned to a digest",
	"pull_policy": "the tag is pinned; set the pull policy to always to follow it",
}

func deployImageUpdateCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "image-update",
		Short: "Follow an image tag and update the app when it moves",
		Long: `Follow an image tag and update the app when it moves.

Orchard checks the registry for apps that run a moving tag (such as :latest or a
major tag like :2, with the pull policy Always) and reports when the tag points
at a newer image. Apply the update yourself, or turn on auto-update to restart
the app onto it as soon as it is found.`,
	}
	c.AddCommand(
		deployImageUpdateStatusCmd(),
		deployImageUpdateCheckCmd(),
		deployImageUpdateApplyCmd(),
		deployImageUpdateAutoCmd(),
	)
	return c
}

func imageUpdateRender(raw map[string]any) error {
	if fmtFlag() == output.FormatJSON {
		return output.JSON(raw)
	}
	tracked := pick(raw, "tracked") == "true"
	pairs := [][2]string{
		{"image", pick(raw, "image")},
		{"auto-update", pick(raw, "autoUpdate")},
	}
	if !tracked {
		reason := imageUpdateBlockers[pick(raw, "blocker")]
		if reason == "" {
			reason = pick(raw, "blocker")
		}
		pairs = append(pairs, [2]string{"tracked", "no: " + reason})
		output.KV(pairs)
		return nil
	}
	state := "up to date"
	switch {
	case pick(raw, "pending") == "true":
		state = "update rolling out"
	case pick(raw, "updateAvailable") == "true":
		state = "update available"
	case pick(raw, "checkedAt") == "":
		state = "not checked yet"
	}
	pairs = append(pairs, [2]string{"state", state})
	for _, opt := range [][2]string{
		{"running", shortDigest(pick(raw, "runningDigest"))},
		{"latest", shortDigest(pick(raw, "latestDigest"))},
		{"checked", pick(raw, "checkedAt")},
		{"last updated", pick(raw, "updatedAt")},
		{"error", pick(raw, "error")},
	} {
		if opt[1] != "" {
			pairs = append(pairs, opt)
		}
	}
	output.KV(pairs)
	return nil
}

func shortDigest(d string) string {
	d = strings.TrimPrefix(d, "sha256:")
	if len(d) > 12 {
		return d[:12]
	}
	return d
}

func deployImageUpdateStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status <id>",
		Short: "Show whether a newer image is available",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "image-update"), &raw); err != nil {
				return err
			}
			return imageUpdateRender(raw)
		},
	}
}

func deployImageUpdateCheckCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "check <id>",
		Short: "Ask the registry now instead of waiting for the next check",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "image-update", "check"), nil, &raw); err != nil {
				return err
			}
			return imageUpdateRender(raw)
		},
	}
}

func deployImageUpdateApplyCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "apply <id>",
		Short: "Restart the app onto the newest image for its tag",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "image-update"), nil, &raw); err != nil {
				return err
			}
			if fmtFlag() != output.FormatJSON {
				output.Successf("restarting %s onto the newest image", args[0])
			}
			return imageUpdateRender(raw)
		},
	}
}

func deployImageUpdateAutoCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "auto <id> on|off",
		Short: "Turn automatic updates on or off",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var enabled bool
			switch strings.ToLower(args[1]) {
			case "on", "true", "yes":
				enabled = true
			case "off", "false", "no":
				enabled = false
			default:
				return fmt.Errorf("expected on or off, got %q", args[1])
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			body := map[string]any{"autoUpdate": enabled}
			if err := cl.Send(cmd.Context(), http.MethodPatch, deployPath(args[0], "image-update"), body, &raw); err != nil {
				return err
			}
			if fmtFlag() != output.FormatJSON {
				if enabled {
					output.Successf("auto-update on for %s", args[0])
				} else {
					output.Successf("auto-update off for %s", args[0])
				}
			}
			return imageUpdateRender(raw)
		},
	}
}
