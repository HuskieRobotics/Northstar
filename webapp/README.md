# Northstar Web App

Read-only status dashboard for the Northstar vision system on the robot's Mac mini.
Huskie Robotics, FRC Team 3061.

Design and the measurements behind it: [`../claude/webAppDesign.md`](../claude/webAppDesign.md).

## What it does

- **Which cameras are running** — a seven-signal status chain per instance, so the page reads
  "process up, camera up, **no calibration**" rather than a generic red dot.
- **Live accept/reject rates** per camera, from the `UpdatePoseCount` / `RejectedPoseCount`
  counters in 3061-lib.
- **Log tailing** with live follow, highlighting, filtering, download, and a divider marking
  where the current boot began.
- **Camera thumbnails** with click-to-expand full-rate streams.
- Calibration status, camera inventory, Mac mini health, and recorded video listing.

**Every endpoint is read-only.** There is no `POST`, `PUT` or `DELETE` anywhere — an intentional
safety property, not an oversight. Control features (restarting instances, triggering calibration)
are deferred; see §12 of the design doc.

## Running it

```bash
npm ci
npm run build
npm start            # port 5800
```

Development, against a WPILib simulation and a Northstar instance on the same laptop:

```bash
npm run dev:sim      # port 5801, NT pointed at 127.0.0.1
```

Port 5801 in development because **the robot code binds 5800 locally** when running in simulation.

> Use `dev:sim` rather than setting the variable yourself. Running
> `NORTHSTAR_NT_SERVER=127.0.0.1` as its own command sets a shell variable but does **not** export it,
> so `npm run dev` afterwards still points at the roboRIO. Either put it on the same line as the
> command, or `export` it first — `dev:sim` just does this for you.

> **Open `http://localhost:5801`, not `http://127.0.0.1:5801`.** `next dev` needs a WebSocket for
> hot-reload, and Turbopack's browser runtime — which evaluates the app's own chunks — carries the
> HMR client. If that socket fails, nothing hydrates and every page freezes at its server-rendered
> state ("Connecting to the status stream…", "Loading…") with no visible error. On at least one
> machine here, something intercepts WebSocket upgrades on the numeric loopback address and Safari
> reported `ws://127.0.0.1:5801/_next/hmr failed: cannot parse response`; the same page over
> `localhost` worked immediately.
>
> Note this is only about the **browser URL**. `NORTHSTAR_NT_SERVER=127.0.0.1` is the server-side
> NetworkTables address and is unaffected.
>
> When in doubt, test against a production build instead — it has no HMR socket at all, and it is
> what the Mac mini actually runs:
>
> ```bash
> npm run build && npm run start:sim     # port 5802, NT at 127.0.0.1
> ```
>
> Diagnosing a blank page: `curl -s localhost:5801/api/status | head -c 120`. JSON back means the
> server is healthy and the problem is browser-side. Note that **View Source is not a useful check** —
> it shows the pre-hydration HTML and will always read "Connecting to the status stream…" even when
> the page is working. Use DevTools → Elements for the live DOM.

### Settings

All optional; defaults suit the Mac mini.

| Variable | Default | Notes |
| --- | --- | --- |
| `NORTHSTAR_NT_SERVER` | `10.30.61.2` | `127.0.0.1` for a local simulation |
| `PORT` | `5800` | In the FRC team-use range (5800–5810) |
| `NORTHSTAR_DISCOVERY` | `auto` | `launchd`, `process`, or `auto` |
| `NORTHSTAR_REPO_ROOT` | `..` | Resolves relative `calibration_folder` / `video_folder` |
| `NORTHSTAR_STARTUP_GRACE` | `90` | Seconds after boot before unestablished signals read as failures |
| `NORTHSTAR_SNAPSHOT_INTERVAL` | `2500` | Thumbnail refresh, ms |
| `NORTHSTAR_LOOP_HZ` | `50` | Robot loop rate, for converting `CyclesWithNoResults` to seconds |
| `NORTHSTAR_EXPECTED_PROFILE` | *(off)* | **Development only** — see below |
| `NORTHSTAR_WHATCABLE_BIN` | `whatcable` | Path to the WhatCable CLI |
| `NORTHSTAR_WHATCABLE_CACHE_MS` | `30000` | Cache for USB link data; `0` disables the integration |
| `NORTHSTAR_WHATCABLE_PROBE` | *(off)* | `1` enables deep USB probing (off by default — see below) |
| `NORTHSTAR_FRAMELOSS_WATCH_MS` | `400` | Log poll interval for event-triggered checks; `0` disables |
| `NORTHSTAR_FRAMELOSS_TRIGGER_GAP_MS` | `3000` | Minimum gap between triggered checks per instance |
| `NORTHSTAR_WHATCABLE_HISTORY_MS` | `30000` | Link-state sampling interval; `0` disables history |
| `NORTHSTAR_CORRELATION_WINDOW_MS` | `120000` | How far before an episode a link change counts as preceding it |

