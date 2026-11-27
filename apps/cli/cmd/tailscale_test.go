package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// tailscaleTestRoot isolates config in a temp HOME and points the client at
// the given httptest server. tailscaleCmd() is registered explicitly until
// root.go wires it in; tailscaleTestRegister skips once it does.
func tailscaleTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	t.Setenv("ORCHARD_TS_AUTHKEY", "")
	t.Setenv("ORCHARD_TS_LOGIN_SERVER", "")
	root := rootCmd()
	tailscaleTestRegister(root, tailscaleCmd())
	return root
}

func tailscaleTestRegister(root *cobra.Command, c *cobra.Command) {
	for _, existing := range root.Commands() {
		if existing.Name() == c.Name() {
			return
		}
	}
	root.AddCommand(c)
}

func tailscaleDecodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Errorf("decode body: %v", err)
	}
	return m
}

func TestTailscaleStatus(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"linked":true,"tailnet":"tskey-auth-k1"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "status"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale status: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/tailscale/status" {
		t.Errorf("request = %s %s, want GET /apiv1/tailscale/status", gotMethod, gotPath)
	}
}

func TestTailscaleLinkFlagBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = tailscaleDecodeBody(t, r)
		io.WriteString(w, `{"tailnet":"k1"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "link", "--auth-key", "tskey-auth-abc"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale link: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/tailscale/link" {
		t.Errorf("request = %s %s, want POST /apiv1/tailscale/link", gotMethod, gotPath)
	}
	if gotBody["apiKey"] != "tskey-auth-abc" {
		t.Errorf("apiKey = %v, want tskey-auth-abc", gotBody["apiKey"])
	}
}

func TestTailscaleLinkOmitsLoginServerByDefault(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = tailscaleDecodeBody(t, r)
		io.WriteString(w, `{"tailnet":"k1"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "link", "--auth-key", "tskey-auth-abc"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale link: %v", err)
	}
	if _, ok := gotBody["loginServer"]; ok {
		t.Errorf("loginServer sent without --login-server: %v", gotBody["loginServer"])
	}
}

func TestTailscaleLinkLoginServerFlag(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = tailscaleDecodeBody(t, r)
		io.WriteString(w, `{"tailnet":"headscale.example.com","loginServer":"https://headscale.example.com"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "link", "--auth-key", "0123abcd", "--login-server", " https://headscale.example.com "})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale link: %v", err)
	}
	if gotBody["apiKey"] != "0123abcd" {
		t.Errorf("apiKey = %v, want 0123abcd", gotBody["apiKey"])
	}
	if gotBody["loginServer"] != "https://headscale.example.com" {
		t.Errorf("loginServer = %v, want https://headscale.example.com", gotBody["loginServer"])
	}
}

func TestTailscaleLinkLoginServerEnvFallback(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = tailscaleDecodeBody(t, r)
		io.WriteString(w, `{"tailnet":"headscale.example.com"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	t.Setenv("ORCHARD_TS_LOGIN_SERVER", "https://headscale.example.com")
	root.SetArgs([]string{"tailscale", "link", "--auth-key", "0123abcd"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale link: %v", err)
	}
	if gotBody["loginServer"] != "https://headscale.example.com" {
		t.Errorf("loginServer = %v, want https://headscale.example.com", gotBody["loginServer"])
	}
}

func TestTailscaleLinkEnvFallback(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = tailscaleDecodeBody(t, r)
		io.WriteString(w, `{"tailnet":"k1"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	t.Setenv("ORCHARD_TS_AUTHKEY", "tskey-auth-env")
	root.SetArgs([]string{"tailscale", "link"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale link: %v", err)
	}
	if gotBody["apiKey"] != "tskey-auth-env" {
		t.Errorf("apiKey = %v, want tskey-auth-env", gotBody["apiKey"])
	}
}

func TestTailscaleLinkStdin(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = tailscaleDecodeBody(t, r)
		io.WriteString(w, `{"tailnet":"k1"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetIn(strings.NewReader("tskey-auth-piped\n"))
	root.SetArgs([]string{"tailscale", "link"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale link: %v", err)
	}
	if gotBody["apiKey"] != "tskey-auth-piped" {
		t.Errorf("apiKey = %v, want tskey-auth-piped", gotBody["apiKey"])
	}
}

func TestTailscaleLinkNoKey(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetIn(strings.NewReader(""))
	root.SetArgs([]string{"tailscale", "link"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "--auth-key") {
		t.Fatalf("want a missing-key error, got %v", err)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestTailscaleUnlink(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"success":true}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "unlink", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale unlink: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/tailscale/unlink" {
		t.Errorf("request = %s %s, want DELETE /apiv1/tailscale/unlink", gotMethod, gotPath)
	}
}

func TestTailscaleUnlinkRefusesWithoutYes(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "unlink"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestTailscaleGet(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"exposed":true,"ip":"100.64.0.7","dns":"app.tail1234.ts.net","hostname":"app"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "get", "dep1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/tailscale/deployment/dep1" {
		t.Errorf("request = %s %s, want GET /apiv1/tailscale/deployment/dep1", gotMethod, gotPath)
	}
}

func TestTailscaleExpose(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"hostname":"app"}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "expose", "dep1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale expose: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/tailscale/expose/dep1" {
		t.Errorf("request = %s %s, want POST /apiv1/tailscale/expose/dep1", gotMethod, gotPath)
	}
}

func TestTailscaleUnexpose(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"success":true}`)
	}))
	defer srv.Close()

	root := tailscaleTestRoot(t, srv.URL)
	root.SetArgs([]string{"tailscale", "unexpose", "dep1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("tailscale unexpose: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/tailscale/unexpose/dep1" {
		t.Errorf("request = %s %s, want POST /apiv1/tailscale/unexpose/dep1", gotMethod, gotPath)
	}
}
