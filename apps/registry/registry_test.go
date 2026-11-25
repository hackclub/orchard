package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeObject struct {
	body         []byte
	contentType  string
	modified     time.Time
	cacheControl string
	disposition  string
}

type fakeS3 struct {
	mu      sync.Mutex
	objects map[string]fakeObject
	puts    int
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") == "" || r.Header.Get("x-amz-date") == "" {
		http.Error(w, "unsigned", http.StatusForbidden)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	key := strings.TrimPrefix(r.URL.Path, "/bucket/")
	if r.URL.Path == "/bucket/" && r.URL.Query().Get("list-type") == "2" {
		prefix := r.URL.Query().Get("prefix")
		type contents struct {
			Key          string `xml:"Key"`
			ETag         string `xml:"ETag"`
			Size         int64  `xml:"Size"`
			LastModified string `xml:"LastModified"`
		}
		var out struct {
			XMLName  xml.Name   `xml:"ListBucketResult"`
			Contents []contents `xml:"Contents"`
		}
		var keys []string
		for k := range f.objects {
			if strings.HasPrefix(k, prefix) {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			o := f.objects[k]
			out.Contents = append(out.Contents, contents{k, md5ETag(o.body), int64(len(o.body)), o.modified.Format(time.RFC3339Nano)})
		}
		xml.NewEncoder(w).Encode(out)
		return
	}
	switch r.Method {
	case http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		f.objects[key] = fakeObject{body, r.Header.Get("Content-Type"), time.Now(), r.Header.Get("Cache-Control"), r.Header.Get("Content-Disposition")}
		f.puts++
		w.Header().Set("ETag", md5ETag(body))
		w.WriteHeader(http.StatusOK)
	case http.MethodGet, http.MethodHead:
		o, ok := f.objects[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		etag := md5ETag(o.body)
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Type", o.contentType)
		if o.disposition != "" {
			w.Header().Set("Content-Disposition", o.disposition)
		}
		w.Header().Set("Last-Modified", o.modified.UTC().Format(http.TimeFormat))
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		if rng := r.Header.Get("Range"); rng != "" && strings.HasPrefix(rng, "bytes=0-") {
			end := 3
			w.Header().Set("Content-Range", "bytes 0-3/"+itoa(len(o.body)))
			w.Header().Set("Content-Length", "4")
			w.WriteHeader(http.StatusPartialContent)
			if r.Method == http.MethodGet {
				w.Write(o.body[:end+1])
			}
			return
		}
		w.Header().Set("Content-Length", itoa(len(o.body)))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			w.Write(o.body)
		}
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

const ghostYAML = `apiVersion: leaf/v1
kind: Template
metadata:
  name: ghost
  displayName: Ghost Blog
  description: A blog.
  version: '1.0.0'
  category: cms
  tags: ['blog']
  keywords: ['writing', 'posts']
  author: LeafdTK
parameters:
  - name: appName
    type: string
    default: ghost
  - name: domain
    type: string
    placeholder: blog.example.com
resources:
  - name: app
    type: deployment
    config:
      name: '{{ params.appName }}'
      image: ghost:5
      resources: {cpu: 500m, memory: 1Gi}
  - name: web
    type: ingress
    config:
      host: '{{ params.domain }}'
`

const redisYAML = `apiVersion: leaf/v1
kind: Template
metadata:
  name: redis
  version: '2.1.0'
resources:
  - name: cache
    type: deployment
    config:
      image: redis:7
      resources: {cpu: 250m, memory: 512Mi}
`

func setup(t *testing.T) (*fakeS3, *Bucket, string, string) {
	t.Helper()
	fake := &fakeS3{objects: map[string]fakeObject{}}
	ts := httptest.NewServer(fake)
	t.Cleanup(ts.Close)
	bucket := &Bucket{Endpoint: ts.URL, Region: "auto", Name: "bucket", AccessKey: "ak", SecretKey: "sk", Client: ts.Client()}
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("ghost.yaml", ghostYAML)
	write("redis.yaml", redisYAML)
	extras := t.TempDir()
	os.WriteFile(filepath.Join(extras, "ghost.md"), []byte("# Ghost\n"), 0o644)
	os.WriteFile(filepath.Join(extras, "ghost.png"), []byte("png"), 0o644)
	return fake, bucket, dir, extras
}

func newPublisher(bucket *Bucket) *publisher {
	return &publisher{bucket: bucket, version: "0.3.0", now: func() time.Time { return time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC) }, log: log.New(io.Discard, "", 0)}
}

func TestPublishBuildsIndexesAndRefusesMutation(t *testing.T) {
	fake, bucket, dir, extras := setup(t)
	dirs := []string{dir, extras}
	files := t.TempDir()
	os.WriteFile(filepath.Join(files, "install.sh"), []byte("#!/bin/sh\necho hi\n"), 0o644)
	os.MkdirAll(filepath.Join(files, ".git"), 0o755)
	os.WriteFile(filepath.Join(files, ".git", "HEAD"), []byte("ref"), 0o644)

	p := newPublisher(bucket)
	cat, err := p.run(context.Background(), dirs, files)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Templates) != 2 || cat.Templates[0].Name != "ghost" || cat.Templates[1].Name != "redis" {
		t.Fatalf("unexpected catalogue %+v", cat.Templates)
	}
	ghost := cat.Templates[0]
	if ghost.Yaml != "templates/ghost/1.0.0/template.yaml" || ghost.Readme != "templates/ghost/1.0.0/README.md" || ghost.Preview != "templates/ghost/1.0.0/preview.png" || ghost.Author != "LeafdTK" {
		t.Fatalf("ghost entry wrong: %+v", ghost)
	}
	if ghost.SHA256 != sha256Hex([]byte(ghostYAML)) {
		t.Fatal("sha256 mismatch")
	}
	if len(ghost.Keywords) != 2 || ghost.Keywords[0] != "writing" || len(cat.Templates[1].Keywords) != 0 {
		t.Fatalf("keywords wrong: %v / %v", ghost.Keywords, cat.Templates[1].Keywords)
	}
	if len(ghost.Resources) != 2 || ghost.Resources[0].Detail != "ghost:5" || ghost.Resources[1].Detail != "blog.example.com" {
		t.Fatalf("resource summary wrong: %+v", ghost.Resources)
	}
	if cat.Templates[1].DisplayName != "redis" || cat.Templates[1].Version != "2.1.0" {
		t.Fatalf("redis entry wrong: %+v", cat.Templates[1])
	}
	for _, key := range []string{
		"templates/index.json", "templates/ghost/index.json", "templates/ghost/1.0.0/template.yaml",
		"templates/ghost/1.0.0/README.md", "templates/ghost/1.0.0/template.json", "templates/redis/2.1.0/template.yaml", "install.sh",
		"templates/ghost/latest/template.yaml", "templates/ghost/latest/README.md", "templates/redis/latest/template.yaml",
	} {
		if _, ok := fake.objects[key]; !ok {
			t.Errorf("missing %s", key)
		}
	}
	if _, ok := fake.objects[".git/HEAD"]; ok {
		t.Error("dotfiles must not be synced")
	}
	if fake.objects["install.sh"].contentType != "text/x-shellscript; charset=utf-8" {
		t.Errorf("install.sh content type %q", fake.objects["install.sh"].contentType)
	}

	var parsed templateJSON
	json.Unmarshal(fake.objects["templates/ghost/1.0.0/template.json"].body, &parsed)
	if parsed.DisplayName != "Ghost Blog" || len(parsed.Parameters) != 2 || parsed.Parameters[0]["default"] != "ghost" || parsed.Resources[0].Type != "deployment" {
		t.Fatalf("template.json wrong: %+v", parsed)
	}

	puts := fake.puts
	if _, err := p.run(context.Background(), dirs, files); err != nil {
		t.Fatal(err)
	}
	if fake.puts != puts {
		t.Fatalf("republishing identical content uploaded %d objects", fake.puts-puts)
	}

	os.WriteFile(filepath.Join(dir, "ghost.yaml"), []byte(strings.Replace(ghostYAML, "ghost:5", "ghost:6", 1)), 0o644)
	if _, err := p.run(context.Background(), []string{dir}, ""); err == nil || !strings.Contains(err.Error(), "bump metadata.version") {
		t.Fatalf("expected immutability error, got %v", err)
	}

	os.WriteFile(filepath.Join(dir, "ghost.yaml"), []byte(strings.NewReplacer("ghost:5", "ghost:6", "'1.0.0'", "'1.1.0'").Replace(ghostYAML)), 0o644)
	later := &publisher{bucket: bucket, now: func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }, log: p.log}
	cat, err = later.run(context.Background(), []string{dir}, "")
	if err != nil {
		t.Fatal(err)
	}
	if cat.Templates[0].Version != "1.1.0" {
		t.Fatalf("latest should be 1.1.0, got %s", cat.Templates[0].Version)
	}
	var idx templateIndex
	json.Unmarshal(fake.objects["templates/ghost/index.json"].body, &idx)
	if idx.Latest != "1.1.0" || len(idx.Versions) != 2 || idx.Versions[1].PublishedAt != "2026-09-28T12:00:00Z" {
		t.Fatalf("name index wrong: %+v", idx)
	}
	if latest := fake.objects["templates/ghost/latest/template.yaml"]; !strings.Contains(string(latest.body), "ghost:6") || latest.cacheControl != cacheIndex {
		t.Fatalf("latest alias should follow 1.1.0 with a short cache, got %q (%s)", latest.body, latest.cacheControl)
	}
}

