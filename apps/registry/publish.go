package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

var (
	cpuQuantityRe    = regexp.MustCompile(`^\d+(\.\d+)?m?$`)
	memoryQuantityRe = regexp.MustCompile(`^\d+(\.\d+)?(Ki|Mi|Gi|Ti|K|M|G|T)$`)
	semverRe         = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$`)
	githubRe         = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`)
	resourceOK       = map[string]bool{"deployment": true, "database": true, "ingress": true}
)

type templateDoc struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Metadata   struct {
		Name        string   `yaml:"name"`
		DisplayName string   `yaml:"displayName"`
		Description string   `yaml:"description"`
		Icon        string   `yaml:"icon"`
		Version     string   `yaml:"version"`
		Category    string   `yaml:"category"`
		Tags        []string `yaml:"tags"`
		Keywords    []string `yaml:"keywords"`
		Author      string   `yaml:"author"`
		Homepage    string   `yaml:"homepage"`
		License     string   `yaml:"license"`
	} `yaml:"metadata"`
	Parameters []map[string]any `yaml:"parameters"`
	Resources  []struct {
		Name   string         `yaml:"name"`
		Type   string         `yaml:"type"`
		Config map[string]any `yaml:"config"`
	} `yaml:"resources"`
}

type resourceSummary struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Detail string `json:"detail,omitempty"`
}

