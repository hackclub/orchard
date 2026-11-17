# Changelog

## [0.43.0](https://github.com/hackclub/orchard/compare/cli/v0.42.0...cli/v0.43.0) (2026-11-17)


### Features

* **cli:** set an app picture from the cli ([d32cc77](https://github.com/hackclub/orchard/commit/d32cc779d816262121b10e2671ecba3fd6059d10))

## [0.42.0](https://github.com/hackclub/orchard/compare/cli/v0.41.1...cli/v0.42.0) (2026-11-09)


### Features

* **cli:** ask for the instance on first run ([5dd05b8](https://github.com/hackclub/orchard/commit/5dd05b8e4c6186fec30b610f680e6a6b581d6441))


### Bug Fixes

* **cli:** hide empty session location column ([9f00ef4](https://github.com/hackclub/orchard/commit/9f00ef499465efcf5085b4802f4561d15edab00f))
* **cli:** require a url in the tofu provider ([3a18970](https://github.com/hackclub/orchard/commit/3a18970bc6b5bdcad1f6f2a88d9473cbf8b9b3db))

## [0.41.1](https://github.com/hackclub/orchard/compare/cli/v0.41.0...cli/v0.41.1) (2026-11-09)


### Bug Fixes

* **docs:** correct cli install and login notes ([3305c4f](https://github.com/hackclub/orchard/commit/3305c4fe520716e54ce13b50ea2aacaf4a379868))

## [0.41.0](https://github.com/hackclub/orchard/compare/cli/v0.40.1...cli/v0.41.0) (2026-11-09)


### Features

* **frontend:** pilot skullet measured skeletons ([a65a915](https://github.com/hackclub/orchard/commit/a65a9154d6cdd0dac30043d6b5df3b2b9e8b6336))


### Bug Fixes

* **frontend:** finish skullet pilot states ([5a75e4e](https://github.com/hackclub/orchard/commit/5a75e4e40cdb8f0798f50743ed1229baf0aaa653))

## [0.40.1](https://github.com/hackclub/orchard/compare/cli/v0.40.0...cli/v0.40.1) (2026-11-09)


### Bug Fixes

* **cli:** never lose a cancel that races the prompt ([229cfd2](https://github.com/hackclub/orchard/commit/229cfd215097558c39441f6f59f5cf6b1ffd955a))

## [0.40.0](https://github.com/hackclub/orchard/compare/cli/v0.39.0...cli/v0.40.0) (2026-11-09)


### Features

* **cli:** contexts for multiple orchard instances ([065e172](https://github.com/hackclub/orchard/commit/065e1729710b9f3e2623f9187581e66c0155fcbe))

## [0.39.0](https://github.com/hackclub/orchard/compare/cli/v0.38.0...cli/v0.39.0) (2026-11-08)


### Features

* **cli:** add orchard doctor ([8d3914d](https://github.com/hackclub/orchard/commit/8d3914da174c946e770d7e2a0d6ae185c405de33))
* **docs:** add orchard doctor page ([08875f6](https://github.com/hackclub/orchard/commit/08875f6f9a3e1fcd9a52bcd451f8a96a5b34cd69))

## [0.38.0](https://github.com/hackclub/orchard/compare/cli/v0.37.1...cli/v0.38.0) (2026-11-05)


### Features

* **cli:** warn about open paths on a domain ([8132f0a](https://github.com/hackclub/orchard/commit/8132f0a4bcfcf9e31e1de34c3e7e43f1e11aee74))


### Bug Fixes

* **grafts:** require exec to set sandbox credentials ([72add1b](https://github.com/hackclub/orchard/commit/72add1b40ed462b173b891db4a51795a51ec754b))

## [0.37.1](https://github.com/hackclub/orchard/compare/cli/v0.37.0...cli/v0.37.1) (2026-11-05)


### Bug Fixes

* **cli:** explain org sso refusals ([30fd077](https://github.com/hackclub/orchard/commit/30fd077698b14ee18a7e5ceaad3c9328cab23297))
* **cli:** keep secrets out of orchard up ([db762ee](https://github.com/hackclub/orchard/commit/db762eec15605c10abb88b8730098be31a5eead8))
* **server:** move to zod 4 ([5fe7fe4](https://github.com/hackclub/orchard/commit/5fe7fe4c11c69f909e65ae2d920dab26e2678c0a))

## [0.37.0](https://github.com/hackclub/orchard/compare/cli/v0.36.0...cli/v0.37.0) (2026-11-02)


### Features

* **cli:** prompt for Orchard instance during login ([#199](https://github.com/hackclub/orchard/issues/199)) ([a06ab1d](https://github.com/hackclub/orchard/commit/a06ab1d53e39f219dea19d15fc7839f399f3ecca))

## [0.36.0](https://github.com/hackclub/orchard/compare/cli/v0.35.0...cli/v0.36.0) (2026-11-01)


### Features

* **server:** search github repos instead of listing all ([a2a5119](https://github.com/hackclub/orchard/commit/a2a5119bc3f5dc9ccbac30a58dd6416cee931179))

## [0.35.0](https://github.com/hackclub/orchard/compare/cli/v0.34.0...cli/v0.35.0) (2026-11-01)


### Features

* request data, attack signals, image scanning and database protection only show what an instance can actually do ([66891ce](https://github.com/hackclub/orchard/commit/66891cedb987beabeac86608d984f02d8c8982c4))

## [0.34.0](https://github.com/hackclub/orchard/compare/cli/v0.33.1...cli/v0.34.0) (2026-11-01)


### Features

* **cli:** db fork, checkpoints, operations, restore tests, diagnose, activity, protection, pooler, trash, replication and users, plus rollback --restore-databases ([08d99d8](https://github.com/hackclub/orchard/commit/08d99d845cda7ed2d638c5b148137408d24f193d))
* **cli:** db versions, db security and db upgrade ([f527592](https://github.com/hackclub/orchard/commit/f5275925d52b1d7506e693072a6350378a2a6616))
* image scanning picks harbor or the bundled trivy scanner, off until a superadmin turns it on ([6a6ed12](https://github.com/hackclub/orchard/commit/6a6ed124464e04a2c5cccda2b15b43e10347de3e))
* release notes get their own ui release track and load at runtime, so a note never bumps the frontend ([4ef98ee](https://github.com/hackclub/orchard/commit/4ef98ee9843cf87bca7c7d158ec9c27e84a71385))
* **server:** attack attempts are classified from access logs and an app can be rate-limited in one click ([77a5c46](https://github.com/hackclub/orchard/commit/77a5c46d8daf4cce3b43fd2b707ac364e2851757))
* **server:** bound databases and apps report their health in plain lines, and database restarts become causes ([a1bc597](https://github.com/hackclub/orchard/commit/a1bc597cae7be208a6d39d23e3191562a8c42a70))
* **server:** one diagnosis call composes health, verdicts, findings, changes, resources, requests and security, and mcp agents can use all of it ([4d3cc52](https://github.com/hackclub/orchard/commit/4d3cc5270ee97c331c254696c7658d3203854c61))

## [0.33.1](https://github.com/hackclub/orchard/compare/cli/v0.33.0...cli/v0.33.1) (2026-10-27)


### Bug Fixes

* keep compose services in place on redeploy so domains and volumes survive ([cc3b724](https://github.com/hackclub/orchard/commit/cc3b7241fb0ce64be8187e30039a82ed438638d3))

## [0.33.0](https://github.com/hackclub/orchard/compare/cli/v0.32.0...cli/v0.33.0) (2026-10-27)


### Features

* let project members pick the builder ([0fc40e3](https://github.com/hackclub/orchard/commit/0fc40e31604c3a762be64200f593d2228c3c41fd))

## [0.32.0](https://github.com/hackclub/orchard/compare/cli/v0.31.1...cli/v0.32.0) (2026-10-26)


### Features

* share organization registry credentials across projects ([#162](https://github.com/hackclub/orchard/issues/162)) ([ec5a3c2](https://github.com/hackclub/orchard/commit/ec5a3c2340e8ab71aa95d1e6623291174d4b98db))

## [0.31.1](https://github.com/hackclub/orchard/compare/cli/v0.31.0...cli/v0.31.1) (2026-10-21)


### Bug Fixes

* build go binaries with go 1.26.10 and bump cli grpc and x/net for open advisories ([576c8ac](https://github.com/hackclub/orchard/commit/576c8ac59c882677d503ff0135c23495fed919c7))
* bump cli grpc to 1.83.2 ([907da02](https://github.com/hackclub/orchard/commit/907da0237780ee81859fd5e6a2381e3071654ae6))

## [0.31.0](https://github.com/hackclub/orchard/compare/cli/v0.30.0...cli/v0.31.0) (2026-10-20)


### Features

* **server:** route builds to the firecracker builder behind a posthog flag ([7bdf7bc](https://github.com/hackclub/orchard/commit/7bdf7bc1ac59593d1a4e4d505d7ab47f69cb17d0))

## [0.30.0](https://github.com/hackclub/orchard/compare/cli/v0.29.0...cli/v0.30.0) (2026-10-16)


### Features

* greenhouse opens folders anywhere, runs named commands and names sessions ([5043f0c](https://github.com/hackclub/orchard/commit/5043f0c27aa4c8603a22a97ca68683c2bcec742d))

## [0.29.0](https://github.com/hackclub/orchard/compare/cli/v0.28.1...cli/v0.29.0) (2026-10-15)


### Features

* greenhouse agents sign in from settings and the model picker lists agents cleanly ([0395d45](https://github.com/hackclub/orchard/commit/0395d45ca4d6c71c194974432eb5f940b9c97f26))


### Bug Fixes

* agentd pool tests no longer depend on how full the disk is ([1a2748a](https://github.com/hackclub/orchard/commit/1a2748ae06b05d2fcafcdc8b882b5be6de0d1b45))
* cli parity follows graft route aliases and the agent sign-in routes are covered ([8adb384](https://github.com/hackclub/orchard/commit/8adb384bb2c1121225b6229c36661e33597bd3eb))

## [0.28.1](https://github.com/hackclub/orchard/compare/cli/v0.28.0...cli/v0.28.1) (2026-10-14)


### Bug Fixes

* **cli:** agentd is unix only so the windows release builds again ([681e17c](https://github.com/hackclub/orchard/commit/681e17c45716514474b4dcba0f3d6442e15cf5f9))

## [0.28.0](https://github.com/hackclub/orchard/compare/cli/v0.27.0...cli/v0.28.0) (2026-10-14)


### Features

* **cli:** orchard sandbox agentd runs scripts, acp agents and a warm worktree pool inside machines ([1987ed7](https://github.com/hackclub/orchard/commit/1987ed78b3a68ce9f4c0e228989a12163f1f9d6c))

## [0.27.0](https://github.com/hackclub/orchard/compare/cli/v0.26.0...cli/v0.27.0) (2026-10-14)


### Features

* greenhouse runs as a graft ([7a808df](https://github.com/hackclub/orchard/commit/7a808df9cc102446361b5369d7ea0b01172e3e87))

## [0.26.0](https://github.com/hackclub/orchard/compare/cli/v0.25.0...cli/v0.26.0) (2026-10-09)


### Features

* **cli:** orchard claude import, list and remove your claude code setup ([d318cf0](https://github.com/hackclub/orchard/commit/d318cf09f21bc7a8d7957bb924ebca2ab3e66f77))

## [0.25.0](https://github.com/hackclub/orchard/compare/cli/v0.24.0...cli/v0.25.0) (2026-10-09)


### Features

* greenhouse chat tabs can be deleted from their close button, with a confirm ([7909a5c](https://github.com/hackclub/orchard/commit/7909a5ce4c2a88e724f9d862491f6ec149ab6352))

## [0.24.0](https://github.com/hackclub/orchard/compare/cli/v0.23.0...cli/v0.24.0) (2026-10-09)


### Features

* greenhouse answers agent permissions, questions and plan handoffs inline, repos get icons, and the title bar tells machines from repos ([b2736fe](https://github.com/hackclub/orchard/commit/b2736fe5397d1386a3a6d4d9d459e8b2a6998691))
* greenhouse gets a title bar with floating panels, two line sessions you can delete, a settings dialog with appearance and usage, live cpu and memory for every machine, and a calmer home ([5640c07](https://github.com/hackclub/orchard/commit/5640c070a01a0cc6b58a8890458f62525acb2b8f))
* greenhouse model switcher with favourites and effort, mcp server manager, context and claude usage popover, and machine usage in the menu ([de256d1](https://github.com/hackclub/orchard/commit/de256d160c0406d7a48eefec77efed474370f4de))


### Bug Fixes

* greenhouse sessions open instantly, chats get live updates from worktrees, agent errors show, ports hide infrastructure, agents can write setup scripts and sandbox terminals predict keystrokes ([a96b6ac](https://github.com/hackclub/orchard/commit/a96b6acc4600aa914d12d39db32fd76b5f48097e))

## [0.23.0](https://github.com/hackclub/orchard/compare/cli/v0.22.0...cli/v0.23.0) (2026-10-08)


### Features

* cli sandbox bridge, one time editor ssh setup and runner flag ([8338e92](https://github.com/hackclub/orchard/commit/8338e92c4665be70ddbe82e43d5c2f13e2eca93c))
* greenhouse keeps share and slack tokens out of analytics, shows admins a lifecycle only view, and refreshes credits ([ea01fbc](https://github.com/hackclub/orchard/commit/ea01fbc0e6a42fc72e548b588b0eccbaa402c6b5))
* greenhouse previews, project links, forks, share links, mcp tools, issue and slack kickoff, and per person git identity ([1214bdb](https://github.com/hackclub/orchard/commit/1214bdb9c1965aa7d52f9108ce9490740f977628))
* vercel sandbox runner, worktree sessions, shared tmux terminals and host and guest multiplayer for greenhouse ([a0c17ea](https://github.com/hackclub/orchard/commit/a0c17ead69b1d8f8ce2933238ddbaab877047ae0))


### Bug Fixes

* greenhouse chart, previews, pr drafts, prompt attribution, retries, bridge checksums and access hardening ([82592fd](https://github.com/hackclub/orchard/commit/82592fd984d9415069ae4faa759176cde23f4069))
* greenhouse security review, proxied content types, scoped mcp tokens, origin checks on upgrades, env var and credential helper confinement ([28669c8](https://github.com/hackclub/orchard/commit/28669c84beb08e61817d0a6497da113e659ed3a9))
* map the slack link preview route in cli parity and format greenhouse docs ([2b54257](https://github.com/hackclub/orchard/commit/2b54257e2d63c569d92419af9a2612607121acb6))

## [0.22.0](https://github.com/hackclub/orchard/compare/cli/v0.21.0...cli/v0.22.0) (2026-10-08)


### Features

* deleting a project or environment tears down everything it owned, asks you to type its name, and audits every child ([0357a83](https://github.com/hackclub/orchard/commit/0357a83175e4eb963436c605ebd5bdbdea843b47))

## [0.21.0](https://github.com/hackclub/orchard/compare/cli/v0.20.0...cli/v0.21.0) (2026-10-07)


### Features

* shell tabs survive a reload, sandbox shells resize, cli sends its size, gpu rendering toggle ([0b713f1](https://github.com/hackclub/orchard/commit/0b713f1a58e0049c3e7f8ae6a7cd027a657c4d59))


### Bug Fixes

* ci exec tests, e2e frontend origin, and superadmin template routes out of cli parity ([d4696a2](https://github.com/hackclub/orchard/commit/d4696a210d7d21c178656c90c3494f86d24dc946))

## [0.20.0](https://github.com/hackclub/orchard/compare/cli/v0.19.0...cli/v0.20.0) (2026-10-07)


### Features

* web terminal on xterm.js with overlay predictions and stable database consoles ([f743331](https://github.com/hackclub/orchard/commit/f743331f72ffb1b8dec6912c9e4fc5f1dd34ec98))

## [0.19.0](https://github.com/hackclub/orchard/compare/cli/v0.18.2...cli/v0.19.0) (2026-10-07)


### Features

* per-project registry credentials for pulling private images ([3b28852](https://github.com/hackclub/orchard/commit/3b28852869cb2d343ad8c534e6962a4757392ef1))

## [0.18.2](https://github.com/hackclub/orchard/compare/cli/v0.18.1...cli/v0.18.2) (2026-09-30)


### Bug Fixes

* otp stays out of logs, scim cannot mint owners, deeper audit redaction ([912db6a](https://github.com/hackclub/orchard/commit/912db6ad1a2c22a860744d65c662d99ae7515c8e))

## [0.18.1](https://github.com/hackclub/orchard/compare/cli/v0.18.0...cli/v0.18.1) (2026-09-29)


### Bug Fixes

* the r2 proxy refuses copies, bucket writes and out-of-prefix deletes, cookie sessions cannot mutate from other origins, trusted images are docker hub only, the mcp consent page and asset proxy pin their origins, the cli token never enters a url, logout is a post, and the k3s kubeconfig is private ([90ac6fc](https://github.com/hackclub/orchard/commit/90ac6fcf5bafc0b05488449bdd72ece7c32e88d4))

## [0.18.0](https://github.com/hackclub/orchard/compare/cli/v0.17.0...cli/v0.18.0) (2026-09-28)


### Features

* a credits page with live contributors, and third-party notices in every app, image and binary ([168c584](https://github.com/hackclub/orchard/commit/168c584bc5de82dd085d6148c54f44f8f61ebc37))
* a stopped app holds its pushes, start builds the newest one, and redeploy starts it ([2fd976f](https://github.com/hackclub/orchard/commit/2fd976f30f1edd865b5947ded6b7e2603e5b8451))
* an anomalies card on projects, apps and databases that names what is wrong and the one action that helps ([4dc261f](https://github.com/hackclub/orchard/commit/4dc261fb7f5d980f962802d70a9adbed03984dff))
* redirects can be edited in place, including the domain, from the app, the cli and mcp ([0b0ded2](https://github.com/hackclub/orchard/commit/0b0ded26f40a8dbb54ded854d9511a0ae6355251))
* the command palette searches every organization you belong to and switches on select ([6c6b41d](https://github.com/hackclub/orchard/commit/6c6b41d92d4159ac8f0e2b3e9206082d5f376c5e))

## [0.17.0](https://github.com/hackclub/orchard/compare/cli/v0.16.0...cli/v0.17.0) (2026-09-27)


### Features

* activity timeline per app with live audit events ([8abc9e4](https://github.com/hackclub/orchard/commit/8abc9e4603f01c52cec168ff669cc6d697224785))
* git providers per user with instance-registered oauth apps and per-connection webhook secrets ([b5584ac](https://github.com/hackclub/orchard/commit/b5584ac18baaedf5a42dc654be590eb3360341ef))
* palette actions with frecency, orchard top and orchard console ([5dd7480](https://github.com/hackclub/orchard/commit/5dd7480321191214ab73e3184954704be219db1a))
* public status pages with hosts, derived from crash state, replicas and alerts ([efa60a9](https://github.com/hackclub/orchard/commit/efa60a97818e96fcaad53ef5eae94207a015b7e9))
* resource bindings so apps follow a database across restores and password rotation ([ad9c7f4](https://github.com/hackclub/orchard/commit/ad9c7f4e5c8b73a24160d29da955b9e1c9934fd9))
* rollout gate with auto rollback, blue/green deploys and releases ([7cc9bc1](https://github.com/hackclub/orchard/commit/7cc9bc1068cff1dbb837d0f99d2e8ebe4018e7ad))
* score.yaml workloads and a terraform and opentofu provider on the cli api client ([33db897](https://github.com/hackclub/orchard/commit/33db89754e915b13ec0d40bcee4445a474108b6e))
* threshold alerts on app metrics with a shared metrics client ([e36774c](https://github.com/hackclub/orchard/commit/e36774c484955b5b68593b97b74284233ce14395))


### Bug Fixes

* cli terminal sessions printed the exec attach handshake frame ([854685c](https://github.com/hackclub/orchard/commit/854685ccaedebd98dd1cb8ca859daf1f44094750))

## [0.16.0](https://github.com/hackclub/orchard/compare/cli/v0.15.1...cli/v0.16.0) (2026-09-18)


### Features

* persist the dockerfile build stage and expose it in the ui, mcp and cli ([8575b56](https://github.com/hackclub/orchard/commit/8575b566b7460c1f961f6b9a8e98e719b2ddb1b0))

## [0.15.1](https://github.com/hackclub/orchard/compare/cli/v0.15.0...cli/v0.15.1) (2026-09-15)


### Bug Fixes

* **api:** return the URL for every ingress instead of letting clients guess it ([41226d7](https://github.com/hackclub/orchard/commit/41226d7f6edbcfe44af39bd06602eaa301fa7cd5))

## [0.15.0](https://github.com/hackclub/orchard/compare/cli/v0.14.0...cli/v0.15.0) (2026-09-14)


### Features

* probe apps with the HEALTHCHECK their Dockerfile declares ([#44](https://github.com/hackclub/orchard/issues/44)) ([4afc98b](https://github.com/hackclub/orchard/commit/4afc98b71eaf5e83ed2d4135c29c54cb43b00fde))


### Bug Fixes

* **server:** make a deployment's secret env vars write-only and encrypted at rest ([d5f82d9](https://github.com/hackclub/orchard/commit/d5f82d99b07ddfabd8995fcf96c37ae8875c25fb))

## [0.14.0](https://github.com/hackclub/orchard/compare/cli/v0.13.1...cli/v0.14.0) (2026-09-04)


### Features

* warn when auto-deploy is enabled but not connected ([e4453d3](https://github.com/hackclub/orchard/commit/e4453d3f279dc5b29ca562ea0eeff5d95a91422a))

## [0.13.1](https://github.com/hackclub/orchard/compare/cli/v0.13.0...cli/v0.13.1) (2026-09-02)


### Bug Fixes

* pin the go toolchain floor so the stdlib patches land ([b1d2b0e](https://github.com/hackclub/orchard/commit/b1d2b0e8e125a959b9b21ca5a8d87cef989a539e))

## [0.13.0](https://github.com/hackclub/orchard/compare/cli/v0.12.0...cli/v0.13.0) (2026-09-01)


### Features

* watch paths for github auto-deploy ([06b1e44](https://github.com/hackclub/orchard/commit/06b1e4426655bb2c40ea32c7a2a6b33641f2b862))


### Bug Fixes

* match express 5 splat routes in the cli parity map ([024b94b](https://github.com/hackclub/orchard/commit/024b94b034f6994fd8f96f2c415c586f738e9581))

## [0.12.0](https://github.com/LeafdTK/leaf/compare/cli/v0.11.0...cli/v0.12.0) (2026-08-28)


### Features

* transfer project ownership by request and accept ([36bf9a7](https://github.com/LeafdTK/leaf/commit/36bf9a761fd7ae0e4df84e29fe6e11ac09a70e37))

## [0.11.0](https://github.com/LeafdTK/leaf/compare/cli/v0.10.0...cli/v0.11.0) (2026-08-27)


### Features

* database health is informer-driven with crash alerts and post-mortem logs ([06fc147](https://github.com/LeafdTK/leaf/commit/06fc147d20cf8a0a203ca3dbf11e8c665690bac7))
* next steps checklist on the app overview ([b6566b8](https://github.com/LeafdTK/leaf/commit/b6566b8addff2a5b66285216b59788be28bc54c0))
* per-app image pull policy so restart can re-pull a moving tag ([3253561](https://github.com/LeafdTK/leaf/commit/3253561ac68c450d345a38656f23ea4da55fd1e1))
* pull policy follows the image tag unless you pin it ([e5fb253](https://github.com/LeafdTK/leaf/commit/e5fb2532139cf419cf63075060b4872e768537c9))


### Bug Fixes

* format docs and close the cli route parity gaps ([b495832](https://github.com/LeafdTK/leaf/commit/b495832ae8fd57254fc9a0e732730199c5c01285))

## [0.10.0](https://github.com/LeafdTK/leaf/compare/cli/v0.9.0...cli/v0.10.0) (2026-08-25)


### Features

* dns-verified org domains, tenant-scoped sso sessions, sso off by default ([61eeaa7](https://github.com/LeafdTK/leaf/commit/61eeaa7716bad680433f7fdc93d1f7f87506b796))

## [0.9.0](https://github.com/LeafdTK/leaf/compare/cli/v0.8.0...cli/v0.9.0) (2026-08-24)


### Features

* multi-provider sso with org login pages and per-org admin controls ([00cc117](https://github.com/LeafdTK/leaf/commit/00cc1172b6cbf07c896f9dfe641b997f08686e07))

## [0.8.0](https://github.com/LeafdTK/leaf/compare/cli/v0.7.0...cli/v0.8.0) (2026-08-05)


### Features

* sandbox boot phases and terminal readiness gate ([9f95737](https://github.com/LeafdTK/leaf/commit/9f95737e55b3ef9a5e8629c75e8fe75c72291d14))


### Bug Fixes

* scope scim-managed profiles to the provisioning org ([5588231](https://github.com/LeafdTK/leaf/commit/55882318fc0b22931a0aa51d2fe16afa40b5bc35))

## [0.7.0](https://github.com/LeafdTK/leaf/compare/cli/v0.6.0...cli/v0.7.0) (2026-08-05)


### Features

* bootstrap sandboxes from stock debian with setup scripts ([05a266a](https://github.com/LeafdTK/leaf/commit/05a266a1bbfbb66bebfc6204e5088306112d898b))
* conductor style workspace and multi repo sandboxes ([96d1dd4](https://github.com/LeafdTK/leaf/commit/96d1dd49925225dc902afb0332cbdde973a6fbd5))
* full git operations for sandbox workspace ([c7f2b75](https://github.com/LeafdTK/leaf/commit/c7f2b754822fe2f46660823ae482a39c7c95d095))
* greenhouse ai sandboxes ([31e2325](https://github.com/LeafdTK/leaf/commit/31e23252b882f05daba9740df85bc621c8c93002))
* ide style cloud code workspace with live git changes ([0126efa](https://github.com/LeafdTK/leaf/commit/0126efa1eab06f9b5509912afc45725a6f68b967))
* opencode serve harness with proxy and native chat sessions ([e520d80](https://github.com/LeafdTK/leaf/commit/e520d80bf85c3c830b4b1653745f5d9f01334c6e))
* orchard mcp by default plus git and file endpoints ([9396499](https://github.com/LeafdTK/leaf/commit/93964994070821a51e61e6e7674b9ef87befbb71))
* sandbox cards, ssh identities, and cloud code chat ([e09fa8e](https://github.com/LeafdTK/leaf/commit/e09fa8ea3ae7d18ab405f53e0f1e80f38405901c))
* sandbox conversations with disk backed history and markdown transcript ([1032977](https://github.com/LeafdTK/leaf/commit/10329772860dbc5d9f5da9d7b11243bcb0c7a622))

## [0.6.0](https://github.com/LeafdTK/leaf/compare/cli/v0.5.0...cli/v0.6.0) (2026-07-28)


### Features

* **builder:** detect frameworks and expose build overrides on railpack builds ([d827c87](https://github.com/LeafdTK/leaf/commit/d827c87780f095f389b3d06759aa5a529074e228))

## [0.5.0](https://github.com/LeafdTK/leaf/compare/cli/v0.4.0...cli/v0.5.0) (2026-07-22)


### Features

* auto-generated protected url on deployment create ([ad7b7d2](https://github.com/LeafdTK/leaf/commit/ad7b7d2a5be0319cef570e6b8fb7ddd80aeaefd9))
* cli spinner, orchard open, deploy success block ([4d5bba4](https://github.com/LeafdTK/leaf/commit/4d5bba44c725b38f5c88cae843056b6de930c20d))
* live build log streaming over sse ([32e8b2f](https://github.com/LeafdTK/leaf/commit/32e8b2f4aadd4fbe66c61cbdea658ca4033a4cf5))
* one-shot github import endpoint and orchard import ([70398a2](https://github.com/LeafdTK/leaf/commit/70398a2efac3300e7400b951a7cca016ca351fc6))
* orchard env pull ([ce899ca](https://github.com/LeafdTK/leaf/commit/ce899ca6b79bb5df1eb0b51a8299ecd1d8430065))
* orchard link per-directory project context ([8f557b5](https://github.com/LeafdTK/leaf/commit/8f557b5ef493000bf00be770843ae1b231319df6))
* orchard up local directory deploys ([685b735](https://github.com/LeafdTK/leaf/commit/685b7350af9cff84abf50ac42e02339a3a3c558a))
* runtime log streaming over sse and event-driven metrics refresh ([81dc35f](https://github.com/LeafdTK/leaf/commit/81dc35fc16953aba8a58d3a60f6e70899d33806c))

## [0.4.0](https://github.com/LeafdTK/leaf/compare/cli/v0.3.2...cli/v0.4.0) (2026-07-21)


### Features

* allow overriding cli default api url via ldflags ([bbb6143](https://github.com/LeafdTK/leaf/commit/bbb6143cd3fec40c2a6310f293ddd01272c1f466))

## [0.3.2](https://github.com/LeafdTK/leaf/compare/cli/v0.3.1...cli/v0.3.2) (2026-07-16)


### Bug Fixes

* **cli:** brew cask links binary orchard, not the cask name ([f4551a5](https://github.com/LeafdTK/leaf/commit/f4551a5508b2b048bdae7d37b9b305d3e16ad9c9))

## [0.3.1](https://github.com/LeafdTK/leaf/compare/cli/v0.3.0...cli/v0.3.1) (2026-07-16)


### Bug Fixes

* **cli:** publish release binaries to public orchard-releases repo ([a44085c](https://github.com/LeafdTK/leaf/commit/a44085c8fb353500729dd9a350f2b89b0707ba42))
* **cli:** rename brew cask to orchard-cli, homebrew core owns orchard ([75e49ab](https://github.com/LeafdTK/leaf/commit/75e49ab0ce99a2ea8f88fd0bcfd7843bfed07c7e))

## [0.3.0](https://github.com/LeafdTK/leaf/compare/cli/v0.2.0...cli/v0.3.0) (2026-07-16)


### Features

* **cli:** database screen with backups, extensions, metrics and psql ([ffcf1d2](https://github.com/LeafdTK/leaf/commit/ffcf1d201ffb8f7676681ec7f6a14921f2dcc090))
* **cli:** deployment screen tabs for deploys, network, storage, resources, advanced ([9923a19](https://github.com/LeafdTK/leaf/commit/9923a195d063e990a9fa20643f7c1cdcd7451a9e))
* **cli:** jobs screens with cron and step editor ([eba1363](https://github.com/LeafdTK/leaf/commit/eba1363d0a5ff2fb8cb230f38923be9833055b90))
* **cli:** org switcher, ctrl+k search and org settings screens ([66467ca](https://github.com/LeafdTK/leaf/commit/66467cab9bc1dff3b2e1d18c3cf9ca40d411e620))
* **cli:** publish brew cask to homebrew-tap on release ([3785757](https://github.com/LeafdTK/leaf/commit/378575722d24b741c423e0f29a0c5d84a5cf074a))
* **cli:** sse live updates and confirm modal in tui ([9ef4809](https://github.com/LeafdTK/leaf/commit/9ef4809f8d30a85fab111b60e0992cea92bb23d7))

## [0.2.0](https://github.com/LeafdTK/leaf/compare/cli/v0.1.0...cli/v0.2.0) (2026-07-15)


### Features

* **cli:** M1 command parity for org, project, env, deploy, db, pod, service, domain ([fc520b6](https://github.com/LeafdTK/leaf/commit/fc520b62adebe5af0de2f3a70437cfc8ecb9165a))
* **cli:** M2 commands for jobs, templates, compose, github, tailscale, webhook ([e5f7591](https://github.com/LeafdTK/leaf/commit/e5f759189ed64e8dd2f6f1c4457bc1a6d1559bff))
* **cli:** M3 streaming (events tail, --follow, --watch) + M5 domains (observe, members, notify, audit, quota, tokens, user) ([82baa6e](https://github.com/LeafdTK/leaf/commit/82baa6ea93833ac3cef1a82590481320f5fc24ff))
* **cli:** M4 distribution (goreleaser, install.sh) + AI polish (AGENTS.md, skill, commands --json, parity gate) ([ec78ebd](https://github.com/LeafdTK/leaf/commit/ec78ebda857e2d6332c8a49b4524240cb5783dfc))
* **cli:** shared infra for parity push (ctx client, SSE, ws exec, scope context, exit codes, wait/pagination) ([2f6262e](https://github.com/LeafdTK/leaf/commit/2f6262eb0f10c04789ecba9c23c4264e75f5de30))

## 0.1.1 (2026-06-16)

### Fixes

- allow dots in github repo names for deploy