> `NORTHSTAR_EXPECTED_PROFILE` scans `cameras/robots/<profile>/config*.json` for the expected
> instance set. **Never enable it on a robot.** That folder is a superset holding configs for
> cameras that do not exist on every robot, and deployment copies only the plists actually needed,
> so it would report permanently-missing instances. launchd is the authority there.

## Deployment

```bash
cp deploy/org.team3061.northstar.webapp.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/org.team3061.northstar.webapp.plist
```

`next start` requires a valid `.next/` — if it is missing or was corrupted by a power cut mid-build,
the app silently fails to start and nobody notices until they need it. **Build off-robot, then
power-cycle the Mac mini once** to confirm it comes back unattended. Add that to the pre-event
checklist.

### launchd does not have your PATH

This is the first thing that bites, and the error messages point in the wrong direction.

launchd never runs your login shell, so `~/.zshrc` and `~/.zprofile` are not sourced and `PATH` is
only `/usr/bin:/bin:/usr/sbin:/sbin`. Node installs to `/usr/local/bin` (official installer) or
`/opt/homebrew/bin` (Homebrew) — neither is on that list. You get, in order:

```
npx: command not found                  <- npx is not on PATH
env: node: No such file or directory    <- npx's #!/usr/bin/env node shebang
```

The second error appears **even after hardcoding the full path to npx**, because the shebang still
resolves `node` through `PATH`. That is why fixing the first error does not fix the second.

`deploy/webapp.sh` handles all of this: it searches the usual install locations (plus nvm as a last
resort), exports `PATH` so the worker processes Next spawns can find node too, and invokes Next's JS
entry point directly with the resolved interpreter so no shebang has to be resolved at all. If node
still is not found it logs a specific message naming the problem rather than failing cryptically.

The script also derives its own paths from its location, so it needs no editing between the Mac mini
and a developer checkout. To reproduce launchd's environment in a terminal before trusting it:

```bash
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" USER="$USER" bash deploy/webapp.sh
```

### `EPERM: operation not permitted` reading node_modules

**The deployment lives at `~/Northstar` specifically to avoid this.** If you see it, the repo has
ended up inside **`~/Documents`**, which macOS protects with TCC.

TCC grants access **per executable**. Terminal has the grant — which is why the exact same command
works interactively — but a launchd agent has none and cannot prompt for one, so `node` is refused.
The Python vision instances keep working because `python3` was granted at some point; a newly
installed `node` has not been.

Confirm it by running the bundled check both ways and comparing:

```bash
bash deploy/check-env.sh                                    # from Terminal
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    USER="$USER" bash deploy/check-env.sh                   # as launchd sees it
```

Passing the first and failing the READ test in the second is TCC. The script also checks ownership,
ACLs and quarantine flags, so it rules out the ordinary permission causes at the same time.

Two fixes:

- **Move the repo out of `~/Documents`** — e.g. `~/Northstar`. Recommended for a robot: it removes
  the whole class of failure permanently, including for the vision instances, whose current grant an
  OS update could reset. Costs a one-time path update across every plist and `config*.sh`.
- **Grant Full Disk Access to the node binary** — System Settings → Privacy & Security → Full Disk
  Access → `+`, then Cmd+Shift+G and enter the path from `which node`. Faster, but the grant is tied
  to that specific binary and a node upgrade can reset it.

Note that moving only the web app does not help: it reads the repo's configs, logs, calibrations and
recordings, so it needs access to that tree wherever it lives.

