---
title: Run the fast builder
description: Build images in Firecracker microVMs that keep each app's build cache warm, turn it on with one command, and change how much of the server it uses.
---

The fast builder runs each build in a Firecracker microVM that stays up between builds and keeps the app's BuildKit cache on its own disk. A second build of the same app starts in a warm VM with a warm cache, so it often takes seconds instead of minutes. Builds that do not go to the fast builder use the standard builder, as before.

The fast builder is experimental. If no fast builder host can take a build when it starts, Orchard builds it with the standard builder and says so in the build log.

## Requirements

- A Linux server with KVM. The file `/dev/kvm` must exist. Bare metal has it. On a cloud VM, the provider must offer nested virtualization, and it must be turned on.
- cgroup v2. Current distributions use it by default.
- An x86_64 or arm64 CPU.
- At least 6 GB of memory. 16 GB or more lets several apps build at the same time.

The installer tells you when the server has KVM. To check yourself, run `ls -l /dev/kvm`.

## Turn it on

On an installer host, run the following command:

```bash
sudo orchardctl fast-builder enable --apply
```

The command does these steps:

1. It checks for `/dev/kvm` and cgroup v2, and stops with the reason if one is missing.
2. It reads the memory, CPUs and free disk space of the server, and sizes the fast builder to fit. The next section shows how.
3. It points the fast builder at the registry that your builds already push to.
4. It labels this node `orchard-fc-builder=true`, so that the fast builder runs on it.
5. It sets the routing to **All builds**, so that every app uses the fast builder unless its own settings say otherwise.
6. With `--apply`, it upgrades Orchard. Without `--apply`, run `sudo orchardctl update` when you are ready.

The first build of each app starts a new VM and fills an empty cache, so it is not faster than the standard builder. The builds after it are.

To see what is set and whether the fast builder is running, run `sudo orchardctl fast-builder status`.

## Default sizes

`enable` chooses each value from the server. You do not have to change any of them.

| Setting                    | Default                                                                 | Flag                            |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| CPUs for each VM           | Half of the server's CPUs, from 1 to 8                                  | `--vcpus`                       |
| Memory for each VM         | A quarter of the server's memory, from 2 GiB to 16 GiB                  | `--memory`                      |
| Memory kept free for apps  | 15% of the server's memory, from 2 GiB to 32 GiB                        | `--min-free`                    |
| VMs at the same time       | As many as fit in the memory that is not kept free, from 1 to 6         | `--max-vms`                     |
| Disk for all build caches  | 40% of the free disk, from 20 GiB to 1 TiB                              | `--storage-size`                |
| Cache for each app         | A quarter of the disk above, from 10 GB to 50 GB                        | `--cache-size`                  |
| StorageClass for that disk | The one the standard build cache uses (`local-path` on installer hosts) | `--storage-class`               |
| Resource limits            | None. The fast builder asks for 0.25 CPU and 256 MiB, and has no limit. | `--cpu-limit`, `--memory-limit` |

Each VM also uses about 1.5 GiB more than its memory setting, for Firecracker and the cache disk.

Without limits, the fast builder still cannot use up the server:

- Each VM has its own memory limit, so one build cannot use more than its VM.
- The fast builder starts a new VM only if the server keeps the **memory kept free for apps** after it. When memory is low, a build waits up to 20 seconds for a running VM. Then it uses the standard builder.

If you want hard limits for the whole fast builder too, set them. Orchard then fits fewer VMs into the limit if needed.

```bash
sudo orchardctl fast-builder enable --cpu-limit 8 --memory-limit 32Gi --apply
```

## Change the sizes

Run `enable` again with the flags that you want to change. Values without a flag are chosen again from the server, except the disk for all build caches and its StorageClass. Kubernetes cannot change those after the disk exists, so `enable` keeps them. To change them, turn the fast builder off with `--apply`, which deletes the caches, then run `enable` with `--storage-size` or `--storage-class`.

