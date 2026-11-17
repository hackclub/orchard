# Changelog

## [2.96.0](https://github.com/hackclub/orchard/compare/server/v2.95.4...server/v2.96.0) (2026-11-17)


### Features

* **frontend:** add app pictures ([91dc44e](https://github.com/hackclub/orchard/commit/91dc44e0538064111ed650cd4be44e92080cc131))


### Bug Fixes

* **chart:** pass the build cache bucket to r2-proxy ([c15684c](https://github.com/hackclub/orchard/commit/c15684cc190c064a66a7b8371281f3ee533add82))
* **greenhouse:** harden machines that run on runc ([057b90b](https://github.com/hackclub/orchard/commit/057b90bbf4d44a5c33ea28f25dce43a8e94ef274))
* **install:** pass registry and tunnel secrets on stdin ([2567151](https://github.com/hackclub/orchard/commit/2567151cdbf510beedfb9b2b4bae44527324173c))
* **mcp:** enforce scope cap on graft tools and api ([e1df4f2](https://github.com/hackclub/orchard/commit/e1df4f2b4ba07bd527d07f26af42975175f58f64))
* **server:** batch mirror heartbeats every 20s ([000dc2d](https://github.com/hackclub/orchard/commit/000dc2d554b699051e7dbe6cd06606d42de5a28d))
* **server:** clone manual builds with the app token ([f59afd1](https://github.com/hackclub/orchard/commit/f59afd1cb61146dc41a0ee54b07aea3d0af7f816))
* **server:** detach removed managed deployment volumes ([#268](https://github.com/hackclub/orchard/issues/268)) ([aab9fbd](https://github.com/hackclub/orchard/commit/aab9fbd4a8efc74f4b8c7a65a2f040c81e0184d0))
* **server:** hide invitations from unverified accounts ([75fd751](https://github.com/hackclub/orchard/commit/75fd75185b36f5aef0e426ef607b4f070cfa218b))
* **server:** keep a service domain in step with its ingress ([e884254](https://github.com/hackclub/orchard/commit/e884254f1c538d0a15ac0e084d033124ddd161d7))
* **server:** keep shared s3 cache keys out of builds ([#4](https://github.com/hackclub/orchard/issues/4)) ([520ed46](https://github.com/hackclub/orchard/commit/520ed463f38c4b7f3e91afb3678bc6612790055e))
* **server:** let the backup proxy read key purposes ([12b1a5a](https://github.com/hackclub/orchard/commit/12b1a5a935a6a7bdb32bba270f1f9eef41bfaad7))
* **server:** limit sandbox mcp tokens to deploy scope ([7a10015](https://github.com/hackclub/orchard/commit/7a1001525d575c7bdd79fa0b51489054367e85ff))
* **server:** log lease, heartbeat and stats fallbacks ([8257259](https://github.com/hackclub/orchard/commit/825725942c68c80d480a9e96d02f407833b32588))
* **server:** measure databases on shared volumes ([e84003e](https://github.com/hackclub/orchard/commit/e84003e4de31fd7d3a25e08929631fd5dd24fd4a))
* **server:** measure shared data dirs every five minutes ([fff677d](https://github.com/hackclub/orchard/commit/fff677d7b8ab9aba497b793881878b1ba85e2e56))
* **server:** name the annotation a build sandbox refuses ([9e3bfc6](https://github.com/hackclub/orchard/commit/9e3bfc6f6e223b2af3f852f11bf9f7ae73f34bff))
* **server:** never cache the orchardctl signing stage ([4df3d9b](https://github.com/hackclub/orchard/commit/4df3d9b872b2b9f5d47e9e0cf728d8462f570f9c))
* **server:** prune old images on any registry ([#265](https://github.com/hackclub/orchard/issues/265)) ([f8806af](https://github.com/hackclub/orchard/commit/f8806afa446ab5581d70e94aa0d41181e0bc3469))
* **server:** read database stats from the metrics store ([3b80a48](https://github.com/hackclub/orchard/commit/3b80a4852b677ae1255d764ed7000269bda04485))
* **server:** refuse yaml alias bombs in compose and score ([f7828b6](https://github.com/hackclub/orchard/commit/f7828b6f3ae69ffba03b76ed76d5d96c4ddd4573))
* **server:** relax the primary lease on single-instance databases ([d407a0c](https://github.com/hackclub/orchard/commit/d407a0c2062cdb0b2b7a64a97296d44d95a7f42f))
* **server:** renew held leases with one write every 10s ([df6e230](https://github.com/hackclub/orchard/commit/df6e230534bb6cb7530b97595ab7c532d4eff18a))
* **server:** repin skopeo after quay re-pushed v1.24.1 again ([e0b03e7](https://github.com/hackclub/orchard/commit/e0b03e787b0147419f5b6aad2bf28821c07aa5a9))
* **server:** require a fresh sign-in to weaken sign-in ([9d085c7](https://github.com/hackclub/orchard/commit/9d085c7fd82a642913c9c50d223bb36bbcbb8d2d))
* **server:** run the mcp image from compiled output ([9e06cdc](https://github.com/hackclub/orchard/commit/9e06cdcebb81a94b4b51877985d7909415e5882b))
* **server:** skip the metrics store when it isn't there ([93852ec](https://github.com/hackclub/orchard/commit/93852ec59e1f7438d7d6239033ad4a7674c1e0fc))
* **server:** stop listing backups from pruning them ([3d98b3f](https://github.com/hackclub/orchard/commit/3d98b3f9bc619e593cb44aa002c340ad2f4f06c9))
* **server:** use a __Host- session cookie ([eb53eed](https://github.com/hackclub/orchard/commit/eb53eed64fd78578cf3134232b2a8182360e87bc))
* **server:** verify oidc emails and add pkce ([13f17f0](https://github.com/hackclub/orchard/commit/13f17f0489fc85e9c58c9074115e9fcfa765a66b))

## [2.95.4](https://github.com/hackclub/orchard/compare/server/v2.95.3...server/v2.95.4) (2026-11-11)


### Bug Fixes

* **server:** bring existing policies up to date after upgrades ([568cc2c](https://github.com/hackclub/orchard/commit/568cc2ce30118ac16ee2128af292690536a25cac))

## [2.95.3](https://github.com/hackclub/orchard/compare/server/v2.95.2...server/v2.95.3) (2026-11-10)


### Bug Fixes

* **server:** classify limits routes, type replica fallback ([326c642](https://github.com/hackclub/orchard/commit/326c642ec683dcfeb35eebf11631113555d8fdc3))

## [2.95.2](https://github.com/hackclub/orchard/compare/server/v2.95.1...server/v2.95.2) (2026-11-10)


### Bug Fixes

* **server:** drop stale mail port egress comment ([56df7c0](https://github.com/hackclub/orchard/commit/56df7c0a1569f6ba5e6cef1abd11cd4ad8416a37))

## [2.95.1](https://github.com/hackclub/orchard/compare/server/v2.95.0...server/v2.95.1) (2026-11-10)


### Bug Fixes

* **server:** drop the mirror on a cluster change ([af72be8](https://github.com/hackclub/orchard/commit/af72be801e4319609da06c64bd3da45045b03ace))
* **server:** keep ingress rows the mirror never saw ([7a3dc27](https://github.com/hackclub/orchard/commit/7a3dc27748461120514c5ce3d1f0a68963e29807))
* **server:** keep projects whose namespace was never seen ([2aee5a6](https://github.com/hackclub/orchard/commit/2aee5a6bf97b9c835c775b49c7d32aef18e538e5))
* **server:** stop denying smtp egress from tenants ([70d54bf](https://github.com/hackclub/orchard/commit/70d54bfb25800392711fa941b54c98abdbeb3a03))

## [2.95.0](https://github.com/hackclub/orchard/compare/server/v2.94.1...server/v2.95.0) (2026-11-09)


### Features

* **docs:** add DEVELOPERS.md with tenancy model ([8a258ca](https://github.com/hackclub/orchard/commit/8a258cae272dc030db772b30a625496f01ec378b))
* **frontend:** add source link to account menu ([5eb4acd](https://github.com/hackclub/orchard/commit/5eb4acd128555c0ae02fbe18c44d3a7ddf7bb74e))


### Bug Fixes

* **chart:** move redis to 8.10.3 ([4fe5857](https://github.com/hackclub/orchard/commit/4fe5857557f47e112f00a461726f40e4281d4c87))
* **install:** warn on low memory instead of stopping ([f9f588e](https://github.com/hackclub/orchard/commit/f9f588eb42f716c03f86600c59d6a379fe2b9a77))
* **server:** make sign-in location lookup opt-in ([29c0cc8](https://github.com/hackclub/orchard/commit/29c0cc8c9e3f8fa19502fb022fd588b821312482))

## [2.94.1](https://github.com/hackclub/orchard/compare/server/v2.94.0...server/v2.94.1) (2026-11-09)


### Bug Fixes

* **chart:** scrape node exporter with credentials ([e055c51](https://github.com/hackclub/orchard/commit/e055c5164978bce07048cced7755af4382613217))
* **install:** enable rootless builds on ubuntu ([5d84df6](https://github.com/hackclub/orchard/commit/5d84df64ba4063b74820e4b09060a578abd806b4))
* **install:** mention sandboxes in the summary ([d5b5080](https://github.com/hackclub/orchard/commit/d5b508053ebfed4b54d3c7a052783d0bbd00ed08))
* **install:** pin images with the chart version ([7587077](https://github.com/hackclub/orchard/commit/7587077f9149a2879ff16415201980615d9e8451))
* **install:** refuse release tags for image-tag ([2850cfa](https://github.com/hackclub/orchard/commit/2850cfa367e39748aeb2ea87c821b6315733cf88))
* **install:** run the installer from a file ([4fbbca7](https://github.com/hackclub/orchard/commit/4fbbca7d8a06a29dc02ecc93a30a810c72e8f410))
* **install:** verify host commands on first install ([5f78f15](https://github.com/hackclub/orchard/commit/5f78f158c5c8e0fcf0596fdae52cabed15fbf2f5))
* **server:** disable prisma checkpoint ([f4b906e](https://github.com/hackclub/orchard/commit/f4b906e9cf5eea76af51f0db6e47234de7d5dc15))
* **server:** require signed registry indexes ([0adcccf](https://github.com/hackclub/orchard/commit/0adcccf1126c494714814364e960860af85a3918))

## [2.94.0](https://github.com/hackclub/orchard/compare/server/v2.93.1...server/v2.94.0) (2026-11-09)


### Features

* **frontend:** pilot skullet measured skeletons ([a65a915](https://github.com/hackclub/orchard/commit/a65a9154d6cdd0dac30043d6b5df3b2b9e8b6336))


### Bug Fixes

* **frontend:** finish skullet pilot states ([5a75e4e](https://github.com/hackclub/orchard/commit/5a75e4e40cdb8f0798f50743ed1229baf0aaa653))

## [2.93.1](https://github.com/hackclub/orchard/compare/server/v2.93.0...server/v2.93.1) (2026-11-09)


### Bug Fixes

* **server:** orchardctl update adds the zot push rule when missing ([2591037](https://github.com/hackclub/orchard/commit/2591037a6a38a68c6496f82503b02d6919446361))

## [2.93.0](https://github.com/hackclub/orchard/compare/server/v2.92.0...server/v2.93.0) (2026-11-09)


### Features

* **server:** disable instead of delete and idp project rules ([7c9881b](https://github.com/hackclub/orchard/commit/7c9881b6c083594214676ca74d6d0051e33cd967))
* **server:** expose sso grants and drop added comments ([09da5d9](https://github.com/hackclub/orchard/commit/09da5d964869e4a8dac4b51bb3ad292a32be21a0))
* **server:** instance scim, org unlink and grant-scoped tokens ([9a67d27](https://github.com/hackclub/orchard/commit/9a67d270cf47b7cf9551ccf11fc9d69ba7cb31c3))
* **server:** org-owned identities, session grants and account links ([d7c6679](https://github.com/hackclub/orchard/commit/d7c667920492a9fe8da94ac27ab0b6f317c26d24))
* **server:** passkey-only accounts and mailbox owner warning ([6da31c1](https://github.com/hackclub/orchard/commit/6da31c15c81addf9c7720352413b2053939465e0))
* **server:** scope account emails and add org identity schema ([38833cd](https://github.com/hackclub/orchard/commit/38833cd53d056e18a974a880e2a8b52f3cee35f7))


### Bug Fixes

* **server:** clear error when sso key is missing ([d772916](https://github.com/hackclub/orchard/commit/d7729165ae853513910dc91be77fde4fe5a5ef05))
* **server:** close idp trust and domain takeover gaps ([dd6f7eb](https://github.com/hackclub/orchard/commit/dd6f7ebd91dfd632b70b3d1da47f971357bc0e18))
* **server:** rbac e2e expects disabled members to keep their row ([b89a521](https://github.com/hackclub/orchard/commit/b89a5211b800d070384aaa57ba7d7142da2f8fa9))

## [2.92.0](https://github.com/hackclub/orchard/compare/server/v2.91.0...server/v2.92.0) (2026-11-08)


### Features

* **server:** add active tenant isolation self-test ([74104ac](https://github.com/hackclub/orchard/commit/74104acd199a5ab2d1f40bf915f3528dddac0c91))
* **server:** add doctor passive configuration checks ([bd74986](https://github.com/hackclub/orchard/commit/bd74986806b8b60eb63e60d8925df1afd2db09f6))
* **server:** add superadmin doctor routes ([bf5a153](https://github.com/hackclub/orchard/commit/bf5a1531df6bd7a0ef24a814310b7364bfbe4fe2))
* **server:** classify every route in an isolation matrix ([923122f](https://github.com/hackclub/orchard/commit/923122f1e10d23e2aa611299def774aa2215889f))
* **server:** default compute caps for new orgs and generous per-org count caps ([5561555](https://github.com/hackclub/orchard/commit/5561555ea75130df99af24ccf849fd6fc83e404f))
* **server:** instance IdP org auto-create and superadmin rule ([7fb72ec](https://github.com/hackclub/orchard/commit/7fb72ecdf4ed0169a387ee1d10cd9bc35dbf4d2d))
* **server:** optional egress bandwidth annotation on tenant pods ([8942051](https://github.com/hackclub/orchard/commit/894205140c353d31bc96e946b406763b42b86bd9))
* **server:** replay every route as foreign principals against a seeded database ([79f377b](https://github.com/hackclub/orchard/commit/79f377b04fd237556e0c1933e7f135f31c1bede2))
* **server:** uncapped new orgs, superadmin instance defaults and per-org count limits ([ce75ebe](https://github.com/hackclub/orchard/commit/ce75ebec0d871006d28a9284bb42e26710a65200))
* **server:** verify the OIDC ID token signature and test the callback end to end ([0646331](https://github.com/hackclub/orchard/commit/0646331408988cb1fc37378ae77772f2c45c4cfa))
* **server:** write SCIM Groups through the group rule resolver ([ce05c92](https://github.com/hackclub/orchard/commit/ce05c9287e627660383da17e3f2a91e24b546f9d))


### Bug Fixes

* **chart:** platform PriorityClass above tenant workloads ([a07edab](https://github.com/hackclub/orchard/commit/a07edab75ddecd6f451fe2d23a0c1a8cd66cb0c9))
* **chart:** throttle tenant log rate per namespace in Vector ([8cdb85b](https://github.com/hackclub/orchard/commit/8cdb85b9eae71211048009725c06aaa9ae629437))
* **server:** answer hidden and missing resources with the same 404 ([fdd64d6](https://github.com/hackclub/orchard/commit/fdd64d68e11cdc2ab7a56ee664e52c2f0fe3217e))
* **server:** authorize before validating on routes that answered foreign ids with 400 ([0843963](https://github.com/hackclub/orchard/commit/08439637575a67f72cf0a47a3229018cd403e27b))
* **server:** avoid control-character regex in mail label ([8d547dd](https://github.com/hackclub/orchard/commit/8d547dde4449389e117837c188bd764574deb5d0))
* **server:** cap concurrent builds per org and claim queued builds fairly ([35a30f1](https://github.com/hackclub/orchard/commit/35a30f19c6fc1687b7b158a0a5055cb8d56e38d8))
* **server:** cap identity provider response bodies at 1 MiB ([975b74e](https://github.com/hackclub/orchard/commit/975b74ec0045ab5e21d9c74fc110da98e0fc45eb))
* **server:** cap multipart upload size, parts and concurrency on every upload route ([f8faaa9](https://github.com/hackclub/orchard/commit/f8faaa90ae1181c9d6ba4d7d2733fe2fe93a25c0))
* **server:** match watch paths with minimatch and reject pathological globs ([f736bf9](https://github.com/hackclub/orchard/commit/f736bf9f14438cf90fe041e23ad1a32388eda1a7))
* **server:** refuse checkpoint group restore and read for foreign databases ([918d08e](https://github.com/hackclub/orchard/commit/918d08e1429e0872cde52895c15d9c1cfd917c17))
* **server:** refuse denied SSE streams with a plain 404 before the head commits ([becf1dc](https://github.com/hackclub/orchard/commit/becf1dcb949c3a6e45abdf7b0aa0c35867c69d4c))
* **server:** reject a failed psql exec instead of hanging ([8599c1e](https://github.com/hackclub/orchard/commit/8599c1efb13ce9662b6d4b469b1be4c5151c004b))
* **server:** require domain proof when signup is open and budget custom domains per org ([55716f1](https://github.com/hackclub/orchard/commit/55716f12a5b83d3cae501610598a16fd99764eba))
* **server:** scope member projects to the token and gate notification scopes by project view ([459d311](https://github.com/hackclub/orchard/commit/459d311ed774ac2efba2741967770bc67d841b4b))
* **server:** split the global invite budget by organization age and degrade instead of blocking ([5170d36](https://github.com/hackclub/orchard/commit/5170d36f988f63954e094d2458650b69a8e59cf7))
* **server:** track mcp client use, prune unused clients, and index error group last seen ([10096ab](https://github.com/hackclub/orchard/commit/10096abd077d5dea60675d3d912f2f2ac02aa5af))

## [2.91.0](https://github.com/hackclub/orchard/compare/server/v2.90.0...server/v2.91.0) (2026-11-05)


### Features

* **server:** warn before installing third-party grafts ([176ccc2](https://github.com/hackclub/orchard/commit/176ccc202b8cb2ddf3cfd477598f642c0528d54e))

## [2.90.0](https://github.com/hackclub/orchard/compare/server/v2.89.0...server/v2.90.0) (2026-11-05)


### Features

* **server:** add optional proof for custom domains ([0ac6f81](https://github.com/hackclub/orchard/commit/0ac6f81bf4dc7e33d1e92a9764d4735af765e680))


### Bug Fixes

* **server:** keep bypass secret out of domain reads ([2a85165](https://github.com/hackclub/orchard/commit/2a85165c1a99bbcf18d371d9ee71a6677553ab3f))
* **server:** keep env values out of all mcp replies ([a702770](https://github.com/hackclub/orchard/commit/a7027706a671bd1d1e5255cac9d11363dc49a003))
* **server:** protect each domain path separately ([1483bad](https://github.com/hackclub/orchard/commit/1483bade8ac6c66bf35c7b585005d32124116193))
* **server:** use real origin for protection sign-in ([f45faf5](https://github.com/hackclub/orchard/commit/f45faf550705cf1c0fb5e18ca40ed61b4a887a4b))

## [2.89.0](https://github.com/hackclub/orchard/compare/server/v2.88.0...server/v2.89.0) (2026-11-05)


### Features

* **server:** check release signatures on hosts ([c66adca](https://github.com/hackclub/orchard/commit/c66adcae35d006b04a9eb81bbd9fadf497298ee5))
* **server:** refuse other projects' images at admission ([8e9bc65](https://github.com/hackclub/orchard/commit/8e9bc6567140f05914c469d47f9ea02553807854))
* **server:** require org sso for tokens and mcp ([6fdbde2](https://github.com/hackclub/orchard/commit/6fdbde2e66d49caeb606307fb5109008bba3f3b2))
* **server:** sign host commands in release images ([68e3ba7](https://github.com/hackclub/orchard/commit/68e3ba75a1495e6db638addebb62ee764a6f8d2c))
* **server:** update bundled images from upstream ([22ee3e2](https://github.com/hackclub/orchard/commit/22ee3e286adc90708e2793f2785b0061cec2fdf7))


### Bug Fixes

* **frontend:** serve only raster images from proxy ([70cef13](https://github.com/hackclub/orchard/commit/70cef1349b1449ed3560b2bc7a7c3923580c107e))
* **grafts:** disclose charts and database access ([ea39796](https://github.com/hackclub/orchard/commit/ea397963d18ed2562c1f733acffdd8d6592c5283))
* **server:** bind sso callbacks to the browser ([52da90b](https://github.com/hackclub/orchard/commit/52da90b1c00279d6b7c56d11c28163d5cd083c3c))
* **server:** block tenant traffic to the platform ([45e7291](https://github.com/hackclub/orchard/commit/45e7291afce9053f63dc0ed17784ad2d13969a03))
* **server:** cap submodule access checks ([6620d90](https://github.com/hackclub/orchard/commit/6620d90fc90f23814eb2b6acdad90fa1500087b3))
* **server:** end log streams when access is lost ([c37bb09](https://github.com/hackclub/orchard/commit/c37bb09e2e570e908e9b64bf77a2006f84a57b04))
* **server:** keep access logs per tenant ([ffc7024](https://github.com/hackclub/orchard/commit/ffc7024c056c9549c18f7a903eafe187c44b5d05))
* **server:** keep clone tokens out of builds ([24567df](https://github.com/hackclub/orchard/commit/24567df96f1c146c8428f2352ab5b0adee1c501b))
* **server:** keep env values out of mcp replies ([8a9e1cc](https://github.com/hackclub/orchard/commit/8a9e1ccfe04ee283058ab40bcb587c9f49661894))
* **server:** keep registry login out of tenant builds ([8bf4e19](https://github.com/hackclub/orchard/commit/8bf4e1937914926a6ea56fd29053320096ebc1c9))
* **server:** keep tenant names independent ([97d2e59](https://github.com/hackclub/orchard/commit/97d2e59b202c45bf787579e80f616ab15d146f57))
* **server:** keep token org limit in terminals ([f8991a9](https://github.com/hackclub/orchard/commit/f8991a903f905cf860d288710b212fdaaa382674))
* **server:** let sso sessions use auth routes ([d58ab9e](https://github.com/hackclub/orchard/commit/d58ab9e75d863b3f1e3ea1efde4b6f8f2de1f579))
* **server:** limit clone tokens to allowed repos ([ac8060a](https://github.com/hackclub/orchard/commit/ac8060a4930d559bb280e226306f0f0093ee30eb))
* **server:** limit protection return urls ([97f90ce](https://github.com/hackclub/orchard/commit/97f90ce43baf7af1ae61713ee4981cfeb8e9ff45))
* **server:** limit what api tokens can reach ([50217f3](https://github.com/hackclub/orchard/commit/50217f3c41511a476833a9decffb3696792e3772))
* **server:** move to zod 4 ([5fe7fe4](https://github.com/hackclub/orchard/commit/5fe7fe4c11c69f909e65ae2d920dab26e2678c0a))
* **server:** pin search path for superuser sql ([fb9ec53](https://github.com/hackclub/orchard/commit/fb9ec533ca8cb1328d3b7913d3c895561bf9ca0e))
* **server:** refuse private database and backup hosts ([5c95aca](https://github.com/hackclub/orchard/commit/5c95aca369cc02f11931683dbdbbf94644817331))
* **server:** require write access to bind github app ([92c61f3](https://github.com/hackclub/orchard/commit/92c61f3e7ec15e97eb23cb8f3a53599699c8b581))
* **server:** stop name collisions across tenants ([1761cdd](https://github.com/hackclub/orchard/commit/1761cddf2edd7c981c1ead2110e25643653e7eff))
* **server:** stop returning github install tokens ([309c5ba](https://github.com/hackclub/orchard/commit/309c5ba5db772cc835b3465a6b9172e5dbfe1a03))
* **server:** throttle unknown tokens by ip ([66008d6](https://github.com/hackclub/orchard/commit/66008d673c823f97a28f5cb58b298644a3b2d186))
* **server:** tighten moves, hostnames and backups ([47b4ca2](https://github.com/hackclub/orchard/commit/47b4ca2ac45ec13304d18d7744b37bd8265df8d5))

## [2.88.0](https://github.com/hackclub/orchard/compare/server/v2.87.0...server/v2.88.0) (2026-11-02)


### Features

* **cli:** prompt for Orchard instance during login ([#199](https://github.com/hackclub/orchard/issues/199)) ([a06ab1d](https://github.com/hackclub/orchard/commit/a06ab1d53e39f219dea19d15fc7839f399f3ecca))


### Bug Fixes

* **server:** first builds use firecracker, stuck sandboxes fail ([1552125](https://github.com/hackclub/orchard/commit/15521253a22aaff1ffd9362b936b45eb0df14192))

## [2.87.0](https://github.com/hackclub/orchard/compare/server/v2.86.0...server/v2.87.0) (2026-11-01)


### Features

* **frontend:** restyle template instance page ([9198416](https://github.com/hackclub/orchard/commit/9198416c385770ac359d71ae28cadae12205b3ad))
* mark template resources on project page ([6b31668](https://github.com/hackclub/orchard/commit/6b316686cbf17fdfcfd86ca50c6f8e8995700905))
* **server:** search github repos instead of listing all ([a2a5119](https://github.com/hackclub/orchard/commit/a2a5119bc3f5dc9ccbac30a58dd6416cee931179))

## [2.86.0](https://github.com/hackclub/orchard/compare/server/v2.85.1...server/v2.86.0) (2026-11-01)


### Features

* copy databases across projects ([6f9edcf](https://github.com/hackclub/orchard/commit/6f9edcfac63c275c045335f1a97eee266b9185bb))
* link findings to their release ([ba87fe8](https://github.com/hackclub/orchard/commit/ba87fe89aef47d2fc37b89dc0bf11cb034d4c382))


### Bug Fixes

* **server:** cache observe capabilities in redis ([cbdacfa](https://github.com/hackclub/orchard/commit/cbdacfaeb404d38342d42f684777d75ed42e83b3))
* **server:** cheaper session checks ([e465908](https://github.com/hackclub/orchard/commit/e4659086d3ff2634f80a8b22f6ea0fc285e359ce))
* **server:** dedupe github token refreshes ([f7b7c2a](https://github.com/hackclub/orchard/commit/f7b7c2ad1bd6a1cb2e4897b3909fdf0d4a72f977))
* **server:** faster deployment detail and metrics ([01d5335](https://github.com/hackclub/orchard/commit/01d533572ca7cd48753f0ade59947939ff460952))
* **server:** faster member usage ([fc03804](https://github.com/hackclub/orchard/commit/fc0380497fa124ddf40d8861487a2b310a3cad7b))
* **server:** faster org overview ([c32f1a5](https://github.com/hackclub/orchard/commit/c32f1a54d7d93dc253bf8d11917c5d55e1d11714))
* **server:** hide credential-like template params ([1778c69](https://github.com/hackclub/orchard/commit/1778c6923e39ca6544e5551629ebab192af68000))
* **server:** only the leader repoints ingress tls, so a dev server or a booting replica can't flip certificates ([031c61a](https://github.com/hackclub/orchard/commit/031c61a70ebe76b3bcff87debf6d603d575e9ddb))
* **server:** per-user github repo cache ([3aafa96](https://github.com/hackclub/orchard/commit/3aafa96d4bbffaf8723273737708962c4ead8b86))
* show org default resource values ([34ce941](https://github.com/hackclub/orchard/commit/34ce941379117840a8f9cd4ab25720758bd5409d))


### Performance Improvements

* **server:** org usage asks victoriametrics seven cluster-wide queries instead of five per app and shares the result through redis ([7ad7753](https://github.com/hackclub/orchard/commit/7ad77537bcf88207496702bd7b741cd19e6acd9f))

## [2.85.1](https://github.com/hackclub/orchard/compare/server/v2.85.0...server/v2.85.1) (2026-11-01)


### Bug Fixes

* **server:** org usage runs a few app queries at a time, shares one run between identical requests and caches it, so a usage page can't knock over victoriametrics ([73e74ee](https://github.com/hackclub/orchard/commit/73e74ee4050f3cbd35d9ab1c0893a2cc78c98f68))

## [2.85.0](https://github.com/hackclub/orchard/compare/server/v2.84.0...server/v2.85.0) (2026-11-01)


### Features

* request data, attack signals, image scanning and database protection only show what an instance can actually do ([66891ce](https://github.com/hackclub/orchard/commit/66891cedb987beabeac86608d984f02d8c8982c4))
* self-hosted installs run logs, metrics, image scanning and local backups by default, and orchardctl update turns them on for existing installs ([524f7d3](https://github.com/hackclub/orchard/commit/524f7d36cf7ec56de8ceff4e82e846e78e5cfc3c))

## [2.84.0](https://github.com/hackclub/orchard/compare/server/v2.83.0...server/v2.84.0) (2026-11-01)


### Features

* **mcp:** every toolset and the exec scope by default, and a scope on the server url can only lower what a connection gets ([a02309f](https://github.com/hackclub/orchard/commit/a02309f0b47988433ea74b8f266f0a0f53f5576c))
* projects order by their latest real activity, from audit events, deploys and builds ([7b73e77](https://github.com/hackclub/orchard/commit/7b73e771337becf9e2c0f73ab2c63729445c2482))
* requests filter by path, status, method, duration and client, and a request opens with its details and the app's logs around it ([9d95a56](https://github.com/hackclub/orchard/commit/9d95a561ed82c674dca3985af926dca747bbe5e3))
* **server:** NOTIFICATIONS_WORKER_DISABLED keeps a replica from sending notifications ([00bf995](https://github.com/hackclub/orchard/commit/00bf99540673c76957d8796cb1b0389eba9f2ff9))


### Bug Fixes

* attack signals fold cluster and private addresses into one hidden source and never call them a flood ([0ebf836](https://github.com/hackclub/orchard/commit/0ebf836882ddd3191d8bc9cc99721137adc45953))
* **server:** projects without an uploaded icon borrow an app's favicon on the overview ([683b8de](https://github.com/hackclub/orchard/commit/683b8de05e1e9652b38d21a5c1f401b0aae1b2da))

## [2.83.0](https://github.com/hackclub/orchard/compare/server/v2.82.1...server/v2.83.0) (2026-11-01)


### Features

* **chart:** orchard-db can archive straight to object storage with a slot cap and an immediate first backup ([9f80aed](https://github.com/hackclub/orchard/commit/9f80aed3192e1f1544f3ff797f734954021f08a4))
* **chart:** orchard-db can archive through the barman cloud plugin, outside databases get a nightly pg_dump, plus a dr runbook ([554ddab](https://github.com/hackclub/orchard/commit/554ddab983227cb9ab8b7aa8cb49bc6ab23544eb))
* computeHealth moves to packages/health so the app page and the server agree on what is wrong ([a017f10](https://github.com/hackclub/orchard/commit/a017f1060b3d1362dd481f738c4f281eb1187c00))
* image scanning picks harbor or the bundled trivy scanner, off until a superadmin turns it on ([6a6ed12](https://github.com/hackclub/orchard/commit/6a6ed124464e04a2c5cccda2b15b43e10347de3e))
* release notes get their own ui release track and load at runtime, so a note never bumps the frontend ([4ef98ee](https://github.com/hackclub/orchard/commit/4ef98ee9843cf87bca7c7d158ec9c27e84a71385))
* **server:** attack attempts are classified from access logs and an app can be rate-limited in one click ([77a5c46](https://github.com/hackclub/orchard/commit/77a5c46d8daf4cce3b43fd2b707ac364e2851757))
* **server:** bound databases and apps report their health in plain lines, and database restarts become causes ([a1bc597](https://github.com/hackclub/orchard/commit/a1bc597cae7be208a6d39d23e3191562a8c42a70))
* **server:** database checkpoints, point in time restores and forks that survive restarts, a 30 day trash, restore tests, pooler, ha and users ([aacf656](https://github.com/hackclub/orchard/commit/aacf6566d5cab78aa67e911037ad058f6d67f18b))
* **server:** database metrics add connections, tps, cache hit, replication lag, size, deadlocks and disk from the cnpg exporter ([048a92a](https://github.com/hackclub/orchard/commit/048a92ab398abdfc8b24af20999411176ba2c389))
* **server:** dns check returns the records to create and accepts a records for root domains ([b20fc93](https://github.com/hackclub/orchard/commit/b20fc93560fbd3dc74cdbdf3415db13678e01831))
* **server:** one diagnosis call composes health, verdicts, findings, changes, resources, requests and security, and mcp agents can use all of it ([4d3cc52](https://github.com/hackclub/orchard/commit/4d3cc5270ee97c331c254696c7658d3203854c61))
* **server:** postgres majors come from the cnpg catalog, rehearsed in-place major upgrades, and cve reports from postgresql.org advisories ([aca4cd4](https://github.com/hackclub/orchard/commit/aca4cd4d758695b21e98ed39a24aaafe7d5d93ce))


### Bug Fixes

* **server:** advisory scores parse even when the html is reflowed, and unused imports are gone ([ee6d1dd](https://github.com/hackclub/orchard/commit/ee6d1ddf497f857efc31f384f0c1bc5d4a25f8da))
* **server:** failed builds report the buildkit error instead of daemon noise ([c4b2b75](https://github.com/hackclub/orchard/commit/c4b2b75e789d92aaac346482b9e06bab8898cf4a))
* **server:** mcp log lines carry one timestamp, not two ([c0005b5](https://github.com/hackclub/orchard/commit/c0005b5a70949761bcc139347e172b83da6626db))
* **server:** point in time restores send postgres a timestamp it accepts, and forks keep the source database name so apps see their data ([64af5ab](https://github.com/hackclub/orchard/commit/64af5ab85200cf0c12c8adceadca4e7913aa1c22))
* **server:** provide the logs store and request services in observability so the app boots ([4e0aa2e](https://github.com/hackclub/orchard/commit/4e0aa2ec39edbf7813a65a9e9bdd7d803846f966))
* **server:** single instance databases get no disruption budget, so drains and updates stop hanging on them ([d4b32ca](https://github.com/hackclub/orchard/commit/d4b32cae290810b7b1779724404677e8ae871544))

## [2.82.1](https://github.com/hackclub/orchard/compare/server/v2.82.0...server/v2.82.1) (2026-10-27)


### Bug Fixes

* keep compose services in place on redeploy so domains and volumes survive ([cc3b724](https://github.com/hackclub/orchard/commit/cc3b7241fb0ce64be8187e30039a82ed438638d3))

## [2.82.0](https://github.com/hackclub/orchard/compare/server/v2.81.1...server/v2.82.0) (2026-10-27)


### Features

* let project members pick the builder ([0fc40e3](https://github.com/hackclub/orchard/commit/0fc40e31604c3a762be64200f593d2228c3c41fd))

## [2.81.1](https://github.com/hackclub/orchard/compare/server/v2.81.0...server/v2.81.1) (2026-10-27)


### Bug Fixes

* **server:** forward saved registry credentials to Firecracker builds ([#188](https://github.com/hackclub/orchard/issues/188)) ([c2bab3b](https://github.com/hackclub/orchard/commit/c2bab3b75e5c7207fedf6cdc9795d7a8f2f6a987))

## [2.81.0](https://github.com/hackclub/orchard/compare/server/v2.80.0...server/v2.81.0) (2026-10-26)


### Features

* share organization registry credentials across projects ([#162](https://github.com/hackclub/orchard/issues/162)) ([ec5a3c2](https://github.com/hackclub/orchard/commit/ec5a3c2340e8ab71aa95d1e6623291174d4b98db))


### Bug Fixes

* **server:** preserve sessions when changing project member roles ([491e18e](https://github.com/hackclub/orchard/commit/491e18e199347300ed817fccc4cbc0f0ba494e1d))
* **server:** refresh every public database's copy of the db wildcard cert in the 6h sweep, not only when someone opens the database ([edbbfa1](https://github.com/hackclub/orchard/commit/edbbfa111e332ea42a277a98bb266c1b3e52365e))

## [2.80.0](https://github.com/hackclub/orchard/compare/server/v2.79.4...server/v2.80.0) (2026-10-23)


### Features

* **server:** tenant postgres follows cnpg's patched image catalog and rolls existing databases onto it a few at a time ([59878bc](https://github.com/hackclub/orchard/commit/59878bc53ee32be99dbf5e2c4bf272e4a7075769))


### Bug Fixes

* **chart:** pin patched victoriametrics, vmagent, kube-state-metrics, node-exporter and pgbouncer images ([a6f7bdb](https://github.com/hackclub/orchard/commit/a6f7bdb408122a6aeff4c55a23012492946586b1))
* pin job runtime, buildkit and redis images so nodes pull patched layers ([7dbf1f6](https://github.com/hackclub/orchard/commit/7dbf1f6961af9e2aaf819e082040daf54f76cda9))
* **server:** drop the void operator oxlint rejects in the postgres image tests ([b42201a](https://github.com/hackclub/orchard/commit/b42201a94e6f7db02358eca72a994558669181cf))
* **server:** prune old image tags without deleting the manifest a newer tag still uses ([22422ec](https://github.com/hackclub/orchard/commit/22422ecbcbe677f604ed307b15dd7f5bb88361a6))
* **server:** restore passkey verification and harden ceremonies ([#179](https://github.com/hackclub/orchard/issues/179)) ([882b5c5](https://github.com/hackclub/orchard/commit/882b5c55ab56c8752a3b17aebd56cd377bb9fbbf))
* **server:** run server and mcp on node alpine and drop the unused git, curl and docker cli ([9482cb6](https://github.com/hackclub/orchard/commit/9482cb68c182e5cfbac3e3f38f401dde3c174bf1))
* **server:** send hsts, frame and nosniff headers on api responses and drop x-powered-by ([0d4a1ac](https://github.com/hackclub/orchard/commit/0d4a1ac97214b1a4d12aec38d1219e5654d6b51e))
* **server:** spread default nightly backups across 01-05 utc instead of every database at 03:00 ([1bdfe9b](https://github.com/hackclub/orchard/commit/1bdfe9b93d21039d910afe60aeddc7a18723f461))
* **server:** tag apm traces with the authenticated user ([da82758](https://github.com/hackclub/orchard/commit/da827583b08e147b92cc8991bf6f0f58c848d631))

## [2.79.4](https://github.com/hackclub/orchard/compare/server/v2.79.3...server/v2.79.4) (2026-10-21)


### Bug Fixes

* build go binaries with go 1.26.10 and bump cli grpc and x/net for open advisories ([576c8ac](https://github.com/hackclub/orchard/commit/576c8ac59c882677d503ff0135c23495fed919c7))
* bump mcp sdk, sharp and patched transitive deps for open advisories ([d11e502](https://github.com/hackclub/orchard/commit/d11e502448535a0fbc7a9a17f07c2653da0b8014))
* bump node to 22.23.4 for the october 2026 security releases ([2c2d032](https://github.com/hackclub/orchard/commit/2c2d03211a30db21df00998d332d2fe8c9bf1bac))

## [2.79.3](https://github.com/hackclub/orchard/compare/server/v2.79.2...server/v2.79.3) (2026-10-21)


### Bug Fixes

* **server:** healthcheck urls with a shell PORT variable probe the app port instead of 80 ([c607cbe](https://github.com/hackclub/orchard/commit/c607cbe43f573004d394fa4a4e0efa151167e426))

## [2.79.2](https://github.com/hackclub/orchard/compare/server/v2.79.1...server/v2.79.2) (2026-10-21)


### Bug Fixes

* **server:** projects whose owner left the org deploy within the org default allowance instead of zero ([8f0e4c7](https://github.com/hackclub/orchard/commit/8f0e4c7e94323b2f2e55ace80562dd1df91d5685))

## [2.79.1](https://github.com/hackclub/orchard/compare/server/v2.79.0...server/v2.79.1) (2026-10-21)


### Bug Fixes

* **server:** clear database replicas stuck behind a failed join so the primary can come back ([f97592f](https://github.com/hackclub/orchard/commit/f97592fd843abc1ed87a3f16c45f71811ad0f7cc))
* **server:** register restore credentials before the restore cluster starts and remove it when a restore fails ([86708bd](https://github.com/hackclub/orchard/commit/86708bd5a35ba8a7ec263a8f71ebf9a3e9cab507))
* **server:** run dockerfile healthchecks that only fetch a loopback url as http probes ([d13ef51](https://github.com/hackclub/orchard/commit/d13ef51f28185152f8b754b1c2249f9e32368956))

## [2.79.0](https://github.com/hackclub/orchard/compare/server/v2.78.1...server/v2.79.0) (2026-10-21)


### Features

* **server:** report build pipeline duration, phase timings and cache hits to datadog ([2658845](https://github.com/hackclub/orchard/commit/2658845976b7c18778a7f01df59a53b2b529c206))

## [2.78.1](https://github.com/hackclub/orchard/compare/server/v2.78.0...server/v2.78.1) (2026-10-20)


### Bug Fixes

* **server:** a malformed id in the url is a 404, not a 500 ([fbb8b30](https://github.com/hackclub/orchard/commit/fbb8b309f288154c9c6fae901e31a70b503ce522))

## [2.78.0](https://github.com/hackclub/orchard/compare/server/v2.77.0...server/v2.78.0) (2026-10-20)


### Features

* **server:** route builds to the firecracker builder behind a posthog flag ([7bdf7bc](https://github.com/hackclub/orchard/commit/7bdf7bc1ac59593d1a4e4d505d7ab47f69cb17d0))


### Bug Fixes

* **server:** engine re-derives a kind once when its consumer logic changes ([1d092d3](https://github.com/hackclub/orchard/commit/1d092d37fb99b3af6ba4c9a65115dd3a905c4ff5))
* **server:** reduce build setup and cache export overhead ([#163](https://github.com/hackclub/orchard/issues/163)) ([7bae538](https://github.com/hackclub/orchard/commit/7bae53890ef8abf5c439bf10cf1626cae1726f66))

## [2.77.0](https://github.com/hackclub/orchard/compare/server/v2.76.0...server/v2.77.0) (2026-10-17)


### Features

* **server:** a cronjob applied back in k8s re-enables its job ([7e2d885](https://github.com/hackclub/orchard/commit/7e2d885ad1a088291a4f1f80c7e44c7f9b7dc110))
* **server:** cronjob schedule edits in k8s are adopted into the job ([6b8ccf0](https://github.com/hackclub/orchard/commit/6b8ccf034fd59b2eb7b7611921c86f17533f94d9))
* **server:** database hibernated or woken in k8s is adopted ([942cfd1](https://github.com/hackclub/orchard/commit/942cfd131966133e5c6bb2069bbb810f46bb054d))
* **server:** database settings edited in k8s are adopted ([f0f8d7c](https://github.com/hackclub/orchard/commit/f0f8d7c86ee51c1ea08f5b8cda842919a08f52db))
* **server:** deleting a deployment in k8s removes it from orchard ([ceee0bf](https://github.com/hackclub/orchard/commit/ceee0bf1031c5b3b6403ef8b5733281a02eef0f5))
* **server:** deleting a job's cronjob in k8s disables the job ([7ede593](https://github.com/hackclub/orchard/commit/7ede593a1a1bc9d6fac2eac9710d539e2fe75dac))
* **server:** env edited with kubectl is adopted, refs are flagged ([04a0263](https://github.com/hackclub/orchard/commit/04a0263d73fc6a7856dfb1124e1aeafa0a48eef8))
* **server:** ingress edited with kubectl is adopted ([0464217](https://github.com/hackclub/orchard/commit/04642176414090a08a19622d40e6b7023aa50274))
* **server:** orchard restores edited or deleted security policies ([d74093f](https://github.com/hackclub/orchard/commit/d74093fd27262d6b7240b81b399ed685a5b8529c))
* **server:** scheduled backup edits and deletes in k8s are adopted ([0f7f2eb](https://github.com/hackclub/orchard/commit/0f7f2ebb1abe76d96b7baaea15326e93af1ba63e))
* **server:** service type changed with kubectl is adopted ([3c6ab5b](https://github.com/hackclub/orchard/commit/3c6ab5becd8d9640414a8a0db490652475bc155d))
* **server:** volume grown with kubectl is adopted ([b4e6472](https://github.com/hackclub/orchard/commit/b4e6472c0542958edabf5152f3e31c3f209dd3d5))


### Bug Fixes

* **server:** a failed cluster read is no longer treated as a missing deployment ([772981e](https://github.com/hackclub/orchard/commit/772981ebeb6f09b4f89f8c837017ed9f7b42544c))
* **server:** a failed first deploy cleaned up by orchard never removes the app ([ea95079](https://github.com/hackclub/orchard/commit/ea9507950ac8db2bdd8cdaa3bf87021bf279a8ad))
* **server:** a node that re-registers keeps its row and org assignments ([ce5a6cf](https://github.com/hackclub/orchard/commit/ce5a6cf578e7ca3b1b322011fcd7f11a509f598d))
* **server:** a replica whose engine watch stays broken hands the shard over ([ee28d3f](https://github.com/hackclub/orchard/commit/ee28d3fe61ac7fd9b0108cb1d59c621437410981))
* **server:** a service port edit never leaves the service deleted ([4495be8](https://github.com/hackclub/orchard/commit/4495be8a9eda8929d112ffdf711ead4ac483b65e))
* **server:** backups turned off in orchard stay off ([dea45e9](https://github.com/hackclub/orchard/commit/dea45e9d47e43c793d280049bc8b1f6aa635785c))
* **server:** build recovery defers when the build job cannot be read ([373677a](https://github.com/hackclub/orchard/commit/373677add9cb1e6b53a474c720a2174d0dbea64a))
* **server:** cronjob resync keeps annotations and labels set outside orchard ([4f002a1](https://github.com/hackclub/orchard/commit/4f002a184210dc24553a9f08fecd934fc7807c46))
* **server:** engine confirms deletes live, errors never count as gone ([7f77a08](https://github.com/hackclub/orchard/commit/7f77a08fad68f966ebb646c275811c00bd95abbd))
* **server:** engine list passes never sweep or overwrite what the watch saw newer ([1bd9812](https://github.com/hackclub/orchard/commit/1bd9812e3bb4ee87cabb1fc9d059b1599f215f6e))
* **server:** engine retries deletes whose handler failed ([a08bb8d](https://github.com/hackclub/orchard/commit/a08bb8d15d2b77221b90a23044d968e6b030bb1e))
* **server:** kubectl edits never delete secrets or mass-remove env and settings ([e065bc8](https://github.com/hackclub/orchard/commit/e065bc8202e30dc7c275746b1077ea0e0d4adb9e))
* **server:** namespace sync only adopts deployments orchard did not create ([d8dd60a](https://github.com/hackclub/orchard/commit/d8dd60a6845c242a51b842a8f87354d68b99dee4))
* **server:** re-pointing backups keeps the data compression already set ([08f9c95](https://github.com/hackclub/orchard/commit/08f9c95063dfa2584ba73620953f2bdb5990fef9))
* **server:** unlabeled ingresses and services keep their rows ([707067a](https://github.com/hackclub/orchard/commit/707067a5fe03150a3abfc94453da9382e779ee20))

## [2.76.0](https://github.com/hackclub/orchard/compare/server/v2.75.0...server/v2.76.0) (2026-10-16)


### Features

* greenhouse opens folders anywhere, runs named commands and names sessions ([5043f0c](https://github.com/hackclub/orchard/commit/5043f0c27aa4c8603a22a97ca68683c2bcec742d))

## [2.75.0](https://github.com/hackclub/orchard/compare/server/v2.74.0...server/v2.75.0) (2026-10-16)


### Features

* databases pick up spec changes made straight in kubernetes ([a40edfe](https://github.com/hackclub/orchard/commit/a40edfe3d933c35c69783916f8d79200f46c939e))


### Bug Fixes

* a paused database says how big to grow it before writes come back ([5f0ef69](https://github.com/hackclub/orchard/commit/5f0ef69b9a06399c8fd65d5686b0977c8394e4b7))

## [2.74.0](https://github.com/hackclub/orchard/compare/server/v2.73.0...server/v2.74.0) (2026-10-15)


### Features

* orchard can put pgbouncer in front of its database so rollouts stop multiplying connections ([31d194e](https://github.com/hackclub/orchard/commit/31d194ee6f0ae92c8485eedecb2d2ad54666bbb1))

## [2.73.0](https://github.com/hackclub/orchard/compare/server/v2.72.1...server/v2.73.0) (2026-10-15)


### Features

* greenhouse agents sign in from settings and the model picker lists agents cleanly ([0395d45](https://github.com/hackclub/orchard/commit/0395d45ca4d6c71c194974432eb5f940b9c97f26))

## [2.72.1](https://github.com/hackclub/orchard/compare/server/v2.72.0...server/v2.72.1) (2026-10-14)


### Bug Fixes

* rollouts drain gracefully and greenhouses reconnect at once instead of going unavailable for a minute ([b275cae](https://github.com/hackclub/orchard/commit/b275cae7f5a3455e26034369e7e20fb187c21537))

## [2.72.0](https://github.com/hackclub/orchard/compare/server/v2.71.0...server/v2.72.0) (2026-10-14)


### Features

* greenhouse sessions open instantly from a warm pool and chats run claude code, opencode, fx or codex over acp ([dad8ae6](https://github.com/hackclub/orchard/commit/dad8ae6959e50772c5397c1b4758c23c9a2d6581))

## [2.71.0](https://github.com/hackclub/orchard/compare/server/v2.70.0...server/v2.71.0) (2026-10-14)


### Features

* graft bump follows a $graftpolicy range in gitops values, releases dispatch graft-published to kubeops ([a6339f1](https://github.com/hackclub/orchard/commit/a6339f1199783ec3864b1fd0a7fec1c0db885244))

## [2.70.0](https://github.com/hackclub/orchard/compare/server/v2.69.0...server/v2.70.0) (2026-10-14)


### Features

* the grove moves out of core into the forum graft, grafts get a storage door ([f5a195b](https://github.com/hackclub/orchard/commit/f5a195b1cf1750e82e1f01bedfe4880d6fafa154))

## [2.69.0](https://github.com/hackclub/orchard/compare/server/v2.68.0...server/v2.69.0) (2026-10-14)


### Features

* community grafts and taps next to official ones, sdk and ui kit publish to npm as [@orchardlabs](https://github.com/orchardlabs) ([fae981d](https://github.com/hackclub/orchard/commit/fae981de67a90b03974129c3408fbaf01e8ff68a))

## [2.68.0](https://github.com/hackclub/orchard/compare/server/v2.67.3...server/v2.68.0) (2026-10-14)


### Features

* arm64 self-hosted installs ([c4c7bea](https://github.com/hackclub/orchard/commit/c4c7bea3a63bfc1ab88f327fb3011a2cb249d9c3))
* graft database pools are sized per graft and checked against the database limit ([b34981d](https://github.com/hackclub/orchard/commit/b34981d23c7b84ed1aa3572c0aca7a478a5a000e))
* graft sdk, doors, frontend host, author cli and announcements example graft ([88ef3e1](https://github.com/hackclub/orchard/commit/88ef3e16f0f141cc83ecd549aea135ad4cfaa229))
* graft settings render in instance configuration; announcements graft 0.2.0 ([bdcb745](https://github.com/hackclub/orchard/commit/bdcb7458ddbd1b54800002126f142f17e0674557))
* grafts docs, generated graft api and slot reference, https sources in orchardctl ([5184e89](https://github.com/hackclub/orchard/commit/5184e89d891fc84d61120bd31a8afa20c83ba513))
* grafts host core with loader, safe migrations, artifact sync and chart wiring ([f85a974](https://github.com/hackclub/orchard/commit/f85a974d8d5c0ca6d5b8217478a4b29bd5f76a69))
* grafts signed with the orchard key are trusted as official ([f29fdab](https://github.com/hackclub/orchard/commit/f29fdab279d61379a1978e0cffadc0487ae05fe0))
* greenhouse runs as a graft ([7a808df](https://github.com/hackclub/orchard/commit/7a808df9cc102446361b5369d7ea0b01172e3e87))
* orchardctl graft commands with offline artifacts, snapshots and rollback ([aa32969](https://github.com/hackclub/orchard/commit/aa32969c864a05fbbda9a235ec757ee853d4b095))


### Bug Fixes

* grafts declare the core tables they take over so greenhouse passes doctor ([8c1cb21](https://github.com/hackclub/orchard/commit/8c1cb2162d2b48fd82a37006786a7c173b88a220))
* keep server typecheck scoped to src after grafts joined the tsconfig ([fbc26a1](https://github.com/hackclub/orchard/commit/fbc26a19a765a17c5d51a96ba88703a52a26bb03))

## [2.67.3](https://github.com/hackclub/orchard/compare/server/v2.67.2...server/v2.67.3) (2026-10-12)


### Bug Fixes

* **server:** greenhouse agents stop failing closed on the anthropic auth plugin custody check ([bdb2713](https://github.com/hackclub/orchard/commit/bdb2713fc93a901e0eb4be1b8815673975de99b1))

## [2.67.2](https://github.com/hackclub/orchard/compare/server/v2.67.1...server/v2.67.2) (2026-10-10)


### Bug Fixes

* **server:** greenhouse agents speak a new enough claude code to use the latest models ([30a4e38](https://github.com/hackclub/orchard/commit/30a4e3887453c2e4d0a21203b9d844d17068abc0))
* **server:** greenhouse machines keep claude code on the latest version ([2ea097d](https://github.com/hackclub/orchard/commit/2ea097d081836c65aec487410410c064440438f9))

## [2.67.1](https://github.com/hackclub/orchard/compare/server/v2.67.0...server/v2.67.1) (2026-10-09)


### Bug Fixes

* **server:** deployments in a non-default environment can reach the project's databases ([81a9a86](https://github.com/hackclub/orchard/commit/81a9a86e9b5c2da40a7fca295d03eb5a998c36af))

## [2.67.0](https://github.com/hackclub/orchard/compare/server/v2.66.0...server/v2.67.0) (2026-10-09)


### Features

* **server:** encrypted per user context library synced into your own machines ([b788d28](https://github.com/hackclub/orchard/commit/b788d28b8e6141cad9362bf36bd0982294ed0be4))

## [2.66.0](https://github.com/hackclub/orchard/compare/server/v2.65.1...server/v2.66.0) (2026-10-09)


### Features

* greenhouse repos can be removed from a machine ([a331497](https://github.com/hackclub/orchard/commit/a3314970d4e33047baa3ff0846be1b648285d7bc))


### Bug Fixes

* greenhouse clones use your github token and report failures ([4af72a4](https://github.com/hackclub/orchard/commit/4af72a42cd2fada2267bf5709b8f4596eba2743b))
* **server:** cache feature flags per user so greenhouse stops flipping off ([105d7f4](https://github.com/hackclub/orchard/commit/105d7f426bf5b6e6d4d807cb814b29f9df022916))

## [2.65.1](https://github.com/hackclub/orchard/compare/server/v2.65.0...server/v2.65.1) (2026-10-09)


### Bug Fixes

* database volumes show capacity to a tenth of a GB so a 1Gi expand is visible, the data size stat says what it is, and a days old crash stops marking a db unhealthy ([b14df88](https://github.com/hackclub/orchard/commit/b14df889b4db79eba82375503dac6e5d02243590))
* deleted greenhouse chats drop from every client ([e5de549](https://github.com/hackclub/orchard/commit/e5de54939aba322a62315808489a744ca9bfc0ed))
* greenhouse chats match worktrees through the resolved home path ([a157579](https://github.com/hackclub/orchard/commit/a157579d0158f838113e7aa6c3325d855fe51072))

## [2.65.0](https://github.com/hackclub/orchard/compare/server/v2.64.0...server/v2.65.0) (2026-10-09)


### Features

* greenhouse chat tabs can be deleted from their close button, with a confirm ([7909a5c](https://github.com/hackclub/orchard/commit/7909a5ce4c2a88e724f9d862491f6ec149ab6352))
* greenhouse composer runs claude code style slash commands plus the repo's own opencode commands ([4dfec12](https://github.com/hackclub/orchard/commit/4dfec12b97acd5e9638c71dc540c39cb65ae0c7d))
* greenhouse multiplayer file editing with one owner per doc, agent edits merged as diffs, per user undo, offline safe reconnects, live cursors and a sync status; questions wait on whoever prompted, remote prompts show live, and session menus open ([68e3046](https://github.com/hackclub/orchard/commit/68e304668ff2b9324516ddcc9a3b5bae20ff9f4d))


### Bug Fixes

* greenhouse machine usage loads instead of restarting its request every time the machine list refreshes, and the server never hangs on a stuck exec ([ffc9b1d](https://github.com/hackclub/orchard/commit/ffc9b1d57cc08a8f1be1b893f8807c6e7f7aef22))

## [2.64.0](https://github.com/hackclub/orchard/compare/server/v2.63.0...server/v2.64.0) (2026-10-09)


### Features

* greenhouse answers agent permissions, questions and plan handoffs inline, repos get icons, and the title bar tells machines from repos ([b2736fe](https://github.com/hackclub/orchard/commit/b2736fe5397d1386a3a6d4d9d459e8b2a6998691))
* greenhouse gets a title bar with floating panels, two line sessions you can delete, a settings dialog with appearance and usage, live cpu and memory for every machine, and a calmer home ([5640c07](https://github.com/hackclub/orchard/commit/5640c070a01a0cc6b58a8890458f62525acb2b8f))
* greenhouse model switcher with favourites and effort, mcp server manager, context and claude usage popover, and machine usage in the menu ([de256d1](https://github.com/hackclub/orchard/commit/de256d160c0406d7a48eefec77efed474370f4de))
* greenhouse settings for sending, steering, sounds, notifications, fonts, git and agents, an ide sidebar with orchard touches, and no more absolutely right ([b29e011](https://github.com/hackclub/orchard/commit/b29e011fae7abf076d40c2f0c1c6df1195cf7dd3))
* vercel greenhouse machines keep their home on a per machine drive and snapshots never expire ([7bc0585](https://github.com/hackclub/orchard/commit/7bc058559d25ed6f414d0c17ae9c36445464477a))


### Bug Fixes

* greenhouse opencode runs with plan mode so agents can hand plans off for approval ([6c10eca](https://github.com/hackclub/orchard/commit/6c10eca92d71c5bc792c76913af77124fba569cc))
* greenhouse sessions open instantly, chats get live updates from worktrees, agent errors show, ports hide infrastructure, agents can write setup scripts and sandbox terminals predict keystrokes ([a96b6ac](https://github.com/hackclub/orchard/commit/a96b6acc4600aa914d12d39db32fd76b5f48097e))
* pin the opencode anthropic auth plugin to 1.22.0, 1.23.0 fails every prompt with a custody state mismatch ([4c48547](https://github.com/hackclub/orchard/commit/4c485475699eed8d47d27e6a81732ef934d648e8))

## [2.63.0](https://github.com/hackclub/orchard/compare/server/v2.62.0...server/v2.63.0) (2026-10-08)


### Features

* greenhouse keeps share and slack tokens out of analytics, shows admins a lifecycle only view, and refreshes credits ([ea01fbc](https://github.com/hackclub/orchard/commit/ea01fbc0e6a42fc72e548b588b0eccbaa402c6b5))
* greenhouse previews, project links, forks, share links, mcp tools, issue and slack kickoff, and per person git identity ([1214bdb](https://github.com/hackclub/orchard/commit/1214bdb9c1965aa7d52f9108ce9490740f977628))
* org admins only manage greenhouse machine lifecycle, removing a guest rotates machine secrets, and a live vercel check script ([ed4acac](https://github.com/hackclub/orchard/commit/ed4acace9baa20962a3c730b13ac4a4ba966abce))
* sandboxes run through pluggable runners and every cluster change goes through the apply queue ([a80b929](https://github.com/hackclub/orchard/commit/a80b929d90f1dccbb976158a08cf516a53cb66a1))
* vercel sandbox runner, worktree sessions, shared tmux terminals and host and guest multiplayer for greenhouse ([a0c17ea](https://github.com/hackclub/orchard/commit/a0c17ead69b1d8f8ce2933238ddbaab877047ae0))


### Bug Fixes

* greenhouse chart, previews, pr drafts, prompt attribution, retries, bridge checksums and access hardening ([82592fd](https://github.com/hackclub/orchard/commit/82592fd984d9415069ae4faa759176cde23f4069))
* greenhouse security review, proxied content types, scoped mcp tokens, origin checks on upgrades, env var and credential helper confinement ([28669c8](https://github.com/hackclub/orchard/commit/28669c84beb08e61817d0a6497da113e659ed3a9))
* map the slack link preview route in cli parity and format greenhouse docs ([2b54257](https://github.com/hackclub/orchard/commit/2b54257e2d63c569d92419af9a2612607121acb6))

## [2.62.0](https://github.com/hackclub/orchard/compare/server/v2.61.0...server/v2.62.0) (2026-10-08)


### Features

* deleting a project or environment tears down everything it owned, asks you to type its name, and audits every child ([0357a83](https://github.com/hackclub/orchard/commit/0357a83175e4eb963436c605ebd5bdbdea843b47))
* volumes, services, certificates and namespaces follow the cluster through the mirror, and every k8s-side deletion is audited ([25c68af](https://github.com/hackclub/orchard/commit/25c68af379dfc1e72a2ec3c34c1814666ebc1c81))


### Bug Fixes

* give the teardown lazy import an explicit extension so typecheck passes ([752d275](https://github.com/hackclub/orchard/commit/752d2754419b4912e558080c2743d71004bec610))
* job step pods expand shared and resource references instead of shipping the literal ([3706812](https://github.com/hackclub/orchard/commit/3706812fd889ae9cab0e5859c17da0677452687a))
* lazy load the databases service in namespace teardown so the server boots again ([dc08dca](https://github.com/hackclub/orchard/commit/dc08dca6c20decc040a8ce28196330bad38d9833))

## [2.61.0](https://github.com/hackclub/orchard/compare/server/v2.60.0...server/v2.61.0) (2026-10-08)


### Features

* require single sign-on for a whole instance, sessions that got in another way are signed out when enforcement turns on ([0db4711](https://github.com/hackclub/orchard/commit/0db471187f5e8978f23a43ab903e449d2f2b9701))


### Bug Fixes

* growing a deployment volume resizes the existing pvc instead of only recording the new size ([682729b](https://github.com/hackclub/orchard/commit/682729ba50d4f82128d2ad370e47f2e004c3dd10))

## [2.60.0](https://github.com/hackclub/orchard/compare/server/v2.59.0...server/v2.60.0) (2026-10-08)


### Features

* backup fleet gauges for datadog, backups waiting, archiving failing and hours since the last backup ([6a87030](https://github.com/hackclub/orchard/commit/6a870304dd67f2601b32103be1ef7cf0cb5833ed))
* scheduled backups still waiting behind a newer one are swept so a stalled cluster cannot pile up ([11b5baf](https://github.com/hackclub/orchard/commit/11b5baf5363e37556edd64bdf2048c52520af920))
* the defaults reconcile lifts databases to the memory floor and drops over-reserved shared_buffers ([8019169](https://github.com/hackclub/orchard/commit/8019169069920bbb198e346dca7b08806c10b5e0))


### Bug Fixes

* a backup whose cluster cannot archive wal fails in minutes instead of six hours ([afd0f57](https://github.com/hackclub/orchard/commit/afd0f5745f856d02d52b0f750090529ef4116c6d))
* stopping a database suspends its backup schedule instead of minting backups that can never run ([71c42bb](https://github.com/hackclub/orchard/commit/71c42bb5c80cafe008aeb86e302de0ea11c720b5))
* the tenant policy reconcile covers namespaces under either managed label ([67adf9c](https://github.com/hackclub/orchard/commit/67adf9c38f9f56167b9ebdc57ed86eb72c0705a5))

## [2.59.0](https://github.com/hackclub/orchard/compare/server/v2.58.0...server/v2.59.0) (2026-10-07)


### Features

* a build finishes when the image is applied, not when the pods are ready ([cb7fc1f](https://github.com/hackclub/orchard/commit/cb7fc1fbfdc0f5570c32a50e9a65b0d5c3e9bbb0))
* startup and readiness probes run every 5s, liveness keeps the interval ([307415b](https://github.com/hackclub/orchard/commit/307415bdd86f14854ebd8232d3754bd581df5950))


### Bug Fixes

* pusher names port 80 so skopeo skips the 30s https dial timeout ([0b9f017](https://github.com/hackclub/orchard/commit/0b9f017bc5e9b2b248eb17d0220999952494e442))

## [2.58.0](https://github.com/hackclub/orchard/compare/server/v2.57.0...server/v2.58.0) (2026-10-07)


### Features

* pod shell reattach restores an exact screen snapshot and speaks protocol v2 ([7cbfd19](https://github.com/hackclub/orchard/commit/7cbfd19ca25530659337465a8601fe8586c84cb3))
* shell tabs survive a reload, sandbox shells resize, cli sends its size, gpu rendering toggle ([0b713f1](https://github.com/hackclub/orchard/commit/0b713f1a58e0049c3e7f8ae6a7cd027a657c4d59))

## [2.57.0](https://github.com/hackclub/orchard/compare/server/v2.56.0...server/v2.57.0) (2026-10-07)


### Features

* web terminal on xterm.js with overlay predictions and stable database consoles ([f743331](https://github.com/hackclub/orchard/commit/f743331f72ffb1b8dec6912c9e4fc5f1dd34ec98))

## [2.56.0](https://github.com/hackclub/orchard/compare/server/v2.55.0...server/v2.56.0) (2026-10-07)


### Features

* add registry credentials from the image card and require encryption at rest for tokens ([e697d5d](https://github.com/hackclub/orchard/commit/e697d5d624636481a7a4fab3aa6254361062f9e7))

## [2.55.0](https://github.com/hackclub/orchard/compare/server/v2.54.1...server/v2.55.0) (2026-10-07)


### Features

* per-project registry credentials for pulling private images ([3b28852](https://github.com/hackclub/orchard/commit/3b28852869cb2d343ad8c534e6962a4757392ef1))

## [2.54.1](https://github.com/hackclub/orchard/compare/server/v2.54.0...server/v2.54.1) (2026-10-06)


### Bug Fixes

* namespace sync only prunes its own namespace and the mirror drops ingress rows the cluster lost ([7684945](https://github.com/hackclub/orchard/commit/76849455a892d3683554b0bc26ad20cb8e90b798))

## [2.54.0](https://github.com/hackclub/orchard/compare/server/v2.53.0...server/v2.54.0) (2026-10-04)


### Features

* **mcp:** accept API tokens as bearer credentials ([3e28db5](https://github.com/hackclub/orchard/commit/3e28db5e4be3f189e9903805e221bb3ba4a5c89e))

## [2.53.0](https://github.com/hackclub/orchard/compare/server/v2.52.0...server/v2.53.0) (2026-10-04)


### Features

* a database near a full disk goes read-only instead of growing or dying ([8558b0f](https://github.com/hackclub/orchard/commit/8558b0f1fae04e23b98965cbff966171ef60d408))
* databases grow their volume before it fills, and never go unwatched ([a0e2815](https://github.com/hackclub/orchard/commit/a0e28153ba05816b1524818e12f4c828f1cb5a63))
* pause live logs while idle and hidden ([#112](https://github.com/hackclub/orchard/issues/112)) ([afb0cbe](https://github.com/hackclub/orchard/commit/afb0cbe2ad7428dfbcfacd98c6a7631a5c4cc8b7))


### Bug Fixes

* backup endpoints must be full urls, and organizations on the instance bucket keep going through the r2-proxy ([0f1a5bb](https://github.com/hackclub/orchard/commit/0f1a5bb41de2333695a04b949cdd7d8cf3ee34a0))
* backup targets are repaired on the leader and probed on save ([7203e5d](https://github.com/hackclub/orchard/commit/7203e5d66a680ab22239949b5f6ca3eed57aa9c3))

## [2.52.0](https://github.com/hackclub/orchard/compare/server/v2.51.3...server/v2.52.0) (2026-09-30)


### Features

* opt-in anonymous usage reports for self-hosted instances ([91bbb19](https://github.com/hackclub/orchard/commit/91bbb19010cb72518a09b1556740b16347aa9823))


### Bug Fixes

* cap domains per app and per project ([acd3203](https://github.com/hackclub/orchard/commit/acd320334579d3f4ba30c8543e67d90f581233c8))
* caps on streams, uploads, env payloads and mcp oauth ([741a874](https://github.com/hackclub/orchard/commit/741a874e255c89d0815f17d819878cd624f4ce92))
* cross-site cookie mutations get a 403, not a 401 or 500 ([817f6a2](https://github.com/hackclub/orchard/commit/817f6a2a7ed97bdd836b71cd1b9a6d340f5b6dd3))
* database storage expansion resizes volumes directly, wal archives in parallel, disk pressure alerts ([577c5a4](https://github.com/hackclub/orchard/commit/577c5a47bf050d700f31fa5c85ba91d99f555edc))
* moving a project needs delete rights, demoted owners cannot transfer it, mcp acting users own their session ([1fc1e74](https://github.com/hackclub/orchard/commit/1fc1e748ad3992f04618aec5e4a4476e826965cd))
* only browser sessions pass the guard, refresh tokens rotate for real ([3209660](https://github.com/hackclub/orchard/commit/32096603c2a721870503dec6d93495f39eaeb6d3))
* otp stays out of logs, scim cannot mint owners, deeper audit redaction ([912db6a](https://github.com/hackclub/orchard/commit/912db6ad1a2c22a860744d65c662d99ae7515c8e))
* rate limit invitations per recipient and per organization ([d45c854](https://github.com/hackclub/orchard/commit/d45c854b23b3c820a02bb913e439dbd372a203be))
* stored credentials are encrypted at rest ([77409e2](https://github.com/hackclub/orchard/commit/77409e22f0339d7775a83fb79d5773d0ff5af49f))
* the builder role only grants what the server holds, so builds create their job again ([3ead11f](https://github.com/hackclub/orchard/commit/3ead11f57dd2c7a91b6c6e19832f1534cc57d282))

## [2.51.3](https://github.com/hackclub/orchard/compare/server/v2.51.2...server/v2.51.3) (2026-09-29)


### Bug Fixes

* orchardctl harden makes the k3s kubeconfig private ([05139c9](https://github.com/hackclub/orchard/commit/05139c91280ef83130ea7a34ce3b62845375fc2f))
* the engine banner waits out watch blips and shard handoffs ([babaaba](https://github.com/hackclub/orchard/commit/babaabae4d9edde79b67ce685e5f7ad8e35ff1b3))

## [2.51.2](https://github.com/hackclub/orchard/compare/server/v2.51.1...server/v2.51.2) (2026-09-29)


### Bug Fixes

* outbound fetches pin dns at connect time, job run snapshots encrypt secret values, organization backup keys never leave the database by default, and the protect page stops naming the project ([7278788](https://github.com/hackclub/orchard/commit/7278788dbe3ac1f69ec095a977b85f03ea2ad968))
* project viewers no longer see logs, secret values, log-derived error text or member emails anywhere, notification replay stays inside the channel scope, environment delete needs delete rights, and mutating sync needs deploy scope ([f490855](https://github.com/hackclub/orchard/commit/f490855fa3122a835005c565467df443bbdd0ed3))
* the r2 proxy refuses copies, bucket writes and out-of-prefix deletes, cookie sessions cannot mutate from other origins, trusted images are docker hub only, the mcp consent page and asset proxy pin their origins, the cli token never enters a url, logout is a post, and the k3s kubeconfig is private ([90ac6fc](https://github.com/hackclub/orchard/commit/90ac6fcf5bafc0b05488449bdd72ece7c32e88d4))
* the server binds a fixed tenant-secrets clusterrole instead of holding escalate, every tenant namespace keeps a floor quota, the backup proxy connects as a read-only postgres role, and plaintext registries come from values ([3c42bcb](https://github.com/hackclub/orchard/commit/3c42bcbeacea96a120dc9fa11696899e37534ed0))

## [2.51.1](https://github.com/hackclub/orchard/compare/server/v2.51.0...server/v2.51.1) (2026-09-28)


### Bug Fixes

* api tokens keep their scopes on superadmin routes and cannot enrol credentials, org-scoped sessions stay confined through mcp consent, exec and github linking, and sign-in codes are keyed on the instance secret ([fcc0100](https://github.com/hackclub/orchard/commit/fcc010083ba518cbc0422a93d78a76d2516b0840))
* build args and job env reach pods through secrets, build pods stay out of the mirror, and every user-supplied outbound url is checked against private networks ([03c6333](https://github.com/hackclub/orchard/commit/03c63336d5d95df268c290367abcbffaf6384506))
* build config, dockerfile target, auto-deploy branch and ingress host updates are validated like their create paths ([3c27464](https://github.com/hackclub/orchard/commit/3c274642c1f066ae72a8b76a653949f4499dee1b))
* sso providers are owner-managed and saml rejects unsolicited assertions, sign-in attempts are counted atomically, jwt secret has a floor, platform images are project-scoped and logs are editor-only ([d540422](https://github.com/hackclub/orchard/commit/d54042289c4d9311e4727968934e029e75b402b7))
* the org-scope and api-token deny lists ignore path case, and notification rules and channels list only what the caller can view ([23bf216](https://github.com/hackclub/orchard/commit/23bf2169b639e19fc38d2061600f9171617781d2))
* the self-host registry answers on loopback with a password, the installer opens ufw or firewalld for k3s, and orchardctl update retrofits both ([711a52a](https://github.com/hackclub/orchard/commit/711a52a84efe98815a4a9d368343928a27e671d2))

## [2.51.0](https://github.com/hackclub/orchard/compare/server/v2.50.0...server/v2.51.0) (2026-09-28)


### Features

* the template registry defaults to assets.orchard.my, with a latest copy of every template ([7ed8e49](https://github.com/hackclub/orchard/commit/7ed8e49e17125de6d969f4893e1f241bde588422))


### Bug Fixes

* built-in templates that no longer ship leave the gallery unless something was deployed from them ([b78c480](https://github.com/hackclub/orchard/commit/b78c480b281c156dc376104a76dd0a381ddac1e3))

## [2.50.0](https://github.com/hackclub/orchard/compare/server/v2.49.0...server/v2.50.0) (2026-09-28)


### Features

* a community template registry on r2 that the server syncs and the landing browses ([4ad1bd7](https://github.com/hackclub/orchard/commit/4ad1bd7663170a6fb0e8294cd65ec5dbd1d061b2))
* a credits page with live contributors, and third-party notices in every app, image and binary ([168c584](https://github.com/hackclub/orchard/commit/168c584bc5de82dd085d6148c54f44f8f61ebc37))
* a stopped app holds its pushes, start builds the newest one, and redeploy starts it ([2fd976f](https://github.com/hackclub/orchard/commit/2fd976f30f1edd865b5947ded6b7e2603e5b8451))
* an anomalies card on projects, apps and databases that names what is wrong and the one action that helps ([4dc261f](https://github.com/hackclub/orchard/commit/4dc261fb7f5d980f962802d70a9adbed03984dff))
* builds record when the job was submitted and scheduled, and the progress view shows where the time went ([0dfe05d](https://github.com/hackclub/orchard/commit/0dfe05d4fc697535d42a94769da922c7c03cefcc))
* database stats and cluster state mirrored by the informer so the page never flickers, with the postgres logo ([4b68095](https://github.com/hackclub/orchard/commit/4b680953da7fb183c0fe3d86e2db8e612aa59a0f))
* redirects can be edited in place, including the domain, from the app, the cli and mcp ([0b0ded2](https://github.com/hackclub/orchard/commit/0b0ded26f40a8dbb54ded854d9511a0ae6355251))
* the command palette searches every organization you belong to and switches on select ([6c6b41d](https://github.com/hackclub/orchard/commit/6c6b41d92d4159ac8f0e2b3e9206082d5f376c5e))


### Bug Fixes

* a service port change repoints every domain on it, keeps protected ones on the proxy, and retries through the apply queue ([dd51c44](https://github.com/hackclub/orchard/commit/dd51c440ac51bbdd0ad69f8b3722925ca33d27c7))
* metrics see blue green pods and environment namespaces, report the store being down, and count protected traffic ([4e90114](https://github.com/hackclub/orchard/commit/4e90114a44b824c60bf7a6a3a9ce7cbbd6f6ec35))
* tenant network policy reconcile only runs from a cluster member ([be90da6](https://github.com/hackclub/orchard/commit/be90da6370addf61baf32e3f3251d2f6a52a0a9f))


### Performance Improvements

* zstd images, a leaner cache export, explicit pull policy on builder containers, and warm daemons that live two hours ([2d1c09f](https://github.com/hackclub/orchard/commit/2d1c09f9783df84848eb220ebb137fe18ca7953b))

## [2.49.0](https://github.com/hackclub/orchard/compare/server/v2.48.0...server/v2.49.0) (2026-09-28)


### Features

* a superadmin picks their sign-in method instead of the login card picking for them ([54018a6](https://github.com/hackclub/orchard/commit/54018a69b6659dd3d38c38078bdc4ab0beef521a))

## [2.48.0](https://github.com/hackclub/orchard/compare/server/v2.47.1...server/v2.48.0) (2026-09-27)


### Features

* activity timeline per app with live audit events ([8abc9e4](https://github.com/hackclub/orchard/commit/8abc9e4603f01c52cec168ff669cc6d697224785))
* an instance backup bucket backs every database whose organization has none, and a leader-only pass brings existing clusters in ([250791e](https://github.com/hackclub/orchard/commit/250791e7c47470025268eef54b84e1fde6cf857e))
* auto-deploy for git providers registers the forge webhook, with docs for providers, score and terraform ([32d6a37](https://github.com/hackclub/orchard/commit/32d6a37df2c7d357e1e98576416780684e9e44ec))
* git providers per user with instance-registered oauth apps and per-connection webhook secrets ([b5584ac](https://github.com/hackclub/orchard/commit/b5584ac18baaedf5a42dc654be590eb3360341ef))
* public status pages with hosts, derived from crash state, replicas and alerts ([efa60a9](https://github.com/hackclub/orchard/commit/efa60a97818e96fcaad53ef5eae94207a015b7e9))
* resource bindings so apps follow a database across restores and password rotation ([ad9c7f4](https://github.com/hackclub/orchard/commit/ad9c7f4e5c8b73a24160d29da955b9e1c9934fd9))
* rollout gate with auto rollback, blue/green deploys and releases ([7cc9bc1](https://github.com/hackclub/orchard/commit/7cc9bc1068cff1dbb837d0f99d2e8ebe4018e7ad))
* score.yaml workloads and a terraform and opentofu provider on the cli api client ([33db897](https://github.com/hackclub/orchard/commit/33db89754e915b13ec0d40bcee4445a474108b6e))
* threshold alerts on app metrics with a shared metrics client ([e36774c](https://github.com/hackclub/orchard/commit/e36774c484955b5b68593b97b74284233ce14395))


### Bug Fixes

* cnpg server ca bundle is completed to a self-signed root, and new clusters cap slot wal so a dead replica cannot fill the primary ([5971bc7](https://github.com/hackclub/orchard/commit/5971bc7a20eaf6f771eb53cf74874d438984b4ab))
* existing cnpg clusters get the slot wal cap and a complete server ca bundle from a leader-only reconcile ([b7456dc](https://github.com/hackclub/orchard/commit/b7456dcc79b16d1ae5b783a974a5941415df8ca8))
* the slot wal cap keeps a fifth of the disk from 256MB up, so tiny databases are not capped at half their volume ([9502ed5](https://github.com/hackclub/orchard/commit/9502ed5e19c48a2b8c6a49f18145f938e4aeef3f))

## [2.47.1](https://github.com/hackclub/orchard/compare/server/v2.47.0...server/v2.47.1) (2026-09-25)


### Bug Fixes

* loading panel for metrics + HTTP tracing ([#95](https://github.com/hackclub/orchard/issues/95)) ([b2c7203](https://github.com/hackclub/orchard/commit/b2c72030c3b9bb62b17ff57d12134d860ddbbd57))

## [2.47.0](https://github.com/hackclub/orchard/compare/server/v2.46.1...server/v2.47.0) (2026-09-22)


### Features

* transcode buildkit rawjson progress into the build log ([c4afb30](https://github.com/hackclub/orchard/commit/c4afb30f270d4ff484e87875a4f5b12c2a34bba8))


### Bug Fixes

* build recovery decides from the k8s job informer instead of our own rows ([bf972a0](https://github.com/hackclub/orchard/commit/bf972a0628074ebb23244f104338fb68780e5b81))
* stop a dev server from doing a production instance's background work ([538a916](https://github.com/hackclub/orchard/commit/538a916632c3a15bcd41e8f02400a29c5349f1e6))

## [2.46.1](https://github.com/hackclub/orchard/compare/server/v2.46.0...server/v2.46.1) (2026-09-21)


### Bug Fixes

* detect proxy hops instead of counting them when reading client ip ([ec65eeb](https://github.com/hackclub/orchard/commit/ec65eeb642ccaf06f0f0753934bdaf55be415ed9))
* share rate limit counters in redis and read the real client ip ([4758b4f](https://github.com/hackclub/orchard/commit/4758b4fa37a6aba48663b41b675e1f1c7dcfdee1))

## [2.46.0](https://github.com/hackclub/orchard/compare/server/v2.45.1...server/v2.46.0) (2026-09-21)


### Features

* optional cloudflare turnstile on the auth pages ([4a435dd](https://github.com/hackclub/orchard/commit/4a435dd07b511ca16bbaa82175a3862659412c40))

## [2.45.1](https://github.com/hackclub/orchard/compare/server/v2.45.0...server/v2.45.1) (2026-09-20)


### Bug Fixes

* enforce ratelimits across the board ([#89](https://github.com/hackclub/orchard/issues/89)) ([145fa8f](https://github.com/hackclub/orchard/commit/145fa8ffe3ae6e1e670064146f5ed6dcc1f56c1f))

## [2.45.0](https://github.com/hackclub/orchard/compare/server/v2.44.0...server/v2.45.0) (2026-09-18)


### Features

* further harden deployment rollout handling ([#85](https://github.com/hackclub/orchard/issues/85)) ([e9787a0](https://github.com/hackclub/orchard/commit/e9787a053ce8a17449d4372d5aef1f55a8bf0ac9))


### Bug Fixes

* finish a build when the cluster accepts the image, not when the app is up ([e585024](https://github.com/hackclub/orchard/commit/e585024bee0903fc65c28d9cec7adc41c0d6bce0))
* keep domain redirects on the destination they were pointed at ([f42a8b0](https://github.com/hackclub/orchard/commit/f42a8b0043afd67659ac709dc108405271539273))
* report a failed stop or start instead of reporting success ([4699f5d](https://github.com/hackclub/orchard/commit/4699f5d372d1455ecc6a5d3cc9317690cf7c4d3f))
* show the replica count kubernetes is running, not orchard's intent ([35d95e5](https://github.com/hackclub/orchard/commit/35d95e57b556f297d1a2f3954f2d32dc79a30090))
* stop reporting impossible cpu percentages against the wrong pod budget ([c03e5f1](https://github.com/hackclub/orchard/commit/c03e5f1008bc393afe75fabd291de7797cf9217b))

## [2.44.0](https://github.com/hackclub/orchard/compare/server/v2.43.1...server/v2.44.0) (2026-09-18)


### Features

* persist the dockerfile build stage and expose it in the ui, mcp and cli ([8575b56](https://github.com/hackclub/orchard/commit/8575b566b7460c1f961f6b9a8e98e719b2ddb1b0))
* run a start command on dockerfile and image deployments ([aea28bd](https://github.com/hackclub/orchard/commit/aea28bd8725d66451a693da7da62c6eb156278d9))


### Bug Fixes

* correct the start command signal note to what the cluster actually does ([7d714e5](https://github.com/hackclub/orchard/commit/7d714e5c071d76289ac7927d8988f0200e7feddc))
* keep deliberately set start commands instead of clearing them on release ([00e2565](https://github.com/hackclub/orchard/commit/00e25652c62dbb0569bcb7a921f1de1b4a183ee5))

## [2.43.1](https://github.com/hackclub/orchard/compare/server/v2.43.0...server/v2.43.1) (2026-09-17)


### Bug Fixes

* unwedge the mirror informer when a burst of watch events hits the concurrency limit ([71ccb8b](https://github.com/hackclub/orchard/commit/71ccb8b4124f360b44b0eb4476612b80a4144bc0))

## [2.43.0](https://github.com/hackclub/orchard/compare/server/v2.42.1...server/v2.43.0) (2026-09-17)


### Features

* use better deploy strat ([#82](https://github.com/hackclub/orchard/issues/82)) ([5d87aa5](https://github.com/hackclub/orchard/commit/5d87aa54499c72bac03b61a327dab016d4342d74))


### Bug Fixes

* anchor the build timer to the build start, not the row's updatedAt ([e245ddf](https://github.com/hackclub/orchard/commit/e245ddff3d6b4769bf66d9b7d6623a1b0aee240e))

## [2.42.1](https://github.com/hackclub/orchard/compare/server/v2.42.0...server/v2.42.1) (2026-09-17)


### Bug Fixes

* resolve namespaces through environments, not just the project ([48c5300](https://github.com/hackclub/orchard/commit/48c5300abde209cbc2a5cbc1c699c44b8c2eca3c))

## [2.42.0](https://github.com/hackclub/orchard/compare/server/v2.41.1...server/v2.42.0) (2026-09-17)


### Features

* allow users to stop apps ([#61](https://github.com/hackclub/orchard/issues/61)) ([d45734a](https://github.com/hackclub/orchard/commit/d45734ad527fa868c0734c2c312c4db002803883))
* **auth:** sign in with a host-minted link or a superadmin password ([3b6f20c](https://github.com/hackclub/orchard/commit/3b6f20c07bac939e25a0fa11a3eb2fbb8d5bca10))
* **frontend:** mouse, paste, zoom, titles and a settings menu for the pod shell ([1817925](https://github.com/hackclub/orchard/commit/181792550b2984c93e2be4cd595188145fb7b725))
* **hostctl:** stop, start and restart the instance ([4601393](https://github.com/hackclub/orchard/commit/460139364f7a3da00802880abe2a449e4ab4fd90))
* let superadmins create unlimited sandboxes ([d30164e](https://github.com/hackclub/orchard/commit/d30164e70d2978c7c8aa776d9ef01979b7c11596))
* link domains to redirect to ([#72](https://github.com/hackclub/orchard/issues/72)) ([77c1c46](https://github.com/hackclub/orchard/commit/77c1c4682a024d9b6a21168da0097b399a9371f9))
* **server:** durable pod shell sessions that survive a dropped connection ([89309ff](https://github.com/hackclub/orchard/commit/89309ff9f0d0a5b8843879ce0b11e63829714be1))
* **setup:** offer a password where a passkey cannot be created ([9f9c8c7](https://github.com/hackclub/orchard/commit/9f9c8c7e25cf56c04f5ff17eaf257b12b1d4f8ac))


### Bug Fixes

* **api:** return the URL for every ingress instead of letting clients guess it ([41226d7](https://github.com/hackclub/orchard/commit/41226d7f6edbcfe44af39bd06602eaa301fa7cd5))
* ensure smooth cutover ([#70](https://github.com/hackclub/orchard/issues/70)) ([63edee2](https://github.com/hackclub/orchard/commit/63edee24a4a1fbf79c406d6d700f4a13bf4889a6))
* handle query-statistics bug for JSON ([#60](https://github.com/hackclub/orchard/issues/60)) ([d45d892](https://github.com/hackclub/orchard/commit/d45d892e7d7adb3c0e2cc29c9ab835038fe0d54a))
* **hostctl:** stop claiming a hostname works before it is deployed ([46a3b89](https://github.com/hackclub/orchard/commit/46a3b898d34da6fa1e03b68cb8056f286dded703))
* **hostctl:** take the claim link's port from frontend_url ([f8b3ef9](https://github.com/hackclub/orchard/commit/f8b3ef92be902b1fead8862f3c0887600cfc1810))
* **install:** make a lan install reachable at the addresses it actually has ([2026400](https://github.com/hackclub/orchard/commit/2026400797c9239aef919e55f368a67cfd4e7247))
* measure sandbox max lifetime from the current run, not the row's age ([f8eb41c](https://github.com/hackclub/orchard/commit/f8eb41c10f87fee6ec68840e7eabc5357c3ed668))
* **server:** exec text frames are control only, real upstream backpressure, forced resize ([54a88fc](https://github.com/hackclub/orchard/commit/54a88fc52697e4f88d27e6929e0ce4edb0bc7e1f))
* **server:** keep a stopped app stopped through a rebuild ([981dff5](https://github.com/hackclub/orchard/commit/981dff503eff6ff08bc7c5a45f62e1f96ab170bf))
* **server:** safely transition health probe handlers ([b786b4e](https://github.com/hackclub/orchard/commit/b786b4e83f3b48ae1e895afba7ff23a6f960ddec))
* slugify template name params instead of rejecting spaces ([0c856a1](https://github.com/hackclub/orchard/commit/0c856a1267e3a1da927ac87aa8246951c25f102e))

## [2.41.1](https://github.com/hackclub/orchard/compare/server/v2.41.0...server/v2.41.1) (2026-09-17)


### Bug Fixes

* **server:** safely transition health probe handlers ([b786b4e](https://github.com/hackclub/orchard/commit/b786b4e83f3b48ae1e895afba7ff23a6f960ddec))

## [2.41.0](https://github.com/hackclub/orchard/compare/server/v2.40.0...server/v2.41.0) (2026-09-16)


### Features

* link domains to redirect to ([#72](https://github.com/hackclub/orchard/issues/72)) ([77c1c46](https://github.com/hackclub/orchard/commit/77c1c4682a024d9b6a21168da0097b399a9371f9))

## [2.40.0](https://github.com/hackclub/orchard/compare/server/v2.39.1...server/v2.40.0) (2026-09-16)


### Features

* **auth:** sign in with a host-minted link or a superadmin password ([3b6f20c](https://github.com/hackclub/orchard/commit/3b6f20c07bac939e25a0fa11a3eb2fbb8d5bca10))
* **setup:** offer a password where a passkey cannot be created ([9f9c8c7](https://github.com/hackclub/orchard/commit/9f9c8c7e25cf56c04f5ff17eaf257b12b1d4f8ac))


### Bug Fixes

* ensure smooth cutover ([#70](https://github.com/hackclub/orchard/issues/70)) ([63edee2](https://github.com/hackclub/orchard/commit/63edee24a4a1fbf79c406d6d700f4a13bf4889a6))

## [2.39.1](https://github.com/hackclub/orchard/compare/server/v2.39.0...server/v2.39.1) (2026-09-15)


### Bug Fixes

* **hostctl:** take the claim link's port from frontend_url ([f8b3ef9](https://github.com/hackclub/orchard/commit/f8b3ef92be902b1fead8862f3c0887600cfc1810))

## [2.39.0](https://github.com/hackclub/orchard/compare/server/v2.38.2...server/v2.39.0) (2026-09-15)


### Features

* **hostctl:** stop, start and restart the instance ([4601393](https://github.com/hackclub/orchard/commit/460139364f7a3da00802880abe2a449e4ab4fd90))


### Bug Fixes

* **hostctl:** stop claiming a hostname works before it is deployed ([46a3b89](https://github.com/hackclub/orchard/commit/46a3b898d34da6fa1e03b68cb8056f286dded703))

## [2.38.2](https://github.com/hackclub/orchard/compare/server/v2.38.1...server/v2.38.2) (2026-09-15)


### Bug Fixes

* **install:** make a lan install reachable at the addresses it actually has ([2026400](https://github.com/hackclub/orchard/commit/2026400797c9239aef919e55f368a67cfd4e7247))

## [2.38.1](https://github.com/hackclub/orchard/compare/server/v2.38.0...server/v2.38.1) (2026-09-15)


### Bug Fixes

* **api:** return the URL for every ingress instead of letting clients guess it ([41226d7](https://github.com/hackclub/orchard/commit/41226d7f6edbcfe44af39bd06602eaa301fa7cd5))

## [2.38.0](https://github.com/hackclub/orchard/compare/server/v2.37.0...server/v2.38.0) (2026-09-15)


### Features

* allow users to stop apps ([#61](https://github.com/hackclub/orchard/issues/61)) ([d45734a](https://github.com/hackclub/orchard/commit/d45734ad527fa868c0734c2c312c4db002803883))


### Bug Fixes

* handle query-statistics bug for JSON ([#60](https://github.com/hackclub/orchard/issues/60)) ([d45d892](https://github.com/hackclub/orchard/commit/d45d892e7d7adb3c0e2cc29c9ab835038fe0d54a))
* **server:** keep a stopped app stopped through a rebuild ([981dff5](https://github.com/hackclub/orchard/commit/981dff503eff6ff08bc7c5a45f62e1f96ab170bf))

## [2.37.0](https://github.com/hackclub/orchard/compare/server/v2.36.0...server/v2.37.0) (2026-09-15)


### Features

* let superadmins create unlimited sandboxes ([d30164e](https://github.com/hackclub/orchard/commit/d30164e70d2978c7c8aa776d9ef01979b7c11596))


### Bug Fixes

* measure sandbox max lifetime from the current run, not the row's age ([f8eb41c](https://github.com/hackclub/orchard/commit/f8eb41c10f87fee6ec68840e7eabc5357c3ed668))

## [2.36.0](https://github.com/hackclub/orchard/compare/server/v2.35.1...server/v2.36.0) (2026-09-15)


### Features

* **frontend:** mouse, paste, zoom, titles and a settings menu for the pod shell ([1817925](https://github.com/hackclub/orchard/commit/181792550b2984c93e2be4cd595188145fb7b725))
* **server:** durable pod shell sessions that survive a dropped connection ([89309ff](https://github.com/hackclub/orchard/commit/89309ff9f0d0a5b8843879ce0b11e63829714be1))


### Bug Fixes

* **server:** exec text frames are control only, real upstream backpressure, forced resize ([54a88fc](https://github.com/hackclub/orchard/commit/54a88fc52697e4f88d27e6929e0ce4edb0bc7e1f))

## [2.35.1](https://github.com/hackclub/orchard/compare/server/v2.35.0...server/v2.35.1) (2026-09-15)


### Bug Fixes

* **server:** stop the pod shell reconnect loop and surface exec failures ([a6ef5bd](https://github.com/hackclub/orchard/commit/a6ef5bdd61c5e2a33d7e545ccff84eb5ecd2600a))

## [2.35.0](https://github.com/hackclub/orchard/compare/server/v2.34.2...server/v2.35.0) (2026-09-15)


### Features

* **server:** make the pod shell fast, reconnecting and colour-capable ([d428970](https://github.com/hackclub/orchard/commit/d428970618d3b9232c53781f8a468bd9428ca239))
* **server:** tell people when something signs in to their account ([f18f117](https://github.com/hackclub/orchard/commit/f18f117d079399033c5100a2515ae1a3ccbf5ac5))


### Bug Fixes

* repair the seed script after the workspace models were removed ([#54](https://github.com/hackclub/orchard/issues/54)) ([187090b](https://github.com/hackclub/orchard/commit/187090bd7ec945edc2660c655b9869ff625de30e))
* **server:** fill email placeholders the formatter padded ([a349bcb](https://github.com/hackclub/orchard/commit/a349bcbde184da5dccea73651d9491d25bf0e0c2))
* **server:** give the pod shell its real size, a heartbeat and no nagle ([254dc97](https://github.com/hackclub/orchard/commit/254dc970ecc17a8d2b8b3e104a47bb9df998abf4))
* **server:** put the sign-in details in the email that asks if it was you ([e197b34](https://github.com/hackclub/orchard/commit/e197b34346954f7f479292ad30bdb1bfffdade37))

## [2.34.2](https://github.com/hackclub/orchard/compare/server/v2.34.1...server/v2.34.2) (2026-09-14)


### Bug Fixes

* make the setup flow honest about github and app domains ([fe028da](https://github.com/hackclub/orchard/commit/fe028daf2ad22cbefec9a7d325567703ed529a61))

## [2.34.1](https://github.com/hackclub/orchard/compare/server/v2.34.0...server/v2.34.1) (2026-09-14)


### Bug Fixes

* **server:** mint a claim link when there is no other way into the instance ([2c95a80](https://github.com/hackclub/orchard/commit/2c95a80fcc8315d1cf37105fd8b5555f6e20fe98))

## [2.34.0](https://github.com/hackclub/orchard/compare/server/v2.33.0...server/v2.34.0) (2026-09-14)


### Features

* probe apps with the HEALTHCHECK their Dockerfile declares ([#44](https://github.com/hackclub/orchard/issues/44)) ([4afc98b](https://github.com/hackclub/orchard/commit/4afc98b71eaf5e83ed2d4135c29c54cb43b00fde))


### Bug Fixes

* **server:** enforce env-pinned config locks outside the admin panel ([fd181d9](https://github.com/hackclub/orchard/commit/fd181d94dc121fc14532e07b1ec9831448a0283a))
* **server:** make a deployment's secret env vars write-only and encrypted at rest ([d5f82d9](https://github.com/hackclub/orchard/commit/d5f82d99b07ddfabd8995fcf96c37ae8875c25fb))

## [2.33.0](https://github.com/hackclub/orchard/compare/server/v2.32.0...server/v2.33.0) (2026-09-13)


### Features

* **server:** pull authenticated base images with app credentials ([#42](https://github.com/hackclub/orchard/issues/42)) ([6a20212](https://github.com/hackclub/orchard/commit/6a2021299d7fb217c2d8ffeee7896a660747dc8a))

## [2.32.0](https://github.com/hackclub/orchard/compare/server/v2.31.0...server/v2.32.0) (2026-09-11)


### Features

* check dns for every hostname and configure cloudflare tunnel routes ([00be104](https://github.com/hackclub/orchard/commit/00be1041de3e9e0910cf44d1812c5f0bb6354865))


### Bug Fixes

* **server:** apply mid-build volumes, report queued rebuilds, gate auto-deploy ([10c0154](https://github.com/hackclub/orchard/commit/10c0154ecbb30f304a3159584ed1340ddb911198))

## [2.31.0](https://github.com/hackclub/orchard/compare/server/v2.30.0...server/v2.31.0) (2026-09-11)


### Features

* auto-configure the mcp endpoint and an instance-wide public ip ([46c7bbc](https://github.com/hackclub/orchard/commit/46c7bbc9d9a439a664244f514228a3b974700b40))

## [2.30.0](https://github.com/hackclub/orchard/compare/server/v2.29.0...server/v2.30.0) (2026-09-11)


### Features

* rewrite orchardctl as a go binary ([db82650](https://github.com/hackclub/orchard/commit/db8265032ae74fc36dbf453452f622ac5d8b332a))


### Bug Fixes

* let the ingress controller reach tenant apps on any cluster ([d83fe8f](https://github.com/hackclub/orchard/commit/d83fe8f2570a0d3223f15458ecf28685e2b68344))

## [2.29.0](https://github.com/hackclub/orchard/compare/server/v2.28.5...server/v2.29.0) (2026-09-11)


### Features

* allow the bundled registry on install and add orchardctl registry ([f809de5](https://github.com/hackclub/orchard/commit/f809de56c67a5f8fafb5292213528ab2e1964b70))

## [2.28.5](https://github.com/hackclub/orchard/compare/server/v2.28.4...server/v2.28.5) (2026-09-11)


### Bug Fixes

* put the real cause in the build failure headline ([328306c](https://github.com/hackclub/orchard/commit/328306c29ff0cc57acd1ade0c883221f4b225527))

## [2.28.4](https://github.com/hackclub/orchard/compare/server/v2.28.3...server/v2.28.4) (2026-09-10)


### Bug Fixes

* stop git lfs failures from killing the build clone ([1541c68](https://github.com/hackclub/orchard/commit/1541c68f249eb64cc5296664fc6f1a423a81c386))

## [2.28.3](https://github.com/hackclub/orchard/compare/server/v2.28.2...server/v2.28.3) (2026-09-10)


### Bug Fixes

* back build scratch with disk when there is no vm isolation ([1768f3a](https://github.com/hackclub/orchard/commit/1768f3a53c6885892fb8daa5ef990318d23d3dac))

## [2.28.2](https://github.com/hackclub/orchard/compare/server/v2.28.1...server/v2.28.2) (2026-09-09)


### Bug Fixes

* read the certificate namespace from instance config and cache the lookup ([1b432cd](https://github.com/hackclub/orchard/commit/1b432cdcd0164205d85600dace8c65e557a458bc))

## [2.28.1](https://github.com/hackclub/orchard/compare/server/v2.28.0...server/v2.28.1) (2026-09-09)


### Bug Fixes

* show whether the wildcard certificate actually issued, not just that it is configured ([1704e6b](https://github.com/hackclub/orchard/commit/1704e6b1e92d35c0bf7612054c0122333a2d897b))

## [2.28.0](https://github.com/hackclub/orchard/compare/server/v2.27.0...server/v2.28.0) (2026-09-09)


### Features

* configure object storage, email, domains and wildcard tls from the admin panel ([a1f4e02](https://github.com/hackclub/orchard/commit/a1f4e023fef2fd988e5197730091b89149fdb44a))


### Bug Fixes

* derive the github oauth callback url instead of requiring an env var ([2631105](https://github.com/hackclub/orchard/commit/26311056b08b498bd0edb245b873a28f6cd3a514))
* repoint existing ingresses when the wildcard certificate config changes ([546d416](https://github.com/hackclub/orchard/commit/546d416b159468194760c741df7bf2cd0a3daaf8))

## [2.27.0](https://github.com/hackclub/orchard/compare/server/v2.26.2...server/v2.27.0) (2026-09-09)


### Features

* rebuild the first-run setup flow ([b0d3930](https://github.com/hackclub/orchard/commit/b0d3930c7937845cdde9d74b602baa86d31d9260))


### Bug Fixes

* require an organization before setup can complete ([6d17c37](https://github.com/hackclub/orchard/commit/6d17c37f424a3c60f27b835eb1437eee42f93df5))

## [2.26.2](https://github.com/hackclub/orchard/compare/server/v2.26.1...server/v2.26.2) (2026-09-07)


### Bug Fixes

* ensure the organization on every claim path ([0789188](https://github.com/hackclub/orchard/commit/0789188534d409e1a3725fef8a1fb96d9e04d2ca))

## [2.26.1](https://github.com/hackclub/orchard/compare/server/v2.26.0...server/v2.26.1) (2026-09-07)


### Bug Fixes

* show the organization step until the org is actually named ([dd123f5](https://github.com/hackclub/orchard/commit/dd123f58e31797b4fd77c014eab0fb56782be546))

## [2.26.0](https://github.com/hackclub/orchard/compare/server/v2.25.1...server/v2.26.0) (2026-09-07)


### Features

* copy the wildcard certificate into tenant namespaces ([fff7752](https://github.com/hackclub/orchard/commit/fff7752bdef365ae038f5fa391b1055cb1cd8e61))
* create the first organization at claim time and derive setup state ([14ad42a](https://github.com/hackclub/orchard/commit/14ad42a40c2e1557884e6f7c7168f79e97698bd9))
* instance setup checklist in the admin area ([a80146e](https://github.com/hackclub/orchard/commit/a80146ee5541e34c0e9ec3e9171c2bc8d76d986d))
* surface certificate issuance status on ingresses ([23d5f0e](https://github.com/hackclub/orchard/commit/23d5f0e5ec378032fa9f12fb342281a6c99dd4c8))


### Bug Fixes

* issue per-host certificates when no wildcard secret is configured ([a3375f9](https://github.com/hackclub/orchard/commit/a3375f921a90d28eaf61f6e8fe1f2b04c812a6e3))
* re-pull moving image tags on update ([2d36e9a](https://github.com/hackclub/orchard/commit/2d36e9abe04e15800f658f13d74f6a525affa197))

## [2.25.1](https://github.com/hackclub/orchard/compare/server/v2.25.0...server/v2.25.1) (2026-09-05)


### Bug Fixes

* keep the host commands under apps/server so releases ship them ([21296e1](https://github.com/hackclub/orchard/commit/21296e11af2e24ef70938a7ce834fc6297dc2e4f))

## [2.25.0](https://github.com/hackclub/orchard/compare/server/v2.24.0...server/v2.25.0) (2026-09-05)


### Features

* ship host commands in the server image so updates carry them ([fbaeb43](https://github.com/hackclub/orchard/commit/fbaeb433b3114f3548105053e0c6ce094edf147f))

## [2.24.0](https://github.com/hackclub/orchard/compare/server/v2.23.0...server/v2.24.0) (2026-09-05)


### Features

* claim an instance without email and sign in from the claim link ([b260bb6](https://github.com/hackclub/orchard/commit/b260bb6c55aa8fcfb2fecef3134525a2932af871))

## [2.23.0](https://github.com/hackclub/orchard/compare/server/v2.22.1...server/v2.23.0) (2026-09-04)


### Features

* basic auth on an ingress without cilium ([ea36adf](https://github.com/hackclub/orchard/commit/ea36adff30dbc83caa372c895c8d87fd0c8ab830))


### Bug Fixes

* derive platform domains from config instead of hardcoding them ([ad585dd](https://github.com/hackclub/orchard/commit/ad585dd681bd5d796a88bc72e9f8f397e44ef803))
* derive sandbox state from an instance-scoped mirror shard ([9d9c071](https://github.com/hackclub/orchard/commit/9d9c0713b0b97322354941cc7d4942c79063209d))
* load a base64 kubeconfig everywhere kubeconfig_path is read ([0928bb3](https://github.com/hackclub/orchard/commit/0928bb350f3bd7d06cb1299b276353ac26051c4f))
* look up sandbox pods through the mirror everywhere ([6402d22](https://github.com/hackclub/orchard/commit/6402d22794e79d5c6e638f85f10f320c42dfec4d))
* recreate a sandbox whose cluster resource vanished ([7a8f82f](https://github.com/hackclub/orchard/commit/7a8f82fd588c181ac6421fe318abc9a458680e25))
* seed project roles in a migration so self-hosted installs have them ([252b98f](https://github.com/hackclub/orchard/commit/252b98f190dc3294fd1dff2e626b65aba9a096ec))

## [2.22.1](https://github.com/hackclub/orchard/compare/server/v2.22.0...server/v2.22.1) (2026-09-04)


### Bug Fixes

* reconcile the disruption budget when the cluster changes replicas ([cbef67a](https://github.com/hackclub/orchard/commit/cbef67a678125001828445acdd380d95e93495bc))

## [2.22.0](https://github.com/hackclub/orchard/compare/server/v2.21.1...server/v2.22.0) (2026-09-04)


### Features

* per-app pod disruption budget in deploy behavior ([e145faa](https://github.com/hackclub/orchard/commit/e145faaa7816b61c2a48a0184fd4d95788921778))


### Bug Fixes

* give super builds a git binary ([ad7ba80](https://github.com/hackclub/orchard/commit/ad7ba807bda1de5de2099274762fab18f2dcabd9))

## [2.21.1](https://github.com/hackclub/orchard/compare/server/v2.21.0...server/v2.21.1) (2026-09-04)


### Bug Fixes

* retry builds that die on a kata sandbox start fault ([c1c7dc9](https://github.com/hackclub/orchard/commit/c1c7dc9a3e03aba33751efb994e5b870be0070b4))
* stream super build logs ([e80353e](https://github.com/hackclub/orchard/commit/e80353ecac1c9ece8fa91b7b56f316cbcbf9c629))

## [2.21.0](https://github.com/hackclub/orchard/compare/server/v2.20.0...server/v2.21.0) (2026-09-04)


### Features

* run super builds under gvisor instead of kata ([a57d630](https://github.com/hackclub/orchard/commit/a57d6309def5f4b2fa9e403aa65698f4cfdabe5c))


### Bug Fixes

* push super builds to the public registry, not the cluster-internal one ([648bb89](https://github.com/hackclub/orchard/commit/648bb896a6469d19716790e342093e447ba333c4))
* stop super builds consuming local builder capacity ([c3547ad](https://github.com/hackclub/orchard/commit/c3547adb6107d7883f6e992564110e045daf7678))

## [2.20.0](https://github.com/hackclub/orchard/compare/server/v2.19.0...server/v2.20.0) (2026-09-04)


### Features

* warn when auto-deploy is enabled but not connected ([e4453d3](https://github.com/hackclub/orchard/commit/e4453d3f279dc5b29ca562ea0eeff5d95a91422a))


### Bug Fixes

* keep the cluster mirror converging when a derived write fails ([184c8ef](https://github.com/hackclub/orchard/commit/184c8ef2e31770967629f62c258c321df279507a))
* stop auto-deploy silently dropping pushes ([a999853](https://github.com/hackclub/orchard/commit/a999853e8d3ffdd4f1b39cb533151827006b8dae))

## [2.19.0](https://github.com/hackclub/orchard/compare/server/v2.18.4...server/v2.19.0) (2026-09-03)


### Features

* deploy templates from a github repo and add the nephthys template ([6716e15](https://github.com/hackclub/orchard/commit/6716e15cab546aea6ae30d8b8b71f91d4e21c216))
* move a project to another organization ([e878cc4](https://github.com/hackclub/orchard/commit/e878cc4a065ab03d9d976db7d5373537283a2660))
* switch a deployment between railpack and dockerfile builds ([c179afb](https://github.com/hackclub/orchard/commit/c179afbaf6a6fd0f26c7ef6f7010a0e61d958266))

## [2.18.4](https://github.com/hackclub/orchard/compare/server/v2.18.3...server/v2.18.4) (2026-09-03)


### Bug Fixes

* create deployments, databases and compose stacks in the selected environment ([166af35](https://github.com/hackclub/orchard/commit/166af35a79104df14617d19819c29727dccca700))

## [2.18.3](https://github.com/hackclub/orchard/compare/server/v2.18.2...server/v2.18.3) (2026-09-03)


### Bug Fixes

* **server:** apply compose deploy.resources limits to child deployments ([9f8577f](https://github.com/hackclub/orchard/commit/9f8577f245f1ec77267c24e51072018e33f8b8e1))
* **server:** point compose-managed resource errors at the compose file ([f96bf73](https://github.com/hackclub/orchard/commit/f96bf73d7953b804d86122f565f7163d935ce0d7))
* **server:** stop enqueue shadowing its own startNow ([26ee46a](https://github.com/hackclub/orchard/commit/26ee46a2caf9ade868d64b625defdd541e9b0f97))

## [2.18.2](https://github.com/hackclub/orchard/compare/server/v2.18.1...server/v2.18.2) (2026-09-02)


### Bug Fixes

* **server:** stop dropping auto-deploys and mark superseded pushes ([92aba4c](https://github.com/hackclub/orchard/commit/92aba4c7800356161169275fd231204b1bfaa4f7))
* **server:** unwedge auto-deploy when the build job is already gone ([8286b7e](https://github.com/hackclub/orchard/commit/8286b7e4ecea498b1b558749b570066b3521f13a))

## [2.18.1](https://github.com/hackclub/orchard/compare/server/v2.18.0...server/v2.18.1) (2026-09-01)


### Bug Fixes

* bound the inputs feeding quadratic path and url trimming ([a91ea49](https://github.com/hackclub/orchard/commit/a91ea49c237addff6307af24e66397aa4068e0bd))
* draw otp codes without modulo bias ([9bbdb1e](https://github.com/hackclub/orchard/commit/9bbdb1e411113fda8b8471eda553c0f20f25abde))

## [2.18.0](https://github.com/hackclub/orchard/compare/server/v2.17.1...server/v2.18.0) (2026-09-01)


### Features

* watch paths for github auto-deploy ([06b1e44](https://github.com/hackclub/orchard/commit/06b1e4426655bb2c40ea32c7a2a6b33641f2b862))


### Bug Fixes

* validate repo urls before they reach the build pipeline ([b17de6b](https://github.com/hackclub/orchard/commit/b17de6b1dc0fc22c1a9d3ccd4c0caf43ea46b521))

## [2.17.1](https://github.com/hackclub/orchard/compare/server/v2.17.0...server/v2.17.1) (2026-09-01)


### Bug Fixes

* bump sharp to 0.35.4 for patched libheif and libvips ([81969b8](https://github.com/hackclub/orchard/commit/81969b82cecf39c12b9554da6c633967f14a3952))

## [2.17.0](https://github.com/LeafdTK/leaf/compare/server/v2.16.0...server/v2.17.0) (2026-08-28)


### Features

* transfer project ownership by request and accept ([36bf9a7](https://github.com/LeafdTK/leaf/commit/36bf9a761fd7ae0e4df84e29fe6e11ac09a70e37))


### Bug Fixes

* reconcile the pod mirror when a replica becomes leader ([5d17a64](https://github.com/LeafdTK/leaf/commit/5d17a6498084e1183c20aab2046fee77fb9669ff))
* share one cluster snapshot instead of four full pod lists ([3e3bdc8](https://github.com/LeafdTK/leaf/commit/3e3bdc8d7fda779e897d2bea7e80f4eac21aa6e1))

## [2.16.0](https://github.com/LeafdTK/leaf/compare/server/v2.15.0...server/v2.16.0) (2026-08-27)


### Features

* database health is informer-driven with crash alerts and post-mortem logs ([06fc147](https://github.com/LeafdTK/leaf/commit/06fc147d20cf8a0a203ca3dbf11e8c665690bac7))
* next steps checklist on the app overview ([b6566b8](https://github.com/LeafdTK/leaf/commit/b6566b8addff2a5b66285216b59788be28bc54c0))
* per-app image pull policy so restart can re-pull a moving tag ([3253561](https://github.com/LeafdTK/leaf/commit/3253561ac68c450d345a38656f23ea4da55fd1e1))
* pull policy follows the image tag unless you pin it ([e5fb253](https://github.com/LeafdTK/leaf/commit/e5fb2532139cf419cf63075060b4872e768537c9))
* surface kubernetes pod events and fix stale ui after saves ([5a2a9da](https://github.com/LeafdTK/leaf/commit/5a2a9da9bff50f80fd6cb029dd6e6d0706677a7d))


### Bug Fixes

* size shared_buffers and backup compression from the memory limit ([95d1c77](https://github.com/LeafdTK/leaf/commit/95d1c77041e3d400720bbf1986ef4c661762bd75))

## [2.15.0](https://github.com/LeafdTK/leaf/compare/server/v2.14.1...server/v2.15.0) (2026-08-25)


### Features

* dns-verified org domains, tenant-scoped sso sessions, sso off by default ([61eeaa7](https://github.com/LeafdTK/leaf/commit/61eeaa7716bad680433f7fdc93d1f7f87506b796))


### Bug Fixes

* make deleting an already-deleted database idempotent ([56c8093](https://github.com/LeafdTK/leaf/commit/56c8093d0c7402ec83b1a67ee1d6de7200cdf646))
* return 503 not 500 when query stats hit a restarting database ([c43d7a6](https://github.com/LeafdTK/leaf/commit/c43d7a66f1ab4192f14e1972142ea1fbc722e163))
* stop logging an error when a build outlives its deployment ([4f918ea](https://github.com/LeafdTK/leaf/commit/4f918eab4dc61e5a7d143282c84a1fc9ec20b476))
* stop the build watch loop spinning when the informer reports a cached terminal ([08f5b56](https://github.com/LeafdTK/leaf/commit/08f5b567b8074b1a1233faf189652b4fffc0d784))
* suspend github installations that github no longer has ([9a40d23](https://github.com/LeafdTK/leaf/commit/9a40d23117e6f9869597a2fd989220d4ae052498))

## [2.14.1](https://github.com/LeafdTK/leaf/compare/server/v2.14.0...server/v2.14.1) (2026-08-25)


### Bug Fixes

* give mcp grants their own session so role changes stop killing them ([7ab489c](https://github.com/LeafdTK/leaf/commit/7ab489c2fdaee21de8c2bd3374a4d3c1b6ee0fce))

## [2.14.0](https://github.com/LeafdTK/leaf/compare/server/v2.13.0...server/v2.14.0) (2026-08-24)


### Features

* multi-provider sso with org login pages and per-org admin controls ([00cc117](https://github.com/LeafdTK/leaf/commit/00cc1172b6cbf07c896f9dfe641b997f08686e07))

## [2.13.0](https://github.com/LeafdTK/leaf/compare/server/v2.12.0...server/v2.13.0) (2026-08-24)


### Features

* show the internal cluster address under every port ([7f77da8](https://github.com/LeafdTK/leaf/commit/7f77da80f41be677ec7acdcfc361ffcfc0542c62))

## [2.12.0](https://github.com/LeafdTK/leaf/compare/server/v2.11.0...server/v2.12.0) (2026-08-24)


### Features

* import a profile picture from gravatar when the email has one ([296e97c](https://github.com/LeafdTK/leaf/commit/296e97c879b488d729fed03454fc3661ba01491e))


### Bug Fixes

* call them read replicas, not standbys ([168256f](https://github.com/LeafdTK/leaf/commit/168256fdf83841997f501fb1cc9af39ccf44d1bd))

## [2.11.0](https://github.com/LeafdTK/leaf/compare/server/v2.10.0...server/v2.11.0) (2026-08-24)


### Features

* managed databases can run standby replicas ([f0c0ab3](https://github.com/LeafdTK/leaf/commit/f0c0ab3c2e425fe59605c71a9b34c9a6621bec5a))


### Bug Fixes

* stop scraping a dockerfile's own PATH into the env vars that run our builder ([0fb6e0d](https://github.com/LeafdTK/leaf/commit/0fb6e0d6b1cabcc084c8d5608b7c0edb19c110d9))

## [2.10.0](https://github.com/LeafdTK/leaf/compare/server/v2.9.0...server/v2.10.0) (2026-08-20)


### Features

* a fresh instance mints a setup token to claim superadmin ([a3742b9](https://github.com/LeafdTK/leaf/commit/a3742b98ae987937ffa4fef7061c651f6b351757))
* github app is created through the manifest flow instead of six pasted values ([a81f05c](https://github.com/LeafdTK/leaf/commit/a81f05c6eeaa5a81b410d3a7682f2c09e1023170))

## [2.9.0](https://github.com/LeafdTK/leaf/compare/server/v2.8.0...server/v2.9.0) (2026-08-18)


### Features

* mcp goes stateless on the 2026-07-28 spec ([6631bec](https://github.com/LeafdTK/leaf/commit/6631bec61ac8e7a32693f03ce67396dc371d2797))

## [2.8.0](https://github.com/LeafdTK/leaf/compare/server/v2.7.1...server/v2.8.0) (2026-08-18)


### Features

* command-k finds every app and database a person built ([607324f](https://github.com/LeafdTK/leaf/commit/607324f4b48a258eb9494179795cd937d4b77ae9))
* mirror engine resumes watches, batches writes, and tracks crash state in the db ([4d870d4](https://github.com/LeafdTK/leaf/commit/4d870d409161663ddf0728e37bfaa2f072ec2856))


### Bug Fixes

* a running pod waiting on its health check said scheduled ([dbb5085](https://github.com/LeafdTK/leaf/commit/dbb508525e4dc847adfd54439a22edd13deef449))
* the pod manifest handed env values to project viewers ([9f83ff4](https://github.com/LeafdTK/leaf/commit/9f83ff4934576962b056f30cbbd76ac75543bdcd))

## [2.7.1](https://github.com/LeafdTK/leaf/compare/server/v2.7.0...server/v2.7.1) (2026-08-16)


### Bug Fixes

* namespace sync overwriting deployment env from the live pod spec ([0f2e671](https://github.com/LeafdTK/leaf/commit/0f2e6717fdb83d3ce134fe3e195434e7370e0bf5))

## [2.7.0](https://github.com/LeafdTK/leaf/compare/server/v2.6.1...server/v2.7.0) (2026-08-15)


### Features

* notification channels can belong to one app instead of the whole org ([0ce6747](https://github.com/LeafdTK/leaf/commit/0ce6747bf35e020a73e5e4a77bb9781172349df1))

## [2.6.1](https://github.com/LeafdTK/leaf/compare/server/v2.6.0...server/v2.6.1) (2026-08-15)


### Bug Fixes

* the auth wall proxy kept the app's own host header ([488fac3](https://github.com/LeafdTK/leaf/commit/488fac3a2cff4bb1cbb1b50aa42327909c8c2d9c))

## [2.6.0](https://github.com/LeafdTK/leaf/compare/server/v2.5.3...server/v2.6.0) (2026-08-14)


### Features

* public paths skip the domain auth wall ([6b5283b](https://github.com/LeafdTK/leaf/commit/6b5283b24dcd766551a0162576e7e88224490ad6))


### Bug Fixes

* build job status tracking is level-triggered off a k8s informer ([3a14452](https://github.com/LeafdTK/leaf/commit/3a144524b3212f61019bcac8ade6aa66c93553ef))
* marking an env var secret needs tenant secrets rbac ([e6cb59b](https://github.com/LeafdTK/leaf/commit/e6cb59b315ecaa95a923d6631042b7671f6274cc))

## [2.5.3](https://github.com/LeafdTK/leaf/compare/server/v2.5.2...server/v2.5.3) (2026-08-12)


### Bug Fixes

* backup schedule updates carry the resourceversion ([0276b22](https://github.com/LeafdTK/leaf/commit/0276b22c122f9f7ff0bd4c36944e658ecef22142))

## [2.5.2](https://github.com/LeafdTK/leaf/compare/server/v2.5.1...server/v2.5.2) (2026-08-12)


### Bug Fixes

* mirror adopts the cpu limit instead of the derived request ([e428cc0](https://github.com/LeafdTK/leaf/commit/e428cc01b5f2586b5fcea4a79350d325fd24d476))

## [2.5.1](https://github.com/LeafdTK/leaf/compare/server/v2.5.0...server/v2.5.1) (2026-08-12)


### Bug Fixes

* pod lists serve real containers from mirrored manifests ([5b37f27](https://github.com/LeafdTK/leaf/commit/5b37f277d4c2e9f3b87bfe703973c45e0212a15f))

## [2.5.0](https://github.com/LeafdTK/leaf/compare/server/v2.4.2...server/v2.5.0) (2026-08-12)


### Features

* external kubectl spec changes adopted into orchard state ([5e1ab22](https://github.com/LeafdTK/leaf/commit/5e1ab22da67364ab7f21d70aedcd4c0456765432))
* lease-based leader election with multi-replica sso state and protection proxy guard ([a7e7c8e](https://github.com/LeafdTK/leaf/commit/a7e7c8e7c60775a8f9bd8e9c169ac66b0e750be2))
* postgres cluster mirror with lease-sharded informers ([2242d46](https://github.com/LeafdTK/leaf/commit/2242d463d9b4ce6ccaee0bdbfe125713ca2f39d0))
* reads served from the postgres mirror with live escape hatches ([a2b60b5](https://github.com/LeafdTK/leaf/commit/a2b60b5878933a8c19a5e3bd34b25e8f834c200d))
* retrying apply queue takes kubernetes writes out of the request path ([6860c1b](https://github.com/LeafdTK/leaf/commit/6860c1b275dffc5776e90d35a55fec6e044af8c4))

## [2.4.2](https://github.com/LeafdTK/leaf/compare/server/v2.4.1...server/v2.4.2) (2026-08-11)


### Bug Fixes

* build args baked into image layers as ENV directives ([23ca1a6](https://github.com/LeafdTK/leaf/commit/23ca1a654217e782b84b744780efcfc4bcf1a1c6))
* env vars removed from a config surviving in the running container ([8c62a39](https://github.com/LeafdTK/leaf/commit/8c62a3947c9bbedbb8f5c4b788e3bbd61053d369))

## [2.4.1](https://github.com/LeafdTK/leaf/compare/server/v2.4.0...server/v2.4.1) (2026-08-10)


### Bug Fixes

* railpack builds shipping a bash container when no start command is detected ([a5b210b](https://github.com/LeafdTK/leaf/commit/a5b210b3478ecd190173f604e89088131d328044))
* tenant workloads reserving their full cpu limit on the node ([b0cb9b7](https://github.com/LeafdTK/leaf/commit/b0cb9b7670197dd93ea220e9d6369c8cae391597))

## [2.4.0](https://github.com/LeafdTK/leaf/compare/server/v2.3.3...server/v2.4.0) (2026-08-08)


### Features

* node pools, taints, and workflow affinity scheduling ([a96caf3](https://github.com/LeafdTK/leaf/commit/a96caf3b8b1d7aa3d7d7116b8361cf2628dc3b83))


### Bug Fixes

* node pool placement type errors ([9c447e2](https://github.com/LeafdTK/leaf/commit/9c447e2638bf013cb1637cf6a160531d42e8754e))

## [2.3.3](https://github.com/LeafdTK/leaf/compare/server/v2.3.2...server/v2.3.3) (2026-08-08)


### Bug Fixes

* deny unresolvable hosts at the protection wall instead of allowing them ([26f62e2](https://github.com/LeafdTK/leaf/commit/26f62e221b52e974a6c913d4d5b2e8860bf008e7))
* ingress rows cascade with their deployment and protection verifies it applied ([66862ae](https://github.com/LeafdTK/leaf/commit/66862ae4db1c225f8e34d15bc18d45e7315622e5))

## [2.3.2](https://github.com/LeafdTK/leaf/compare/server/v2.3.1...server/v2.3.2) (2026-08-08)


### Bug Fixes

* never ship wal without a backup schedule behind it ([a74fe22](https://github.com/LeafdTK/leaf/commit/a74fe22d85d3438bc06f6d92970b0f76b37847cb))
* surface real kubernetes errors instead of http request failed ([0b833f0](https://github.com/LeafdTK/leaf/commit/0b833f0d769753f30bc5e3001997a0a94613f545))

## [2.3.1](https://github.com/LeafdTK/leaf/compare/server/v2.3.0...server/v2.3.1) (2026-08-06)


### Bug Fixes

* bound shared buildkit cache with tenant eviction ([5c34368](https://github.com/LeafdTK/leaf/commit/5c34368be478bed853393fddd73aef0ee410eaf1))

## [2.3.0](https://github.com/LeafdTK/leaf/compare/server/v2.2.1...server/v2.3.0) (2026-08-05)


### Features

* sandbox boot phases and terminal readiness gate ([9f95737](https://github.com/LeafdTK/leaf/commit/9f95737e55b3ef9a5e8629c75e8fe75c72291d14))
* scim role provisioning and enterprise extension ([6902152](https://github.com/LeafdTK/leaf/commit/6902152f1347b84dd58891ff196361fd63722b46))


### Bug Fixes

* make scim provisioning rfc 7644 compliant ([56ab24a](https://github.com/LeafdTK/leaf/commit/56ab24a7c25cab878dcaefe7c333447bad88d51e))
* scope scim-managed profiles to the provisioning org ([5588231](https://github.com/LeafdTK/leaf/commit/55882318fc0b22931a0aa51d2fe16afa40b5bc35))

## [2.2.1](https://github.com/LeafdTK/leaf/compare/server/v2.2.0...server/v2.2.1) (2026-08-05)


### Bug Fixes

* refresh sandbox secret and pod spec on start ([a5af781](https://github.com/LeafdTK/leaf/commit/a5af781ab3faa5b163dac8f7b806a25a95540072))

## [2.2.0](https://github.com/LeafdTK/leaf/compare/server/v2.1.0...server/v2.2.0) (2026-08-05)


### Features

* scope sandboxes to organizations with role based access ([7ae69e6](https://github.com/LeafdTK/leaf/commit/7ae69e67cbbf8b5d708b6e1a04f042d55975fabe))

## [2.1.0](https://github.com/LeafdTK/leaf/compare/server/v2.0.0...server/v2.1.0) (2026-08-05)


### Features

* auto-create sandbox namespace and isolation policy ([938e989](https://github.com/LeafdTK/leaf/commit/938e989bb0a5b1179ee639354fefe15267204241))
* bootstrap sandboxes from stock debian with setup scripts ([05a266a](https://github.com/LeafdTK/leaf/commit/05a266a1bbfbb66bebfc6204e5088306112d898b))
* build worker kill switch for shared infra dev servers ([3f0c075](https://github.com/LeafdTK/leaf/commit/3f0c07521b95fc7de0529c6656256c15ac5aa5ab))
* conductor style workspace and multi repo sandboxes ([96d1dd4](https://github.com/LeafdTK/leaf/commit/96d1dd49925225dc902afb0332cbdde973a6fbd5))
* default sandbox image from ghcr with publish workflow ([b3561b9](https://github.com/LeafdTK/leaf/commit/b3561b9b40712a78ff4cba4c799976bdc8ea63ba))
* enable sandboxes by default in dev ([25b367f](https://github.com/LeafdTK/leaf/commit/25b367fd8872f89ee2ec6e858b5a40a5b44d526b))
* full git operations for sandbox workspace ([c7f2b75](https://github.com/LeafdTK/leaf/commit/c7f2b754822fe2f46660823ae482a39c7c95d095))
* greenhouse ai sandboxes ([31e2325](https://github.com/LeafdTK/leaf/commit/31e23252b882f05daba9740df85bc621c8c93002))
* ide style cloud code workspace with live git changes ([0126efa](https://github.com/LeafdTK/leaf/commit/0126efa1eab06f9b5509912afc45725a6f68b967))
* opencode serve harness with proxy and native chat sessions ([e520d80](https://github.com/LeafdTK/leaf/commit/e520d80bf85c3c830b4b1653745f5d9f01334c6e))
* orchard mcp by default plus git and file endpoints ([9396499](https://github.com/LeafdTK/leaf/commit/93964994070821a51e61e6e7674b9ef87befbb71))
* sandbox cards, ssh identities, and cloud code chat ([e09fa8e](https://github.com/LeafdTK/leaf/commit/e09fa8ea3ae7d18ab405f53e0f1e80f38405901c))
* sandbox conversations with disk backed history and markdown transcript ([1032977](https://github.com/LeafdTK/leaf/commit/10329772860dbc5d9f5da9d7b11243bcb0c7a622))
* sandbox terminal websocket over pod exec ([5ae3a2c](https://github.com/LeafdTK/leaf/commit/5ae3a2cdbfbe6458616dd8beb873feeede2d67b1))


### Bug Fixes

* argv chat prompt and gate greenhouse behind posthog flag ([3fc34d5](https://github.com/LeafdTK/leaf/commit/3fc34d596aa51af7742370f8c3f215514355bd53))
* idle busy check understands opencode sessions ([1a142c0](https://github.com/LeafdTK/leaf/commit/1a142c04bb4206c46663044ef43debf1688fca0b))
* inject agent token per chat exec instead of boot env ([57afb77](https://github.com/LeafdTK/leaf/commit/57afb77f59b67301fe2739538f4db5112016a373))
* purge orphaned R2 backup objects when a database is deleted ([#153](https://github.com/LeafdTK/leaf/issues/153)) ([7b0285a](https://github.com/LeafdTK/leaf/commit/7b0285a81bf87b39ef203e197c3002e28042cf92))
* sandbox storage class falls back to cluster default ([aa335fe](https://github.com/LeafdTK/leaf/commit/aa335fe49633c138e5fb204d0d52338f2ae792f7))
* shell syntax in repo listing and clone scripts ([32e707b](https://github.com/LeafdTK/leaf/commit/32e707b8a67409bd371e7e2eac32ebdddd18be5c))
* strip whitespace from pasted agent tokens ([43381f8](https://github.com/LeafdTK/leaf/commit/43381f8c8901204edf5a4929d64ca1f06ebf2f3c))
* surface sandbox k8s errors and show status message in list ([a31e74e](https://github.com/LeafdTK/leaf/commit/a31e74e2aea830f0824a86518ace9505ce98289c))

## [2.0.0](https://github.com/LeafdTK/leaf/compare/server/v1.37.0...server/v2.0.0) (2026-08-04)


### ⚠ BREAKING CHANGES

* ui version 2.0 ([#150](https://github.com/LeafdTK/leaf/issues/150))

### Features

* ui version 2.0 ([#150](https://github.com/LeafdTK/leaf/issues/150)) ([12878ec](https://github.com/LeafdTK/leaf/commit/12878ec3e5987942f20bebc64bea06a56a189857))

## [1.37.0](https://github.com/LeafdTK/leaf/compare/server/v1.36.0...server/v1.37.0) (2026-07-30)


### Features

* **builder:** make tmpfs scratch an explicit bounded mode ([19f0f5a](https://github.com/LeafdTK/leaf/commit/19f0f5a3a6f5e4a3a53f3c16afd6617e3e19df80))


### Bug Fixes

* **builder:** drop build retries and skip the cache instead of rebuilding ([9950e25](https://github.com/LeafdTK/leaf/commit/9950e2535fa45ad2aefeced1e285428e0e5f926a))
* **builder:** stop retrying builds that failed inside a dockerfile step ([43569e1](https://github.com/LeafdTK/leaf/commit/43569e1b62f7004c919ba575a16b0b2d32770ca5))

## [1.36.0](https://github.com/LeafdTK/leaf/compare/server/v1.35.4...server/v1.36.0) (2026-07-30)


### Features

* **builder:** add disk-backed scratch mode as an alternative to block and tmpfs ([d3355f0](https://github.com/LeafdTK/leaf/commit/d3355f0b639eaca306dc873c6a09d6ee9ce82d49))


### Bug Fixes

* **databases:** send sslrootcert=system when the import source verifies its certificate ([86468fd](https://github.com/LeafdTK/leaf/commit/86468fd941e36844c124a79523c8c7d5161ac6eb))
* **network:** let in-cluster pods reach publicly exposed databases and deployments ([ba56e71](https://github.com/LeafdTK/leaf/commit/ba56e718c758a425bfd3cfe697577c8d3ad1428c))

## [1.35.4](https://github.com/LeafdTK/leaf/compare/server/v1.35.3...server/v1.35.4) (2026-07-30)


### Bug Fixes

* **builder:** make scratch reset survive the daemonless buildkitd lifecycle ([0eedf5b](https://github.com/LeafdTK/leaf/commit/0eedf5b67b8c5cb231834afb1fa3ec6f4ff1feb1))
* **compose:** claim a pvc for named volumes instead of silently mounting emptydir ([7959700](https://github.com/LeafdTK/leaf/commit/7959700ef7e7ad8d847cc4f7e36c05975651c666))
* **deployments:** keep public port exposure across namespace sync and exposure toggle ([fb0fea7](https://github.com/LeafdTK/leaf/commit/fb0fea7b370b1cb2018395a8eb09722a378ec95c))
* **quotas:** give database images a workable resource default ([a300234](https://github.com/LeafdTK/leaf/commit/a3002346c55ac27243dcd8e2cb7593a21fee98e8))

## [1.35.3](https://github.com/LeafdTK/leaf/compare/server/v1.35.2...server/v1.35.3) (2026-07-30)


### Bug Fixes

* **builder:** derive build status from pod phase and fail fast on unschedulable pods ([86e0e42](https://github.com/LeafdTK/leaf/commit/86e0e42e8c57690b66e4e21dab93fd7c87fb71ec))
* **builder:** retry storage io errors and rebuild scratch filesystem before retrying ([99545bb](https://github.com/LeafdTK/leaf/commit/99545bbb5e4a32b824d52baa806a375cefdd89ba))
* **builder:** stop stripping local cache export for sidecar push ([c522eac](https://github.com/LeafdTK/leaf/commit/c522eacabfcf4d4cebaed51874ff59b9e7caf1bb))

## [1.35.2](https://github.com/LeafdTK/leaf/compare/server/v1.35.1...server/v1.35.2) (2026-07-30)


### Bug Fixes

* **github:** only expose repos the user can access on github ([084d4d6](https://github.com/LeafdTK/leaf/commit/084d4d65fd378332d58d84266e4bcf96a5cc6bb8))
* **mcp:** delete unreferenced remote entrypoint with unvalidated oauth redirect ([e97ee4b](https://github.com/LeafdTK/leaf/commit/e97ee4b2299b72ce44b6d6cb27eaeee1cffeb626))

## [1.35.1](https://github.com/LeafdTK/leaf/compare/server/v1.35.0...server/v1.35.1) (2026-07-29)


### Bug Fixes

* allow removing an org member who is the sole admin of a project ([3497ad6](https://github.com/LeafdTK/leaf/commit/3497ad6d30028378d92df0c0bcefb8988f4cefed))

## [1.35.0](https://github.com/LeafdTK/leaf/compare/server/v1.34.3...server/v1.35.0) (2026-07-28)


### Features

* **builder:** make orchard build settings outrank a repo railpack.json ([0590c6c](https://github.com/LeafdTK/leaf/commit/0590c6c3986296ce1078222e1725da39d63d2b2f))


### Bug Fixes

* **builder:** detect the sveltekit adapter from config, not installed deps ([60c281b](https://github.com/LeafdTK/leaf/commit/60c281bc3a1b877b9b1b93eb9bd928b669816a96))
* **builder:** stop the local build path overwriting the chosen framework too ([82c9af5](https://github.com/LeafdTK/leaf/commit/82c9af5c49258f6a54168d77afb0cc3627e60f8e))

## [1.34.3](https://github.com/LeafdTK/leaf/compare/server/v1.34.2...server/v1.34.3) (2026-07-28)


### Bug Fixes

* **builder:** pin the railpack frontend to the cli version and stop spurious no-cache retries ([4ab7892](https://github.com/LeafdTK/leaf/commit/4ab7892c2e86ff3ac5cfa4da1fc206c6120ea9fb))

## [1.34.2](https://github.com/LeafdTK/leaf/compare/server/v1.34.1...server/v1.34.2) (2026-07-28)


### Bug Fixes

* **builder:** stop the cache prune and no-cache retry trampling live builds ([d3eda11](https://github.com/LeafdTK/leaf/commit/d3eda11cc70150c32caeb6084ef09ce7fa48bf4c))

## [1.34.1](https://github.com/LeafdTK/leaf/compare/server/v1.34.0...server/v1.34.1) (2026-07-28)


### Bug Fixes

* **builder:** stop the railpack binary squatting on railpack's cache dir ([12b5b07](https://github.com/LeafdTK/leaf/commit/12b5b073843e53288c848079be248823bb18aa65))

## [1.34.0](https://github.com/LeafdTK/leaf/compare/server/v1.33.0...server/v1.34.0) (2026-07-28)


### Features

* **builder:** detect frameworks and expose build overrides on railpack builds ([d827c87](https://github.com/LeafdTK/leaf/commit/d827c87780f095f389b3d06759aa5a529074e228))

## [1.33.0](https://github.com/LeafdTK/leaf/compare/server/v1.32.6...server/v1.33.0) (2026-07-24)


### Features

* **builder:** block-device scratch mode so build state lands on disk not ram ([5b2e8a8](https://github.com/LeafdTK/leaf/commit/5b2e8a83c04d420a423c45b99da048d34ac4bb28))

## [1.32.6](https://github.com/LeafdTK/leaf/compare/server/v1.32.5...server/v1.32.6) (2026-07-24)


### Bug Fixes

* **builder:** clear buildkit state before no-cache retry ([0cf60fb](https://github.com/LeafdTK/leaf/commit/0cf60fbab82aee5153fdf0cbff92b54ec81e82e3))

## [1.32.5](https://github.com/LeafdTK/leaf/compare/server/v1.32.4...server/v1.32.5) (2026-07-24)


### Bug Fixes

* **builder:** raise build vm memory so tmpfs fits large builds ([c11c07c](https://github.com/LeafdTK/leaf/commit/c11c07c3913b6072711edd828d4e6ef5f94665cd))

## [1.32.4](https://github.com/LeafdTK/leaf/compare/server/v1.32.3...server/v1.32.4) (2026-07-24)


### Bug Fixes

* **builder:** keep buildkit state on tmpfs, virtiofs causes ebadf ([c6bd76c](https://github.com/LeafdTK/leaf/commit/c6bd76cd3ceaa5c3fa7428af1978d3112769fb47))

## [1.32.3](https://github.com/LeafdTK/leaf/compare/server/v1.32.2...server/v1.32.3) (2026-07-24)


### Bug Fixes

* pin buildkit, retry builds without cache when it fills ([38e17be](https://github.com/LeafdTK/leaf/commit/38e17becb82086970c7ee88965ee0d35ead12ca7))

## [1.32.2](https://github.com/LeafdTK/leaf/compare/server/v1.32.1...server/v1.32.2) (2026-07-24)


### Bug Fixes

* buildkit gc so the cache volume stops filling up ([024b7ba](https://github.com/LeafdTK/leaf/commit/024b7ba2b032db04b81db934e4403f87191dc760))

## [1.32.1](https://github.com/LeafdTK/leaf/compare/server/v1.32.0...server/v1.32.1) (2026-07-23)


### Bug Fixes

* **builder:** move buildkit-state and output emptyDirs off tmpfs to disk ([fe4d790](https://github.com/LeafdTK/leaf/commit/fe4d79066a04908dedfeda6218bd182634cf4396))

## [1.32.0](https://github.com/LeafdTK/leaf/compare/server/v1.31.0...server/v1.32.0) (2026-07-22)


### Features

* github repo mirror, picker served from db ([3284a3d](https://github.com/LeafdTK/leaf/commit/3284a3d48c7e7436c613106da9d7aba88d4244a5))


### Performance Improvements

* parallel repo pagination, serve cached list instantly ([22ce7c7](https://github.com/LeafdTK/leaf/commit/22ce7c7817a369cc970bffd0a80efbc803241183))

## [1.31.0](https://github.com/LeafdTK/leaf/compare/server/v1.30.1...server/v1.31.0) (2026-07-22)


### Features

* auto deploy on by default for github deployments ([c09109d](https://github.com/LeafdTK/leaf/commit/c09109d49a2f28a1634e7573e31a6af3a1a3df09))
* auto-generated protected url on deployment create ([ad7b7d2](https://github.com/LeafdTK/leaf/commit/ad7b7d2a5be0319cef570e6b8fb7ddd80aeaefd9))
* gate local deploys behind LOCAL_DEPLOYS_ENABLED, off by default ([d37baeb](https://github.com/LeafdTK/leaf/commit/d37baeb1322c2bb9d7e57bd88229b5200364e4d8))
* live build log streaming over sse ([32e8b2f](https://github.com/LeafdTK/leaf/commit/32e8b2f4aadd4fbe66c61cbdea658ca4033a4cf5))
* one-shot github import endpoint and orchard import ([70398a2](https://github.com/LeafdTK/leaf/commit/70398a2efac3300e7400b951a7cca016ca351fc6))
* orchard up local directory deploys ([685b735](https://github.com/LeafdTK/leaf/commit/685b7350af9cff84abf50ac42e02339a3a3c558a))
* runtime log streaming over sse and event-driven metrics refresh ([81dc35f](https://github.com/LeafdTK/leaf/commit/81dc35fc16953aba8a58d3a60f6e70899d33806c))
* zero-config repo detection endpoint and create form pre-fill ([53ebf72](https://github.com/LeafdTK/leaf/commit/53ebf72057e7b859b64526db9f569f084e4d34ee))


### Bug Fixes

* resolve sub to uuid in project member filters, creamy card hover ([c71be35](https://github.com/LeafdTK/leaf/commit/c71be35e01850e73f5233eb0b66d1995cd756560))
* timeout, parallelize and cache github repo listing ([fdae0be](https://github.com/LeafdTK/leaf/commit/fdae0be26ffa96821a9f953ec14fc8440bdc4f09))

## [1.30.1](https://github.com/LeafdTK/leaf/compare/server/v1.30.0...server/v1.30.1) (2026-07-22)


### Bug Fixes

* hoist logUrl so auto deploys stop crashing on scope ([4c1561b](https://github.com/LeafdTK/leaf/commit/4c1561bf89b1f984977139de3e4b6f80e584d04d))

## [1.30.0](https://github.com/LeafdTK/leaf/compare/server/v1.29.1...server/v1.30.0) (2026-07-22)


### Features

* alert on failing wal archiving and missing backup schedules ([d9a2c3b](https://github.com/LeafdTK/leaf/commit/d9a2c3bdb824a5d82355319d84b89299899269ef))


### Bug Fixes

* platform db policy allows r2-proxy namespace ([1d3209c](https://github.com/LeafdTK/leaf/commit/1d3209ccdace68514679f2e25ae8e57d637ba977))

## [1.29.1](https://github.com/LeafdTK/leaf/compare/server/v1.29.0...server/v1.29.1) (2026-07-22)


### Bug Fixes

* watchdog timeout on build start so hung pre-job phases fail instead of spinning forever ([b91ee34](https://github.com/LeafdTK/leaf/commit/b91ee34859ee2b4308885be23185c5361f3badb4))

## [1.29.0](https://github.com/LeafdTK/leaf/compare/server/v1.28.0...server/v1.29.0) (2026-07-22)


### Features

* seamless build recovery with log continuity and deploy history ([aab1df3](https://github.com/LeafdTK/leaf/commit/aab1df31c34177f2e29cc3e9c01c54d204e3085a))


### Bug Fixes

* recover finished builds from job status or registry instead of marking lost ([e0763db](https://github.com/LeafdTK/leaf/commit/e0763db429e6451683859257ccdd0d77a8fb0745))
* requeue builds orphaned by server restart instead of failing ([3e6e12f](https://github.com/LeafdTK/leaf/commit/3e6e12fc00003997ed01ce06366eac2ecf82c305))

## [1.28.0](https://github.com/LeafdTK/leaf/compare/server/v1.27.1...server/v1.28.0) (2026-07-22)


### Features

* pass GIT_SHA build arg with checked out commit to image builds ([b346611](https://github.com/LeafdTK/leaf/commit/b34661142bf858ca69258c65635094f056870efd))

## [1.27.1](https://github.com/LeafdTK/leaf/compare/server/v1.27.0...server/v1.27.1) (2026-07-21)


### Bug Fixes

* public db hostnames are namespace qualified to prevent cross org collisions ([60b424a](https://github.com/LeafdTK/leaf/commit/60b424a18fd5279cdbe82df4ca8efb2c78900863))

## [1.27.0](https://github.com/LeafdTK/leaf/compare/server/v1.26.2...server/v1.27.0) (2026-07-21)


### Features

* per query statistics tab from pg_stat_statements ([7654b99](https://github.com/LeafdTK/leaf/commit/7654b9977a4962b80d262cad754f8714e624211f))
* postgres version choice and database stop start restart ([8e8660a](https://github.com/LeafdTK/leaf/commit/8e8660a2a5366015c53ec47b248afb8ddc158d02))


### Bug Fixes

* database page renders instantly, live stats load separately ([d7c90a7](https://github.com/LeafdTK/leaf/commit/d7c90a78d90115d5a8c15edca37b4e87d5ce4cdf))
* database size and connection stats, psql vars do not expand in -c ([a632218](https://github.com/LeafdTK/leaf/commit/a6322189f7299765324a3636d76013076792033d))

## [1.26.2](https://github.com/LeafdTK/leaf/compare/server/v1.26.1...server/v1.26.2) (2026-07-21)


### Bug Fixes

* github checks link to orchard logs instead of embedding them, reclaim closes orphaned runs ([1a7943f](https://github.com/LeafdTK/leaf/commit/1a7943f415afc18946aaa1bd6831fe243eb5cd41))
* redeploy forces recreate strategy when a pvc volume is mounted ([41d5f30](https://github.com/LeafdTK/leaf/commit/41d5f30cd1a55779d2250091ef0c2deb35404bcf))

## [1.26.1](https://github.com/LeafdTK/leaf/compare/server/v1.26.0...server/v1.26.1) (2026-07-21)


### Bug Fixes

* accept legacy hackclubid jwt claim in raw token readers ([3638dde](https://github.com/LeafdTK/leaf/commit/3638dde44c40476f088d9cb7f191e9cf0f02555e))

## [1.26.0](https://github.com/LeafdTK/leaf/compare/server/v1.25.2...server/v1.26.0) (2026-07-21)


### Features

* add signup_mode flag and de-hardcode asset, posthog and email hosts ([2b2bfb5](https://github.com/LeafdTK/leaf/commit/2b2bfb54bfeecedd47dc8b7e100e4a24b649cadc))
* generic oidc login provider and externalauthid rename ([d241af9](https://github.com/LeafdTK/leaf/commit/d241af93e8c50a06e7a08f31c5aa949ec9f10351))
* make registry project, pull secret and no_proxy configurable ([99cca73](https://github.com/LeafdTK/leaf/commit/99cca7318c9f2d2843a08cdf9176d01981427bc4))
* make storage class, ingress class, cert issuer and wildcard domains configurable ([33816bc](https://github.com/LeafdTK/leaf/commit/33816bcbd364b4b57fb0d7e61637b2ac1d74585a))
* real env examples, dev compose stack, contributor docs and clerk cleanup ([e5b849b](https://github.com/LeafdTK/leaf/commit/e5b849b6fe08c181078af2209af0bde28524fd7f))


### Bug Fixes

* cnpg operator netpol sweep targets only orchard managed namespaces ([b67abe0](https://github.com/LeafdTK/leaf/commit/b67abe020bd88aa92327da14a91523d12037f3bc))
* platform ensures its own db network policies at boot ([5ac7f0c](https://github.com/LeafdTK/leaf/commit/5ac7f0cf2db11ba5d4c5a62eb7adb762046047a9))
* read legacy orchard.dev labels and annotations during rename transition ([c88528f](https://github.com/LeafdTK/leaf/commit/c88528f00ef9f58dbc4ba73d27a1fdf7b2308b17))
* unify k8s label and annotation keys on orchard.my ([d1b42b2](https://github.com/LeafdTK/leaf/commit/d1b42b2c0d8c324f8a28fdc013ffb5983f962561))

## [1.25.2](https://github.com/LeafdTK/leaf/compare/server/v1.25.1...server/v1.25.2) (2026-07-20)


### Bug Fixes

* tenant namespaces allow cnpg operator to instance managers ([1082bae](https://github.com/LeafdTK/leaf/commit/1082bae50ac20872fcb2263369ee90fe4c3deabd))

## [1.25.1](https://github.com/LeafdTK/leaf/compare/server/v1.25.0...server/v1.25.1) (2026-07-20)


### Bug Fixes

* scrub credentials from clone logs and check run output ([581ed88](https://github.com/LeafdTK/leaf/commit/581ed886188fe76774bb6b73442a26b8057bfc3e))

## [1.25.0](https://github.com/LeafdTK/leaf/compare/server/v1.24.1...server/v1.25.0) (2026-07-20)


### Features

* version aware db imports, provision cluster at source pg major ([7d22a8a](https://github.com/LeafdTK/leaf/commit/7d22a8a4b27f89e35633c640b5ed132f5be6c543))

## [1.24.1](https://github.com/LeafdTK/leaf/compare/server/v1.24.0...server/v1.24.1) (2026-07-18)


### Bug Fixes

* hide org settings entry from non-admins ([c8c0250](https://github.com/LeafdTK/leaf/commit/c8c0250f2da931308425e6033975a841aabf497f))

## [1.24.0](https://github.com/LeafdTK/leaf/compare/server/v1.23.0...server/v1.24.0) (2026-07-18)


### Features

* rename apps via display name, k8s name stays frozen ([898fd5e](https://github.com/LeafdTK/leaf/commit/898fd5e2746646eb2c744629db38987df6ac47ed))
* rename databases, compose stacks, template instances, environments and api tokens ([625ee58](https://github.com/LeafdTK/leaf/commit/625ee58d7657538e2127cd6a399221ab13c7a33b))

## [1.23.0](https://github.com/LeafdTK/leaf/compare/server/v1.22.3...server/v1.23.0) (2026-07-18)


### Features

* change github repo, branch and dockerfile of an app after creation ([c5b99da](https://github.com/LeafdTK/leaf/commit/c5b99da385ebe9d1f2951ddb71bd2322808be905))

## [1.22.3](https://github.com/LeafdTK/leaf/compare/server/v1.22.2...server/v1.22.3) (2026-07-18)


### Bug Fixes

* csrf-protect github link oauth flow with an httponly nonce cookie checked against state, rejects forged callbacks ([9bbfada](https://github.com/LeafdTK/leaf/commit/9bbfadab8538a442a49ea2633bb05743db850ed4))
* github link threw account-exists for otp/passkey sessions, resolve existing user by hackclubid or internal id instead of findorcreate on sub ([c8d8173](https://github.com/LeafdTK/leaf/commit/c8d8173b45410070a802ab2780ff6e1ff2ed2d78))

## [1.22.2](https://github.com/LeafdTK/leaf/compare/server/v1.22.1...server/v1.22.2) (2026-07-18)


### Bug Fixes

* enqueue advisory lock threw deserializing void, use executeraw not queryraw ([18763b8](https://github.com/LeafdTK/leaf/commit/18763b80fcd95eba8ad81149dd8cf86c81e0fd00))

## [1.22.1](https://github.com/LeafdTK/leaf/compare/server/v1.22.0...server/v1.22.1) (2026-07-18)


### Bug Fixes

* build queue crash-looped the server on boot via circular dep, resolve with moduleref and a non-blocking claim lock ([4d28aec](https://github.com/LeafdTK/leaf/commit/4d28aec87c1984ca07beba548a92a1bcd3fe9d61))

## [1.22.0](https://github.com/LeafdTK/leaf/compare/server/v1.21.0...server/v1.22.0) (2026-07-18)


### Features

* auto-deploy queues the latest commit when a build is in progress instead of dropping it ([68f49a9](https://github.com/LeafdTK/leaf/commit/68f49a951e2fe6df47be4c332bb40a44e5c4dcb2))
* build queue rides the redis-streams sse bus with adaptive polling like the rest ([1a6c76b](https://github.com/LeafdTK/leaf/commit/1a6c76b161d293209d709d522294bfe99965f138))
* build queue view in Deploys tab with live run states, buildRunStatus badges, read API ([e102780](https://github.com/LeafdTK/leaf/commit/e1027802011392494f65913609794eb5d2e02f20))
* the build queue is real now, postgres skip-locked gates every build path through per-app and per-instance caps ([a8a1485](https://github.com/LeafdTK/leaf/commit/a8a1485118f6cf11006ef2970a3d699a34cfded5))

## [1.21.0](https://github.com/LeafdTK/leaf/compare/server/v1.20.2...server/v1.21.0) (2026-07-17)


### Features

* grove becomes an issue tracker with numbers, priorities, triage statuses, image attachments and chat style replies ([1142e46](https://github.com/LeafdTK/leaf/commit/1142e461fe79f1b6231e3d071a66d910f563b758))
* grove delete for own posts and replies, superadmins delete anything ([2718719](https://github.com/LeafdTK/leaf/commit/271871957ee2739db164a1ac9ba63c5ec70e99f9))
* grove gated behind GROVE_ENABLED / PUBLIC_GROVE_ENABLED env flags ([a3f9f34](https://github.com/LeafdTK/leaf/commit/a3f9f34ac9966de7df769a74dbe8e90d06aa882f))
* grove scopes replace emoji categories, bugs and feature requests only ([6901477](https://github.com/LeafdTK/leaf/commit/6901477454598e9a6ab3c5ae0a34f358ecda5ecf))
* the grove, a community forum for bugs, ideas and showcase with votes, statuses and orchard pixel sprites ([178fb96](https://github.com/LeafdTK/leaf/commit/178fb96aff66a0159ff4719e8df42fd9126e3734))


### Bug Fixes

* drop dashboard scope, main platform covers it ([3ae9e45](https://github.com/LeafdTK/leaf/commit/3ae9e4574154b463998c701ef75fd67ad1e717b3))
* **server:** forum images restricted to own storage prefix, upload extension from validated mimetype ([a275058](https://github.com/LeafdTK/leaf/commit/a2750588294a60aaec0d7c4165e12b3d52f888f9))
* volume attach failures now validated with real error messages, sizes and names normalized ([ba7fd9d](https://github.com/LeafdTK/leaf/commit/ba7fd9d0b88cf01cb278568364a71b6e4ab96fc9))

## [1.20.2](https://github.com/LeafdTK/leaf/compare/server/v1.20.1...server/v1.20.2) (2026-07-16)


### Bug Fixes

* **server:** sanitize auto-generated usernames from email local-parts across all signup paths ([d3f2357](https://github.com/LeafdTK/leaf/commit/d3f23575637f8cf670c9186338fc213d9e48bab3))

## [1.20.1](https://github.com/LeafdTK/leaf/compare/server/v1.20.0...server/v1.20.1) (2026-07-16)


### Bug Fixes

* username validation names the offending characters, strips invisible chars, backend enforces format ([4672510](https://github.com/LeafdTK/leaf/commit/46725103073c652bfeed0af0324b3da09e3522a4))

## [1.20.0](https://github.com/LeafdTK/leaf/compare/server/v1.19.0...server/v1.20.0) (2026-07-15)


### Features

* encrypt shared-var secrets at rest, size limits, write-only UI ([d812836](https://github.com/LeafdTK/leaf/commit/d812836479bca60b9637769043963ec6d265cd23))
* project environments — namespace-isolated envs with shared + secret variables ([cfab235](https://github.com/LeafdTK/leaf/commit/cfab2358dbc6baebf5cfebc2f1c58b8538c79c8a))


### Bug Fixes

* **server:** scrub ingress/db credential leaks, keep untouched secrets on shared-vars PUT, pod logs since params, per-PAT throttle, mcp validate_dns projectId ([eb7a3af](https://github.com/LeafdTK/leaf/commit/eb7a3af7bbd6aab3ddad6a1659b0ab719285ef36))

## [1.19.0](https://github.com/LeafdTK/leaf/compare/server/v1.18.0...server/v1.19.0) (2026-07-09)


### Features

* orchard jobs — scheduled multi-step pipelines on kubernetes ([#93](https://github.com/LeafdTK/leaf/issues/93)) ([721f190](https://github.com/LeafdTK/leaf/commit/721f190dfada0e2777e47c9b0f3d04bd1ba87535))

## [1.18.0](https://github.com/LeafdTK/leaf/compare/server/v1.17.1...server/v1.18.0) (2026-07-09)


### Features

* notification channel MCP tools ([ab74f5c](https://github.com/LeafdTK/leaf/commit/ab74f5c72b17d278da1d87fdd14e25f21e195031))


### Bug Fixes

* tailscale proxy apiserver egress via CiliumNetworkPolicy ([fcca09d](https://github.com/LeafdTK/leaf/commit/fcca09da032f0a44c233a1d305c5666a5ba379fc))

## [1.17.1](https://github.com/LeafdTK/leaf/compare/server/v1.17.0...server/v1.17.1) (2026-07-08)


### Bug Fixes

* allow kube apiserver egress in tailscale proxy network policy ([b976cca](https://github.com/LeafdTK/leaf/commit/b976ccaa7c93872bd51e12dec029b077f8997c76))
* boost db resources during import, settle after, and guard storage size ([e593566](https://github.com/LeafdTK/leaf/commit/e593566ae9e0e17c6659c050bd1abc7a841f353f))
* make depot build failures loud and match buildkit lint behavior ([2cad74a](https://github.com/LeafdTK/leaf/commit/2cad74ac66ccd3d9d8992be35557d4a56997f2ed))
* run ANALYZE after cnpg import so restored dbs have planner stats ([6f8458a](https://github.com/LeafdTK/leaf/commit/6f8458a61f895bb0d6735374bd5b0aaf42288417))
* surface real error when scaling fails ([bfb963b](https://github.com/LeafdTK/leaf/commit/bfb963bb820b12f5b1bc71a652a27b3e669a9560))

## [1.17.0](https://github.com/LeafdTK/leaf/compare/server/v1.16.0...server/v1.17.0) (2026-07-08)


### Features

* org notification channels for deploy, crash, and backup events ([ff906f1](https://github.com/LeafdTK/leaf/commit/ff906f10e4cb3041dc97094082fe11b7f595e2cc))

## [1.16.0](https://github.com/LeafdTK/leaf/compare/server/v1.15.2...server/v1.16.0) (2026-07-07)


### Features

* make warm cache a superadmin only setting ([6793747](https://github.com/LeafdTK/leaf/commit/6793747d4167d6c605267e4a4ea064acbc65f51f))

## [1.15.2](https://github.com/LeafdTK/leaf/compare/server/v1.15.1...server/v1.15.2) (2026-07-07)


### Bug Fixes

* fetch size and connections for cnpg databases ([c3f0dd6](https://github.com/LeafdTK/leaf/commit/c3f0dd69ce52ab877529d10823653d0ef8579822))
* restrict buildkit daemon ingress to build-job pods ([9e9709f](https://github.com/LeafdTK/leaf/commit/9e9709fa12a808545f389ebf301d3e04176f98b6))
* tailscale proxy rbac and pod env for containerboot ([6e27afb](https://github.com/LeafdTK/leaf/commit/6e27afb05d4f93cea61fc6bd4f34e7c987811458))

## [1.15.1](https://github.com/LeafdTK/leaf/compare/server/v1.15.0...server/v1.15.1) (2026-07-06)


### Bug Fixes

* persist mcp oauth client registrations across restarts ([91b3ebc](https://github.com/LeafdTK/leaf/commit/91b3ebce0abf0ec90f69b2b397b4958bab2d52e8))

## [1.15.0](https://github.com/LeafdTK/leaf/compare/server/v1.14.4...server/v1.15.0) (2026-07-06)


### Features

* grow-only database storage expansion with mcp tool ([f422d4f](https://github.com/LeafdTK/leaf/commit/f422d4ff41c048ed5a9c02f91f7de4131d93ab72))
* warn on failing wal archiving when expanding database storage ([95c4d39](https://github.com/LeafdTK/leaf/commit/95c4d3999be05a5a8c83bfb56d108cc531a35054))

## [1.14.4](https://github.com/LeafdTK/leaf/compare/server/v1.14.3...server/v1.14.4) (2026-07-06)


### Bug Fixes

* skip SecretsUsedInArgOrEnv lint so check=error dockerfiles build ([d6c0fa0](https://github.com/LeafdTK/leaf/commit/d6c0fa0d1a039c2589915773354a3f68f69147f0))
* surface the real build error instead of container termination noise ([af67c68](https://github.com/LeafdTK/leaf/commit/af67c68343640b217c378f445644a2be81633031))

## [1.14.3](https://github.com/LeafdTK/leaf/compare/server/v1.14.2...server/v1.14.3) (2026-07-06)


### Bug Fixes

* proxy protected apps before body parsing and tunnel websockets ([7bc7922](https://github.com/LeafdTK/leaf/commit/7bc792217a27a278b13df99d132b9c6e1f58f071))

## [1.14.2](https://github.com/LeafdTK/leaf/compare/server/v1.14.1...server/v1.14.2) (2026-07-06)


### Bug Fixes

* mark protection proxy endpoints ready and restore orphaned backends ([3878314](https://github.com/LeafdTK/leaf/commit/3878314bd693f1209a86f230bcbfcb217563fd2e))
* mcp crash on boot from required leader election dependency ([8b8cd11](https://github.com/LeafdTK/leaf/commit/8b8cd11ceb83c4f593e4c5c7098227e92d780eed))

## [1.14.1](https://github.com/LeafdTK/leaf/compare/server/v1.14.0...server/v1.14.1) (2026-07-06)


### Bug Fixes

* protection proxy endpoints no longer go stale on server redeploy ([7281c42](https://github.com/LeafdTK/leaf/commit/7281c429a0e7c3d3a0ddb0f911e51f5f212a7934))

## [1.14.0](https://github.com/LeafdTK/leaf/compare/server/v1.13.0...server/v1.14.0) (2026-07-06)


### Features

* cnpg pod informer emits database.changed health events ([34eaca9](https://github.com/LeafdTK/leaf/commit/34eaca94b33efaa0be0dde4e6548bdd7bf4bf55f))
* flood-fill white matte off scraped favicons ([0c03d16](https://github.com/LeafdTK/leaf/commit/0c03d163f025ecc475bb58d5f538e0c785bbdc84))
* **mcp:** killed-container log tools + previous-logs param ([609d318](https://github.com/LeafdTK/leaf/commit/609d31858db8d4d9ad5c6947cbeb49d80bcb2f93))
* push live deployment metrics over sse, relax frontend polling ([95c53fb](https://github.com/LeafdTK/leaf/commit/95c53fbd88f65e6342c966862ae5418c3528f596))
* scoped org builds feed endpoint, tighter deployment access checks ([d809db6](https://github.com/LeafdTK/leaf/commit/d809db6f3d501315ecf0a5e315c6d41534c8b039))
* summarize build failures instead of dumping full logs ([af18f15](https://github.com/LeafdTK/leaf/commit/af18f157659300fd7e814ee420d7c8d04bd5f3a6))


### Bug Fixes

* gate singleton background jobs behind leader election ([92aa32a](https://github.com/LeafdTK/leaf/commit/92aa32a3bb76cabf43d462e99a0f5eaea30d31dd))
* strip trailing dashes when truncating k8s resource names ([87bb10b](https://github.com/LeafdTK/leaf/commit/87bb10bd18f75a4424bd79ab00ae92c1c622af03))

## [1.13.0](https://github.com/LeafdTK/leaf/compare/server/v1.12.2...server/v1.13.0) (2026-07-02)


### Features

* informer-driven pod events on redis streams, OOM surfacing, killed-container logs ([#79](https://github.com/LeafdTK/leaf/issues/79)) ([2ba9309](https://github.com/LeafdTK/leaf/commit/2ba930913a6b3d4eaa8fe879081c66c24b114f85))

## [1.12.2](https://github.com/LeafdTK/leaf/compare/server/v1.12.1...server/v1.12.2) (2026-07-01)


### Bug Fixes

* exclude a deployment from its own member-allowance usage so redeploys don't double-count ([799a75f](https://github.com/LeafdTK/leaf/commit/799a75f7658dd6d7b2bf1916acd3dafb34781c13))
* namespace sync only reaps successfully-built deployments missing from k8s, and logs it ([7d6bdcd](https://github.com/LeafdTK/leaf/commit/7d6bdcd35e757b55076f2f9a66e54ede8d5113a8))
* zero-surge rolling updates (maxSurge 0) so deploys don't momentarily double pod resources ([9f14205](https://github.com/LeafdTK/leaf/commit/9f1420579394360094362687ff1a8c61c08bfd45))

## [1.12.1](https://github.com/LeafdTK/leaf/compare/server/v1.12.0...server/v1.12.1) (2026-07-01)


### Bug Fixes

* allow env var updates on compose-managed deployments, preserve them across redeploy ([67b95df](https://github.com/LeafdTK/leaf/commit/67b95df7a401fb3db033dda00da475ec8c551b99))

## [1.12.0](https://github.com/LeafdTK/leaf/compare/server/v1.11.2...server/v1.12.0) (2026-06-30)


### Features

* terminal-style colored logs with grouping, scroll pagination, server-side search, sentry-style errors ([9564844](https://github.com/LeafdTK/leaf/commit/95648442a08a5b209d0809e81d29bf0e33c0c81e))


### Bug Fixes

* cap prisma connection pool to prevent postgres connection exhaustion ([79f7b24](https://github.com/LeafdTK/leaf/commit/79f7b2412b9401363fa3cc9ad8ed4f14ef986b9d))

## [1.11.2](https://github.com/LeafdTK/leaf/compare/server/v1.11.1...server/v1.11.2) (2026-06-29)


### Bug Fixes

* restore observe logs + http metrics after haproxy ingress switch ([47eda41](https://github.com/LeafdTK/leaf/commit/47eda417516a0d448de07eaa5d28fec3c99e260f))

## [1.11.1](https://github.com/LeafdTK/leaf/compare/server/v1.11.0...server/v1.11.1) (2026-06-29)


### Bug Fixes

* pass label selector in correct arg position for pod informer list ([#73](https://github.com/LeafdTK/leaf/issues/73)) ([b7af352](https://github.com/LeafdTK/leaf/commit/b7af35299b2ee31bc722cede1ccc48a05dd5183f))

## [1.11.0](https://github.com/LeafdTK/leaf/compare/server/v1.10.0...server/v1.11.0) (2026-06-29)


### Features

* reliable live updates (redis streams bus, k8s pod informer, crash-loop surfacing) ([#72](https://github.com/LeafdTK/leaf/issues/72)) ([a710ece](https://github.com/LeafdTK/leaf/commit/a710ece69334fcfdfeee4ea5208954307865aec1))


### Bug Fixes

* make build-status SSE updates live and prompt reload on disconnect ([6a229dc](https://github.com/LeafdTK/leaf/commit/6a229dcb9b238d58fa049cedbf1c27c14ab473e2))

## [1.10.0](https://github.com/LeafdTK/leaf/compare/server/v1.9.0...server/v1.10.0) (2026-06-28)


### Features

* accurate build phases (scheduling builder) and skip pod-ready wait on deploy ([#69](https://github.com/LeafdTK/leaf/issues/69)) ([5eabbe9](https://github.com/LeafdTK/leaf/commit/5eabbe9d569439e54376a5b60bed43b1d4c6e147))

## [1.9.0](https://github.com/LeafdTK/leaf/compare/server/v1.8.0...server/v1.9.0) (2026-06-28)


### Features

* surface registry push as its own build step with live pusher logs ([#67](https://github.com/LeafdTK/leaf/issues/67)) ([0015ef8](https://github.com/LeafdTK/leaf/commit/0015ef88537cb9fd7849d57387f3995f2e2ee19b))

## [1.8.0](https://github.com/LeafdTK/leaf/compare/server/v1.7.2...server/v1.8.0) (2026-06-25)


### Features

* grant SYS_CHROOT to tenant workloads ([#65](https://github.com/LeafdTK/leaf/issues/65)) ([7691dda](https://github.com/LeafdTK/leaf/commit/7691dda84655b0423599ee9a69640c9ab598759e))

## [1.7.2](https://github.com/LeafdTK/leaf/compare/server/v1.7.1...server/v1.7.2) (2026-06-25)


### Bug Fixes

* re-apply health check probes on deployment rebuild ([#61](https://github.com/LeafdTK/leaf/issues/61)) ([80a3d2e](https://github.com/LeafdTK/leaf/commit/80a3d2e19c4d9aeff54aeae360b310cc69873388))

## [1.7.1](https://github.com/LeafdTK/leaf/compare/server/v1.7.0...server/v1.7.1) (2026-06-23)


### Bug Fixes

* show webhook token banner on create ([#57](https://github.com/LeafdTK/leaf/issues/57)) ([e0d33f4](https://github.com/LeafdTK/leaf/commit/e0d33f4b5790cc1f31960378a7982de395b1e349))

## [1.7.0](https://github.com/LeafdTK/leaf/compare/server/v1.6.6...server/v1.7.0) (2026-06-23)


### Features

* pull git-lfs files in builder clone ([#55](https://github.com/LeafdTK/leaf/issues/55)) ([76f1c32](https://github.com/LeafdTK/leaf/commit/76f1c323f46f338123f6be974ccaa08fb4a485d9))

## [1.6.6](https://github.com/LeafdTK/leaf/compare/server/v1.6.5...server/v1.6.6) (2026-06-23)


### Bug Fixes

* migrate tenant ingress to haproxy class, drop lua redirect CEC ([#52](https://github.com/LeafdTK/leaf/issues/52)) ([1a5fd6b](https://github.com/LeafdTK/leaf/commit/1a5fd6ba7886dcdb5cc5c58c981b4ea92b14024c))

## [1.6.5](https://github.com/LeafdTK/leaf/compare/server/v1.6.4...server/v1.6.5) (2026-06-23)


### Bug Fixes

* add DB-level claim for recovery, prevent wrong-image deploy ([df258c2](https://github.com/LeafdTK/leaf/commit/df258c257cae404419b609c151389076623fcab1))
* add host and remote-node entities to allow-cilium-ingress CNP ([5eeaa8c](https://github.com/LeafdTK/leaf/commit/5eeaa8ccfe4a0648084e4aeb24d862952e060399))
* align build steps with frontend, fix NaN total duration from __jobName ([0ad95f9](https://github.com/LeafdTK/leaf/commit/0ad95f9fee2398e42617a827144738b3610d3839))
* don't mark build succeeded when k8s deployment missing, sort jobs by creation time ([9c83edd](https://github.com/LeafdTK/leaf/commit/9c83eddd69b9836916944c81bb5a714489daa9d1))
* keep cache export in sidecar push, run it after .done marker ([ce9caa5](https://github.com/LeafdTK/leaf/commit/ce9caa5f7fb8daa0b1c07538ea9455de8810c477))
* speed up post-build deploy, add build recovery on server restart ([4d0cd4c](https://github.com/LeafdTK/leaf/commit/4d0cd4c30183ccb8363dca9365352db909b211d4))
* wait for rollout before marking build as succeeded ([df2c74f](https://github.com/LeafdTK/leaf/commit/df2c74fe16c165c2ab4b232fd79fe0c16547eac6))


### Performance Improvements

* parallelize pre-build setup, reduce DB round trips in build pipeline ([2309a68](https://github.com/LeafdTK/leaf/commit/2309a680ecb6de3a33c2c0e7121feb2e6290c7e9))
* SSE-first polling, emit build step events, skip cache export for sidecar push ([4779a49](https://github.com/LeafdTK/leaf/commit/4779a4907b8d17920e36b6785c8a8061d6173346))

## [1.6.4](https://github.com/LeafdTK/leaf/compare/server/v1.6.3...server/v1.6.4) (2026-06-22)


### Bug Fixes

* allow allowance overcommit, reconcile k8s replicas on redeploy/restart ([9f0520b](https://github.com/LeafdTK/leaf/commit/9f0520bcb18cd398558b7acea0aa1696d7640a5e))

## [1.6.3](https://github.com/LeafdTK/leaf/compare/server/v1.6.2...server/v1.6.3) (2026-06-20)


### Bug Fixes

* protection proxy security + restyle to match platform ([#48](https://github.com/LeafdTK/leaf/issues/48)) ([018cf71](https://github.com/LeafdTK/leaf/commit/018cf71fa58195c2fb72e2ba4f0c3e645a2257be))

## [1.6.2](https://github.com/LeafdTK/leaf/compare/server/v1.6.1...server/v1.6.2) (2026-06-20)


### Bug Fixes

* replace CEC-based protection with reverse proxy through orchard server ([#45](https://github.com/LeafdTK/leaf/issues/45)) ([c916942](https://github.com/LeafdTK/leaf/commit/c91694205f6d1c1df0e5bcbaf7bfef2d30399e72))

## [1.6.1](https://github.com/LeafdTK/leaf/compare/server/v1.6.0...server/v1.6.1) (2026-06-20)


### Bug Fixes

* backendServices.number must be string array, not integer ([#43](https://github.com/LeafdTK/leaf/issues/43)) ([18594b1](https://github.com/LeafdTK/leaf/commit/18594b1e9859ebb44733300968ecd1755ef13ddf))

## [1.6.0](https://github.com/LeafdTK/leaf/compare/server/v1.5.2...server/v1.6.0) (2026-06-20)


### Features

* add deployment protection (password + orchard sign-in) ([#40](https://github.com/LeafdTK/leaf/issues/40)) ([a44e598](https://github.com/LeafdTK/leaf/commit/a44e598182c7dd64307b6983007cb7a5a75af0ff))

## [1.5.2](https://github.com/LeafdTK/leaf/compare/server/v1.5.1...server/v1.5.2) (2026-06-20)


### Bug Fixes

* add route_config to CECs, set force-https disabled on TLS ingresses ([#38](https://github.com/LeafdTK/leaf/issues/38)) ([f760c1f](https://github.com/LeafdTK/leaf/commit/f760c1fb62ebfb786a82ae1073d0d4b21e1468b7))

## [1.5.1](https://github.com/LeafdTK/leaf/compare/server/v1.5.0...server/v1.5.1) (2026-06-20)


### Bug Fixes

* replace force-https with per-service envoy lua redirect ([#36](https://github.com/LeafdTK/leaf/issues/36)) ([f24a517](https://github.com/LeafdTK/leaf/commit/f24a51762d04def745c1c83f1542917398cdef71))

## [1.5.0](https://github.com/LeafdTK/leaf/compare/server/v1.4.3...server/v1.5.0) (2026-06-20)


### Features

* migrate ingress from traefik to cilium ([#33](https://github.com/LeafdTK/leaf/issues/33)) ([6f56338](https://github.com/LeafdTK/leaf/commit/6f56338ad3fbc98378cff94c32caa42a368176f7))


### Bug Fixes

* add allow-cilium-ingress CNP to tenant namespace setup ([#35](https://github.com/LeafdTK/leaf/issues/35)) ([fc2a17d](https://github.com/LeafdTK/leaf/commit/fc2a17d79c2418c9046afa7ae75ba78a229da114))

## [1.4.3](https://github.com/LeafdTK/leaf/compare/server/v1.4.2...server/v1.4.3) (2026-06-20)


### Bug Fixes

* add sharing-cross-namespace annotation for cilium lb ipam ([#32](https://github.com/LeafdTK/leaf/issues/32)) ([5000dbe](https://github.com/LeafdTK/leaf/commit/5000dbef9e9e141cbb3b1dae1cbd4b064cd73ac2))
* use cilium lbipam sharing-key instead of metallb allow-shared-ip ([#30](https://github.com/LeafdTK/leaf/issues/30)) ([a7a29e8](https://github.com/LeafdTK/leaf/commit/a7a29e8bf269092afb1d0b6981ee4ec1b5aabc18))

## [1.4.2](https://github.com/LeafdTK/leaf/compare/server/v1.4.1...server/v1.4.2) (2026-06-20)


### Bug Fixes

* normalize .git suffix on github repo URLs for autodeploy matching ([#28](https://github.com/LeafdTK/leaf/issues/28)) ([8f3ba7d](https://github.com/LeafdTK/leaf/commit/8f3ba7d1335c4176033000c1acb40e1c95687674))

## [1.4.1](https://github.com/LeafdTK/leaf/compare/server/v1.4.0...server/v1.4.1) (2026-06-16)


### Bug Fixes

* observability dashboard uptime, HTTP stats, and multi-container logs ([#26](https://github.com/LeafdTK/leaf/issues/26)) ([1c7c18a](https://github.com/LeafdTK/leaf/commit/1c7c18afc9998ef4ea8ad0ddbecbdcac3d9b1948))

## [1.4.0](https://github.com/LeafdTK/leaf/compare/server/v1.3.0...server/v1.4.0) (2026-06-16)


### Features

* observability dashboard with runtime detection and error tracking ([#24](https://github.com/LeafdTK/leaf/issues/24)) ([c3b2bca](https://github.com/LeafdTK/leaf/commit/c3b2bca293bda8b1b7ca63210baa915f6b2c85b0))

## [1.3.0](https://github.com/LeafdTK/leaf/compare/server/v1.2.0...server/v1.3.0) (2026-06-16)


### Features

* show app version on user settings page ([#22](https://github.com/LeafdTK/leaf/issues/22)) ([26b0522](https://github.com/LeafdTK/leaf/commit/26b052287c7c3c4b0b7f32afa5b95c7d15c16dde))

## [1.2.0](https://github.com/LeafdTK/leaf/compare/server/v1.1.0...server/v1.2.0) (2026-06-16)


### Features

* production hardening — probes/HA, rate limiting, LICENSE ([#18](https://github.com/LeafdTK/leaf/issues/18)) ([3031369](https://github.com/LeafdTK/leaf/commit/303136918d186e601437ac4da26608ed1601236b))

## [1.1.0](https://github.com/LeafdTK/leaf/compare/server/v1.0.1...server/v1.1.0) (2026-06-16)


### Features

* SCIM 2.0 user/group provisioning ([#14](https://github.com/LeafdTK/leaf/issues/14)) ([eb242ee](https://github.com/LeafdTK/leaf/commit/eb242ee3cd19bc4b068a045d4772a4bcc17eefc0))

## [1.0.1](https://github.com/LeafdTK/leaf/compare/server/v1.0.0...server/v1.0.1) (2026-06-16)


### Bug Fixes

* allow dots in github repo names for deploy ([cb1364d](https://github.com/LeafdTK/leaf/commit/cb1364d0b83a7a613cd400a3556cd477e4aa48c9))

## 1.0.1 (2026-06-16)

### Fixes

- allow dots in github repo names for deploy
