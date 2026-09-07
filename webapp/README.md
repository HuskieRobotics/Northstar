# Northstar Web App

Read-only status dashboard for the Northstar vision system, running on the robot's Mac mini.
Huskie Robotics, FRC Team 3061.

Design, and the measurements behind every decision in it:
[`../claude/webAppDesign.md`](../claude/webAppDesign.md).

---

## What it does

Answers, at a glance, whether the vision system is healthy — and when it isn't, which stage failed.

| Page | Purpose |
| --- | --- |
| **Dashboard** `/` | One card per instance: a six-signal status chain, live vitals, and a camera snapshot |
| **Logs** `/logs` | stdout and stderr per instance, live-following, with an error count badge |
| **Cameras** `/cameras` | Calibration per instance, USB link quality, frame-loss correlation |
| **Recordings** `/videos` | Match recordings with parsed device / event / match metadata |
| **System** `/system` | Mac mini load, memory, disk, power and thermal |

The status chain is the core idea: rather than a single red dot, each card reads
*process up → camera up → **no calibration*** so the first failing stage names the fix.

**Every endpoint is read-only.** There is no `POST`, `PUT` or `DELETE` anywhere — an intentional
safety property, not an oversight. Control features (restarting instances, triggering calibration)
are deferred; see §12 of the design doc.

---

## Requirements

**Node ≥ 24.** `WebSocket` became a Node global in v22 and `CloseEvent` in v23; the vendored NT4
client needs both. Install system-wide via Homebrew or the official pkg — **not nvm**, whose node
lives under a versioned path and which is a shell function that does not exist under launchd.

**WhatCable CLI** *(optional, recommended)* — powers the USB link diagnostics that catch a camera
silently falling back to USB 2:

```bash
brew install darrylmorley/whatcable/whatcable-cli     # CLI only — right for the Mac mini
brew install --cask darrylmorley/whatcable/whatcable  # CLI + menu bar app
```

Requires macOS 14+ on Apple Silicon. Without it the dashboard works normally and the cabling section
simply reports that it is not installed.

---

## Quick start

```bash
npm ci
npm run build
npm start                # port 5800 — what the Mac mini runs
```

Development, against a WPILib simulation plus a Northstar instance on the same laptop:

```bash
npm run dev:sim          # port 5801, NT pointed at 127.0.0.1
```

