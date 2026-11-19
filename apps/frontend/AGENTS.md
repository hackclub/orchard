# Orchard frontend: agent guide

## Stack

- **Framework:** SvelteKit + Svelte 5 (`$state`, `$derived`, `$effect`, `$props`, `$bindable`)
- **Styling:** Tailwind CSS 4 + scoped `<style>` blocks with CSS custom properties
- **Icons:** `lucide-svelte` (static), `@jis3r/icons` (animated, hover-triggered)
- **Animation:** `motion` (motion.dev), real spring physics via `animate()`
- **Package manager:** pnpm (never bun)
- **Type checking:** don't run `tsc` / `svelte-check`; it's slow and has pre-existing noise

## Design System (hard rules)

Full reference: `apps/frontend/DESIGN.md`. Guardrail: `pnpm check:design` (run in apps/frontend) fails
when counts of hex colors, legacy tokens, legacy classes or status-token fills in `.svelte` files
exceed `design-baseline.json`.

- Never write a hex color in a `.svelte` file. Use semantic tokens from `src/lib/design/tokens.css`
  (`--bg-*`, `--text-*`, `--border-*`, `--accent*`, `--status-*`, `--hue-*`) or the
  Tailwind utilities `text-fg/text-muted/text-faint/bg-surface/bg-raised/border-edge`.
- Never use legacy tokens in components. `LEGACY_TOKENS` in `scripts/check-design.mjs` is the list:
  `--center-channel*`, `--sidebar-*`, `--surface-{bg,border,muted}`, `--control-{bg,hover-bg,text}`,
  `--dropdown-{bg,border,hover-bg}`, `--mention-*`, `--online/away/dnd-indicator`, `--org-trigger*`,
  `--button-{bg,color}`, `--card-bg`, `--error-text-color`, `--link-color`, `--new-message-separator`,
  and `--{warning,success,info}-{bg,border,text}`. They are the private engine layer under `tokens.css`.
- Never use raw `.btn/.card/.badge/.alert/.input/.dropdown/.skeleton` classes in new
  markup. Use `ui/` components (`Button`, `SectionCard`, `Badge`, `Alert`, `Input`,
  `Menu`/`Dropdown`/`PopoverPanel`, `Skeleton`, `EmptyState`, `Modal`).
- All status rendering goes through `ui/status.ts` (`resourceStatus`/`podStatus`/
  `buildStatusMeta`/`runStatus`/`statusMeta`) rendered as `StatusBadge`/`StatusDot`.
  Never hand-roll a status switch; status is never color alone.
- No left-accent borders. Alerts/callouts are tinted bg + subtle full border.
- Labels are a last resort: combine into the value or de-emphasize under it. No
  "Label: value" grids.
- No comments in authored code. No em dashes in UI copy.
- Never redefine motion utilities locally; import from `$lib/utils/motion.svelte`.
- Svelte transitions come from `$lib/utils/transitions`, never `svelte/transition`.
  Raw `animate()` calls take `transition(name)` as their options; css keyframes are
  killed below `full` by default, so a spinner opts back in with `data-motion="progress"`.
- Never write `stiffness`, `damping`, or `mass` in a component. Name a spring.

## Motion System

All interactive animation uses spring physics. CSS `transition` carries color and opacity on hover states, and transforms when it runs on the spring tokens (`transform var(--spring-press-duration) var(--spring-press)` in `Button.svelte`). Any other movement, scaling or layout change goes through a Motion spring.

### Curves

The curve table, tempo and how to use them are in Motion in `DESIGN.md`. **Never write stiffness, damping, mass, cubic-bezier or a millisecond duration for interaction motion in a component. Name a curve.**

### Coming from somewhere

Things that appear should come from where they were, not fade in from nowhere. `originBurst` measures a real page-space point (the control you clicked) and launches each item out of it at 0.2 scale along its own vector, reversing on close. Three details make it read as mass rather than decoration:

- the origin is **measured**, not a generic `y: 8` offset, so every item has a different trajectory
- opacity **lags the movement by 50ms** on exit, so an item is still visible while it travels home. In lockstep it vanishes before it arrives and reads as a fade
- the exit stagger is **reversed**, so the furthest item leaves first

