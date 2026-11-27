package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func serviceCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "service",
		GroupID: groupResources,
		Aliases: []string{"services", "svc"},
		Short:   "Manage deployment services and ports",
	}
	c.AddCommand(
		serviceListCmd(),
		serviceCreateCmd(),
		serviceUpdateCmd(),
		serviceDeleteCmd(),
		serviceExposureCmd(),
		servicePortCmd(),
	)
	return c
}

func serviceDeploymentFlag(c *cobra.Command, p *string) {
	c.Flags().StringVarP(p, "deployment", "d", "", "deployment id")
}

func serviceDeployment(v string) (string, error) {
	if v == "" {
		return "", &exitcode.UsageError{Err: errors.New("--deployment is required")}
	}
	return v, nil
}

func servicesPath(deployment string, segments ...string) string {
	p := "/deployments/" + url.PathEscape(deployment) + "/services"
	for _, s := range segments {
		p += "/" + url.PathEscape(s)
	}
	return p
}

func serviceListCmd() *cobra.Command {
	var deployment string
	c := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List services for a deployment",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			dep, err := serviceDeployment(deployment)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			// services come embedded in the deployment; there is no
			// GET /deployments/:id/services endpoint.
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/deployments/"+url.PathEscape(dep), &raw); err != nil {
				return err
			}
			svcs := raw["services"]
			if svcs == nil {
				svcs = []any{}
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(svcs)
			}
			rows := [][]string{}
			for _, s := range asList(svcs) {
				rows = append(rows, []string{
					pick(s, "id"),
					pick(s, "name"),
					servicePortsCell(s),
					serviceExposureCell(s),
				})
			}
			output.Table([]string{"id", "name", "ports", "exposure"}, rows)
			return nil
		},
	}
	serviceDeploymentFlag(c, &deployment)
	return c
}

func servicePortsCell(svc map[string]any) string {
	entries := asList(svc["ports"])
	if len(entries) == 0 {
		// legacy shape: a single port flattened onto the service itself
		entries = []map[string]any{svc}
	}
	parts := []string{}
	for _, p := range entries {
		sp := pick(p, "port", "servicePort")
		tp := pick(p, "targetPort", "containerPort")
		if sp == "" && tp == "" {
			continue
		}
		s := sp + "->" + tp
		if proto := pick(p, "protocol"); proto != "" {
			s += "/" + proto
		}
		if pick(p, "publicEnabled") == "true" {
			if pub := pick(p, "publicPort", "nodePort"); pub != "" {
				s += " (public:" + pub + ")"
			} else {
				s += " (public)"
			}
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, ", ")
}

func serviceExposureCell(svc map[string]any) string {
	exp := pick(svc, "type")
	if exp == "" {
		exp = "internal"
	}
	if d := pick(svc, "domain"); d != "" {
		exp += " " + d
	}
	return exp
}

func serviceCreateCmd() *cobra.Command {
	var (
		deployment string
		name       string
		port       int
		targetPort int
		protocol   string
		nodePort   int
		public     bool
		domain     string
	)
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a service exposing a port on a deployment",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			dep, err := serviceDeployment(deployment)
			if err != nil {
				return err
			}
			if port <= 0 {
				return &exitcode.UsageError{Err: errors.New("--port is required and must be positive")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if targetPort <= 0 {
				targetPort = port
			}
			if name == "" {
				name = fmt.Sprintf("port-%d", port)
			}
			p := map[string]any{
				"servicePort":   port,
				"containerPort": targetPort,
				"protocol":      strings.ToUpper(protocol),
			}
			if nodePort > 0 {
				p["nodePort"] = nodePort
			}
			body := map[string]any{
				"name":         name,
				"ports":        []any{p},
				"exposePublic": public,
			}
			if cmd.Flags().Changed("domain") {
				body["domain"] = domain
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, servicesPath(dep), body, nil); err != nil {
				return err
			}
			output.Successf("created service %s on deployment %s", name, dep)
			return nil
		},
	}
	serviceDeploymentFlag(c, &deployment)
	c.Flags().StringVar(&name, "name", "", "service name (default: port-<port>)")
	c.Flags().IntVar(&port, "port", 0, "service port (required)")
	c.Flags().IntVar(&targetPort, "target-port", 0, "container port to route to (default: --port)")
	c.Flags().StringVar(&protocol, "protocol", "TCP", "port protocol (TCP|UDP)")
	c.Flags().IntVar(&nodePort, "node-port", 0, "explicit public port")
	c.Flags().BoolVar(&public, "public", false, "expose the service publicly")
	c.Flags().StringVar(&domain, "domain", "", "custom domain for the service")
	return c
}

func serviceUpdateCmd() *cobra.Command {
	var (
		deployment string
		port       int
		targetPort int
		protocol   string
		nodePort   int
		domain     string
	)
	c := &cobra.Command{
		Use:   "update <service-id>",
		Short: "Update a service's ports or domain",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dep, err := serviceDeployment(deployment)
			if err != nil {
				return err
			}
			body := map[string]any{}
			if cmd.Flags().Changed("port") || cmd.Flags().Changed("target-port") {
				if targetPort <= 0 {
					targetPort = port
				}
				if port <= 0 {
					port = targetPort
				}
				if port <= 0 {
					return &exitcode.UsageError{Err: errors.New("--port/--target-port must be positive")}
				}
				p := map[string]any{
					"servicePort":   port,
					"containerPort": targetPort,
					"protocol":      strings.ToUpper(protocol),
				}
				if nodePort > 0 {
					p["nodePort"] = nodePort
				}
				body["ports"] = []any{p}
			}
			if cmd.Flags().Changed("domain") {
				if domain == "" {
					body["domain"] = nil
				} else {
					body["domain"] = domain
				}
			}
			if len(body) == 0 {
				return &exitcode.UsageError{Err: errors.New("nothing to update: pass --port and/or --domain")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPut, servicesPath(dep, args[0]), body, nil); err != nil {
				return err
			}
			output.Successf("updated service %s", args[0])
			return nil
		},
	}
	serviceDeploymentFlag(c, &deployment)
	c.Flags().IntVar(&port, "port", 0, "service port")
	c.Flags().IntVar(&targetPort, "target-port", 0, "container port to route to (default: --port)")
	c.Flags().StringVar(&protocol, "protocol", "TCP", "port protocol (TCP|UDP)")
	c.Flags().IntVar(&nodePort, "node-port", 0, "explicit public port")
	c.Flags().StringVar(&domain, "domain", "", "custom domain for the service (empty clears it)")
	return c
}

func serviceDeleteCmd() *cobra.Command {
	var deployment string
	c := &cobra.Command{
		Use:     "delete <service-id>",
		Aliases: []string{"rm"},
		Short:   "Delete a service from a deployment",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dep, err := serviceDeployment(deployment)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := output.Confirm(fmt.Sprintf("delete service %s from deployment %s (its ports stop routing traffic)", args[0], dep), yesFlag); err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, servicesPath(dep, args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted service %s", args[0])
			return nil
		},
	}
	serviceDeploymentFlag(c, &deployment)
	return c
}

func serviceExposureCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "exposure",
		Short: "Manage service exposure",
	}
	c.AddCommand(serviceExposureSetCmd())
	return c
}