func TestValidationErrors(t *testing.T) {
	cases := map[string]string{
		"metadata:\n  name: Bad Name\n  version: 1.0.0\nresources:\n  - {name: a, type: deployment, config: {}}\n":                                      "metadata.name",
		"metadata:\n  name: ok\nresources:\n  - {name: a, type: deployment, config: {}}\n":                                                              "metadata.version is required",
		"metadata:\n  name: ok\n  version: v1\nresources:\n  - {name: a, type: deployment, config: {}}\n":                                               "semantic version",
		"metadata:\n  name: ok\n  version: 1.0.0\n":                                                                                                     "at least one resource",
		"metadata:\n  name: ok\n  version: 1.0.0\nresources:\n  - {name: a, type: cronjob, config: {}}\n":                                               "unknown type",
		"metadata:\n  name: ok\n  version: 1.0.0\n  author: 'not a login'\nresources:\n  - {name: a, type: deployment, config: {}}\n":                   "GitHub login",
		"metadata:\n  name: ok\n  version: 1.0.0\nparameters:\n  - {name: x}\n  - {name: x}\nresources:\n  - {name: a, type: deployment, config: {}}\n": "defined twice",
		"metadata:\n  name: ok\n  version: 1.0.0\nresources:\n  - {name: a, type: deployment, config: {image: x}}\n":                                    "needs recommended resources",
		"metadata:\n  name: ok\n  version: 1.0.0\nresources:\n  - {name: a, type: database, config: {resources: {cpu: 1}}}\n":                           "resources.memory is required",
		"metadata:\n  name: ok\n  version: 1.0.0\nresources:\n  - {name: a, type: deployment, config: {resources: {cpu: lots, memory: 1Gi}}}\n":         "not a valid size",
		"metadata:\n  name: ok\n  version: 1.0.0\nresources:\n  - {name: a, type: deployment, config: {resources: {cpu: 1, memory: 1Gi, gpu: 1}}}\n":    "unknown field",
	}
	for _, image := range []string{"redis", "redis:latest", "localhost:5000/redis", "ghcr.io/a/b:latest"} {
		body := "metadata:\n  name: ok\n  version: 1.0.0\nresources:\n  - {name: a, type: deployment, config: {image: '" + image + "', resources: {cpu: 1, memory: 1Gi}}}\n"
		cases[body] = "must pin a version"
	}
	for _, image := range []string{"redis:7", "localhost:5000/redis:7.2", "redis@sha256:abc", "{{ params.image }}"} {
		body := "metadata:\n  name: ok\n  version: 1.0.0\nresources:\n  - {name: a, type: deployment, config: {image: '" + image + "', resources: {cpu: 1, memory: 1Gi}}}\n"
		if _, err := parseTemplate([]byte(body)); err != nil {
			t.Errorf("%q: expected no error, got %v", image, err)
		}
	}
	for body, want := range cases {
		if _, err := parseTemplate([]byte(body)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: expected error containing %q, got %v", body, want, err)
		}
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "wrong.yaml"), []byte(redisYAML), 0o644)
	if _, err := loadTemplates([]string{dir}); err == nil || !strings.Contains(err.Error(), "must be named redis.yaml") {
		t.Errorf("expected filename mismatch error, got %v", err)
	}
}