### State that arrives on its own

Most of what Orchard shows is not typed in by the user. Build steps advance, pods crash, replicas come up. It arrives over SSE and the pod informer, and it describes something that **already happened on the cluster**. `DeploymentAlerts` even keeps grace windows because that state genuinely flaps.

So the normal rule inverts. Animating *into* a reality-driven state adds latency to information: a pod that died 200ms ago should not spend another 350ms springing a red dot into view. The state lands instantly, and only its **trail** is animated, which is also the thing that tells you what changed while you were on another tab.

`stateEcho(key)` does exactly that: when `key()` changes it drives `--echo` from 1 to 0 over 0.8s. Add `.motion-echo` plus an `echo--<kind>` class (or set `--echo-color`) and it paints a decaying ring in the status colour.

The ring is a `<span class="motion-echo-ring">` the attachment creates and removes itself, **not** a `::before`/`::after`. Components here already use both pseudo-elements for shadow and border layers, and at equal specificity source order wins silently: a pseudo-element version of this compiled fine, animated its variable correctly, and painted absolutely nothing.

```svelte
<div class="entity motion-echo echo--{status.kind}" {@attach stateEcho(() => status.kind)}>
```

Wired to `EntityCard` and to `ActivityRow`, which carries the ring classes for the rows `HistoryTab` and `ReleaseCard` attach it to. It never fires on mount, since a freshly rendered list has not just changed. It survives `reduced` as a plain fade, because it carries information and moves nothing.

**Use a named spring when the user caused the change. Use `stateEcho` when the cluster did.**

### What moves, what doesn't

The rule and the full table are in Motion in `DESIGN.md`.

### Overlays

Every transient surface (`Menu`, `PopoverPanel`, and anything built on them) goes through `overlayMotion`. It replaced a 130ms CSS keyframe that had **no exit at all**, because the same rule that hid the panel used `display: none`, so panels vanished rather than dismissed.

Two constraints come from these being native popovers:

- the element is not in the top layer until the library calls `showPopover()`, which happens *after* the Svelte effect. Animating immediately runs against a non-rendered element and completes instantly, so the entrance is deferred one frame.
- the library rewrites the element's `style` attribute while positioning it, so an inline "start hidden" seed is gone by the next frame. The closed state is seeded with the `.motion-entering` class instead, dropped once the animation owns the property.

**Interruptibility**: a fresh open passes explicit `[from, to]` keyframes, but an interrupted one passes **targets only**, so the spring continues from the live on-screen values instead of snapping back to the start. Reversing a half-open menu picks up where it actually is.

### Accessibility tiers

Every animation resolves through `transition(name)`, which rewrites itself per the user's animation level (Settings → Accessibility):

| Level | Behaviour |
|---|---|
| `full` | the named spring, transforms allowed |
| `reduced` | a **260ms** cross-fade, transforms stripped and stagger set to zero. Deliberately *not* faster than `full` |
| `off` | nothing animates. `MotionGlobalConfig.skipAnimations` stops Motion itself, CSS transitions are clamped, and the mesh gradient stops drifting |

**`reduced` is a cross-fade, not a fast-forward.** Compressing the same choreography into a fraction of the time makes things worse for the people who asked for less motion: a 500px panel closing in 120ms is a snap, exactly the abrupt change Reduce Motion exists to avoid. The tier keeps an unhurried duration and removes the *motion* instead: `adapt` strips transforms, the stagger goes to zero (a wave travelling across a group is choreography even when nothing translates), and opacity carries the change.

`system` follows `prefers-reduced-motion`. CSS `@keyframes` are killed below `full` by default; a progress indicator that must keep spinning opts back in with `data-motion="progress"`.

### Import

```ts
import { springHover, motionStagger, springPop, springCollapse, springRotate, springWidth, motionPopover, motionBackdrop, magneticHighlight, transition, motion } from '$lib/utils/motion.svelte';
```

### Core utilities (all in `$lib/utils/motion.svelte.ts`)

