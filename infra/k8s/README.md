# BuildKit Image Builder Setup

This directory contains Kubernetes manifests for the BuildKit-based image builder system that uses Cloudflare R2 for build cache storage.

## Overview

The new build system:
- Spawns ephemeral "image-builder" pods for each build
- Uses BuildKit for efficient, parallelized Docker builds
- Caches build layers to Cloudflare R2 for faster subsequent builds
- Automatically cleans up build pods after completion

## Prerequisites

1. A Kubernetes cluster with the ability to run privileged pods
2. A Cloudflare account with R2 storage enabled
3. Harbor registry (or modify for your registry)

## Setup Instructions

### Step 1: Create R2 Bucket for Build Cache

1. Go to Cloudflare Dashboard > R2
2. **IMPORTANT: Create a new bucket named `buildkit-cache`** (or your preferred name)
   - The bucket MUST exist before builds will work
   - Without this bucket, you'll get "Access Denied" errors
3. Note your **Account ID** (shown in the R2 dashboard URL or overview)
   - Format: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - Example: If your endpoint is `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com`
   - Then your Account ID is: `0123456789abcdef0123456789abcdef`

### Step 2: Create R2 API Token

1. Go to Cloudflare Dashboard > R2 > Manage R2 API Tokens
2. Click "Create API Token"
3. Give it a name like "BuildKit Cache"
4. Set permissions to "Object Read & Write" for your bucket
5. Save the **Access Key ID** and **Secret Access Key**

### Step 3: Update the Kubernetes Manifests

Edit `image-builder-setup.yaml` and replace the placeholders:

```yaml
# In the harbor-registry-creds secret:
"password": "YOUR_HARBOR_PASSWORD"

# In the buildkit-s3-cache-creds secret:
AWS_ACCESS_KEY_ID: "YOUR_R2_ACCESS_KEY_ID"
AWS_SECRET_ACCESS_KEY: "YOUR_R2_SECRET_ACCESS_KEY"
```

### Step 4: Apply the Kubernetes Manifests

```bash
kubectl apply -f k8s/image-builder-setup.yaml
```

This creates:
- `orchard-builders` namespace
- `image-builder` ServiceAccount with RBAC
- `harbor-registry-creds` secret for registry auth
- `buildkit-s3-cache-creds` secret for R2 auth
- `buildkit-config` ConfigMap for BuildKit settings
- ResourceQuota and LimitRange for resource management
- NetworkPolicy for security

### Step 5: Configure the Backend Deployment

Add these environment variables to your backend deployment:

```yaml
env:
  # Enable Kubernetes-based builds (default)
  - name: BUILD_MODE
    value: "kubernetes"

  # Enable S3/R2 cache
  - name: BUILDKIT_S3_CACHE_ENABLED
    value: "true"

  # Your Cloudflare Account ID (from R2 dashboard)
  - name: R2_ACCOUNT_ID
    value: "your-cloudflare-account-id"

  # R2 bucket name for cache
  - name: BUILDKIT_S3_BUCKET
    value: "buildkit-cache"

  # R2 credentials (or reference from secret)
  - name: R2_ACCESS_KEY_ID
    value: "your-r2-access-key-id"
  - name: R2_SECRET_ACCESS_KEY
    value: "your-r2-secret-access-key"

  # Optional: Custom cache prefix
  - name: BUILDKIT_S3_CACHE_PREFIX
    value: "buildkit-cache/"

  # Builder namespace (default: orchard-builders)
  - name: BUILDER_NAMESPACE
    value: "orchard-builders"
```

Or using a patch command:

```bash
kubectl patch deployment backend -n leafycorp-thething-the-thing --type='json' -p='[
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "BUILD_MODE", "value": "kubernetes"}},
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "BUILDKIT_S3_CACHE_ENABLED", "value": "true"}},
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "R2_ACCOUNT_ID", "value": "YOUR_ACCOUNT_ID"}},
  {"op": "add", "path": "/spec/template/spec/containers/0/env/-", "value": {"name": "BUILDKIT_S3_BUCKET", "value": "buildkit-cache"}}
]'
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BUILD_MODE` | No | `kubernetes` | Build mode: `kubernetes` or `local` |
| `BUILDKIT_S3_CACHE_ENABLED` | Yes* | `false` | Enable R2/S3 cache |
| `R2_ACCOUNT_ID` | Yes* | - | Cloudflare Account ID |
| `BUILDKIT_S3_BUCKET` | Yes* | `buildkit-cache` | R2 bucket name |
| `R2_ACCESS_KEY_ID` | Yes* | - | R2 API Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Yes* | - | R2 API Secret Access Key |
| `BUILDKIT_S3_ENDPOINT` | No | Auto-generated | Custom S3 endpoint (overrides R2_ACCOUNT_ID) |
| `BUILDKIT_S3_REGION` | No | `auto` | S3 region (use `auto` for R2) |
| `BUILDKIT_S3_CACHE_PREFIX` | No | `buildkit-cache/` | Prefix for cache objects in bucket |
| `BUILDKIT_S3_SHARED_KEY` | No | `false` | Without the r2-proxy, the S3 cache stays off unless this is `true`. Every build can read the shared key, so set it only on a single-tenant instance |
| `BUILDER_NAMESPACE` | No | `orchard-builders` | Kubernetes namespace for builder pods |

*Required if using R2 cache

## How It Works

1. When a build is triggered, the `ImageBuilderService` creates a Kubernetes Job in the `orchard-builders` namespace
2. The job runs a `moby/buildkit` container with:
   - Registry credentials mounted from secrets
   - R2 credentials as environment variables
   - BuildKit config for insecure registries
3. BuildKit:
   - Clones the repository
   - Checks R2 for cached layers
   - Builds the image using cached layers when available
   - Pushes new layers to R2 cache
   - Pushes the final image to Harbor
4. The job is automatically cleaned up after 1 hour (TTL)

## Monitoring Builds

Watch build jobs:
```bash
kubectl get jobs -n orchard-builders -w
```

View build logs:
```bash
kubectl logs -n orchard-builders job/image-builder-<name> -f
```

List running builds:
```bash
kubectl get pods -n orchard-builders -l app.kubernetes.io/name=image-builder
```

## Troubleshooting

### Build pods fail to start
- Check if the namespace exists: `kubectl get ns orchard-builders`
- Verify secrets are created: `kubectl get secrets -n orchard-builders`
- Check pod events: `kubectl describe pod -n orchard-builders <pod-name>`

### R2 cache not working
- Verify `BUILDKIT_S3_CACHE_ENABLED=true` is set
- Check R2 credentials are correct
- Ensure the R2 bucket exists and API token has write access
- Look for cache-related errors in build logs

### Registry push fails
- Verify Harbor credentials in `harbor-registry-creds` secret
- Check if the registry is reachable from the cluster
- Ensure insecure registry is configured in buildkit-config

### Permission denied errors
- Ensure the ServiceAccount and RBAC are properly created
- Verify the backend has permissions to create jobs in orchard-builders namespace

## Fallback to Local Docker

If Kubernetes builds fail, you can fall back to local Docker builds by setting:

```yaml
env:
  - name: BUILD_MODE
    value: "local"
```

This uses the existing DinD sidecar setup in the backend pod.

## Cleanup

To remove the image builder setup:

```bash
kubectl delete -f k8s/image-builder-setup.yaml
```

To clean up old build jobs manually:

```bash
kubectl delete jobs -n orchard-builders --all
```