```bash
sudo orchardctl fast-builder enable --memory 8Gi --max-vms 2 --apply
```

To change one value and keep the rest, use `orchardctl config`:

```bash
sudo orchardctl config set fcBuilder.vm.maxVms 3 --apply
```

Memory values take a number of MiB or a size such as `8Gi`.

## Choose which builds use it

The routing decides which builds use the fast builder. To change it, go to **Instance admin** > **Configuration** > **Fast builder**.

| Routing               | What it does                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- |
| All builds            | Every app uses the fast builder, unless the fast builder is turned off in the app's settings. |
| Only apps that opt in | Apps use the standard builder, unless the fast builder is turned on in the app's settings.    |
| Off                   | Every build uses the standard builder, including apps that turned the fast builder on.        |
| PostHog flag          | Apps set to **Auto** follow the `firecracker-builder` feature flag.                           |

`orchardctl fast-builder enable` sets **All builds**. To start with another one, add `--routing per_app`, `--routing off` or `--routing flag`. A choice in **Instance admin** replaces it.

Each app can also choose for itself. In the app, go to **Settings** > **Source & build** > **Fast builder** and select **Auto**, **On** or **Off**. **Auto** follows the routing.

## Turn it off

```bash
sudo orchardctl fast-builder disable --apply
```

Builds go back to the standard builder. The upgrade deletes the `orchard-fc-builders` namespace and every build cache in it, which frees the disk. The sizes stay in the values file, so `enable` starts with them next time, and the first build of each app fills its cache again.

## Helm installs

Without the installer, set these values and run `helm upgrade`. The chart defaults are sized for a large dedicated build node (12 CPUs and 48 GiB requested), so set the sizes for your node.

```yaml
fcBuilder:
  enabled: true
  serverEnabled: true
  routing: all
  replicas: 1
  resources:
    requests: { cpu: 250m, memory: 256Mi }
  storage:
    storageClass: ''
    size: 100Gi
  vm:
    vcpus: 4
    memoryMiB: 4096
    maxVms: 2
    minNodeFreeMiB: 4096
    cacheSize: 25G
  registry:
    upstream: http://registry.example.svc.cluster.local:5000
  registryEgress:
    - namespace: registry
      podLabels: { app: registry }
      ports:
        - port: 5000
```

Then label each node that has `/dev/kvm`:

```bash
kubectl label node <node> orchard-fc-builder=true
```

`replicas` is the number of nodes that run the fast builder. Each one needs the label. `fcBuilder.registry.upstream` is where the fast builder sends the images it builds. Use the same registry as `builders.harbor.hosts`, with `http://` if it is in `builders.httpRegistries`. The credentials come from `builders.harbor` unless you set `fcBuilder.registry.username` and `password`. The [chart reference](https://github.com/hackclub/orchard/blob/main/infra/charts/orchard/README.md#fast-builder-fcbuilder) lists every value.

## Troubleshooting

**The fast builder pod stays Pending.** No node has the `orchard-fc-builder=true` label, or the node does not have the CPU and memory that `fcBuilder.resources.requests` asks for. Run `sudo kubectl -n orchard-fc-builders describe pod -l app.kubernetes.io/name=fc-builder` to see which.

**Builds still use the standard builder.** Check the routing in **Instance admin** > **Configuration** > **Fast builder**, and the app's own setting. If the build log says "The fast builder is unavailable right now", no fast builder host took the build: check that the fast builder pod is ready, and read its log.

**The fast builder log says "node memory low ... refusing new VMs".** Starting another VM would leave less free memory than `fcBuilder.vm.minNodeFreeMiB`, so builds that cannot use a running VM go to the standard builder. To run more VMs at once, lower `--memory`, or lower `--min-free` if your apps can spare the memory.

**Pushes fail.** Check `fcBuilder.registry.upstream` and `fcBuilder.registryEgress`. They must name the registry that your standard builds push to. Run `sudo kubectl -n orchard-fc-builders logs statefulset/fc-builder --tail=50` to see the error.