| Utility | Purpose | Usage |
|---|---|---|
| `transition(name, opts?)` | Resolve a named spring for the current tier | `animate(el, kf, transition('smooth'))` |
| `motion(el, kf, name?, opts?)` | Tier-aware `animate` that also drops transforms at `reduced` | `motion(el, { opacity: 0, y: 8 }, 'smooth')` |
| `springHover(opts?)` | Lift + press/release on hover/click | `{@attach springHover()}` |
| `motionStagger(opts)` | Staggered entrance for lists/grids | `{@attach motionStagger({ index: i })}` |
| `springPop(active)` | One-shot pop when boolean flips to true | `{@attach springPop(() => isActive)}` |
| `springCollapse(collapsed)` | Spring-driven height collapse | `{@attach springCollapse(() => isCollapsed)}` |
| `springRotate(active, opts?)` | Rotate between two angles (chevron toggles) | `{@attach springRotate(() => expanded, { rest: 0, on: 180 })}` |
| `springWidth(active, opts)` | Interpolate width between two values | `{@attach springWidth(() => wide, { rest: 32, on: 200 })}` |
| `motionPopover(opts)` | In/out lifecycle for modals/popovers | `{@attach motionPopover({ closing: () => !open, onClosed })}` |
| `motionBackdrop(closing, onClosed)` | Backdrop fade paired with popover | `{@attach motionBackdrop(() => !open, onClosed)}` |
| `magneticHighlight(target)` | One highlight that springs between items like a pointer | `{@attach magneticHighlight(() => activeEl)}` |
| `originBurst(opts)` | Launch items out of a measured point and put them back, like a folder opening | `{@attach originBurst({ origin, index: i, count, closing })}` |
| `stateEcho(key)` | Instant arrival, decaying trail, for cluster-driven state | `{@attach stateEcho(() => m.kind)}` |
| `overlayMotion(isOpen, opts?)` | Menus, popovers, dropdowns: spring in **and** out | `{@attach overlayMotion(() => open)}` |
| `motionPanel(isActive)` | Entrance for a tab panel that stays mounted | `{@attach motionPanel(() => tabs.value === id)}` |
| `centerOf(el)` | Page-space centre of an element, for an origin | `const origin = () => centerOf(avatarEl)` |
| `springProgress(name, opts?)` | A named spring sampled as progress over time, for Svelte transitions | `springProgress('glide').at(ms)` |
| `presence` (`$lib/utils/transitions`) | In-flow enter and exit that opens and closes its own space | `<div in:presence out:presence>` |
| `swap` (`$lib/utils/transitions`) | Incoming half of a content swap; use the `Swap` component | `<Swap key={tab}>…</Swap>` |
| `pressSpringDelegate(root, sel)` | Delegated hover/press for many children | Called imperatively in `onMount` |
| `motionEnabled()` / `decorativeMotion()` | Tier predicates for imperative code | `if (!motionEnabled()) return;` |

**Rules:**
- Motion communicates state, orientation, and continuity. It does not decorate. No tilt, no rubber-banding, no reacting to how hard the pointer was moving.
- A long CSS `cubic-bezier` is not a slow animation. `cubic-bezier(0.22, 1, 0.36, 1)` over 320ms is 91% complete in 136ms and then crawls: nominally slow, visually instant. Springs spend their time where the eye can see it.
- Never reach for a bezier to avoid a spring's overshoot at a hard floor. Every curve tried front-loaded the same way: `cubic-bezier(0.32, 0.72, 0, 1)` had the header two thirds collapsed inside 70ms. Use `springToFloor`, which keeps the physics and clamps per frame.
- Anything that animates in from `opacity: 0` needs `.motion-entering` applied synchronously and dropped on `finished`. Between mount/reveal and the animation's first sample the element paints at full opacity for a frame, which reads as a flash.
- Nothing may appear or disappear without an opposing force. If a surface has an entrance it must have an exit; `display: none` is not a dismissal.
- Never animate a status *into* view. Reality-driven state is instant; animate its trail.
- Anything animating to a hard floor (`height: 0`) must not use a plain bouncy spring. The undershoot goes negative, the browser discards every invalid write, and the box freezes at its last valid value before snapping shut. Use `springToFloor`, which drives the spring itself and clamps per frame, so the physics survive.
- Motion keeps ownership of every property it has animated on an element and re-applies its last value when the next animation starts on that element. If a property needs to be reset outside an animation, never animate it at all; set it directly. Animating `padding` on close is what left it at 0.9px through the following open.

  This bites hardest when only *one* direction uses Motion. `springCollapse`'s expand animated `height` as an element property while its collapse wrote height directly; starting the collapse's opacity animation made Motion re-apply the remembered expanded height, and the header sprang back open a beat after closing. Both directions now drive height as a plain value through `onUpdate`, so Motion never owns it. **If a property is ever written outside an animation, no animation on that element may own it either.**