Then open **`http://localhost:5801`** — see [Troubleshooting](#troubleshooting) for why `localhost`
and not `127.0.0.1`. Port 5801 because **the robot code binds 5800 locally** when running in
simulation.

> Use `dev:sim` rather than setting the variable yourself. Running `NORTHSTAR_NT_SERVER=127.0.0.1`
> as its own command sets a shell variable but does **not** export it, so a following `npm run dev`
> still points at the roboRIO.

### Settings

All optional; the defaults suit the Mac mini.

| Variable | Default | Notes |
| --- | --- | --- |
| `NORTHSTAR_NT_SERVER` | `10.30.61.2` | `127.0.0.1` for a local simulation |
| `PORT` | `5800` | In the FRC team-use range (5800–5810) |
| `NORTHSTAR_DISCOVERY` | `auto` | `launchd`, `process`, or `auto` |
| `NORTHSTAR_REPO_ROOT` | `..` | Resolves relative `calibration_folder` / `video_folder` |
| `NORTHSTAR_STARTUP_GRACE` | `90` | Seconds after boot before unestablished signals read as failures |
| `NORTHSTAR_SNAPSHOT_INTERVAL` | `2500` | Thumbnail refresh, ms |
| `NORTHSTAR_LOOP_HZ` | `50` | Robot loop rate, for converting `CyclesWithNoResults` to seconds |
| `NORTHSTAR_EXPECTED_PROFILE` | *(off)* | **Development only** — see warning below |
| `NORTHSTAR_WHATCABLE_BIN` | `whatcable` | Path to the WhatCable CLI |
| `NORTHSTAR_WHATCABLE_CACHE_MS` | `30000` | Cache for USB link data; `0` disables the integration |
| `NORTHSTAR_WHATCABLE_PROBE` | *(off)* | `1` enables deep USB probing (off by default — see below) |
| `NORTHSTAR_WHATCABLE_HISTORY_MS` | `30000` | Link-state sampling interval; `0` disables history |
| `NORTHSTAR_FRAMELOSS_WATCH_MS` | `400` | Log poll interval for event-triggered checks; `0` disables |
| `NORTHSTAR_FRAMELOSS_TRIGGER_GAP_MS` | `3000` | Minimum gap between triggered checks per instance |
| `NORTHSTAR_CORRELATION_WINDOW_MS` | `120000` | How far before an episode a link change counts as preceding it |

> **Never set `NORTHSTAR_EXPECTED_PROFILE` on a robot.** It scans
> `cameras/robots/<profile>/config*.json` for the expected instance set, but that folder is a
> superset holding configs for cameras that do not exist on every robot, and deployment copies only
> the plists actually needed. It would report permanently-missing instances. launchd is the authority
> there.

---

## Deployment

```bash
# One-time, on the Mac mini
brew install darrylmorley/whatcable/whatcable-cli    # optional
npm ci && npm run build

cp deploy/org.team3061.northstar.webapp.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/org.team3061.northstar.webapp.plist
```

`next start` requires a valid `.next/`. If it is missing or was corrupted by a power cut mid-build,
the app silently fails to start and nobody notices until they need it. **Build off-robot, then
power-cycle the Mac mini once** to confirm it comes back unattended. Put that on the pre-event
checklist — it is the only test that proves the deployment.

Sanity-check the environment launchd will actually give it:

```bash
bash deploy/check-env.sh                                    # from Terminal
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    USER="$USER" bash deploy/check-env.sh                   # as launchd sees it
```

Both must pass. Passing the first and failing the second is the signature of the two problems below.

### launchd does not have your PATH

The first thing that bites, and the error messages point in the wrong direction.

launchd never runs your login shell, so `~/.zshrc` and `~/.zprofile` are not sourced and `PATH` is
only `/usr/bin:/bin:/usr/sbin:/sbin`. Node installs to `/usr/local/bin` (official installer) or
`/opt/homebrew/bin` (Homebrew) — neither is on that list. You get, in order:

```
npx: command not found                  <- npx is not on PATH
env: node: No such file or directory    <- npx's #!/usr/bin/env node shebang
```

The second appears **even after hardcoding the full path to npx**, because the shebang still resolves
`node` through `PATH`. That is why fixing the first does not fix the second.

`deploy/webapp.sh` handles it: it searches the usual install locations (nvm as a last resort),
exports `PATH` so the workers Next spawns can find node too, and invokes Next's JS entry point
directly with the resolved interpreter so no shebang is involved. It also derives its own paths from
its location, so it needs no editing between the Mac mini and a developer checkout. If node still is
not found it logs a message naming the problem rather than failing cryptically.

The same `PATH` export covers `whatcable`. If the cabling section reports the CLI missing under
launchd but works from a terminal, set `NORTHSTAR_WHATCABLE_BIN` to the absolute path.

### `EPERM: operation not permitted` reading node_modules

**The deployment lives at `~/Northstar` specifically to avoid this.** If you see it, the repo has
ended up inside `~/Documents`, which macOS protects with TCC.

TCC grants access **per executable**. Terminal has the grant — which is why the identical command
works interactively — but a launchd agent has none and cannot prompt for one, so `node` is refused.
The Python vision instances keep working only because `python3` was granted at some point.

Fix by moving the repo out of `~/Documents` (see
[`../claude/MOVE-TO-HOME.md`](../claude/MOVE-TO-HOME.md)). Granting Full Disk Access to the node
binary also works but is tied to that binary and a node upgrade can reset it. Moving *only* the web
app does not help — it reads the repo's configs, logs, calibrations and recordings, so it needs
access to that tree wherever it lives.

---

## Troubleshooting

**Blank page, "Connecting to the status stream…" or "Loading…" forever.**

First establish which side is broken:

```bash
curl -s localhost:5801/api/status | head -c 120
```

JSON back means the server is healthy and the problem is browser-side.

> **View Source is not a useful check.** It shows the pre-hydration HTML and will *always* read
> "Connecting to the status stream…" even when the page is working perfectly. Use DevTools → Elements
> for the live DOM.

If the server is healthy, the usual cause in development is the HMR WebSocket:

> **Open `http://localhost:5801`, not `http://127.0.0.1:5801`.** `next dev` needs a WebSocket for
> hot-reload, and Turbopack's browser runtime — which evaluates the app's own chunks — carries the
> HMR client. If that socket fails, nothing hydrates and every page freezes at its server-rendered
> state with no visible error. On at least one machine here something intercepts WebSocket upgrades
> on the numeric loopback address; Safari reported
> `ws://127.0.0.1:5801/_next/hmr failed: cannot parse response`, and the same page over `localhost`
> worked immediately. This concerns only the **browser URL** — `NORTHSTAR_NT_SERVER=127.0.0.1` is the
> server-side NetworkTables address and is unaffected.

A production build has no HMR socket at all and is what the Mac mini runs, so it sidesteps this
entirely:

```bash
npm run build && npm run start:sim     # port 5802, NT at 127.0.0.1
```

**Everything red right after power-on.** Expected — the Mac mini boots before the roboRIO. The header
shows uptime, and unestablished signals read as *starting* for the first
`NORTHSTAR_STARTUP_GRACE` seconds.

---

## Maintenance

### After merging upstream Northstar changes

```bash
npm run check-coupling
```

This app parses Northstar's printed log strings, NetworkTables key names, and array layouts — none of
which are an API. Upstream 6328 changes are hand-merged, and a reviewer looking at a vision diff has
no reason to connect a reworded `print` to a TypeScript dashboard. The checker greps the Python
sources for every literal the app depends on and exits non-zero when one disappears.

Everything it checks is declared in one place: [`lib/contract.ts`](lib/contract.ts). If a check fails,
update that file — not the call sites.

---

## USB link diagnostics (WhatCable)

Northstar sometimes stops receiving frames, kills the instance, re-enumerates the port and retries.
One candidate cause is the camera quietly negotiating **down from USB 3 to USB 2** — the pipeline
still reports frames and FPS, so it looks healthy by every other measure while the link has halved.

The cameras page reads `whatcable --json` and joins its devices to Northstar instances by **serial
number**, which equals Northstar's `camera_id` (verified against a Basler `daA1280-54um` reporting
`24608715` on both sides). For each camera it shows the negotiated link speed, the port's `active` vs
`supported` transports, and a verdict. A camera at USB 2 on a port that supports USB 3 is flagged in
red on the cameras page **and** as a note on its dashboard card.

