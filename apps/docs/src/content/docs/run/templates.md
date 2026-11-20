---
title: Deploy and write templates
description: Deploy an Orchard template that creates several resources together, write your own template in YAML, and publish it to the community registry.
sidebar:
  order: 4
---

A template deploys a whole stack in one step, such as an app, the database it needs, and a domain in front of it, already wired together. You answer a few questions, and Orchard creates each resource and passes values such as the database password from one resource to the next. A template is a YAML file, so you can also write your own and share it in the community registry.

## Deploy a template

1. Open a project.
2. Select **New app**.
3. Select a template, or search for one by name.
4. Fill in the parameters.
5. (Optional) Change the size of each service.
6. Select the deploy button, which names the template, such as **Deploy Ghost Blog**.

From the CLI, run `orchard template list` to find the template ID, then run the following command:

```sh
orchard template deploy <template-id> --param appName=ghost --param domain=blog.example.com
```

The result is a template instance, which groups the resources it created. Each resource is a normal app or database that you can [scale](/deploy/scaling/), configure, and [roll back](/deploy/rollbacks/).

To find the instance, open the project and go to **Templates**. To remove the instance and its resources, open it and select **Delete everything**.

## Write a template

A template has three sections. `metadata` describes it. `parameters` lists the questions Orchard asks before it deploys. `resources` lists what it creates, in order.

```yaml
apiVersion: leaf/v1
kind: Template
metadata:
  name: ghost
  displayName: Ghost Blog
  description: Ghost with a Postgres database and a public domain.
  version: '1.0.0'
  category: cms
  tags: ['blog', 'cms']
  author: your-github-handle

parameters:
  - name: appName
    displayName: App Name
    type: string
    default: ghost
    required: true
    validation:
      pattern: '^[a-z][a-z0-9-]{1,58}[a-z0-9]$'
      message: Lowercase letters, digits and hyphens, 3 to 60 characters
  - name: domain
    displayName: Domain
    type: string
    required: true
    placeholder: blog.example.com
  - name: enableTls
    displayName: Enable HTTPS
    type: boolean
    default: true

resources:
  - name: db
    type: database
    config:
      name: '{{ params.appName }}-db'

  - name: app
    type: deployment
    config:
      name: '{{ params.appName }}'
      image: ghost:5
      ports:
        - name: http
          containerPort: 2368
          servicePort: 2368
          protocol: TCP
      env:
        - key: database__client
          value: postgres
        - key: database__connection__host
          value: '{{ resources.db.host }}'
        - key: database__connection__password
          value: '{{ resources.db.dbPassword }}'
          secret: true
        - key: url
          value: 'https://{{ params.domain }}'

  - name: ingress
    type: ingress
    config:
      host: '{{ params.domain }}'
      tlsEnabled: '{{ params.enableTls }}'
      routes:
        - path: /
          serviceName: '{{ resources.app.serviceName }}'
          servicePort: 2368
```

### Metadata

| Field         | Required   | Notes                                                                   |
| ------------- | ---------- | ----------------------------------------------------------------------- |
| `name`        | Yes        | Lowercase letters, digits, and hyphens. Must be unique on the instance. |
| `displayName` | No         | Shown in the dashboard. The default is `name`.                          |
| `description` | No         | One or two sentences.                                                   |
| `version`     | To publish | A semantic version. Required to publish to the registry.                |
| `category`    | No         | Groups templates in the gallery, such as `cms` or `database`.           |
| `tags`        | No         | A list of searchable strings.                                           |
| `keywords`    | No         | Extra search terms.                                                     |
| `icon`        | No         | An icon name for the dashboard.                                         |
| `author`      | No         | Your GitHub username. The gallery credits you with it.                  |
| `homepage`    | No         | An `https://` link to the software's site.                              |
| `license`     | No         | The SPDX ID of the software the template deploys.                       |

### Parameters

Each parameter needs a `name`. The other fields are optional.