- `pnpm build` does **not** catch undefined identifiers in `.svelte.ts` modules; it compiles and ships a `ReferenceError` that blanks the page. After editing `motion.svelte.ts`, load a real page and confirm it renders.
- Never compose two springs writing the same transform axis.
- A surface that switches between two layouts (the project hero going from spotlight to banner) morphs with a view transition, never a height animation plus cross-faded copies. Start it in `onNavigate`, put a class on `<html>` for the duration and hang every `view-transition-name` off that class so the names never exist at rest. Shrink-wrap named text (`width: fit-content`) or the group scales it by the box width, keep the taller snapshot underneath at full opacity with the shorter one fading on top, and give the group the shadow the snapshots cannot keep. Chrome ignores `mask` on `::view-transition-group`, so a masked edge (the glass rim) goes on `::view-transition-image-pair` of a named stand-in element. The default `plus-lighter` blend adds the two snapshots together; set `mix-blend-mode: normal` whenever one of them stays opaque.
- Art and canvases inside something the sidebar resizes are sized off the viewport, not their container, so a sidebar toggle only moves the crop. A `ResizeObserver` that reallocates a WebGL buffer is debounced.
- Stagger stride is 25ms and total delay is capped at 200ms, so long lists do not trail off.

### When to use what

- **Interactive element (button, card, link):** `springHover`: 2px lift on hover, constant press scale
- **List of items appearing:** `motionStagger` with `index`; never pass `stride`, the 25ms default is the demo's
- **`originBurst` on a group:** never pass `stride` either. It derives one from `BURST_WINDOW` so a 2-tile and an 11-tile group take the same time; a fixed per-item stride turns a long list into a slow top-to-bottom wave
- **Expand/collapse content:** `springCollapse`
- **Row the user adds or deletes:** `in:presence out:presence` on the keyed `{#each}` item, or `ListRow presence`
- **Content that changes with a choice (tab, segment, source):** `Swap` with the choice as `key`
- **Toggle indicator (chevron, arrow):** `springRotate`
- **Modal/popover lifecycle:** `motionPopover` + `motionBackdrop` with render-flag pattern
- **Selection moving between items (tabs, menus, segments):** `magneticHighlight`
- **A group revealing out of the thing you clicked:** `originBurst` with that thing's centre as `origin`
- **Numeric value change:** `animate(0, target, { ...transition('smooth'), onUpdate })`
- **Ambient loops (pulse, breathing):** CSS `@keyframes` only; Motion is for state transitions

### Animated icons (`@jis3r/icons`)

These icons have built-in hover animations. To trigger animation from a parent element instead of the icon itself:

1. Track hover state on the parent: `onmouseenter={() => (hovered = true)}`
2. Pass to icon through the tier gate: `<Unplug size={14} animate={iconAnimation(hovered)} />`
3. Wrap icon in `pointer-events: none` span to prevent its internal handlers from fighting

The animations are plain CSS inside the package and their end state is a static transform, so
the tier rules in `tokens.css` only shorten the transition, and the icon still snaps into its
animated pose. Icon flourishes are decoration, so they must never enter that state below `full`:
every `animate` prop goes through `iconAnimation()`, and `tokens.css` takes the wrappers out of
hit testing below `full` so the icon's own `mouseenter` cannot fire either. Any code that
synthesises `mouseenter` on an icon to forward parent hover must check `decorativeMotion()`.

