package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func deployAccessCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "access",
		Short: "Share one deployment with an organization member, without the rest of the project",
	}
	c.AddCommand(deployAccessListCmd(), deployAccessGrantCmd(), deployAccessRevokeCmd())
	return c
}

func deployAccessListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <id>",
		Aliases: []string{"ls"},
		Short:   "List who has been given access to a deployment",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "access"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, g := range asList(raw) {
				rows = append(rows, []string{pick(g, "email"), pick(g, "username"), pick(g, "role"), pick(g, "createdAt")})
			}
			output.Table([]string{"email", "username", "role", "since"}, rows)
			return nil
		},
	}
}

func deployAccessGrantCmd() *cobra.Command {
	var role string
	c := &cobra.Command{
		Use:   "grant <id> <email>",
		Short: "Give an organization member a role on this deployment only",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"email": args[1], "role": role}
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "access"), body, nil); err != nil {
				return err
			}
			output.Successf("gave %s %s access to %s", args[1], role, args[0])
			return nil
		},
	}
	c.Flags().StringVar(&role, "role", "member", "viewer (read only) or member (edit env, restart, logs, shell)")
	return c
}

func deployAccessRevokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <id> <email>",
		Short: "Remove a member's access to this deployment",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "access"), &raw); err != nil {
				return err
			}
			userID := ""
			for _, g := range asList(raw) {
				if strings.EqualFold(str(g["email"]), args[1]) {
					userID = str(g["userId"])
					break
				}
			}
			if userID == "" {
				return fmt.Errorf("%s has no access to %s", args[1], args[0])
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, deployPath(args[0], "access/"+url.PathEscape(userID)), nil, nil); err != nil {
				return err
			}
			output.Successf("removed %s from %s", args[1], args[0])
			return nil
		},
	}
}