func TestLoginFor(t *testing.T) {
	authors := map[string]string{"hi@leafd.dev": "LeafdTK"}
	cases := map[string]string{
		"hi@leafd.dev":                           "LeafdTK",
		"HI@leafd.dev":                           "LeafdTK",
		"12345+octocat@users.noreply.github.com": "octocat",
		"octocat@users.noreply.github.com":       "octocat",
		"someone@example.com":                    "",
	}
	for email, want := range cases {
		if got := loginFor(email, authors); got != want {
			t.Errorf("%s: want %q, got %q", email, want, got)
		}
	}
}

func TestAddedByFromGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Octo Cat", "GIT_AUTHOR_EMAIL=1+octocat@users.noreply.github.com", "GIT_COMMITTER_NAME=Octo Cat", "GIT_COMMITTER_EMAIL=1+octocat@users.noreply.github.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	os.WriteFile(filepath.Join(dir, "ghost.yaml"), []byte(ghostYAML), 0o644)
	run("add", ".")
	run("-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat(templates): add ghost")
	os.WriteFile(filepath.Join(dir, "ghost.yaml"), []byte(ghostYAML+"# edit\n"), 0o644)
	run("-c", "commit.gpgsign=false", "-c", "user.name=Someone Else", "-c", "user.email=else@example.com", "commit", "-qam", "chore: touch")

	wd, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(wd)
	p := &publisher{git: true, authors: map[string]string{}}
	added := p.addedBy("ghost.yaml")
	if added == nil || added.person.Login != "octocat" || added.person.Name != "Octo Cat" || added.at == "" {
		t.Fatalf("addedBy wrong: %+v", added)
	}
	if (&publisher{}).addedBy("ghost.yaml") != nil {
		t.Fatal("without -git nothing should be recorded")
	}
}