For snippet-based components, pass hover as a snippet parameter, already run through
`iconAnimation()`, so the snippet passes it straight to the icon:
```svelte
<!-- Component declares: icon?: Snippet<[boolean]> -->
{#snippet icon(hovered)}<KeyRound size={18} animate={hovered} />{/snippet}
```

### Settings pages

Org settings (`/[org]/settings`) and account settings (`/user/settings`) share the `SettingsShell` pattern
(breadcrumbs, a `ResourceHeader` with an `AvatarEdit`, `SettingsRail`, the scrolling section stack). Every
section is a kit `SectionCard` of `SettingsList` rows or a flush `List`; creates, reveals and edits open a
`Modal`; destructive actions confirm with `ConfirmModal`. The tab bodies live in `org-settings/` and
`user-settings/`; there are no settings-only primitives anymore.

## Sound

Interaction sounds come from `cuelume`, imported in exactly one place: `$lib/utils/sound.ts`.
Everything else calls `cue(name)`, which checks the user's Sound setting (Accessibility,
off by default) and a per-cue 2s gate so a burst of SSE events cannot stack.

A cue is reserved for something that **finished happening to a thing you were waiting on**:
a build succeeding or failing on the app on screen, or one this browser started. Never
hover, press, toggle, palette open, navigation, pod transitions, or rows arriving. Those
would train people to mute the whole thing. Sound is never the only channel for a change.

A background tab is where cues matter most, so `cue()` does not check page visibility.
Browser autoplay policy means the first sound needs a gesture, which is why switching the
setting on plays a preview.

## Svelte 5 patterns

- Use `$state` for component-local reactive state
- Use `$derived` for computed values
- Use `$effect` for side effects (but never read+write the same `$state` in one effect; use a plain `let` sentinel)
- Use `$props()` for component inputs, `$bindable()` for two-way bindings
- Use `{@attach fn()}` to attach Motion utilities to elements
- Use `{#snippet name(params)}...{/snippet}` for typed render slots

## Resource Quota System

Three-level hierarchy: **Org cap** → **Member allowance** → **Deployment request**.

**Backend** (`apps/server/src/quotas/`):
- `GET /organizations/:orgId/quota`: org usage vs caps (admin only)
- `GET /organizations/:orgId/quota/me`: current user's allowance, usage breakdown, org cap, and `effectiveLimit`
- `effectiveLimit` = `min(userAllowanceRemaining, orgCapRemaining)`, the max the user can assign to a single new deployment right now
- Member allowance cascade: explicit → org default → unlimited
- Enforcement at deploy create, scale, and resource update

**Frontend**:
- `ResourcePicker` is two `AmountSlider`s, memory then CPU: a doubling scale that ends at `effectiveLimit`, with the org default and current usage on the track
- With no cap there is no ceiling on the scale; an amount over the limit shows a red note
- Usage page (`/[orgSlug]/usage?tab=me`) shows the same numbers as `Metric` tiles with a `Progress` meter against the cap

**UX rule**: never show redundant description text. Section titles should be self-explanatory.

## Deployment Page Architecture

- Tabs (`PageTabs`, `?tab=`): Overview, Variables, Activity (`deploys`), Observe, Files, Network, Security, Settings
  (Files is `FilesTab`: a pod picker, folder breadcrumb and download links for the running pod's file system, reading
  `GET /apiv1/pods/:podName/files` and streaming `.../files/download`; the mock serves a fixed tree)
  (`SettingsRail`, `?s=`). Old ids (`metrics`, `environment`, `resources`, `volumes`, `build`,
  `advanced`) still resolve.
- Overview fills exactly one viewport at 64rem wide and 40rem tall or more (`dep-shell--fit`): the
  console takes the main column at full height; the side column (1.618 : 1) stacks `PodsList` (one
  `IslandPill` per pod; opening one morphs an `IslandSheet` over the whole card; replicas in the kit
  `Dropdown`), `UsageCard` (CPU and memory against their limits,
  sparklines seeded from `/metrics` then extended by SSE) and `ErrorsCard` (the 5xx error rate and
  its trend from `/observe/.../http-metrics`, when the app serves HTTP). Add `?guides=1` to
  draw the golden-ratio `GoldenReticle` over the page when checking alignment. Below that size it scrolls. Nodes and
  other infrastructure stay hidden.
