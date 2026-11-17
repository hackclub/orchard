# Changelog

## [0.8.1](https://github.com/hackclub/orchard/compare/r2-proxy/v0.8.0...r2-proxy/v0.8.1) (2026-11-17)


### Bug Fixes

* **r2-proxy:** bind every key to its own buckets ([0facfa6](https://github.com/hackclub/orchard/commit/0facfa683ab2d70d1b4e7b6576d289f8ec16d524))

## [0.8.0](https://github.com/hackclub/orchard/compare/r2-proxy/v0.7.1...r2-proxy/v0.8.0) (2026-11-09)


### Features

* **frontend:** pilot skullet measured skeletons ([a65a915](https://github.com/hackclub/orchard/commit/a65a9154d6cdd0dac30043d6b5df3b2b9e8b6336))


### Bug Fixes

* **frontend:** finish skullet pilot states ([5a75e4e](https://github.com/hackclub/orchard/commit/5a75e4e40cdb8f0798f50743ed1229baf0aaa653))

## [0.7.1](https://github.com/hackclub/orchard/compare/r2-proxy/v0.7.0...r2-proxy/v0.7.1) (2026-11-05)


### Bug Fixes

* **r2-proxy:** refuse ambiguous requests ([f275e73](https://github.com/hackclub/orchard/commit/f275e73cb6b6ebaaa8f62293020b3eb5bde92916))
* **server:** move to zod 4 ([5fe7fe4](https://github.com/hackclub/orchard/commit/5fe7fe4c11c69f909e65ae2d920dab26e2678c0a))

## [0.7.0](https://github.com/hackclub/orchard/compare/r2-proxy/v0.6.3...r2-proxy/v0.7.0) (2026-11-01)


### Features

* **r2-proxy:** short-lived scoped keys let restores, forks and restore tests read one archive and write another ([3d507b4](https://github.com/hackclub/orchard/commit/3d507b49dc92f4afb0002ea3cdd202b4095b9c72))

## [0.6.3](https://github.com/hackclub/orchard/compare/r2-proxy/v0.6.2...r2-proxy/v0.6.3) (2026-10-23)


### Bug Fixes

* **r2-proxy:** stream hashed and unsigned uploads to r2 instead of buffering every part in memory ([a2a78c1](https://github.com/hackclub/orchard/commit/a2a78c12b1cc45f0d23540a2bb4bdef659978d1e))

## [0.6.2](https://github.com/hackclub/orchard/compare/r2-proxy/v0.6.1...r2-proxy/v0.6.2) (2026-10-21)


### Bug Fixes

* build go binaries with go 1.26.10 and bump cli grpc and x/net for open advisories ([576c8ac](https://github.com/hackclub/orchard/commit/576c8ac59c882677d503ff0135c23495fed919c7))

## [0.6.1](https://github.com/hackclub/orchard/compare/r2-proxy/v0.6.0...r2-proxy/v0.6.1) (2026-10-21)


### Bug Fixes

* **r2-proxy:** resolve restore credentials so a restore cluster can archive into its own prefix ([9e8b804](https://github.com/hackclub/orchard/commit/9e8b8049bbe299940c8052cd11cd45c1fcd4ff54))

## [0.6.0](https://github.com/hackclub/orchard/compare/r2-proxy/v0.5.0...r2-proxy/v0.6.0) (2026-10-08)


### Features

* greenhouse keeps share and slack tokens out of analytics, shows admins a lifecycle only view, and refreshes credits ([ea01fbc](https://github.com/hackclub/orchard/commit/ea01fbc0e6a42fc72e548b588b0eccbaa402c6b5))

## [0.5.0](https://github.com/hackclub/orchard/compare/r2-proxy/v0.4.1...r2-proxy/v0.5.0) (2026-10-07)


### Features

* web terminal on xterm.js with overlay predictions and stable database consoles ([f743331](https://github.com/hackclub/orchard/commit/f743331f72ffb1b8dec6912c9e4fc5f1dd34ec98))

## [0.4.1](https://github.com/hackclub/orchard/compare/r2-proxy/v0.4.0...r2-proxy/v0.4.1) (2026-09-29)


### Bug Fixes

* the r2 proxy refuses copies, bucket writes and out-of-prefix deletes, cookie sessions cannot mutate from other origins, trusted images are docker hub only, the mcp consent page and asset proxy pin their origins, the cli token never enters a url, logout is a post, and the k3s kubeconfig is private ([90ac6fc](https://github.com/hackclub/orchard/commit/90ac6fcf5bafc0b05488449bdd72ece7c32e88d4))

## [0.4.0](https://github.com/hackclub/orchard/compare/r2-proxy/v0.3.0...r2-proxy/v0.4.0) (2026-09-28)


### Features

* a credits page with live contributors, and third-party notices in every app, image and binary ([168c584](https://github.com/hackclub/orchard/commit/168c584bc5de82dd085d6148c54f44f8f61ebc37))

## [0.3.0](https://github.com/hackclub/orchard/compare/r2-proxy/v0.2.1...r2-proxy/v0.3.0) (2026-09-27)


### Features

* an instance backup bucket backs every database whose organization has none, and a leader-only pass brings existing clusters in ([250791e](https://github.com/hackclub/orchard/commit/250791e7c47470025268eef54b84e1fde6cf857e))

## [0.2.1](https://github.com/hackclub/orchard/compare/r2-proxy/v0.2.0...r2-proxy/v0.2.1) (2026-09-02)


### Bug Fixes

* pin the go toolchain floor so the stdlib patches land ([b1d2b0e](https://github.com/hackclub/orchard/commit/b1d2b0e8e125a959b9b21ca5a8d87cef989a539e))

## [0.2.0](https://github.com/LeafdTK/leaf/compare/r2-proxy/v0.1.0...r2-proxy/v0.2.0) (2026-06-16)


### Features

* **ci:** add knope versioning + release pipeline ([5d4ecd2](https://github.com/LeafdTK/leaf/commit/5d4ecd22e1c0c9cd1c3ea09eb5e86f73ef84b81b))

## 0.1.1 (2026-06-16)

### Fixes

- allow dots in github repo names for deploy
