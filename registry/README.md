# The Orchard registry

Everything in this directory is published to `https://assets.orchard.my/registry`
and shown in the gallery at `https://orchard.hackclub.com/templates`. Every Orchard instance
pulls the catalogue from there unless `TEMPLATE_REGISTRY_URL` says otherwise, so a
merged template shows up in the hosted instance and in self-hosted ones alike.

## Adding a template

1. Fork the repo and add `registry/templates/<name>.yaml`. The file name must
   match `metadata.name`. `metadata.version` is required and must be a semantic
   version. Add `metadata.author` with your GitHub login so the gallery credits
   you, `metadata.keywords` for search, and `metadata.homepage` if the software
   has one. Deployment images must pin a version or a floating major tag
   (`gotify/server:3`), not `latest` or no tag.
2. Optionally add `registry/templates/<name>.md` (a README rendered on the
   template's page) and `registry/templates/<name>.png` (a 1200x675 preview
   shown in the gallery). Sidecars are matched by name across every template
   directory, which is how the built-in templates get their previews from here.
3. Run `go run -C apps/registry . validate -templates ../../registry/templates`, and
   deploy the template on a real instance once.
4. Commit it as `feat(templates): add <name>` and open a pull request. CI runs
   the same validator. After the merge, it publishes with the next `templates`
   release, when its release pull request is merged.

Every deployment and database needs a recommended size under `config`, which
is what the deploy form starts from and what people can change before deploying:

```yaml
resources:
  cpu: 500m
  memory: 1Gi
```

Size it for real use, because memory is a hard limit and a container that goes
over it gets killed. The validator rejects a template without it.

Set `metadata.license` to the SPDX id of the software the template deploys
(`MIT`, `AGPL-3.0-only`, `GPL-2.0-or-later`) and `metadata.homepage` to its
site; the page shows both. The template file itself is covered by this repo's
license. Nothing is redistributed: a template only references an image or a
repository.

The publisher records who added each template from git (the author of the
commit that created the file) and shows it with the GitHub avatar. That works
by itself for commits made with a GitHub noreply address; otherwise add an
`email login` line to `registry/authors.txt`. `metadata.author` overrides it.

`metadata.keywords` is optional and worth filling in: the gallery search
matches on it, so list the words someone would type when they do not know the
template's name (`blog`, `newsletter`, `helpdesk`, `key-value`).

The catalogue is its own release-please package (tags `templates/vX.Y.Z`), so
merges show up in a changelog and `templates/index.json` carries the catalogue
version. Publishing runs when a `templates` or `server` release is cut, and once
a week.

## Listing a graft

Grafts (Orchard's extensions) published by people outside Orchard are listed
from `registry/community/`, one `<id>.json` file per graft. The graft itself
stays in its author's GitHub repo and is picked up from their releases.
`registry/community/README.md` explains how to get listed and what gets checked.

## Changing a template

A published version never changes. Bump `metadata.version` when you edit the
YAML or a sidecar; the publisher refuses to overwrite a released version and CI
will tell you so. Old versions stay available at their versioned URLs.

## Layout in the bucket

```
templates/index.json                       catalogue of the latest version of everything
templates/<name>/index.json                every published version of one template
templates/<name>/<version>/template.yaml   the template, immutable
templates/<name>/<version>/template.json   parsed metadata, parameters and resources
templates/<name>/<version>/README.md       optional
templates/<name>/<version>/preview.png     optional
templates/<name>/latest/<file>             302 to the latest version
```

Files under `registry/files/` are synced verbatim to the bucket root and may be
overwritten, which is where mutable things such as an install script belong.

The built-in templates in `apps/server/src/templates/built-in` are published
too, from the same job. The server is `apps/registry`; run
`go run -C apps/registry . validate -templates ../../registry/templates` locally to
check a template before pushing.