- Problems show as one `AlertStack` line above the panels; it expands to the full list. They come from
  `computeHealth` in `packages/health` (imported as `$health`; the server uses a generated copy in `apps/server/src/health`) (app vs deploy vs build, current state only, unit tested in
  `packages/health/test/health.test.ts`), fed by pod facts and `rollout` (the server's `summarizeRollout` in
  `kubernetes/rollout-strategy.ts`, read from the informer mirror).
- Live values land instantly; motion is the decorative layer on top (`NumberRoll`, the sparkline growing),
  never a tween that delays the number.
- Variables is the kit `EnvVarEditor` (the same one shared variables and the new-app flow use) with
  `secrets`, `stored` and `issues`; resource references come in through its `accessory`, `tokenized` and
  `addon` slots, so "Use a resource" and the linked-value pill never fork the editor.
- `NextSteps` is a "Set up" button with a progress ring in the header, opening a popover.
- `DeploymentAlerts` maps those problems, plus GitHub auth, apply errors, resource pressure and metric
  alerts, onto `AlertStack`.
- Pods arrive from the informer, never from polling. `pod.changed` carries `payload.pods`, a batch of full
  pod records (or `{ name, deleted: true }`), and the page upserts them. `deployment.changed` (also fired
  by ReplicaSet changes) refetches the detail, which carries `rollout`. `/pods-live` lists pods, events
  and metrics from the Kubernetes API itself, so it runs once on load and after a scale, never per event.
  The detail query polls every 60s only as a backstop while SSE is up.
- Activity: the live release (`ReleaseCard`) above `HistoryTab` (`ActivityRow`s, capsule filter); webhooks for
  image apps in `WebhooksTab`.
- Observe (`ObserveTab` + `deployment/observe/`): Metrics, Logs, Requests, Errors, Events. Metrics is a dashboard of
  `MetricPanel`s in collapsible sections (traffic and errors, resources, pods, logs, deploys) with one shared
  time range, a synced crosshair, brush zoom, deploy and kill markers, incident bands and findings
  (`observe/findings.ts`). `?demo` feeds it synthetic data.
- Network (`NetworkTab` + `deployment/network/`): two `Widget`s. Domains (`DomainsCard`): one row per
  domain or redirect with its status, the port it serves only when the app has more than one web port, an
  "Add protection" button (or a green chip naming the protection) and open/more. Ports (`PortsCard`): one
  row per port with protocol, private address (public address once public) and a Public switch, plus a
  Tailscale row; turning Public on confirms with "Anyone on the internet can reach this port". Adding a domain is one address field with a "Point to this app / Redirect" switch, then
  "Set up DNS" with the exact records from `POST /projects/ingresses/validate-dns` (CNAME for
  subdomains, A records for roots) and a check that polls until connected. Protection is a "Protection
  type" radio list (None, Password, Username and password, Project members). No explaining copy in these
  sheets. Never say ingress, service, cluster or NodePort.
- Security (`SecurityTab`): scan card and Configuration card at 1.618 : 1, then the vulnerability table only
  when there are findings. Reads `GET /deployments/:id/security`, rescans with `POST .../security/scan`, polls
  every 3s only while scanning. The scanner is an instance choice (`scan.provider`: `off`, `harbor`,
  or `trivy`, the Orchard scanner), set in Admin, Instance (`admin/ImageScanning.svelte`). Until a superadmin
  picks one it follows `defaultValue`: `trivy` when the Orchard scanner is set up, else `harbor` when the
  registry answers Harbor's `/api/v2.0/systeminfo`, else `off`; `off` is a calm neutral state, not a warning. Harbor covers only images in Orchard's registry, Trivy covers external ones
  too. The mock defaults to `trivy`. Mock states:
  `POST /apiv1/__mock/deployments/:id/security {scenario}`.