func TestIconFetchPrefersTouchIconThenManifest(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(`<html><head><link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="32x32" href="/small.png"><link rel="manifest" href="/site.webmanifest"></head></html>`))
		case "/site.webmanifest":
			w.Header().Set("Content-Type", "application/manifest+json")
			w.Write([]byte(`{"icons":[{"src":"/android-chrome-512x512.png","sizes":"512x512","type":"image/png"}]}`))
		case "/android-chrome-512x512.png":
			w.Header().Set("Content-Type", "image/png")
			w.Write([]byte(strings.Repeat("m", 100)))
		case "/apple-touch-icon.png":
			w.Header().Set("Content-Type", "image/png")
			w.Write([]byte(strings.Repeat("t", 100)))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer site.Close()
	f := &IconFetcher{Source: site.URL + "/nope?domain=%s", Client: site.Client()}
	icon, err := f.Fetch(context.Background(), "", site.URL+"/")
	if err != nil || string(icon.Body) != strings.Repeat("m", 100) {
		t.Fatalf("expected the 512px manifest icon, got %v %q", err, icon)
	}
	icon, err = f.Fetch(context.Background(), site.URL+"/apple-touch-icon.png", site.URL+"/")
	if err != nil || string(icon.Body) != strings.Repeat("t", 100) {
		t.Fatalf("an explicit icon url must win, got %v", err)
	}
}