var exprRe = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}`)

func (d templateDoc) paramHint(name string) string {
	for _, p := range d.Parameters {
		if n, _ := p["name"].(string); n != name {
			continue
		}
		for _, key := range []string{"default", "placeholder"} {
			switch v := p[key].(type) {
			case string:
				if v != "" {
					return v
				}
			case int, int64, float64, bool:
				return fmt.Sprint(v)
			}
		}
		return "<" + name + ">"
	}
	return "<" + name + ">"
}

func (d templateDoc) resolveHint(value any) string {
	text, ok := value.(string)
	if !ok {
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
	return exprRe.ReplaceAllStringFunc(text, func(m string) string {
		expr := exprRe.FindStringSubmatch(m)[1]
		if strings.HasPrefix(expr, "params.") {
			return d.paramHint(strings.TrimPrefix(expr, "params."))
		}
		if strings.HasPrefix(expr, "resources.") {
			parts := strings.Split(expr, ".")
			if len(parts) == 3 {
				return "<" + parts[1] + "." + parts[2] + ">"
			}
		}
		return m
	})
}

func (d templateDoc) resourceDetail(kind string, config map[string]any) string {
	switch kind {
	case "deployment":
		if image := d.resolveHint(config["image"]); image != "" {
			return image
		}
		for _, key := range []string{"repo", "githubRepo", "repoUrl"} {
			if repo := d.resolveHint(config[key]); repo != "" {
				return strings.TrimPrefix(strings.TrimPrefix(repo, "https://"), "github.com/")
			}
		}
	case "database":
		return "postgres"
	case "ingress":
		return d.resolveHint(config["host"])
	}
	return ""
}

type templateJSON struct {
	Name        string            `json:"name"`
	DisplayName string            `json:"displayName"`
	Description string            `json:"description,omitempty"`
	Icon        string            `json:"icon,omitempty"`
	Version     string            `json:"version"`
	Category    string            `json:"category,omitempty"`
	Tags        []string          `json:"tags"`
	Keywords    []string          `json:"keywords"`
	Author      string            `json:"author,omitempty"`
	Homepage    string            `json:"homepage,omitempty"`
	License     string            `json:"license,omitempty"`
	Parameters  []map[string]any  `json:"parameters"`
	Resources   []resourceSummary `json:"resources"`
}

func (d templateDoc) summary() templateJSON {
	m := d.Metadata
	out := templateJSON{
		Name:        m.Name,
		DisplayName: firstNonEmpty(m.DisplayName, m.Name),
		Description: m.Description,
		Icon:        m.Icon,
		Version:     m.Version,
		Category:    m.Category,
		Tags:        nonNil(m.Tags),
		Keywords:    nonNil(m.Keywords),
		Author:      m.Author,
		Homepage:    m.Homepage,
		License:     m.License,
		Parameters:  d.Parameters,
		Resources:   []resourceSummary{},
	}
	if out.Parameters == nil {
		out.Parameters = []map[string]any{}
	}
	for _, r := range d.Resources {
		out.Resources = append(out.Resources, resourceSummary{r.Name, r.Type, d.resourceDetail(r.Type, r.Config)})
	}
	return out
}

type artifact struct {
	Name        string
	Body        []byte
	ContentType string
	Derived     bool
}

type localTemplate struct {
	doc       templateDoc
	source    string
	artifacts []artifact
}

type fileInfo struct {
	Path        string `json:"path"`
	SHA256      string `json:"sha256"`
	Size        int    `json:"size"`
	ContentType string `json:"contentType"`
}

type versionInfo struct {
	Version     string              `json:"version"`
	PublishedAt string              `json:"publishedAt"`
	Files       map[string]fileInfo `json:"files"`
}

type templateIndex struct {
	Name        string        `json:"name"`
	DisplayName string        `json:"displayName"`
	Description string        `json:"description,omitempty"`
	Icon        string        `json:"icon,omitempty"`
	Category    string        `json:"category,omitempty"`
	Tags        []string      `json:"tags"`
	Author      string        `json:"author,omitempty"`
	Homepage    string        `json:"homepage,omitempty"`
	License     string        `json:"license,omitempty"`
	Latest      string        `json:"latest"`
	Source      string        `json:"source,omitempty"`
	AddedBy     *person       `json:"addedBy,omitempty"`
	AddedAt     string        `json:"addedAt,omitempty"`
	Versions    []versionInfo `json:"versions"`
}

type person struct {
	Name  string `json:"name"`
	Login string `json:"login,omitempty"`
}

type catalogEntry struct {
	Name        string            `json:"name"`
	DisplayName string            `json:"displayName"`
	Description string            `json:"description,omitempty"`
	Icon        string            `json:"icon,omitempty"`
	Category    string            `json:"category,omitempty"`
	Tags        []string          `json:"tags"`
	Keywords    []string          `json:"keywords"`
	Author      string            `json:"author,omitempty"`
	Homepage    string            `json:"homepage,omitempty"`
	License     string            `json:"license,omitempty"`
	Version     string            `json:"version"`
	PublishedAt string            `json:"publishedAt"`
	Yaml        string            `json:"yaml"`
	SHA256      string            `json:"sha256"`
	Size        int               `json:"size"`
	Readme      string            `json:"readme,omitempty"`
	Preview     string            `json:"preview,omitempty"`
	IconUrl     string            `json:"iconUrl,omitempty"`
	Index       string            `json:"index"`
	Source      string            `json:"source,omitempty"`
	AddedBy     *person           `json:"addedBy,omitempty"`
	AddedAt     string            `json:"addedAt,omitempty"`
	Resources   []resourceSummary `json:"resources"`
}

type catalog struct {
	GeneratedAt string         `json:"generatedAt"`
	Version     string         `json:"version,omitempty"`
	Sequence    int64          `json:"sequence,omitempty"`
	ExpiresAt   string         `json:"expiresAt,omitempty"`
	Templates   []catalogEntry `json:"templates"`
}

func validatePodResources(raw any) error {
	fields, ok := raw.(map[string]any)
	if !ok {
		return errors.New("needs recommended resources with cpu and memory")
	}
	for key, pattern := range map[string]*regexp.Regexp{"cpu": cpuQuantityRe, "memory": memoryQuantityRe} {
		value, set := fields[key]
		if !set {
			return fmt.Errorf("resources.%s is required", key)
		}
		if text := fmt.Sprint(value); !pattern.MatchString(text) {
			return fmt.Errorf("resources.%s %q is not a valid size", key, text)
		}
	}
	for key := range fields {
		if key != "cpu" && key != "memory" {
			return fmt.Errorf("resources has unknown field %q", key)
		}
	}
	return nil
}

func parseTemplate(body []byte) (templateDoc, error) {
	var doc templateDoc
	if err := yaml.Unmarshal(body, &doc); err != nil {
		return doc, fmt.Errorf("invalid yaml: %w", err)
	}
	m := doc.Metadata
	if !templateNameRe.MatchString(m.Name) {
		return doc, fmt.Errorf("metadata.name %q must be lowercase letters, digits and hyphens", m.Name)
	}
	if m.Version == "" {
		return doc, errors.New("metadata.version is required")
	}
	if !semverRe.MatchString(m.Version) {
		return doc, fmt.Errorf("metadata.version %q is not a semantic version", m.Version)
	}
	if m.Author != "" && !githubRe.MatchString(m.Author) {
		return doc, fmt.Errorf("metadata.author %q must be a GitHub login", m.Author)
	}
	if m.Homepage != "" && !strings.HasPrefix(m.Homepage, "https://") {
		return doc, errors.New("metadata.homepage must be an https url")
	}
	if len(doc.Resources) == 0 {
		return doc, errors.New("template must define at least one resource")
	}
	for i, r := range doc.Resources {
		if r.Name == "" || r.Type == "" || r.Config == nil {
			return doc, fmt.Errorf("resources[%d] needs name, type and config", i)
		}
		if !resourceOK[r.Type] {
			return doc, fmt.Errorf("resources[%d] has unknown type %q", i, r.Type)
		}
	}
	seen := map[string]bool{}
	for i, p := range doc.Parameters {
		name, _ := p["name"].(string)
		if name == "" {
			return doc, fmt.Errorf("parameters[%d] needs a name", i)
		}
		if seen[name] {
			return doc, fmt.Errorf("parameter %q is defined twice", name)
		}
		seen[name] = true
	}
	for i, r := range doc.Resources {
		if r.Type == "ingress" {
			continue
		}
		if err := validatePodResources(r.Config["resources"]); err != nil {
			return doc, fmt.Errorf("resources[%d] (%s): %w", i, r.Name, err)
		}
		if r.Type != "deployment" {
			continue
		}
		if err := validateImageTag(r.Config["image"]); err != nil {
			return doc, fmt.Errorf("resources[%d] (%s): %w", i, r.Name, err)
		}
	}
	return doc, nil
}

func validateImageTag(raw any) error {
	image, ok := raw.(string)
	if !ok || image == "" || strings.Contains(image, "{{") || strings.Contains(image, "@") {
		return nil
	}
	tag := ""
	if i := strings.LastIndex(image, ":"); i > strings.LastIndex(image, "/") {
		tag = image[i+1:]
	}
	if tag == "" || tag == "latest" {
		return fmt.Errorf("image %q must pin a version or a major tag such as :2, not latest", image)
	}
	return nil
}

var sidecars = []struct{ ext, name, ctype string }{
	{".md", "README.md", "text/markdown; charset=utf-8"},
	{".png", "preview.png", "image/png"},
	{".svg", "icon.svg", "image/svg+xml"},
	{".icon.png", "icon.png", "image/png"},
}

func loadTemplates(dirs []string) ([]localTemplate, error) {
	byName := map[string]string{}
	var out []localTemplate
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			ext := filepath.Ext(entry.Name())
			if entry.IsDir() || (ext != ".yaml" && ext != ".yml") {
				continue
			}
			file := filepath.Join(dir, entry.Name())
			body, err := os.ReadFile(file)
			if err != nil {
				return nil, err
			}
			doc, err := parseTemplate(body)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", file, err)
			}
			stem := strings.TrimSuffix(entry.Name(), ext)
			if stem != doc.Metadata.Name {
				return nil, fmt.Errorf("%s: file must be named %s%s to match metadata.name", file, doc.Metadata.Name, ext)
			}
			if prior, dup := byName[doc.Metadata.Name]; dup {
				return nil, fmt.Errorf("%s: template %q is already defined in %s", file, doc.Metadata.Name, prior)
			}
			byName[doc.Metadata.Name] = file
			t := localTemplate{doc: doc, source: file}
			t.artifacts = append(t.artifacts, artifact{"template.yaml", body, "application/yaml; charset=utf-8", false})
			parsed, _ := json.MarshalIndent(doc.summary(), "", "  ")
			t.artifacts = append(t.artifacts, artifact{"template.json", parsed, "application/json; charset=utf-8", true})
			out = append(out, t)
		}
	}
	for i := range out {
		for _, side := range sidecars {
			found := ""
			for _, dir := range dirs {
				candidate := filepath.Join(dir, out[i].doc.Metadata.Name+side.ext)
				if _, err := os.Stat(candidate); err == nil {
					if found != "" {
						return nil, fmt.Errorf("%s: %s is also present in %s", candidate, side.name, found)
					}
					found = candidate
				}
			}
			if found == "" {
				continue
			}
			body, err := os.ReadFile(found)
			if err != nil {
				return nil, err
			}
			out[i].artifacts = append(out[i].artifacts, artifact{side.name, body, side.ctype, false})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].doc.Metadata.Name < out[j].doc.Metadata.Name })
	return out, nil
}

type publisher struct {
	bucket     *Bucket
	prefix     string
	sourceBase string
	version    string
	icons      *IconFetcher
	git        bool
	authors    map[string]string
	now        func() time.Time
	log        *log.Logger
	signKey    ed25519.PrivateKey
	indexTTL   time.Duration
}

func (p *publisher) sourceURL(file string) string {
	if p.sourceBase == "" {
		return ""
	}
	rel, err := filepath.Rel(".", file)
	if err != nil || strings.HasPrefix(rel, "..") {
		rel = filepath.Base(file)
	}
	return strings.TrimSuffix(p.sourceBase, "/") + "/" + filepath.ToSlash(rel)
}

func (p *publisher) key(k string) string { return p.prefix + k }

func (p *publisher) putIfChanged(ctx context.Context, key string, body []byte, contentType, cacheControl string, immutable bool) (bool, error) {
	existing, err := p.bucket.Head(ctx, p.key(key))
	switch {
	case errors.Is(err, ErrNotFound):
	case err != nil:
		return false, err
	case existing.ETag == md5ETag(body) && existing.ContentDisposition == dispositionFor(key, contentType):
		return false, nil
	case existing.ETag == md5ETag(body):
	case immutable:
		return false, fmt.Errorf("%s is already published with different content; bump metadata.version instead of editing a released version: %w", key, errAlreadyPublished)
	}
	return true, p.bucket.Put(ctx, p.key(key), body, contentType, cacheControl)
}

var errAlreadyPublished = errors.New("a published version never changes")

func (p *publisher) readIndex(ctx context.Context, name string) (*templateIndex, error) {
	raw, err := p.bucket.ReadAll(ctx, p.key("templates/"+name+"/index.json"))
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var idx templateIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, fmt.Errorf("templates/%s/index.json is unreadable: %w", name, err)
	}
	return &idx, nil
}

func (p *publisher) publishTemplate(ctx context.Context, t localTemplate) (templateIndex, error) {
	m := t.doc.Metadata
	base := "templates/" + m.Name + "/" + m.Version + "/"
	files := map[string]fileInfo{}
	hasIcon := m.Icon == "none"
	for _, a := range t.artifacts {
		if strings.HasPrefix(a.Name, "icon.") {
			hasIcon = true
		}
	}
	if !hasIcon && p.icons != nil && (m.Homepage != "" || strings.HasPrefix(m.Icon, "http")) {
		if icon, err := p.icons.Fetch(ctx, m.Icon, m.Homepage); err == nil {
			t.artifacts = append(t.artifacts, artifact{iconArtifactName(icon.ContentType), icon.Body, icon.ContentType, true})
		} else {
			p.log.Printf("icon for %s skipped: %v", m.Name, err)
		}
	}
	for _, a := range t.artifacts {
		key := base + a.Name
		changed, err := p.putIfChanged(ctx, key, a.Body, a.ContentType, cacheImmutable, !a.Derived)
		if err != nil {
			return templateIndex{}, err
		}
		if changed {
			p.log.Printf("uploaded %s (%d bytes)", key, len(a.Body))
		}
		files[a.Name] = fileInfo{Path: key, SHA256: sha256Hex(a.Body), Size: len(a.Body), ContentType: a.ContentType}
	}

	prior, err := p.readIndex(ctx, m.Name)
	if err != nil {
		return templateIndex{}, err
	}
	versions := map[string]versionInfo{}
	if prior != nil {
		for _, v := range prior.Versions {
			versions[v.Version] = v
		}
	}
	current := versionInfo{Version: m.Version, PublishedAt: p.now().UTC().Format(time.RFC3339), Files: files}
	if existing, ok := versions[m.Version]; ok && existing.PublishedAt != "" {
		current.PublishedAt = existing.PublishedAt
	}
	versions[m.Version] = current

	idx := templateIndex{
		Name:        m.Name,
		DisplayName: firstNonEmpty(m.DisplayName, m.Name),
		Description: m.Description,
		Icon:        m.Icon,
		Category:    m.Category,
		Tags:        nonNil(m.Tags),
		Author:      m.Author,
		Homepage:    m.Homepage,
		License:     m.License,
		Source:      p.sourceURL(t.source),
	}
	if added := p.addedBy(t.source); added != nil {
		idx.AddedBy = &added.person
		idx.AddedAt = added.at
	}
	for _, v := range versions {
		idx.Versions = append(idx.Versions, v)
	}
	sort.Slice(idx.Versions, func(i, j int) bool { return compareSemver(idx.Versions[i].Version, idx.Versions[j].Version) > 0 })
	idx.Latest = idx.Versions[0].Version

	if idx.Latest == m.Version {
		for _, a := range t.artifacts {
			if _, err := p.putIfChanged(ctx, "templates/"+m.Name+"/latest/"+a.Name, a.Body, a.ContentType, cacheIndex, false); err != nil {
				return templateIndex{}, err
			}
		}
	}

	body, _ := json.MarshalIndent(idx, "", "  ")
	if _, err := p.putIfChanged(ctx, "templates/"+m.Name+"/index.json", body, "application/json; charset=utf-8", cacheIndex, false); err != nil {
		return templateIndex{}, err
	}
	return idx, nil
}

func (p *publisher) publishFiles(ctx context.Context, dir string) error {
	if dir == "" {
		return nil
	}
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return filepath.WalkDir(dir, func(file string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") && file != dir {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		rel, err := filepath.Rel(dir, file)
		if err != nil {
			return err
		}
		key := path.Clean(filepath.ToSlash(rel))
		if strings.HasPrefix(key, "templates/") {
			return fmt.Errorf("%s: the templates/ prefix is reserved for published templates", file)
		}
		body, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		changed, err := p.putIfChanged(ctx, key, body, contentTypeFor(key, ""), cacheDefault, false)
		if err != nil {
			return err
		}
		if changed {
			p.log.Printf("uploaded %s (%d bytes)", key, len(body))
		}
		return nil
	})
}

func (p *publisher) run(ctx context.Context, templateDirs []string, filesDir string) (*catalog, error) {
	templates, err := loadTemplates(templateDirs)
	if err != nil {
		return nil, err
	}
	cat := &catalog{GeneratedAt: p.now().UTC().Format(time.RFC3339), Version: p.version, Templates: []catalogEntry{}}
	cat.Sequence, cat.ExpiresAt = p.stamp()
	for _, t := range templates {
		idx, err := p.publishTemplate(ctx, t)
		if err != nil {
			return nil, err
		}
		latest := idx.Versions[0]
		entry := catalogEntry{
			Name:        idx.Name,
			DisplayName: idx.DisplayName,
			Description: idx.Description,
			Icon:        idx.Icon,
			Category:    idx.Category,
			Tags:        idx.Tags,
			Keywords:    nonNil(t.doc.Metadata.Keywords),
			Author:      idx.Author,
			Homepage:    idx.Homepage,
			License:     idx.License,
			Version:     latest.Version,
			PublishedAt: latest.PublishedAt,
			Yaml:        latest.Files["template.yaml"].Path,
			SHA256:      latest.Files["template.yaml"].SHA256,
			Size:        latest.Files["template.yaml"].Size,
			Readme:      latest.Files["README.md"].Path,
			Preview:     latest.Files["preview.png"].Path,
			IconUrl:     iconPath(latest.Files),
			Index:       "templates/" + idx.Name + "/index.json",
			Source:      idx.Source,
			AddedBy:     idx.AddedBy,
			AddedAt:     idx.AddedAt,
			Resources:   t.doc.summary().Resources,
		}
		cat.Templates = append(cat.Templates, entry)
	}
	if err := p.publishFiles(ctx, filesDir); err != nil {
		return nil, err
	}
	body, _ := json.MarshalIndent(cat, "", "  ")
	changed, err := p.putIndex(ctx, rootIndexKey, body)
	if err != nil {
		return nil, err
	}
	if changed {
		p.log.Printf("wrote %s with %d templates", rootIndexKey, len(cat.Templates))
	}
	return cat, nil
}

func compareSemver(a, b string) int {
	ma, mb := semverRe.FindStringSubmatch(a), semverRe.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return strings.Compare(a, b)
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(ma[i])
		y, _ := strconv.Atoi(mb[i])
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	switch {
	case ma[4] == mb[4]:
		return 0
	case ma[4] == "":
		return 1
	case mb[4] == "":
		return -1
	}
	return strings.Compare(ma[4], mb[4])
}

func iconPath(files map[string]fileInfo) string {
	for _, name := range []string{"icon.svg", "icon.png", "icon.webp", "icon.jpg", "icon.ico"} {
		if f, ok := files[name]; ok {
			return f.Path
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func validateOnly(dirs []string) error {
	templates, err := loadTemplates(dirs)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	for _, t := range templates {
		fmt.Fprintf(&buf, "ok  %-24s %-10s %s\n", t.doc.Metadata.Name, t.doc.Metadata.Version, t.source)
	}
	os.Stdout.Write(buf.Bytes())
	return nil
}