func serviceExposureSetCmd() *cobra.Command {
	var deployment string
	c := &cobra.Command{
		Use:   "set <service-id> <public|internal>",
		Short: "Switch a service between public and internal",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var expose bool
			switch strings.ToLower(args[1]) {
			case "public", "external":
				expose = true
			case "internal", "private":
				expose = false
			default:
				return &exitcode.UsageError{Err: fmt.Errorf("exposure must be public or internal, got %q", args[1])}
			}
			dep, err := serviceDeployment(deployment)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"exposePublic": expose}
			if err := cl.Send(cmd.Context(), http.MethodPatch, servicesPath(dep, args[0])+"/exposure", body, nil); err != nil {
				return err
			}
			output.Successf("service %s is now %s", args[0], strings.ToLower(args[1]))
			return nil
		},
	}
	serviceDeploymentFlag(c, &deployment)
	return c
}

func servicePortCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "port",
		Short: "Manage individual service ports",
	}
	c.AddCommand(servicePortPublicCmd())
	return c
}

func servicePortPublicCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "public",
		Short: "Toggle public exposure of a single service port",
	}
	c.AddCommand(servicePortPublicEnableCmd(), servicePortPublicDisableCmd())
	return c
}

func servicePortPublicEnableCmd() *cobra.Command {
	var deployment string
	var preserveClientIP bool
	c := &cobra.Command{
		Use:   "enable <service-id> <port-id>",
		Short: "Expose a single service port publicly",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			dep, err := serviceDeployment(deployment)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var body any
			if cmd.Flags().Changed("preserve-client-ip") {
				body = map[string]any{"preserveClientIp": preserveClientIP}
			}
			var res map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, servicesPath(dep, args[0], "ports", args[1], "public"), body, &res); err != nil {
				return err
			}
			if host, port := pick(res, "host"), pick(res, "port"); host != "" && port != "" {
				output.Successf("port %s publicly reachable at %s:%s", args[1], host, port)
			} else {
				output.Successf("enabled public exposure for port %s", args[1])
			}
			return nil
		},
	}
	serviceDeploymentFlag(c, &deployment)
	c.Flags().BoolVar(&preserveClientIP, "preserve-client-ip", false, "let the app see real client addresses; only nodes running a replica serve the port")
	return c
}

func servicePortPublicDisableCmd() *cobra.Command {
	var deployment string
	c := &cobra.Command{
		Use:   "disable <service-id> <port-id>",
		Short: "Stop exposing a single service port publicly",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			dep, err := serviceDeployment(deployment)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, servicesPath(dep, args[0], "ports", args[1], "public"), nil, nil); err != nil {
				return err
			}
			output.Successf("disabled public exposure for port %s", args[1])
			return nil
		},
	}
	serviceDeploymentFlag(c, &deployment)
	return c
}