func TestPublishFetchesIcons(t *testing.T) {
	fake, bucket, dir, extras := setup(t)
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Write([]byte(strings.Repeat("g", 100)))
	}))
	defer fallback.Close()
	os.WriteFile(filepath.Join(dir, "ghost.yaml"), []byte(strings.Replace(ghostYAML, "author: LeafdTK", "author: LeafdTK\n  homepage: https://127.0.0.1:1/", 1)), 0o644)
	os.WriteFile(filepath.Join(dir, "redis.yaml"), []byte(strings.Replace(redisYAML, "version: '2.1.0'", "version: '2.1.0'\n  homepage: https://127.0.0.1:1/", 1)), 0o644)
	os.WriteFile(filepath.Join(extras, "redis.icon.png"), []byte(strings.Repeat("r", 100)), 0o644)
	p := newPublisher(bucket)
	p.icons = &IconFetcher{Source: fallback.URL + "/favicon?domain=%s", Client: &http.Client{Timeout: 2 * time.Second}}
	cat, err := p.run(context.Background(), []string{dir, extras}, "")
	if err != nil {
		t.Fatal(err)
	}
	if cat.Templates[0].IconUrl != "templates/ghost/1.0.0/icon.svg" || string(fake.objects["templates/ghost/1.0.0/icon.svg"].body) != strings.Repeat("g", 100) {
		t.Fatalf("ghost should fall back to the service and keep the svg name, got %q", cat.Templates[0].IconUrl)
	}
	if cat.Templates[1].IconUrl != "templates/redis/2.1.0/icon.png" || string(fake.objects["templates/redis/2.1.0/icon.png"].body) != strings.Repeat("r", 100) {
		t.Fatalf("redis sidecar icon should win: %+v", cat.Templates[1].IconUrl)
	}
	for _, key := range []string{"templates/ghost/1.0.0/icon.svg", "templates/ghost/latest/icon.svg"} {
		if got := fake.objects[key].disposition; got != "attachment" {
			t.Errorf("%s stored with disposition %q, want attachment", key, got)
		}
	}
	if got := fake.objects["templates/redis/2.1.0/icon.png"].disposition; got != "" {
		t.Errorf("png icon should stay inline, got %q", got)
	}
}

func TestPublishRepairsAnSvgStoredInline(t *testing.T) {
	fake, bucket, dir, extras := setup(t)
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	os.WriteFile(filepath.Join(extras, "redis.svg"), svg, 0o644)
	fake.objects["templates/redis/2.1.0/icon.svg"] = fakeObject{body: svg, contentType: "image/svg+xml", modified: time.Now()}
	if _, err := newPublisher(bucket).run(context.Background(), []string{dir, extras}, ""); err != nil {
		t.Fatalf("same bytes with new metadata must not count as editing a released version: %v", err)
	}
	if got := fake.objects["templates/redis/2.1.0/icon.svg"].disposition; got != "attachment" {
		t.Fatalf("published svg kept disposition %q", got)
	}
	puts := fake.puts
	if _, err := newPublisher(bucket).run(context.Background(), []string{dir, extras}, ""); err != nil {
		t.Fatal(err)
	}
	if fake.puts != puts {
		t.Fatalf("a second publish should upload nothing, uploaded %d", fake.puts-puts)
	}
}

func TestIconCandidatesPreferLargeAndSvg(t *testing.T) {
	base, _ := url.Parse("https://example.com/docs/")
	html := `<link rel="shortcut icon" href="/favicon.ico"><link rel="icon" sizes="16x16" href="s.png"><link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="apple-touch-icon" href="../touch.png"><link rel="manifest" href="/m.json">`
	cands, manifests := iconCandidates(base, html)
	got := pick(cands)
	if len(got) != 4 || got[0].href != "https://example.com/logo.svg" || got[1].href != "https://example.com/touch.png" {
		t.Fatalf("unexpected order: %+v", got)
	}
	if len(manifests) != 1 || manifests[0] != "https://example.com/m.json" {
		t.Fatalf("manifest not found: %v", manifests)
	}
}

func TestCompareSemver(t *testing.T) {
	ordered := []string{"0.9.0", "1.0.0-beta", "1.0.0", "1.0.10", "1.2.0", "2.0.0"}
	for i := 1; i < len(ordered); i++ {
		if compareSemver(ordered[i-1], ordered[i]) >= 0 {
			t.Errorf("%s should sort before %s", ordered[i-1], ordered[i])
		}
	}
}