- Settings (`AppSettings` + `SettingsRail`): every section is a `SectionCard` of `SettingsList` rows, built from
  `BuilderOptions`, `UpdatesCard`, `AutoDeployCard`, `HealthChecks` and `ImageSource`.
- Logs: see Logs in `DESIGN.md`. Builds open on `StepRail` + `BuildLog`/`BuildTerminal` (phase sections, Docker-style
  step lines, Raw logs switch); a failure opens its step with the cause and fix from `diagnoseBuild`. The deployment page feeds `error_spike` and `rollback`
  anomalies (`anomalyFeed`) into the same `AlertStack` as everything else, dismissible; the `Anomalies` card is for project pages. `?view=killed` opens the newest kill's output. The
  console keeps the pod you picked; when it disappears, `podGone`/`replacementPod` show a capsule instead of swapping.
- `computeHealth` takes `now`; the page ticks it every 5s so a grace window can expire without new data.
- The console's logs follow by default: the deployment log stream (`/observe/.../logs/stream`) wakes a
  refetch whenever the selected pod writes a line. There is no Live toggle, only Pause. If the stream stays
  down for 4s a "Logs aren't updating" capsule offers Retry; nothing falls back to polling silently. A
  hidden tab closes the stream and catches up when it returns.

## Database Page Architecture

- Same shape as the app page: `DatabaseHeader` on the kit `ResourceHeader` (status, a facts line, Restart, the
  primary **Connect** button and `···` with Stop, Rename, Delete), one `AlertStack` line (`DatabaseAlerts`), then
  `PageTabs` synced to `?tab=` (Overview, Backups, Observe, Settings) with `&s=` for the Settings rail. Old ids
  redirect: `connection`/`terminal` to Overview, `metrics`/`queries` to Observe, `resources`/`extensions` to Settings.
- Connect is a sheet (Supabase style), not a card: Private or Public first (public opens by default once it is on,
  and offers Turn on right there while it is off), format (URI, psql, .env, JDBC), which instances (primary,
  standbys, any; private only), and the kit `SecretString`, which only fetches the real password from `/connection` on reveal or
  copy (the server audits that call).
