# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, discussion or pull request.

- Use **Report a vulnerability** on the
  [Security tab](https://github.com/hackclub/orchard/security) of this repository, or
- Email [hi@leafd.dev](mailto:hi@leafd.dev).

Include the Orchard version, how it is installed, and steps to reproduce. If the issue depends on
a particular cluster setup, describe that too.

We will acknowledge your report, work with you on a fix, and credit you when it ships unless you
would rather stay anonymous.

## Running code from people you don't trust

**A default install is not safe for untrusted tenants.** The installer and the Helm chart leave
`tenantSandbox` and `builderSandbox` off, because gVisor and Kata need runtimes installed on the
node.

Without them, apps run as ordinary containers on the node's kernel, and image builds run in
rootless BuildKit with seccomp and AppArmor turned off. A kernel vulnerability reachable from
either one gives whoever deployed that code the node. On a single-node install, that includes the
control plane, the database and every other tenant's secrets.

A rootless build's `RUN` steps can also read the command lines, environment and files of the
BuildKit processes in their build container. Orchard gives a build no credential that reaches
beyond its own project: the S3 build cache uses per-project keys through the backup proxy, and the
instance-wide cache key is refused unless `BUILDKIT_S3_SHARED_KEY=true` marks a single-tenant
instance.

Turn on both sandboxes before you let anyone deploy code you wouldn't run on the machine yourself.
[install/README.md](install/README.md) explains how.

## Supported versions

Fixes go into the latest release. Please check that the issue still exists there before reporting.
