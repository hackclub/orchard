---
title: Offer GPUs and other devices
description: Let apps attach a GPU, /dev/dri or another host device through a Kubernetes device plugin.
sidebar:
  order: 4
---

Apps such as Jellyfin, Immich, model servers and remote desktops need a host device: an NVIDIA GPU, or `/dev/dri` for Intel and AMD graphics. Orchard does not mount host paths into tenant pods, because a host path escapes tenant isolation. Instead, a [device plugin](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/) on the node advertises each device as an extended resource, such as `nvidia.com/gpu`, and Kubernetes gives a pod that requests it only that device.

You decide which devices apps may attach. You must be able to change the Helm values of your instance.

## Install a device plugin

Install the plugin for your hardware on every node that has the device:

- **NVIDIA:** Install the NVIDIA Container Toolkit on the node, then restart k3s. k3s finds the NVIDIA runtime when it starts and creates a RuntimeClass named `nvidia`. Then install the [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin) with `runtimeClassName: nvidia`. It advertises `nvidia.com/gpu`.
- **Intel:** Install the [Intel GPU device plugin](https://github.com/intel/intel-device-plugins-for-kubernetes), which advertises `gpu.intel.com/i915` or `gpu.intel.com/xe`.
- **Any `/dev` path:** Install the [generic device plugin](https://github.com/squat/generic-device-plugin), and configure it to advertise the path, for example `/dev/dri` as `squat.ai/dri`.

Confirm that the node advertises the resource:

```sh
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'
```

## Offer the device to apps

Add each device to `devices.classes` in your Helm values, then run `helm upgrade`:

```yaml
devices:
  classes:
    - resource: nvidia.com/gpu
      label: NVIDIA GPU
      runtimeClassName: nvidia
      max: 1
    - resource: squat.ai/dri
      label: Intel GPU
```

| Field              | Description                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource`         | The extended resource that the plugin advertises.                                                                                                                         |
| `label`            | The name that people see in the dashboard. It defaults to `resource`.                                                                                                     |
| `runtimeClassName` | The RuntimeClass for pods that attach this device. Set `nvidia` for NVIDIA GPUs on k3s. Omit it to keep the default. An app can only attach devices that share a runtime. |
| `max`              | The most of this device that one pod can attach. It defaults to 1 and is at most 16.                                                                                      |

Without Helm, set `DEVICE_CLASSES` on the server to the same list as JSON. The server logs a warning that names any entry it cannot use, such as an invalid resource or RuntimeClass name, and leaves that entry out. If the value is not a JSON array, no devices are offered.

People who can edit an app can then attach the device in **Settings** > **Resources**, with `orchard deploy devices set`, or through MCP. Orchard does not count devices against [quotas](/teams/quotas/), so anyone who can edit an app can take a device that another app is waiting for.

## Devices and the tenant sandbox

gVisor cannot pass a device through to a pod. If you turned on `tenantSandbox`, give every device class a `runtimeClassName` that runs on the host kernel, such as `nvidia`, or a RuntimeClass with the `runc` handler for `/dev/dri`. A pod that attaches the device runs outside the sandbox, so offer devices only to people you would trust with the host kernel.

The admission policy accepts that RuntimeClass only on a pod that requests the device it belongs to. A pod that names `nvidia` without requesting `nvidia.com/gpu` is still reported.

## Stop offering a device

When you remove a class from `devices.classes`, apps that still have the device keep running. Their next redeploy or image change fails with an error that names the device, so that the app does not quietly lose it or move to a different RuntimeClass. Detach the device from those apps, or add the class back. Detaching works even though the device is no longer offered, and the app can keep it attached while you attach another device.

## Troubleshoot

- **The pod stays in Pending with `Insufficient nvidia.com/gpu`:** every device is in use, or no node advertises it. Check the allocatable count on the node, and scale down the app that holds the device.
- **The pod fails with `no runtime for "nvidia" is configured`:** the node does not have the NVIDIA runtime. Install the NVIDIA Container Toolkit, and restart k3s.
- **The app starts but finds no device:** check the app's documentation for the group it needs. For `/dev/dri`, the process must be root or belong to the `render` group of the node.