- Overview: the Postgres console (`TerminalTab`: kit `LogViewer`, killed output, psql/shell tabs) as the main column;
  `DatabaseHealth` (one kit `CheckList`: each instance with the primary from `liveStatus.currentPrimary`, disk and
  connections against `max_connections` as thin meters, WAL backlog, backups, version) and `DatabaseActivity`
  (transactions, cache hit, connections, CPU, memory sparklines, stretched to the console's height) on the side,
  fitting one viewport.
- Observe (`DatabaseObserve`): Metrics and Queries. `/databases/:id/metrics` returns the container series plus the
  CloudNativePG exporter series (`connections`, `tps`, `cacheHit`, `lag`, `size`, `deadlocks`, `disk`,
  `diskCapacity`), scraped by the `cnpg-instances` job in the chart. A series with no points drops its panel.
  Queries has Supabase-style lenses (most time, most frequent, slowest).
- Backups: the recovery home. Protection sentence (with the last restore test under it), one primary Restore and
  a "Save a point" menu (checkpoint or backup), one Schedule row (preset, plus the cron field when custom),
  operations with progress, Cancel and Undo, one "Restore points" list merging backups and checkpoints newest
  first, and restore tests.
  Every restore goes through `RestoreSheet` (a point: latest, backup, checkpoint or time; then replace or
  copy into a new database). Replacing keeps the previous copy 24 hours.
- Settings rail (`SettingsRail`, `&s=`): General, Resources (`ResourceLimits`, `StorageCard`, `ReplicasCard`), Protection,
  Public access; under Postgres: Version and security, High availability, Connection pooler, Users, Parameters
  (`SettingsTab` + `ParamRow`), Extensions (a `Switch` per row); Danger zone.

## Usage Page Architecture

- `/[org]/usage` uses the same shell as a resource page: `Breadcrumbs`, a `ResourceHeader` with facts, `PageTabs`
  synced to `?tab=` (Organization `overview`, Yours `me`, Members, Right-sizing `provisioning`, plus graft tabs),
  and a capsule `SegmentedControl` for `?range=` on the tabs that read `/metrics/provisioning`.
- Numbers are `Metric` tiles in `Widget`s with a `Progress` meter against the cap; rankings are `TopList`s; the
  right-sizing summary is a `CheckList`; members and workloads are kit `Table`s inside `SectionCard`s. Allowance
  edits open a `Modal` with a Default / Custom / Unlimited `SegmentedControl` per resource.

## Running without a backend

`pnpm dev:mock` (from here or the repo root) starts Vite with `ORCHARD_MOCK=1`, which mounts the
`mockApi()` plugin from `mock/plugin.ts`. It answers every `/apiv1/*` request from an in-memory
store, so the real app runs with no Nest server, Postgres, Redis, Kubernetes or gateway. You are
signed in as `alfd`, with two orgs (`ysws`, `hq`), the projects from `src/routes/dev/ui/fixtures.ts`,
and deployments, databases and jobs in mixed states (running, building, crashing, stopped,
provisioning).

- **Live:** the org SSE stream (`/apiv1/events/orgs/:id`) emits the same `{ type, id, projectId, payload, ts }`
  events as the server, so redeploys, restarts, scaling, env edits, job runs and backups update the UI on
  their own. A redeploy walks queued, cloning, building, pushing, deploying, running over about 20s.
  The Observe log stream, build log stream and pod shell (`ws`, a toy shell) work too.
- **Pod states:** every pod can be put into a Kubernetes scenario (crash loop, out of memory, liveness kill,
  image pull failure, missing secret, unschedulable, failing readiness, terminating, evicted, sidecar crash,
  init crash, node lost) from the flask
  button on an app's Pods card, or `POST /apiv1/__mock/deployments/:id/pods` with `{ scenario, index? }`.
  `mock/scenarios.ts` produces the same status and pod facts (`podFacts`) the server does, timed from the
  moment you set the scenario, so grace windows play out as they will in production. `POST /apiv1/__mock/deployments/:id/rollout`
  with `{ outcome, twice? }` simulates a rolling deploy whose new version has that outcome (`twice` deploys
  again a second later), and `{ cancel: true }` ends it. `POST /apiv1/__mock/deployments/:id/build` with
  `{ failure }` (`command`, `lockfile`, `dockerfile`, `typescript`, `branch`) runs a build that fails that way, or
  succeeds without one. `__ORCHARD_MOCK__` is true only in mock mode.
- **Sign out** makes every non-auth route 401 until you click "Continue as alfd (mock)" on the login
  page (any email and 6-digit code also work).
- **Data** is seeded in `mock/seed.ts` (entity types in `mock/types.ts`). State lives in `mock/store.ts`,
  which also owns the mutations and the build simulation. It resets whenever Vite restarts, and Vite
  restarts whenever a file in `mock/` changes.
- **Routes** live in `mock/routes/*.ts`, grouped by page. Add one with
  `r.get('/things/:id', ({ params, query, body }) => ...)`: return a value for 200 JSON,
  `reply(status, body)` or `notFound()` for anything else. Serialize through `mock/serialize.ts` so shapes
  stay in step with the server (check `packages/contracts/src/schemas` and the Nest controller).
  The most specific pattern wins, so registration order does not matter.
- **Gaps:** an unhandled GET answers `[]` and an unhandled mutation answers `{ ok: true }`, and both are
  logged once as `[mock] unhandled METHOD /apiv1/...` in the Vite console. That line is the to-do list.
- `ORCHARD_MOCK_LATENCY=300` adds latency to every response. Mock mode uses its own Vite cache
  (`node_modules/.vite-mock`) so switching between `dev` and `dev:mock` does not re-optimize deps.

`mock/` is outside `src/`, so none of it ships.

## File organization

- Routes: `src/routes/`
- Shared components: `src/lib/components/`
- Feature components: `src/lib/components/<feature>/` with `index.ts` barrel export
- Utilities: `src/lib/utils/`
- Stores: `src/lib/stores/`