func TestServe(t *testing.T) {
	fake, bucket, dir, extras := setup(t)
	if _, err := newPublisher(bucket).run(context.Background(), []string{dir, extras}, ""); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newServer(bucket, ""))
	defer srv.Close()
	get := func(path string, headers map[string]string) *http.Response {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := srv.Client().Transport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp
	}

	root := get("/", nil)
	if root.StatusCode != 200 || root.Header.Get("Cache-Control") != cacheIndex || root.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("root: %d %v", root.StatusCode, root.Header)
	}
	var cat catalog
	json.NewDecoder(root.Body).Decode(&cat)
	if len(cat.Templates) != 2 || cat.Version != "0.3.0" {
		t.Fatalf("root index wrong: %d templates, version %q", len(cat.Templates), cat.Version)
	}

	if resp := get("/templates/ghost", nil); resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("name index: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	yamlResp := get("/templates/ghost/1.0.0/template.yaml", nil)
	if yamlResp.StatusCode != 200 || yamlResp.Header.Get("Cache-Control") != cacheImmutable || yamlResp.Header.Get("ETag") == "" {
		t.Fatalf("versioned: %d %v", yamlResp.StatusCode, yamlResp.Header)
	}
	if !strings.HasPrefix(yamlResp.Header.Get("Content-Type"), "application/yaml") {
		t.Fatalf("yaml content type %q", yamlResp.Header.Get("Content-Type"))
	}
	body, _ := io.ReadAll(yamlResp.Body)
	if string(body) != ghostYAML {
		t.Fatal("yaml body mismatch")
	}

	if resp := get("/templates/ghost/1.0.0/template.yaml", map[string]string{"If-None-Match": yamlResp.Header.Get("ETag")}); resp.StatusCode != 304 {
		t.Fatalf("conditional get: %d", resp.StatusCode)
	}

	latest := get("/templates/ghost/latest/template.yaml", nil)
	if latest.StatusCode != 302 || latest.Header.Get("Location") != "/templates/ghost/1.0.0/template.yaml" {
		t.Fatalf("latest: %d %s", latest.StatusCode, latest.Header.Get("Location"))
	}
	prefixed := get("/templates/ghost/latest/template.yaml", map[string]string{"X-Forwarded-Prefix": "/registry"})
	if prefixed.Header.Get("Location") != "/templates/ghost/1.0.0/template.yaml" {
		t.Fatalf("forwarded prefix must be ignored: %s", prefixed.Header.Get("Location"))
	}
	for _, h := range []string{"X-Forwarded-Prefix", "X-Forwarded-Host", "Host", "X-Forwarded-Proto"} {
		poisoned := get("/templates/ghost/latest/template.yaml", map[string]string{h: "//evil.example"})
		if poisoned.Header.Get("Location") != "/templates/ghost/1.0.0/template.yaml" {
			t.Fatalf("%s leaked into the redirect: %s", h, poisoned.Header.Get("Location"))
		}
	}
	if cc := latest.Header.Get("Cache-Control"); cc != cacheIndex {
		t.Fatalf("latest cache-control: %q", cc)
	}

	if resp := get("/templates/ghost/1.0.0/template.yaml", map[string]string{"Range": "bytes=0-3"}); resp.StatusCode != 206 || resp.Header.Get("Content-Range") == "" {
		t.Fatalf("range: %d %v", resp.StatusCode, resp.Header)
	}

	for _, p := range []string{"/../secret", "/templates/../x", "/.env", "/templates//x"} {
		if resp := get(p, nil); resp.StatusCode != 404 {
			t.Errorf("%s: expected 404, got %d", p, resp.StatusCode)
		}
	}
	if resp := get("/templates/nope", nil); resp.StatusCode != 404 {
		t.Errorf("missing template: %d", resp.StatusCode)
	}
	if resp := get("/templates/nope/latest/template.yaml", nil); resp.StatusCode != 404 {
		t.Errorf("missing latest: %d", resp.StatusCode)
	}

	before := len(fake.objects)
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/templates/x.yaml", strings.NewReader("x"))
	if resp, _ := srv.Client().Do(req); resp.StatusCode != 405 || len(fake.objects) != before {
		t.Errorf("put should be refused, got %d", resp.StatusCode)
	}

	options, _ := http.NewRequest(http.MethodOptions, srv.URL+"/templates/index.json", nil)
	if resp, _ := srv.Client().Do(options); resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Methods") == "" {
		t.Errorf("preflight: %d", resp.StatusCode)
	}
}