| Field         | Notes                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName` | The label in the form. The default is `name`.                                                                                                                                            |
| `description` | Help text under the field.                                                                                                                                                               |
| `type`        | `string` (default), `number`, `boolean`, `select`, or `secret`.                                                                                                                          |
| `default`     | The value used when the field is empty.                                                                                                                                                  |
| `required`    | Rejects an empty value that has no default.                                                                                                                                              |
| `placeholder` | Hint text in the empty field.                                                                                                                                                            |
| `options`     | For `select`, a list of `{ label, value }`.                                                                                                                                              |
| `validation`  | `pattern` and `message` for strings. `min` and `max` for numbers and secret lengths. `bytes` and `encoding` (`hex` or `base64`) for generated secrets that must decode to an exact size. |

Orchard handles each type as follows when you deploy:

| Type      | Handling                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `string`  | Checked against `validation.pattern`. A parameter that names a resource (`name`, `appName`, or anything ending in `Name`) is converted to a slug first, so `My Blog` becomes `my-blog`. |
| `number`  | Converted to a number and checked against `min` and `max`.                                                                                                                              |
| `boolean` | Accepts `true` or the string `"true"`.                                                                                                                                                  |
| `select`  | Must match one of the option values.                                                                                                                                                    |
| `secret`  | Generated when empty, as a random hex string. The length is 32 characters, or `validation.min` if that is larger.                                                                       |

### Resources

Orchard creates resources from top to bottom. Each resource can reference the ones above it. `name` is how later resources refer to it, and `type` decides which `config` keys apply.

#### `database`

Creates a [Postgres database](/data/databases/).

| Config      | Notes                                       |
| ----------- | ------------------------------------------- |
| `name`      | Required.                                   |
| `replicas`  | The number of instances. The default is 1.  |
| `resources` | The recommended size, as `{ cpu, memory }`. |

A database exposes `host`, `port`, `dbName`, `dbUser`, `dbPassword`, and `connectionString` to later resources.

#### `deployment`

Creates an app from [an image](/deploy/image/) or from [a repository](/deploy/github/).

| Config                                                                               | Notes                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                               | Required.                                                                                                                                                                                                                                                                         |
| `image`                                                                              | The image to deploy. Use this or `repo`.                                                                                                                                                                                                                                          |
| `repo`, `branch`                                                                     | A Git repository to build.                                                                                                                                                                                                                                                        |
| `buildType`                                                                          | `dockerfile` (default, with `dockerfilePath`) or `railpack`.                                                                                                                                                                                                                      |
| `rootDirectory`, `installCommand`, `buildCommand`, `startCommand`, `outputDirectory` | Build settings for a repository. `startCommand` also applies to images.                                                                                                                                                                                                           |
| `replicas`                                                                           | The default is 1.                                                                                                                                                                                                                                                                 |
| `ports`                                                                              | A list of `{ name, containerPort, servicePort, protocol, public, preserveClientIp }`. `public: true` publishes the port on the organization's external IP over raw TCP or UDP. `preserveClientIp: true` also [keeps client addresses](/deploy/networking/#keep-client-addresses). |
| `env`                                                                                | A list of `{ key, value }`. Add `secret: true` to store the value as a secret.                                                                                                                                                                                                    |
| `volumes`                                                                            | Persistent volumes, in the shape the API accepts. Each `pvc` volume gets its own randomly named disk, so two deployed templates do not share one.                                                                                                                                 |
| `resources`                                                                          | The recommended size, as `{ cpu, memory }`, such as `500m` and `1Gi`. The deploy form starts here, and you can change it before you deploy.                                                                                                                                       |
| `exposePublic`                                                                       | Creates the Service as a NodePort instead of ClusterIP. Use `public: true` on a port instead.                                                                                                                                                                                     |
| `autoDeploy`, `autoDeployBranch`                                                     | Redeploys on push, for repository builds.                                                                                                                                                                                                                                         |

A deployment exposes `serviceName`, which an ingress route points at. A deployment with a published port also exposes `publicIp`, `publicPort`, and `publicHost`. The instance assigns the public port number.

#### `ingress`

Puts [a domain](/deploy/domains/) in front of a deployment.

| Config                               | Notes                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `host`                               | Required. The domain.                                                    |
| `tlsEnabled`                         | The default is `true`.                                                   |
| `routes`                             | A list of `{ path, serviceName, servicePort }`.                          |
| `path`, `serviceName`, `servicePort` | Shorthand for a single route when you omit `routes`.                     |
| `basicAuth`                          | [Protects the domain](/deploy/protection/) with a username and password. |

An ingress exposes `host`.

### Expressions

Templates support two expression forms:

- `{{ params.<name> }}` reads a parameter.
- `{{ resources.<name>.<field> }}` reads a field from an earlier resource.

A value that is exactly one expression keeps its type. For example, `replicas: '{{ params.replicas }}'` stays a number. A longer value is string interpolation, such as `'https://{{ params.domain }}'`. A reference to a resource defined further down fails when you deploy.

:::caution
Deploy a template end to end before you publish it. A template can deploy without errors and then crash-loop, for example if the software cannot use the database it receives.
:::

## The community registry

Orchard publishes its built-in templates and community templates to `https://assets.orchard.my/registry`. The gallery is at [orchard.hackclub.com/templates](https://orchard.hackclub.com/templates).

Each instance reads the catalog when it starts and every six hours. To use another registry, set `TEMPLATE_REGISTRY_URL`. On an air-gapped instance, set the variable to an empty value. The built-in templates still load from the server image.

The registry signs the catalog and the graft revocation list with the Orchard key. Each instance verifies the signature, refuses an older catalog than the last one it accepted, and refuses an expired one. When a catalog is refused the instance keeps the templates it already has and logs a warning. `ORCHARD_REGISTRY_SIGNATURE` controls this. `required` (the default) never accepts an unsigned catalog. If `TEMPLATE_REGISTRY_URL` or `ORCHARD_GRAFT_MARKETPLACE_URL` points at a registry you run yourself, set it to `auto`, which accepts an unsigned catalog with a warning until a signed one has been seen (Helm: `graftSettings.registrySignature`). Signed catalogs are checked against the Orchard key in both modes, so a registry signed with your own key does not verify.

You cannot edit or delete imported templates from the instance. An import does not overwrite a custom template with the same name.

### Publish a template

1. Add `registry/templates/<name>.yaml` to the [Orchard repository](https://github.com/hackclub/orchard/tree/main/registry). The file name must match `metadata.name`, and `metadata.version` is required.
2. (Optional) Add `<name>.md`, which appears on the template's page, and a 1200x675 `<name>.png`, which is its preview in the gallery.
3. Validate the template:

   ```sh
   go run -C apps/registry . validate -templates ../../registry/templates
   ```

4. Commit with the message `feat(templates): add <name>`.
5. Open a pull request. CI runs the same validator. After the merge, the template publishes with the next templates release.

Published versions cannot change. To ship a change, increase `metadata.version`. Every version stays available:

```text
https://assets.orchard.my/registry/templates/index.json
https://assets.orchard.my/registry/templates/<name>/index.json
https://assets.orchard.my/registry/templates/<name>/<version>/template.yaml
https://assets.orchard.my/registry/templates/<name>/latest/template.yaml
```

## Related resources

- [Deploy a compose stack](/run/compose/) - Deploy the services in a `docker-compose.yml` file instead of a template.
- [`orchard template` reference](/reference/cli/#template) - Every `orchard template` command and flag.