> **nvm is a poor fit for a robot.** Its node lives under a versioned path that changes on upgrade,
> and nvm itself is a shell function that only exists in an interactive shell. Prefer a system-wide
> install — Homebrew or the official pkg — on any machine that must boot unattended.

## After merging upstream Northstar changes

```bash
npm run check-coupling
```

This app parses Northstar's printed log strings, NetworkTables key names, and array layouts — none
of which are an API. Upstream 6328 changes are hand-merged, and a reviewer looking at a vision diff
has no reason to connect a reworded `print` to a TypeScript dashboard. The checker greps the Python
sources for every literal the app depends on and exits non-zero when one disappears.

Everything it checks is declared in one place: [`lib/contract.ts`](lib/contract.ts).

## USB link diagnostics (WhatCable)

Northstar sometimes stops receiving frames, kills the instance, re-enumerates the port and retries.
One candidate cause is the camera quietly negotiating **down from USB 3 to USB 2** — the pipeline
still reports frames and FPS, so it looks healthy by every other measure while the link has halved.

The cameras page reads `whatcable --json` and joins its devices to Northstar instances by
**serial number**, which equals Northstar's `camera_id` (verified against a Basler `daA1280-54um`
reporting `24608715` on both sides). For each camera it shows the negotiated link speed, the port's
`active` vs `supported` transports, and a verdict. A camera running at USB 2 on a port that supports
USB 3 is flagged in red on the cameras page **and** as a note on its dashboard card.

Install the CLI:

```bash
brew install darrylmorley/whatcable/whatcable-cli    # CLI only
brew install --cask darrylmorley/whatcable/whatcable # CLI + menu bar app
```

Requires macOS 14+ on Apple Silicon. If it is not installed the section says so and nothing else
breaks.

> **Why it is cached rather than polled.** The CLI performs USB probing, and probing a bus that is
> actively streaming camera frames is not obviously free — this app must never be the reason a camera
> hiccups. It runs at most once per `NORTHSTAR_WHATCABLE_CACHE_MS` (default 30s) with a manual
> **Re-check now** button, never per request. Set the cache to `0` to disable it entirely, or
> `NORTHSTAR_WHATCABLE_NO_PROBE=1` to pass `--no-usb-probe`. A single run measured ~0.1s.

### Event-triggered checks

Frame loss can recover in **just over a second**, so a periodic sampler would essentially never
observe the degraded state — by the time a 30-second tick runs, the link is back and the evidence is
gone.

So the instance logs are polled sub-second, and the moment `No frame received` appears the USB bus is
checked **immediately**, forcing a fresh read past the cache (the cached reading predates the event
and would be exactly the wrong answer). Frames resuming triggers a second check, so a recovery is
captured too.

Measured latency from log line written to USB checked: **~0.3s** (0.26 / 0.37 / 0.27 over three
runs). A trigger gap (default 3s per instance) stops a flapping camera from causing a storm of USB
reads.

Triggered samples are recorded **unconditionally**, unlike periodic ones — "we looked during the
episode and the link was fine" is just as much evidence as finding it degraded.

> Deep USB probing is **off by default**. Measured on a Basler `daA1280-54um`: with and without
> `--no-usb-probe`, device speed, `usbVersion` and port transports come back identical. Probing buys
> nothing this app reads, and these checks fire while a camera is already in trouble — so the
> cautious default is free. `NORTHSTAR_WHATCABLE_PROBE=1` re-enables it.

### Frame loss vs link state

A live reading says the link is degraded *now*; it cannot say whether degradation **preceded**
Northstar losing frames. So link state is sampled in the background and appended to
`logs/cabling-history.jsonl` — **only when it changes**, plus a 10-minute heartbeat, so the file
stays small and every line means something.

The cameras page then lines each frame-loss episode (a run of `No frame received` in that instance's
log) up against what the link was doing beforehand, and reports how many episodes were preceded by a
degraded link.

The wording is deliberately not a verdict. A handful of episodes proves nothing either way — the
count is there to be looked at, and "none of N episodes had a degraded link beforehand" is written as
evidence against the theory, not proof.

The history file is disposable: it is bounded to 2 MB, a truncated final line from a power cut is
skipped on read, and losing it costs nothing but past correlations. That keeps it consistent with the
no-persistent-state rule — nothing here has to be valid at next boot.