Verify the CLI with `whatcable --json | head -c 200`.

> Deep USB probing is **off by default**. Measured on a Basler `daA1280-54um`: with and without
> `--no-usb-probe`, device speed, `usbVersion` and port transports come back identical. Probing buys
> nothing this app reads, and these checks fire while a camera is already in trouble — so the
> cautious default is free. `NORTHSTAR_WHATCABLE_PROBE=1` re-enables it.

### Event-triggered checks

Frame loss can recover in **just over a second**, so a periodic sampler would essentially never
observe the degraded state — by the time a 30-second tick ran, the link would be back and the
evidence gone.

So instance logs are polled sub-second, and the moment `No frame received` appears the USB bus is
checked **immediately**, forcing a fresh read past the cache (the cached reading predates the event
and would be exactly the wrong answer). Frames resuming triggers a second check, capturing recovery
too.

Measured latency from log line written to USB checked: **~0.3s** (0.26 / 0.37 / 0.27 over three
runs). A per-instance trigger gap (default 3s) stops a flapping camera causing a storm of USB reads.

Triggered samples are recorded **unconditionally**, unlike periodic ones — "we looked during the
episode and the link was fine" is just as much evidence as finding it degraded.

### Frame loss vs link state

A live reading says the link is degraded *now*; it cannot say whether degradation **preceded** frames
stopping. So link state is appended to `logs/cabling-history.jsonl` — **only on change**, plus a
10-minute heartbeat, keeping the file small and every line meaningful.

The cameras page then lines each frame-loss episode up against what the link was doing, leading with
mid-episode checks because they are far stronger evidence than a before-and-after inference.

The wording is deliberately not a verdict. A handful of episodes proves nothing either way, and "none
of N episodes had a degraded link beforehand" is phrased as evidence against the theory, not proof.

The history file is disposable: bounded to 2 MB, a power-cut-truncated final line is skipped on read,
and losing it costs only past correlations — consistent with the no-persistent-state rule.

Correlation needs history collected **before** an episode, so it fills in over time rather than being
useful immediately. Leave it running through a practice session.

---

## Colour

Team palette: **#FF4800** orange, **#002F55** navy, **#FFFFFF**, **#ACA89F** taupe.

The orange is close enough to a danger red that using it decoratively *and* keeping a separate red for
failures would put two competing warm colours on the same card. So the orange carries the
**failure/attention** state: a healthy board is calm navy, white and green, and anything orange means
look here. Raw #FF4800 also appears as the header rule, wordmark, active-nav underline and focus ring.

Every value was contrast-checked against the surface it sits on, because this is read across a pit
under bad lighting:

| | on navy #002F55 | on white |
| --- | --- | --- |
| Body text | #FFFFFF — 13.7:1 | #002F55 — 13.7:1 |
| Muted | #ACA89F — 5.8:1 | #6E6A62 — 5.4:1 |
| OK | #4ADE80 — 7.8:1 | #0E7A4D — 5.4:1 |
| Warn | #FFC24B — 8.5:1 | #8A5A00 — 5.9:1 |
| Fail | #FF6A33 — 4.8:1 | #C43B00 — 5.3:1 |
| Starting | #7CC4F5 — 7.2:1 | #12599E — 7.1:1 |

Two things to know before editing the palette:

- **Raw #FF4800 is 4.02:1 on navy** — fine for borders and large elements, short of the 4.5:1 needed
  for small text. Failure *text* therefore uses #FF6A33, a lightened team orange.
- **#ACA89F is only 2.37:1 on white.** It works well as muted text on navy, but in light mode it is
  restricted to borders and dividers; muted text there uses a darkened #6E6A62.

Colour is never load-bearing alone — every status carries a glyph (● ▲ ✕ ◐ ○ ? –) and a text label, so
the chain stays readable for colourblind users and on washed-out screens.

---

## Implementation constraints worth knowing

None of these are arbitrary; each was measured. Full detail in the design doc.

- **Thumbnails connect, read one frame, and disconnect.** Northstar only encodes a frame while a
  client is attached, so a held-open stream costs a frame copy, overlay and JPEG encode *per frame* on
  a machine already running several pipelines at `nice -20`.
- **The NT subscription is narrow** — explicit topic lists, never a prefix on `""`, which pulls ~280
  messages/second of mostly `Pose3d` arrays the app never reads. In practice ~44 topics of ~550.
- **`getServerTime_us()` is invalidated on disconnect.** It returns a *stale* offset right after a
  reconnect — measured reporting 1304.9s of robot uptime for a roboRIO that had just restarted, which
  is exactly when a robot reboots. Staleness decisions use the local clock instead.
- **Frame-rate booleans are latched, not sampled.** `ReceivingFrames` toggles ~5×/second, so an
  instantaneous read lands on `false` routinely while the camera is perfectly healthy.
- **Counters are absent, not zero, until a camera's first accept/reject.** A camera that never came up
  has neither — which is the failure that matters most — so their absence is never rendered as an
  error. `CyclesWithNoResults` covers that gap; it exists from the first cycle.
- **Northstar exits when it loses NT**, so "process dead while NT is down" is expected, and one
  restart per instance follows every robot reboot. Crash-loop detection is suppressed accordingly.
- **A camera seeing no AprilTags is healthy, not faulty.** On a stationary robot most cameras see
  nothing; that reads as *idle* and is excluded from the healthy count.

---

## Layout

```
lib/contract.ts          every coupling to Northstar / 3061-lib internals, in one file
lib/settings.ts          environment settings
lib/nt.ts                NT4 client singleton (narrow subs, server time, boolean latching)
lib/nt4/NT4.ts           vendored from AdvantageScope, BYTE-IDENTICAL — do not edit
lib/discovery.ts         launchd + process-scan instance discovery, merged
lib/status.ts            the status chain
lib/logs.ts              tail-from-end, truncation tolerant, boot marker
lib/mjpeg.ts             snapshot-and-disconnect, port probing
lib/system.ts            host health, calibrations, videos
lib/whatcable.ts         USB link state, degradation rule
lib/cablingHistory.ts    link-state sampler and history file
lib/frameLossWatcher.ts  sub-second log watch, event-triggered USB checks
lib/events.ts            frame-loss episodes and correlation
app/api/*                read-only JSON + SSE + media endpoints
components/*             dashboard, instance detail, log viewer, link history
deploy/*                 launchd plist, launcher, environment checker
scripts/check-coupling   post-merge guard on the Northstar coupling
```

`lib/nt4/NT4.ts` is copied verbatim from AdvantageScope (BSD, Littleton Robotics / FRC 6328). Its one
type incompatibility with TypeScript 5.7 is handled in `types/vendor-compat.d.ts` rather than by
editing the file, so upstream fixes re-pull with a plain copy.