The JSON shape is an external tool's output, not an API — the parser treats missing fields as
unknown rather than throwing, so a WhatCable update cannot take the dashboard down. Shapes were read
from v1.4.0.

## Colour

Team palette: **#FF4800** orange, **#002F55** navy, **#FFFFFF**, **#ACA89F** taupe.

The orange is close enough to a danger red that using it decoratively *and* keeping a separate red
for failures would put two competing warm colours on the same card. So the orange carries the
**failure/attention** state: a healthy board is calm navy, white and green, and anything orange means
look here. Raw #FF4800 also appears as the header rule, the wordmark, active-nav underline and focus
ring.

Every value was contrast-checked against the surface it sits on, because this gets read across a pit
under bad lighting:

| | on navy #002F55 | on white |
| --- | --- | --- |
| Body text | #FFFFFF — 13.7:1 | #002F55 — 13.7:1 |
| Muted | #ACA89F — 5.8:1 | #6E6A62 — 5.4:1 |
| OK | #4ADE80 — 7.8:1 | #0E7A4D — 5.4:1 |
| Warn | #FFC24B — 8.5:1 | #8A5A00 — 5.9:1 |
| Fail | #FF6A33 — 4.8:1 | #C43B00 — 5.3:1 |
| Starting | #7CC4F5 — 7.2:1 | #12599E — 7.1:1 |

Two consequences worth knowing before editing the palette:

- **Raw #FF4800 is 4.02:1 on navy** — fine for borders and large elements, short of the 4.5:1 needed
  for small text. Failure *text* therefore uses #FF6A33, a lightened team orange.
- **#ACA89F is only 2.37:1 on white.** It works beautifully as muted text on navy, but in light mode
  it is restricted to borders and dividers; muted text there uses a darkened #6E6A62.

Colour is never load-bearing on its own — every status also carries a glyph (● ▲ ✕ ◐ ? –) and a text
label, so the chain stays readable for colourblind users and on washed-out screens.

## Notable implementation constraints

These are not arbitrary; each was measured. Details in the design doc.

- **Thumbnails connect, read one frame, and disconnect.** Northstar only encodes a frame while a
  client is attached, so a held-open stream costs a frame copy, overlay and JPEG encode *per frame*
  on a machine already running several pipelines at `nice -20`.
- **The NT subscription is narrow** — explicit topic lists, never a prefix on `""`, which pulls
  ~280 messages/second of mostly `Pose3d` arrays the app never reads. In practice it subscribes to
  ~44 topics out of ~550.
- **`getServerTime_us()` is invalidated on disconnect.** It returns a *stale* offset right after a
  reconnect — measured reporting 1304.9s of robot uptime for a roboRIO that had just restarted,
  which is exactly when a robot reboots. Staleness decisions use the local clock instead.
- **Frame-rate booleans are latched, not sampled.** `ReceivingFrames` toggles ~5×/second, so an
  instantaneous read lands on `false` routinely while the camera is healthy.
- **Counters are absent, not zero, until a camera's first accept/reject.** A camera that never came
  up has neither — which is the failure that matters most — so their absence is never rendered as an
  error. `CyclesWithNoResults` covers that gap; it exists from the first cycle.
- **Northstar exits when it loses NT**, so "process dead while NT is down" is expected, and one
  restart per instance follows every robot reboot. Crash-loop detection is suppressed accordingly.

## Layout

```
lib/contract.ts   every coupling to Northstar / 3061-lib internals, in one file
lib/nt.ts         NT4 client singleton (narrow subs, server-time handling, latching)
lib/nt4/NT4.ts    vendored from AdvantageScope, BYTE-IDENTICAL — do not edit
lib/discovery.ts  launchd + process-scan instance discovery, merged
lib/status.ts     the status chain
lib/logs.ts       tail-from-end, truncation tolerant, boot marker
lib/mjpeg.ts      snapshot-and-disconnect, port probing
lib/system.ts     host health, cameras, calibrations, videos
app/api/*         read-only JSON + SSE + media endpoints
```

`lib/nt4/NT4.ts` is copied verbatim from AdvantageScope (BSD, Littleton Robotics / FRC 6328).
Its one type incompatibility with TypeScript 5.7 is handled in `types/vendor-compat.d.ts` rather
than by editing the file, so upstream fixes can be re-pulled with a plain copy.
