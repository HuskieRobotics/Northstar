# Northstar Web App — Design & Requirements

**Team:** Huskie Robotics, FRC Team 3061
**Status:** Implemented — see [`webapp/`](../webapp/) and its
[README](../webapp/README.md). This document is the design record and the reference for *why* things
are the way they are; the README is the operating manual.
**Target host:** the Mac mini that runs Northstar on the robot
**Describes:** `HuskieRobotics/Northstar` @ `fd8593d` (branch `6328-2026-updates`)

> **Scope note.** This repository is Team 3061's **fork** of 6328's Northstar, with local changes on
> top. Everything in [§2](#2-background-how-northstar-runs-today) was derived by reading the code in
> *this* repo — not from upstream documentation — and may not describe 6328's version. Upstream
> Northstar should not be treated as a reference for how this app's data sources behave.
>
> Upstream changes are **hand-merged** into this repo, so they arrive through human review rather
> than automatically. That is a meaningful safeguard, but it protects against the wrong thing: the
> reviewer is evaluating vision code, and has no particular reason to notice that a reworded `print`
> statement is something a dashboard parses.
> [§11.1](#111-coupling-to-northstar-internals) inventories those dependencies so the connection is
> visible at merge time.

---

## 1. Purpose

Northstar runs as a set of headless Python processes on the robot's Mac mini. The machine is not hard
to reach — SSH, SFTP, and VNC all work fine for pulling logs or checking configuration, and will
remain the right tools for deep debugging.

The gap this app fills is not *access*, it is *aggregation*. Answering "is the vision system
healthy?" today means checking five or six instances one at a time, across twelve log files, and
knowing which of them matters and what a healthy one looks like. Specifically:

- **Nothing shows the whole system at once.** The failure that matters is usually one camera out of
  six, and finding it is a serial hunt through per-instance logs.
- **Northstar-side and robot-side data live in different places.** Whether a camera is publishing is
  visible on the Mac mini; whether the robot is *accepting* its poses is only visible in
  NetworkTables. Correlating them is the single most useful diagnostic here, and nothing does it
  today.
- **Video streams require knowing port numbers** and opening several browser tabs against
  8000–9001, with no indication of which ports are live.
- **It is a programmer-only workflow.** A terminal and knowledge of the log format are prerequisites,
  so "did all the cameras come up?" cannot be answered by anyone else on the team.

So the target is a glanceable, correlated view for the common case, with SSH and VNC still there for
the uncommon one.

This web app gives the team a single page, reachable from a laptop on the same network, that answers:

1. Which Northstar instances are running, and are they healthy?
2. What do their logs and error logs say right now?
3. What is each camera actually seeing?

**Scope for v1 is read-only.** Control features (restarting instances, triggering calibration,
editing NetworkTables config) are captured in [§12 Deferred Features](#12-deferred-features) and are
explicitly out of scope for the first release.

---

## 2. Background: How Northstar Runs Today

This section records the observed behavior of **this fork**, read directly from the code at
`fd8593d`, because the web app's design depends heavily on it. Where upstream 6328 differs, this
description — not upstream — is the one that governs.

### 2.1 Process topology

Northstar is not a single service. It is **one independent Python process per camera**, each with
its own config file, its own NetworkTables device ID, and its own MJPEG stream ports.

On the competition robot ([cameras/robots/competition/](../cameras/robots/competition/)):

| Config | `device_id` | Pipeline | AprilTag port | ObjDetect port | Capture impl |
| --- | --- | --- | --- | --- | --- |
| `configBR` | `northstar_BR` | AprilTags | 8000 | 8001 | `pylon-cropped` |
| `configBL` | `northstar_BL` | AprilTags | 8004 | 8005 | `pylon-cropped` |
| `configBCL` | `northstar_BCL` | AprilTags | 8006 | 8007 | `pylon` |
| `configBCH` | `northstar_BCH` | AprilTags | 8008 | 8009 | `pylon-cropped` |
| `configPower` | `northstar_power` | Power metrics only | 9000 | 9001 | `pylon` |
| `configCenter` | `northstar_center` | Object detection | 8002 | 8003 | `pylon-color` |

**`configCenter` is present but not deployed.** The centre camera was dropped as a requirement for
the competition robot, so its plist is not installed. The files are kept on purpose: it is the only
colour-camera and object-detection configuration we have working end to end, and worth preserving as
a reference.

That makes it the concrete example of a rule this design depends on: **the config folder is a
superset of what any robot runs**, so the expected instance set must come from the installed launch
agents, never from a directory listing (FR-1, FR-4b). A separate `practice` profile
([cameras/robots/practice/](../cameras/robots/practice/)) defines a smaller set again. The web app
must not hard-code any of them.

### 2.2 The launchd → shell → Python chain

Each instance is started by launchd:

```
org.team3061.northstar.config<X>.plist   (RunAtLoad, StandardOut/ErrorPath)
        └── config<X>.sh                 (while true: reenumerate USB, run Python, sleep 1)
                └── python3 __init__.py --config cameras/robots/<profile>/config<X>.json
```

**This three-level chain has a consequence the web app must handle.** The shell script is an
infinite `while true` loop. If the Python process crashes, the shell script survives and restarts
it. So launchd reports the service as *running* even when Python is crash-looping every two seconds
and no vision data is being produced. **Liveness of the launchd job is not liveness of the
pipeline.** The web app must check for the Python child process specifically, and corroborate with
NetworkTables activity and log recency.

### 2.3 Logs

launchd redirects each instance's stdout and stderr to separate files:

- `logs/config<X>Out.log` — normal output
- `logs/config<X>Error.log` — Python tracebacks, Pylon/AVFoundation errors

Notable characteristics:

- The plists contain **absolute paths** under the deployment account
  (`/Users/nnrobot/Northstar/logs/...`), which differ from a developer checkout.
  The app must read the real paths out of launchd rather than assuming a repo-relative location.
- Both streams are **appended to indefinitely** — launchd does not rotate them, and the shell
  script's restart loop does not truncate them. These files grow across the whole event. The app
  must tail from the end of the file, never read the whole thing.
- [`__init__.py`](../__init__.py) calls `sys.stdout.reconfigure(line_buffering=True)`, so stdout is
  line-buffered and a tail sees lines promptly.
- Recognizable log lines that carry health meaning:
  - `Running AprilTag pipeline at N fps` / `Running object detection pipeline at N fps` (once/sec)
  - `No frame received, waiting for capture` (camera not delivering)
  - `No calibration found for camera <id>` (every 5s)
  - `Loaded calibration for camera <id> from <path>`
  - `Starting recording` / `Stopping recording`
  - `Starting Northstar...` (marks a restart — useful for detecting a crash loop)

### 2.4 Existing MJPEG stream servers

[`output/StreamServer.py`](../output/StreamServer.py) already runs an HTTP MJPEG server per worker
thread, bound to all interfaces:

- `GET /` → a minimal HTML page
- `GET /stream.mjpg` → `multipart/x-mixed-replace` JPEG stream

**Critical performance property:** the workers only encode a frame when a client is attached —

```python
if stream_server.get_client_count() > 0:
    image = image.copy()
    [overlay_image_observation(image, x) for x in image_observations]
    stream_server.set_frame(image)
```

An attached client costs a full-frame copy, overlay drawing, and a JPEG encode **per frame** on a
Mac mini that is already running five vision pipelines. A naive dashboard that holds six MJPEG
connections open permanently would meaningfully degrade vision performance. The design in
[§6.3](#63-video-streams) is built around this constraint.

Port 7999 is used by an ad-hoc `MjpegServer` during calibration mode only.

### 2.5 NetworkTables

The roboRIO at `10.30.61.2` is the NT server; every Northstar instance is an NT **client** named
after its `device_id`.

- **Subscribes** (`/{device_id}/config/…`): `camera_id`, `camera_resolution_width/height`,
  `camera_auto_exposure`, `camera_exposure`, `camera_gain`, `camera_denoise`,
  `camera_balance_red/blue`, `fiducial_size_m`, `tag_layout`, `is_recording`, `timestamp`,
  `event_name`, `match_type`, `match_number`, `throttle_fps`
- **Publishes** (`/{device_id}/output/…`): `observations`, `demo_observations`,
  `objdetect_observations`, `fps_apriltags`, `fps_objdetect`, `power_metrics`

`power_metrics` is a 4-element double array: `[cpu_power_mW, gpu_power_mW, ane_power_mW,
pressure_level]` where pressure is `0=Nominal, 1=Fair, 2=Serious, 3=Critical, -1=Unknown`.

### 2.6 Calibration

[`config/ConfigSource.py`](../config/ConfigSource.py) loads
`cameras/calibrations/calibration<sanitized_camera_id>.yml` for whatever `camera_id` NT currently
reports. If the file is absent, the pipeline does nothing but log every five seconds. This is a
common and quiet failure mode, which is why calibration status is a first-class dashboard signal.

### 2.7 Recorded video

[`output/VideoWriter.py`](../output/VideoWriter.py) writes two `.mkv` files per recording into
`video_folder` (`./videos/`) — an overlaid version and a `_raw` version — named:

```
<device_id>_<YYYYMMDD>_<HHMMSS>[_<event>][_<matchprefix><matchnumber>][_raw].mkv
```

Match prefixes are `""`, `p`, `q`, `e` for the `match_type` index. These files are large and
accumulate; free disk space is a real operational concern.

### 2.8 Power and boot behavior

The Mac mini is powered from the robot. **Turning the robot off cuts its power immediately — there
is no clean shutdown, ever.** It is configured to "start up automatically after a power failure,"
so it boots whenever the robot is turned on, at the same time as the roboRIO. In practice the Mac
mini finishes booting *first*.

This is not a corner case; it is what happens every single time the robot is switched on or off, and
it drives several requirements:

- **The NT server is not there at startup.** Every Northstar instance — and the web app's own NT
  client — comes up before the roboRIO's NT server exists. "Server unreachable" is the **normal boot
  path**, not an error condition. Connecting must be a retry-with-backoff loop from the start, and
  topics appear progressively as the robot code initializes.
- **Everything looks broken for the first minute.** Immediately after power-on, a dashboard that
  renders raw state shows a wall of red. If the UI cannot distinguish *starting up* from *broken*,
  students will chase failures that would have resolved themselves in thirty seconds — the exact
  opposite of what this tool is for.
- **Nothing gets a chance to shut down.** ffmpeg recordings are killed mid-write, log files are
  never closed, and no process runs cleanup. Anything the web app writes to disk can be interrupted
  at any instant.
- **Log files may end mid-line**, and they persist across power cycles with no boot marker other
  than the repeated `Starting Northstar...` banner.
- **Northstar exits when an established NT connection is lost**, but *waits* when the server was
  never there — so the boot race resolves by waiting, while a robot reboot costs one restart per
  instance. See [§2.9](#29-northstar-depends-on-the-nt-server-being-up).
- **Clock trust.** The robot network has no internet, so there is no NTP sync at boot and the Mac
  mini's wall clock may be wrong or skewed relative to the roboRIO. Local file timestamps and local
  log timestamps share the same clock, so comparing them to each other is safe; comparing them
  against NT server timestamps is not.

### 2.9 Northstar depends on the NT server being up

**Observed during the resilience spike:** stopping the robot code did not leave the running Northstar
instance idling and waiting — the Python process **exited**. Zero instances remained. The `while
true` loop in `config<X>.sh` is what brings it back, which is presumably why that loop exists.

Importantly, **the two directions are not symmetric**:

- **Cold start with no NT server** (the boot-race case from [§2.8](#28-power-and-boot-behavior)):
  Python starts and **waits** for the robot code. It does not exit and it does not churn. Expect it
  to sit logging `No frame received, waiting for capture` and `Waiting for camera ID to load
  calibration` until the roboRIO is up.
- **NT server disappearing after a successful connection**: Python **exits**. The `while true` loop
  restarts it about a second later, and the restarted process then waits as above.

So an NT outage costs **exactly one restart per instance**, not a restart loop. On the Mac mini this
is fully self-healing and needs no intervention; the system converges as soon as the roboRIO is back.
Nothing here is broken. What follows is entirely about how the *dashboard interprets* the behavior.

Three consequences, all of which change requirements:

- **Status signal 1 is not independent of signal 4.** The status chain in
  [§6.2](#62-camera-status-model) reads as a sequence of independent stages, but "process alive"
  actually *depends on* "NT server reachable." A process that vanished while NT is down is expected;
  the same absence while NT is up is a real failure. The UI must distinguish these, because they
  demand opposite responses.
- **A brief process gap around every robot reboot or code redeploy is normal.** Each instance dies
  and comes back once. Crash-loop detection (FR-4) must not treat a single NT-correlated restart as a
  fault, and should be suppressed entirely while NT is unreachable — otherwise every robot redeploy
  lights up every camera at once.
- **The "waiting" state deserves its own display.** An instance that is alive, logging
  `No frame received`, and waiting for the robot code is neither healthy nor broken. During the boot
  race this is the correct state for *every* camera, so FR-28's *starting* state should cover it
  rather than showing a failed camera stage.

> **Worth a separate look:** it is not obvious that exiting is the *desirable* behavior — waiting and
> retrying in-process would avoid the restart churn and the camera re-enumeration it triggers. That
> is a Northstar question rather than a web app question, but the dashboard will make the behavior
> visible for the first time, so expect it to come up.

---

## 3. Users and Usage Context

**Primary users:** programming students and mentors debugging vision at the bench or in the pit.

**Access pattern (v1):** a laptop on the same local network as the Mac mini, or a browser on the
Mac mini itself. **Not** used during matches over the robot radio, and not exposed to the internet.

**Implication:** no authentication in v1, and no hard bandwidth ceiling. However, the app listens on
**TCP 5800**, which is inside the FRC team-use range (5800–5810) permitted through FMS. This costs
nothing today and leaves the door open to on-field use later without re-plumbing anything.

---

## 4. Goals and Non-Goals

### Goals

- Answer "is every camera up and working?" in under five seconds of looking at one page.
- Distinguish clearly between the different ways a camera can be "not working," so the fix is obvious.
- Show live and error logs without SSH or screen sharing.
- Show what each camera sees, without degrading vision performance.
- Survive the robot being powered off / NT being unreachable, degrading gracefully rather than erroring.
- Be operable by a student who did not write it, during the six minutes between matches.

### Non-Goals (v1)

- Any write, restart, or control action (see [§12](#12-deferred-features)).
- Authentication, user accounts, or multi-tenancy.
- Historical metric storage, trending, or a time-series database. The app shows *now*, plus whatever
  history the log files happen to contain.
- Replacing AdvantageScope for pose visualization or log analysis.
- Running anywhere other than the Mac mini that hosts the Northstar instances.

---

## 5. Architecture

```
┌──────────────────────────── Mac mini ─────────────────────────────┐
│                                                                    │
│  launchd ── config<X>.sh ── python3 __init__.py  ×N instances      │
│                │                     │                             │
│                │ stdout/stderr       │ MJPEG :8000-8009, :9000-9001 │
│                ▼                     │                             │
│           logs/*.log                 │                             │
│                │                     │                             │
│  ┌─────────────┴─────────────────────┴──────────────────────────┐  │
│  │  Next.js app  (node, port 5800, own launchd service)         │  │
│  │                                                              │  │
│  │  Route handlers (Node runtime, server-only):                 │  │
│  │    • launchctl queries + child-process checks                │  │
│  │    • log tail (seek from end) + SSE follow                   │  │
│  │    • MJPEG snapshot grab / stream proxy (localhost)          │  │
│  │    • filesystem: calibrations, videos, disk space            │  │
│  │    • system health: load, memory, thermal, uptime            │  │
│  │    • NT4 client singleton ──────────────────┐                │  │
│  │                                             │                │  │
│  │  React UI ◄── SSE / polling ────────────────┘                │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ NT4 (WebSocket :5810)
                                 ▼
                        roboRIO 10.30.61.2
                        (NT server, 3061-lib)
```

### 5.1 Stack: Next.js

The app is a **Next.js (App Router) application** run in production mode (`next build` +
`next start`) on the Mac mini, supervised by its own launchd job.

Rationale: the team already works in Next.js, the UI is the interesting part of this project, and
the server-side work (spawning `launchctl`, seeking in log files, proxying MJPEG) maps cleanly onto
Next.js route handlers running in the Node runtime.

**Constraints this choice imposes, to be aware of:**

- Node must be installed and version-pinned on the competition Mac mini, and `npm ci && next build`
  must be part of the deployment procedure. Any UI change requires a rebuild — unlike the Python
  code, which can be edited in place.
- NetworkTables must be spoken from TypeScript rather than via `pyntcore` (see [§7](#7-networktables-integration)).
- The Northstar config dataclasses in [`config/config.py`](../config/config.py) can't be imported;
  the app parses the `config<X>.json` files directly. This is a small, stable schema, but it is a
  duplicated definition that can drift.

**Outcome:** Next.js was built and the fallback was never needed — the TypeScript NT client works
unmodified under bare Node 24 ([§14.3](#143-result)). The fallback is recorded below because the
reasoning still applies if the Node toolchain ever becomes a burden on the competition machine.

**Documented fallback:** a **Python + FastAPI** app served from the existing `venv`, with a plain
HTML/CSS/JS front end and no build step. That version could import `config.config` and use
`pyntcore` directly, and would be editable in place on the robot. The API surface in
[§8](#8-api-surface) is deliberately framework-agnostic so this swap would not require redesign.

### 5.2 Server-side vs. browser-side data access

All privileged and cross-origin work happens **server-side** in route handlers:

- Log files and `launchctl` obviously require server access.
- The **NT client runs on the server**, as a single shared connection, not one per browser tab.
  This keeps exactly one extra NT client on the robot's network regardless of how many people have
  the page open, and it means the page works from a laptop that can reach the Mac mini but not the
  roboRIO.
- MJPEG is fetched from `127.0.0.1:<port>` server-side, so no stream ports need to be reachable from
  the client and only 5800 must be open.

The browser receives everything over a small number of **Server-Sent Events** streams plus a few
plain `GET` endpoints. SSE is preferred over WebSockets: the data flow is one-directional in v1, SSE
reconnects automatically, and it is far simpler to reason about.

---

## 6. Functional Requirements

### 6.1 Instance discovery and status

Northstar is started two different ways depending on where it runs: under launchd on the Mac mini,
and by hand on a development machine (`python3 __init__.py --config …` in a terminal, or by running
`config<X>.sh` directly). **The app must work in both cases**, so discovery is deliberately not
launchd-specific.

**FR-1 — Discover instances from multiple sources.** Discovery sits behind one interface with two
implementations, and the results are merged:

- **launchd source** — enumerate services matching `org.team3061.northstar.*`; for each, use
  `launchctl print gui/$UID/<label>` (falling back to `launchctl list <label>`) to obtain the PID or
  its absence, the last exit status, `ProgramArguments` → the `config<X>.sh` path, and
  `StandardOutPath` / `StandardErrorPath` → the real log file paths.
- **process source** — scan running processes for a Python command line containing `__init__.py` with
  a `--config <path>` argument, regardless of parent. This finds instances started by hand, and it is
  **the same scan FR-3 already requires**, so it costs essentially nothing extra.

Merge on the resolved `--config` path, attaching launchd metadata where it exists. A union rather
than an either/or, because both can be true at once — a developer on the Mac mini may stop one
launchd job and run that instance by hand while the others stay supervised.

Default to auto (use whatever each source finds); allow an explicit override for troubleshooting.

**FR-1a — Key instances by config basename, not launchd label.** The canonical instance key is the
config file's basename — `configBL`, `configCenter` — which is identical in both environments and
already embedded in the launchd label. The launchd label becomes metadata rather than identity. This
keeps URLs and API paths stable whether an instance was launched by launchd or by hand.

**FR-2 — Resolve each instance's config.** From the launchd `ProgramArguments` shell script, or
directly from the process command line, extract the `--config <path>` argument; parse that JSON for
`device_id`, `apriltags_stream_port`, `objdetect_stream_port`, `capture_impl`, `apriltags_enable`,
`objdetect_enable`, `powermetrics_enable`, `video_folder`, and `calibration_folder`. Everything the
dashboard needs about an instance comes from this file, which is why process-only discovery loses
almost nothing.

**FR-3 — Detect the Python process, not just the launchd job.** Because the shell wrapper restarts
Python in a loop ([§2.2](#22-the-launchd--shell--python-chain)), the app must locate the `python3
__init__.py --config <path>` process itself — by walking children of the shell PID, or by matching
the command line — and report its PID and start time.

**FR-4 — Detect crash loops.** If the Python process's start time keeps resetting, or
`Starting Northstar...` appears repeatedly in the tail of the out-log, the instance is flagged as
**crash-looping** — visually distinct from both healthy and stopped. Note this applies only where
something is restarting Python: under launchd, or when a developer runs `config<X>.sh`. A bare
`python3 __init__.py` that dies simply disappears from the process scan.

> **Suppress this whenever NT is unreachable.** Northstar exits when the NT server goes away
> ([§2.9](#29-northstar-depends-on-the-nt-server-being-up)), so one restart per instance is the
> *expected* result of any robot reboot or code redeploy — on every camera at once. Restart counting
> is only meaningful while the app's own NT client is connected, and the threshold must sit above a
> single NT-correlated restart.

**FR-4a — Handle missing log files.** A hand-run instance writes to the terminal, not to
`logs/config<X>Out.log`, so there are no files to tail. Report log availability per instance and
render the log panel as *unavailable in this environment* rather than as an error or an endless
spinner. Developers who want the log features can redirect through `tee` — see
[§10](#10-deployment) — but the app must not require it.

**FR-4b — Optional expected-instance list (development aid only).** A process scan can only see what
is running; unlike launchd it cannot report an instance that *should* be running but is not. A scan
of `cameras/robots/<profile>/config*.json` fills that gap on a development machine.

> **Do not use this as the expected set on a robot.** The config folder is a superset: it holds
> configs for cameras that do not exist on every robot, and deployment works by copying only the
> plists that are actually needed — `configCenter` being a current example. Treating the folder as
> the expected set would report permanently-missing instances that were never supposed to run, which
> is precisely the false-alarm failure FR-28 exists to prevent.
>
> **launchd is the authority on what should be running**, because the set of installed plists *is*
> the deployment decision. This is the strongest argument for the launchd-based discovery in FR-1.

Default off; enable only in development.

### 6.2 Camera status model

The core of the dashboard. A camera is not simply "up" or "down"; it fails in stages, and knowing
*which* stage tells you what to fix. Each instance shows an ordered chain of indicators:

| # | Signal | Meaning | Source |
| --- | --- | --- | --- |
| 1 | **Process** | The Python process for this instance is alive and not crash-looping | Process scan, plus launchd metadata where available (FR-1, FR-3). **Depends on signal 4** — Northstar exits when NT is down ([§2.9](#29-northstar-depends-on-the-nt-server-being-up)), so read this jointly with NT reachability, not in isolation |
| 2 | **Camera** | The camera hardware is delivering frames to Northstar | Live evidence first — `ReceivingFrames` latched, or an FPS publication within 5s — then, only as a fallback, `No frame received` in the **last ~12s** of log (FR-4d) |
| 3 | **Calibration** | A calibration file exists for the `camera_id` NT currently reports | Filesystem check (FR-8) |
| 4 | **NT connected** | This Northstar instance is connected to the roboRIO's NT server | `/AdvantageKit/Vision/<loc>/Connected`, falling back to `SystemStats/NTClients/<device_id>@<n>/Connected` — **read the value, not the key's presence** ([§7.3](#73-robot-side-3061-lib-topics)) |
| 5 | **Sending frames** | The roboRIO is actually receiving observations from this camera | `/AdvantageKit/Vision/<loc>/ReceivingFrames` |
| 6 | **Poses accepted** | Rate of this camera's pose estimates the robot accepted | `RealOutputs/Vision/<loc>/UpdatePoseCount` — cumulative; show a delta over a window. **Absent until the first acceptance** |
| 7 | **Poses rejected** | Rate of this camera's pose estimates rejected | `RealOutputs/Vision/<loc>/RejectedPoseCount` — cumulative, eligibility-gated. **Absent until the first rejection** |
| — | **Results freshness** | Cycles since this camera last produced a result | `RealOutputs/Vision/<loc>/CyclesWithNoResults` — **present from the first cycle for every camera**, so this is the signal to lean on when the counters above are absent ([§7.5.2](#752-verification-of-the-counter-changes)) |

**FR-4c — A camera with no tags in view is healthy, not faulty.** Signal 7 reports `idle` when the
camera is delivering frames but no poses are being produced, and `idle` is excluded from the card's
overall verdict and from the "N of M healthy" count. On a stationary robot it is routine for most
cameras to see no AprilTag; counting that as a fault makes the header read "1/4" when nothing is
wrong, which is the false alarm FR-28 exists to prevent. Rejections only warn when poses are
*actually being produced and refused*.

**FR-4d — Prefer live evidence over log history.** Signals must check current NT values before
falling back to log scraping, and log evidence must be time-bounded (last ~12s by printed timestamp).
A tail holds minutes of history, so testing whether it *contains* `No frame received` keeps a camera
red long after frames resume.

**FR-5 — Render the chain, not a single verdict.** The first failing link is highlighted, so the
page reads as "process up, camera up, **no calibration**" rather than a generic red dot.

**FR-6 — Show accepted vs. rejected pose rates side by side.** A camera that is publishing plenty of
tag poses which the robot is *rejecting* looks healthy by every other measure and is exactly the
failure this dashboard exists to catch. Show both counts and a ratio, and flag a high rejection
ratio as a warning state.

> **Satisfied per camera.** 3061-lib now publishes both `UpdatePoseCount` and `RejectedPoseCount`
> per camera, ungated, verified at a 91% accept rate over a live window
> ([§7.5.2](#752-verification-of-the-counter-changes)). Compute the ratio from deltas of the two
> counters. Note both are **absent until that camera's first acceptance/rejection** — render that as
> "none yet," never as an error.

**FR-7 — Per-instance vitals.** Alongside the chain: measured FPS (`fps_apriltags` /
`fps_objdetect`), active `camera_id`, resolution, exposure, gain, `throttle_fps`, and
`is_recording`.

### 6.3 Video streams

**FR-8 — Thumbnail grid with click-to-expand.** The dashboard shows a low-rate still snapshot per
camera. A full-rate stream opens **only** when a user clicks a thumbnail.

This directly serves the constraint in [§2.4](#24-existing-mjpeg-stream-servers): a thumbnail is
obtained by connecting to `127.0.0.1:<port>/stream.mjpg`, reading exactly one JPEG frame, and
**closing the connection immediately** so `get_client_count()` returns to zero and the worker stops
encoding. Snapshot cadence is configurable and defaults to roughly one frame every 2–3 seconds, only
while the tab is visible.

**Consequence: the access log had to be silenced.** One connect-and-disconnect every 2–3 seconds per
camera is a successful `GET /stream.mjpg` every 2–3 seconds per camera, and
`BaseHTTPRequestHandler.log_request()` writes each one to **stderr** — which launchd captures into
`logs/config<X>Error.log`. Across four cameras that is roughly two lines per second in the one file
that exists to surface faults. [`StreamServer.py`](../output/StreamServer.py) therefore overrides
`log_request()` to a no-op. Only *accepted* requests are dropped: `send_error()` calls `log_error()`
on its own path, so 404s and malformed requests are still recorded.

**FR-9 — Proxy, don't link.** All stream traffic is proxied through the Next.js app on port 5800.
The client never connects to 8000–9001 directly.

**FR-10 — Expanded view.** Clicking a thumbnail opens a single full-rate proxied MJPEG stream. Only
one expanded stream at a time by default, with a visible indicator that a live stream is attached
and costing CPU. Closing the view must terminate the upstream connection promptly.

**FR-11 — Handle absent streams.** An instance with `apriltags_enable: false` has no meaningful
AprilTag stream; `configPower` has neither. Show which streams an instance actually offers, and
render a clear placeholder rather than a spinner when a port isn't listening.

### 6.4 Logs

**FR-12 — Tail both streams per instance.** Out-log and error-log, each tailed from the end of the
file (never a full read — see [§2.3](#23-logs)), default 200 lines, adjustable. The final line may be
truncated by a power cut (FR-30) and must be handled without error.

**FR-12a — Mark the current boot.** Log files persist across power cycles with no boot marker. Since
log lines are prefixed `%Y-%m-%d %H:%M:%S` from the same clock the app runs on, the app can compare
them against the system boot time and draw a visible divider at the start of the current boot's
output. Without this, a student tailing a log during troubleshooting cannot tell this power-on's
errors from last week's.

**FR-13 — Live follow.** An SSE endpoint pushes new lines as they are appended, with a
pause/resume control and auto-scroll that disengages when the user scrolls up.

**FR-14 — Highlighting.** Recognize and visually distinguish the known log patterns from
[§2.3](#23-logs): FPS lines, `No frame received`, `No calibration found`, `Starting Northstar...`,
and Python tracebacks. A traceback should be grouped and collapsible rather than shown as a wall of
loose lines.

**FR-15 — Filter and download.** A plain substring/regex filter over the tailed buffer, and a link
to download the full log file for offline analysis.

**FR-16 — Error-log prominence.** Because the error log is where the useful information lands and
it is easy to forget to look at, surface "N new error lines" per instance on the main dashboard,
not only inside the log view.

### 6.5 Calibration status

**FR-17 — Per-camera calibration check.** For each instance, take the `camera_id` reported over NT,
apply the same sanitization as [`sanitize_camera_id`](../config/config.py) (strip everything that is
not `[A-Za-z0-9_-]`), and check for
`<calibration_folder>/calibration<sanitized_id>.yml`. Report present/absent, the resolved path, and
the file's modification date. Absent is a prominent warning — this is the silent killer described in
[§2.6](#26-calibration).

**FR-18 — Calibration inventory.** A list of all calibration files on disk with their camera IDs, so
a mismatch between "camera plugged in" and "calibration on hand" is visible at a glance.

### 6.6 Connected camera inventory — *superseded*

~~**FR-19 / FR-20** — enumerate cameras the OS sees via `system_profiler`, and cross-reference
against configured `camera_id` values.~~

**Built, then removed.** The `system_profiler` listing duplicated what the status chain already said
and did not answer the question people actually have at the bench, which is whether a camera is
*wired correctly*. [§6.10](#610-usb-link-diagnostics-whatcable) replaced it with WhatCable, which
answers that and more: negotiated link speed, port transports, and expected-but-absent cameras — all
joined to instances by serial number.

Kept here as a record of a feature that was implemented and deliberately withdrawn, so nobody
re-adds it.

### 6.7 System health

**FR-21 — Mac mini vitals.** CPU load, memory pressure, uptime, and per-instance CPU/memory usage of
the Northstar Python processes.

**FR-22 — Thermal and power.** Surface the `power_metrics` NT array from the `northstar_power`
instance (CPU/GPU/ANE mW and thermal pressure level), decoding the pressure integer back to
`Nominal`/`Fair`/`Serious`/`Critical`. Note that the app should **not** run `powermetrics` itself —
it requires sudo and the `configPower` instance already collects it once per second.

**FR-23 — Disk space.** Free space on the volume holding `video_folder`, with a warning threshold.
Recordings are written in pairs and are large; running out of disk mid-event is a realistic failure.

### 6.8 Recorded video

**FR-24 — List recordings.** Browse `video_folder`, parsing the filename convention from
[§2.7](#27-recorded-video) into structured columns: device, timestamp, event, match type/number,
raw-vs-overlaid, size. Sort newest first; group the overlaid and `_raw` pair for the same recording.

**FR-25 — Download.** Direct download links. In-browser playback is **not** required — these are
HEVC in MKV, which most browsers will not play natively. Do not promise playback the browser can't
deliver; offer download and note the codec.

**FR-25a — Flag unfinalized recordings.** If the robot is switched off while recording, ffmpeg is
killed mid-write and the resulting `.mkv` is never finalized. The most recent recording before any
power cut is therefore suspect by default. Flag recordings that are zero-byte, or whose write appears
to have been interrupted at power-off, so nobody wastes time wondering why a file won't open.

### 6.9 Resilience

**FR-26 — Degrade gracefully.** Every data source can be independently unavailable: the roboRIO may
be off, an instance may be stopped, a stream port may not be listening, `pylon` enumeration may
fail. Each panel reports its own staleness and error state. **The page must never fail as a whole
because one source is down**, and it must be obvious which data is live versus stale.

**FR-27 — Show NT connection state.** A persistent indicator of the app's own connection to the
roboRIO NT server, with the time of last successful update. When NT is down, NT-derived fields are
visibly greyed rather than showing stale values as if current.

**FR-28 — A distinct "starting up" state.** Because the Mac mini boots before the roboRIO
([§2.8](#28-power-and-boot-behavior)), a page loaded shortly after power-on legitimately has no NT
data and possibly no running pipelines. The app compares the **system boot time** against a
configurable startup grace window (default ~90s) and, within it, renders unestablished signals as
*starting* — visually distinct from both healthy and failed — alongside a visible "up for 0:24"
counter.

This is a correctness requirement, not decoration. A dashboard that cries wolf every time the robot
is switched on trains the team to ignore it, which costs more than having no dashboard at all. The
grace window applies per signal: a signal that has *ever* been established during this boot and then
drops is a real failure and must show as failed immediately, regardless of uptime.

**FR-29 — Hold no persistent writable state.** Power can be cut at any instant with no warning. The
app must keep nothing on disk that it needs to be valid at next boot — no caches requiring
invalidation, no lock or PID files, no session store, no partially written state. All state is
in-memory and rebuilt from scratch on start. Read-only operation ([§4](#4-goals-and-non-goals))
makes this nearly free, and it is another reason to keep it that way.

**FR-30 — Tolerate truncated files.** A hard power cut can leave a log file ending mid-line and a
`.mkv` without a finalized container. The log tailer must not choke on a partial final line, and the
recording list must handle zero-byte, truncated, and unfinalized files without erroring.

---

### 6.10 USB link diagnostics (WhatCable)

**FR-31 — Report per-camera USB link quality.** Northstar periodically stops receiving frames, exits,
re-enumerates the port and retries; the cause is unconfirmed and ESD is one theory. Another, which
nothing on this dashboard could previously detect, is the camera **negotiating down from USB 3 to
USB 2**. The pipeline keeps reporting frames and FPS, so every existing signal stays green while the
link has halved.

`whatcable --json` exposes exactly this: per port, the transports `supported`, `provisioned` and
`active`, plus each device's negotiated speed. Its `devices[].serialNumber` equals Northstar's
`camera_id`, which gives a clean join with no configuration — verified against a Basler
`daA1280-54um` reporting `24608715` on both sides.

- **Degradation rule:** a device running at USB 2 speed on a port whose `supported` or `provisioned`
  transports include USB 3. Flagged on the cameras page and as a note on the dashboard card, since a
  card that looks entirely healthy is precisely the case this is meant to catch.
- **Also surfaced:** WhatCable's own `dataLink` warning, the port location ID (correlates with
  [MacMiniPorts.md](../MacMiniPorts.md)), and configured cameras absent from the bus entirely.
- **Cached, not polled.** The CLI probes the USB bus, and probing a bus that is actively streaming is
  not obviously free. Default 30s cache with a manual re-check; `0` disables it. A run measured
  ~0.1s. This app must never be the reason a camera hiccups.
- **Fails soft.** Not installed, missing fields, or a changed JSON shape all degrade to "unavailable"
  rather than breaking the page — it is an external tool's output format, not an API.

This replaced the OS camera enumeration, which duplicated what the status chain already said and did
not answer the question people actually have at the bench.

**FR-32 — Retain link history and correlate it with frame loss.** A live reading cannot answer the
question that matters: did the link degrade *before* frames stopped? Link state is sampled on a timer
and appended to `logs/cabling-history.jsonl` on change (plus a heartbeat); frame-loss episodes are
extracted from runs of `No frame received` in each instance's log; the two are lined up and the page
reports how many episodes were preceded by a degraded link.

- **Change-only recording** keeps the file small and every line meaningful.
- **Disposable by design** — bounded to 2 MB, a power-cut-truncated final line is skipped on read,
  and losing the file costs only past correlations. Consistent with FR-29: nothing here must be
  valid at next boot.
- **Reported as a count, not a verdict.** A handful of episodes proves nothing either way, and
  "none of N episodes had a degraded link beforehand" is phrased as evidence against the theory
  rather than proof. Verified end to end against a synthetic pair of episodes — one preceded by a
  USB 2 fallback, one not — which the correlation separated correctly.
- **Correlation needs history collected *before* an episode**, so it fills in over time rather than
  being useful immediately. Worth leaving running.

**FR-33 — Check the bus on the event, not on a timer.** Frame loss can recover in just over a second,
so a 30-second sampler would essentially never observe the degraded state — by the time it ran, the
link would be back and the evidence gone. Instance logs are therefore polled sub-second, and the
first `No frame received` line triggers an **immediate** check that forces past the cache (the cached
reading predates the event, and would be exactly the wrong answer). Frames resuming triggers a second
check so recovery is captured too.

- **Measured latency, log line to USB checked: ~0.3s** (0.26 / 0.37 / 0.27 over three runs).
- A per-instance trigger gap (default 3s) stops a flapping camera causing a storm of USB reads.
- **Triggered samples are recorded unconditionally**, unlike periodic ones — "we looked during the
  episode and the link was healthy" is evidence too, and the summary now leads with mid-episode
  checks because they are far stronger than a before-and-after inference.
- **Deep USB probing is off by default.** Measured on a Basler `daA1280-54um`, `--no-usb-probe`
  returns identical device speed, `usbVersion` and port transports. Probing buys nothing this app
  reads, and these checks fire while a camera is already in trouble — so the cautious default costs
  nothing.
- **The camera→instance mapping is remembered.** It derives from NT's `camera_id`, and NT goes away
  routinely (the robot power-cycles; Northstar exits when it loses the connection). Samples taken
  during an outage would otherwise be unattributable — which is precisely when they matter. The
  mapping is cached in memory and re-learned from the history file on read.

## 7. NetworkTables Integration

### 7.1 Client

A single NT4 client runs server-side in the Next.js Node process as a module-level singleton, guarded
against Next.js dev-mode double-instantiation and hot reload. It connects to the roboRIO NT server
over NT4's WebSocket transport (`ws://10.30.61.2:5810/nt/<client-id>`), identifying itself distinctly
(e.g. `northstar_webapp`) so it is obvious in AdvantageScope who is connected.

**Implementation: vendor AdvantageScope's `NT4.ts`.** AdvantageScope contains a self-contained
TypeScript NT4 client at `src/hub/dataSources/nt4/NT4.ts` (~700 lines). This is a much better
starting point than any npm NT4 package:

- **It is the client thousands of FRC teams already rely on**, maintained by 6328 — the same team
  that wrote Northstar. Its failure modes are known and it is exercised at every event.
- **One runtime dependency:** `@msgpack/msgpack`. Nothing else.
- **Reconnection is built in and is the documented behavior** — "the client will reconnect
  automatically when disconnected" — with a liveness poll and a watchdog timeout that forces a
  reconnect when the server goes quiet. This is acceptance item 4, already solved.
- **It implements NT4.1 RTT server-time sync** and exposes `getServerTime_us()`, which sidesteps the
  Mac mini clock-skew concern in [§2.8](#28-power-and-boot-behavior): NT data can be timestamped
  against the *server's* clock rather than the local one.
- **The API is exactly what this app needs** — `connect()`, `disconnect()`,
  `subscribe(patterns, prefixMode, …)`, `subscribeTopicsOnly(...)`, and callbacks delivering
  `(topic, timestamp_us, value)`. Prefix-mode subscription maps directly onto
  `/AdvantageKit/Vision/` and the per-`device_id` trees.
- It already types its timers as `NodeJS.Timeout`, so Node is clearly anticipated.

**Node compatibility — verified.** The only browser globals used at runtime are `WebSocket` and
`CloseEvent` (`CloseEvent` also appears in type position, which erases at compile time). Both are
Node globals on **Node 24.17.0**, confirmed by direct check, so the file should run unmodified with
no `ws` shim. `WebSocket` landed as a Node global in v22 and `CloseEvent` in v23, so **pin Node ≥ 24**
and this stays true. *Still to confirm by running it:* an actual connect/subscribe against a live
server, which is what the spike in [§14](#14-nt-client-spike) is now for.

**Licensing.** AdvantageScope is BSD-3-Clause-style (Littleton Robotics / FRC 6328). Redistribution
in source form is permitted provided the copyright notice and disclaimer are retained, and the
Littleton Robotics / AdvantageScope names are not used to endorse this project. So: vendor the file
with its header intact, note its origin and any local modifications, and keep it isolated in one
directory so upstream fixes can be re-pulled. The repo already carries 6328's MIT-licensed Northstar
code, so this is a familiar arrangement.

Prefer vendoring over a git submodule or an npm dependency on the whole of AdvantageScope: it is a
single file with one dependency, and pulling in an Electron application to get it would be absurd.

Note that `NT4.ts` handles the NT4 wire protocol only. WPILib struct decoding lives separately in
`src/shared/log/StructDecoder.ts`, so struct-typed topics such as `TagPoses` arrive as raw bytes —
sufficient for v1, which needs only array lengths. If a later feature wants actual poses, that file
is available on the same terms.

**Requirements:** subscribe-only in v1 (do not use `publishTopic` / `addSample`), and retain a
last-update timestamp per topic so the UI can distinguish "value is zero" from "no data since the
robot rebooted."

> **Trap — `getServerTime_us()` is unreliable at two moments, both observed.**
>
> 1. **At first connect it returns `null`.** The `onConnect` callback fires before the separate RTT
>    socket has completed a round trip. Handle null; do not assume server time exists at connect.
> 2. **Immediately after a reconnect it returns a stale value.** `serverTimeOffset_us` is not
>    cleared on disconnect, so the offset from the *previous* session is reused until the first
>    post-reconnect RTT sample lands. Measured directly: on reconnect the client reported **1304.9 s**
>    of robot uptime for a roboRIO that had just restarted; a fresh client moments later correctly
>    reported **70.6 s**.
>
> The second case is the dangerous one, because it coincides exactly with a roboRIO reboot — when the
> robot's clock has reset to near zero and the carried-over offset is therefore wildly in the future.
> Anything timestamped in that window would be stamped ahead of real time and could be treated as
> permanently fresh.
>
> **Mitigation:** on `onDisconnect`, mark server time invalid; treat it as unavailable until a fresh
> RTT sample has arrived after reconnect (≥250 ms on NT4.1). While invalid, fall back to local
> monotonic time for staleness decisions and show NT-derived ages as unknown rather than computed.
> This is the one place the vendored client needs care rather than trust.

### 7.2 Topics consumed

Per instance `device_id`, from Northstar itself (all verified present in the live tree):

- `/{device_id}/output/fps_apriltags`, `fps_objdetect` — measured pipeline rate
- `/{device_id}/output/observations`, `objdetect_observations` — presence and update rate are used as
  a liveness signal; the payload is also decodable for a tag count. **The layout is variable and must
  be parsed, not pattern-matched on length** — see
  [`OutputPublisher.py`](../output/OutputPublisher.py):

  | Offset | Contents |
  | --- | --- |
  | `[0]` | Pose-solution count: `0`, `1`, or `2` |
  | next `8 × count` | Per solution: `error`, then `x, y, z, qw, qx, qy, qz` |
  | next `1` | Tag count `N` |
  | next `N` | Tag IDs |
  | remainder | Only when `tagangle_enable`: per tag, `tag_id`, 8 corner angles, `distance` |

  A single-tag capture measured 19 elements — solution count `2`, so `1 + 16`, then a tag count of
  `1` and one ID. **That is one specific case, not the shape.** A multi-tag frame resolves to a
  single solution, giving `1 + 8 + 1 + N`; a frame with no pose solution starts at `0`. Decode by
  walking the fields; never infer the layout from the array length.
- `/{device_id}/output/power_metrics` — for `northstar_power`
- `/{device_id}/config/*` — the live camera settings the instance is operating under
- `/{device_id}/calibration/active`, `capture_flag` — observed on the running instance. Not used in
  v1, but this is the interface deferred feature 2 ([§12](#12-deferred-features)) would drive.

These are published by Northstar itself, so they exist whenever the instance is running — including
for instances the robot code knows nothing about (`northstar_center`, `northstar_power`).

3061-lib mirrors much of this per camera under `/AdvantageKit/Vision/<loc>/` (FPS, power, thermal),
and the robot-side copy is preferable where available: keyed consistently with the status chain and
already normalized — `ThermalPressure` is a readable string versus Northstar's 0–3 integer encoding.
Since that tree is present in competition builds ([§7.3](#73-robot-side-3061-lib-topics)), prefer it,
and fall back to the Northstar topics for instances with no `Vision/` entry.

### 7.3 Robot-side (3061-lib) topics

**Verified** by dumping the live NT tree from 3061-lib in simulation, using the spike in
[§14](#14-nt-client-spike). Several earlier assumptions in this document were wrong; what follows is
what the robot actually publishes.

> ### ✅ Everything here was measured with `ENABLE_EXTRA_LOGGING` **off**
>
> 3061-lib gates additional per-camera logging behind `ENABLE_EXTRA_LOGGING`, which is enabled while
> debugging and **disabled when competing**, for performance.
>
> **All measurements in this section were taken with the flag off** — i.e. against a
> competition-equivalent build. So everything documented here, including `UpdatePoseCount`,
> `ReceivingFrames`, `PoseObservations`, and the per-camera `Vision/<loc>/*` tree, is available at an
> event. That is the configuration that matters, and it is the one that was measured.
>
> Two consequences:
>
> - **The design rests on the competition baseline, not a debug-only superset.** No requirement here
>   depends on a flag that will be off when it counts.
> - **Do not add dependencies on topics seen only with the flag on.** Anything discovered during
>   bench debugging with extra logging enabled is enrichment at best; verify against a flag-off
>   capture before building on it.

> **AdvantageKit creates topics lazily, on first record.** An inventory taken from an idle system is
> **incomplete**, and absence from it is not evidence a topic does not exist. Measured directly: idle
> = 540 topics, with one camera actively detecting a tag = 558. `UpdatePoseCount` — the key that
> unblocks FR-6 — is one of the topics that only appears under load. Always inventory with a camera
> actually detecting something, and diff against an idle baseline
> (`snapshot-topics.ts`).
>
> This, not the logging flag, is the real reason a topic may be missing from an inventory.

**Per-camera, under `/AdvantageKit/Vision/<camera location>/`** — these are IO inputs and are the
primary source for the status chain:

| Key | Type | Notes |
| --- | --- | --- |
| `Connected` | boolean | Status signal 4 |
| `ReceivingFrames` | boolean | Status signal 5. Updated 53× in 12s on the live instance, versus once for the idle cameras — so update *rate* is itself a liveness signal |
| `AprilTags/Fps`, `ObjDetect/Fps` | int | Per-pipeline FPS, mirrored from Northstar |
| `AprilTags/Frames/length`, `ObjDetect/Frames/length` | int | Frame counts |
| `AprilTags/Timestamps`, `ObjDetect/Timestamps` | double[] | |
| `PoseObservations` | `struct:PoseObservation[]` | Per-camera pose observations submitted this cycle. 112 B each; schema in [§7.3.2](#732-decoding-poseobservation) |
| `CpuPower`, `GpuPower`, `AnePower` | double | Per-camera power draw |
| `ThermalPressure` | **string** | Not the 0–3 integer encoding Northstar uses |

**Global, under `/AdvantageKit/RealOutputs/Vision/`** — not per-camera:

| Key | Type | Observed behavior |
| --- | --- | --- |
| `AprilTags` | `struct:Pose3d[]` | Tag poses **accepted** this cycle. Confirmed positively in the multi-tag run — reached 2 tags alongside `RobotPosesAccepted` = 1 observation, mirroring the rejected pair exactly |
| `RejectedAprilTags` | `struct:Pose3d[]` | Tag poses **rejected**. Peaked at 168 B = 3 poses with one tag visible |
| `RobotPosesAccepted` / `RobotPosesRejected` | `struct:Pose3d[]` | The corresponding robot poses; rejected updated 1248× in 25 s while accepted never changed |
| `AprilTagsPoses` | `struct:Pose3d[]` | **Static field layout**, not observations — 1792 B = 32 poses, published once. Do not mistake this for live data |
| `DetectedObjectPoses` | `struct:Pose3d[]` | Object detection |
| `IsEnabled`, `IsUpdating` | boolean | `IsUpdating` tracks whether poses are currently being incorporated |
| `CamerasToConsider` | string | e.g. `"[0, 1, 2, 3]"` |
| `<camera location>/sending frames` | boolean | Per-camera, lowercase, **with a space** |
| `<camera location>/UpdatePoseCount` | int | **Per-camera cumulative count of ACCEPTED pose updates.** Only appears once that camera has had a pose accepted |

**Struct sizes.** `Pose3d` is **56 bytes** and `PoseObservation` is **112 bytes**. These are safe to
rely on: both are *fixed-layout* structs whose sizes come from the published schema
([§7.3.2](#732-decoding-poseobservation)), independently confirmed against wire byte lengths. A
multi-tag observation does not make the struct larger — the tag information is carried *inside* the
fixed struct as `numTags` and `tagsSeenBitMap`. So dividing byte length by struct size gives the
array length correctly regardless of how many tags are in frame. Assert a zero remainder anyway.

**What each array length actually counts — measured with two tags in one frame.** The two families
count *different things*, which single-tag testing cannot reveal because the counts coincide:

| Topic | One entry per… |
| --- | --- |
| `RobotPosesAccepted` / `RobotPosesRejected` | **observation** (one robot pose estimate) |
| `AprilTags` / `RejectedAprilTags` | **tag** |
| `Vision/<loc>/PoseObservations` | **observation** |

With tags 15 and 16 both in frame, the dominant sample was:

```
obs=1  numTags=2  type=MULTI_TAG  →  rejectedPoses=1   rejTagPoses=2
```

One observation, one rejected robot pose, **two** rejected tag poses. The multi-tag run was also the
first to produce **accepted** poses, and they behaved symmetrically — `RobotPosesAccepted` = 1
observation with `AprilTags` = 2 tags. Until then `AprilTags` had only ever been empty, so its
meaning was inferred from absence; it is now positively confirmed. In the earlier single-tag
captures the same relationship read as `obs=3 → rejTagPoses=3`, which looks like a 1:1 rule and is
not one. **`RejectedAprilTags` length ÷ `RobotPosesRejected` length = `numTags`**, and `numTags`
varies frame to frame.

Consequences:

- To count **rejection events**, use `RobotPosesRejected`. To count **tags involved**, use
  `RejectedAprilTags`. Using one where the other belongs inflates or deflates by the tag count.
- A genuine per-observation tag count requires decoding `numTags` / `tagsSeenBitMap` from the struct
  ([§7.3.2](#732-decoding-poseobservation)) — which is straightforward and now proven to work.
- Anything labelled "tags" in the UI must be checked against a multi-tag frame before it is believed.

> **These topics are not sample-synchronized.** They are published independently within a cycle, so
> an instantaneous read frequently shows inconsistent combinations — `obs=2` alongside
> `rejectedPoses=1`, or `acceptedPoses=1` with `tagPoses=0`. All of those appeared in a 20 s capture.
> **Never correlate these topics instant-by-instant**; accumulate each over a rolling window and
> compare the windows. This also weakens the "derive rejected from observations minus accepted"
> option in [§7.3.1](#731-consequence-for-fr-6) further than sampling loss alone would.

> **Gotcha: an empty array that stays empty produces no updates.** NT only sends changed values, so
> `RobotPosesAccepted` showed exactly **one** update — the retained empty value at subscribe time —
> across 25 seconds in which the system was actively rejecting poses at ~50 Hz. "Accepted count is
> zero" and "this topic has never reported" are therefore indistinguishable by update count alone.
>
> Two consequences: **never use update rate on these topics as a liveness signal**, and always
> distinguish *last value was empty* from *no value ever received*. Use a topic that actually changes
> — `ReceivingFrames`, `PoseObservations`, or `IsUpdating` — to establish liveness, then read the
> accepted/rejected arrays for content.

Corrections against what this document previously assumed:

- **`TagPoses` and `RejectedTagPoses` do not exist.** The accepted/rejected pair is
  `AprilTags` / `RejectedAprilTags` (and `RobotPosesAccepted` / `RobotPosesRejected`) — and
  critically they are **global, not per-camera**. See [§7.3.1](#731-consequence-for-fr-6); this
  changes a headline feature.
- **Signal 5 is `ReceivingFrames`, not `receivingFrames`**, and it lives under `Vision/`, not
  `RealOutputs/`. There is *also* a `RealOutputs/Vision/<loc>/sending frames` — lowercase, space
  included. Both exist and agree; prefer `ReceivingFrames`, which updates continuously while
  `sending frames` was observed updating once.
- The earlier note about "inconsistent casing" was itself based on a wrong key. The real
  inconsistency is between `ReceivingFrames` (PascalCase, `Vision/`) and `sending frames`
  (lowercase-with-space, `RealOutputs/`). The underlying point stands and is now better evidenced:
  **define these strings once, from a live dump, and never retype them.**

**Bonus source — NT client connection status, independent of robot code.** The NT server itself
publishes `/AdvantageKit/SystemStats/NTClients/<client name>@<n>/Connected`, plus `IPAddress` and
`RemotePort`, for every client. This is valuable because it works for instances the robot's Vision
subsystem knows nothing about — `northstar_center` and `northstar_power` (see
[§7.4](#74-mapping-device_id-to-camera-location)) — and needs no robot-code support.

> **Three gotchas, all measured — get these wrong and this source lies.**
>
> 1. **Entries persist after a client disconnects.** A probe found four entries of which only **one**
>    had `Connected=true`; the other three were dead clients. **Presence is not liveness** — always
>    read the `Connected` value, never infer from the key existing.
> 2. **`@<n>` increments per connection, and old entries are not removed.** One `device_id` therefore
>    accumulates *several* entries over a session — `northstar_webapp_spike@1`, `@2`, `@3` were all
>    present simultaneously. Resolve a device by taking entries whose name matches before the `@`,
>    then selecting the one with `Connected=true` (falling back to the highest index). Never assume
>    one entry per device.
> 3. **The index resets when the robot code restarts**, so it is not stable across a reboot and must
>    not be persisted or used as an identity.
>
> A consequence worth knowing separately: because each connection permanently adds four topics,
> **the total topic count grows over a session** — it drifted 528 → 532 → 536 purely from spike
> clients coming and going. Never treat a change in topic count as meaningful.

**Config topics come from the robot, not from Northstar.** With Northstar entirely stopped,
`/northstar_<loc>/config/*` remained fully populated — 15 topics each for `BCH`, `BCL`, `BL`, and
`BR` — while `/northstar_<loc>/output/*` and `/calibration/*` vanished with the process that
published them. Two implications:

- **The presence of a `config` subtree says nothing about whether that instance is running.** Only
  the `output` subtree does.
- The set of `config` subtrees is an **authoritative, robot-side list of the cameras the robot code
  expects** — independent of launchd and of the config-folder superset problem in FR-4b. Useful as a
  cross-check: an instance running on the Mac mini with no matching `config` subtree is misconfigured
  on one side or the other.

#### 7.3.1 Consequence for FR-6

**Largely resolved — the accepted side is available per camera after all.** The earlier claim that
acceptance is only aggregated was an artifact of inventorying an idle system: the relevant topic is
created lazily and had never been recorded.

`RealOutputs/Vision/<loc>/UpdatePoseCount` is a **per-camera cumulative counter of accepted pose
updates**. Confirmed by correlating it against the global arrays over an 18 s window with a tag in
view: it incremented from 30 to 34 exactly on the cycles where `AprilTags` and `RobotPosesAccepted`
went non-empty, and held steady across every rejection.

So the two halves of FR-6 sit differently:

| Half | Per camera? | Source |
| --- | --- | --- |
| **Accepted** | ✅ yes, exact | `UpdatePoseCount` delta over a rolling window |
| **Rejected** | ❌ not published | Global `RejectedAprilTags` / `RobotPosesRejected` only |

Two properties of `UpdatePoseCount` matter for the UI:

- It is **cumulative and monotonic**, so display a *rate* (delta over a window), never the raw value.
- It updates only when it changes — 5 updates in 18 s. As with the pose arrays, **a low update count
  does not mean the camera is dead.**

Remaining options for the rejected half, in order of preference:

1. **Add a per-camera `RejectedPoseCount` to 3061-lib**, symmetric with `UpdatePoseCount`. One
   integer per camera — negligible logging cost, and it makes FR-6 exact while removing struct
   decoding, `numTags` arithmetic, and cross-topic correlation from the app entirely. See
   [§7.5](#75-logging-cost-ask-for-counters-not-poses) for why a counter is also the *better* data
   structure here, not merely the cheaper one. **Strongly recommended.**
2. **Ship accepted-per-camera plus rejected-system-wide** in the meantime. Honest and available
   today. Label the system-wide figure clearly so it is not read as belonging to one camera's card.

A third option — deriving rejections from `PoseObservations` minus `UpdatePoseCount` — was considered
and **rejected**: it is lossy under polling, requires `numTags` arithmetic, and depends on correlating
topics that are not sample-synchronized. Not worth doing when option 1 is one integer.

This is [§13](#13-open-questions) item 8. Option 2 ships today either way, so nothing is blocked.

#### 7.3.2 Decoding `PoseObservation`

NT publishes struct schemas as text under `/AdvantageKit/.schema/struct:<Name>`, so the layout does
not need to be guessed. Retrieved live:

```
double timestamp; Pose3d cameraPose; double latencySecs; double averageAmbiguity;
double reprojectionError; int64 tagsSeenBitMap; int32 numTags;
double averageTagDistance; enum {SINGLE_TAG=0, MULTI_TAG=1} int32 type;
```

That sums to exactly **112 bytes** (8 + 56 + 8 + 8 + 8 + 8 + 4 + 8 + 4), independently confirming the
size measured from the wire.

Three fields carry the multi-tag information, and they are the reason array lengths must not be read
as tag counts:

- `numTags` — how many tags this single observation covers
- `tagsSeenBitMap` — which tag IDs, as an `int64` bitmap
- `type` — `SINGLE_TAG=0` or `MULTI_TAG=1`

**Field offsets, verified by decoding live data** (tight packing, little-endian, no padding):

| Offset | Field |
| --- | --- |
| 0 | `double timestamp` |
| 8 | `Pose3d cameraPose` (56 B) |
| 64 | `double latencySecs` |
| 72 | `double averageAmbiguity` |
| 80 | `double reprojectionError` |
| 88 | `int64 tagsSeenBitMap` |
| 96 | `int32 numTags` |
| 100 | `double averageTagDistance` |
| 108 | `int32 type` |

Decoding a live multi-tag capture yielded `numTags = 2`, `type = MULTI_TAG`, and a bitmap resolving
to tags **15 and 16** — matching the two tags physically in frame. So a minimal hand-rolled decoder
for this one struct is entirely practical; `StructDecoder.ts` is only needed if the app grows to
decode arbitrary types. Note `averageTagDistance` sits at an offset that is not 8-byte aligned;
`DataView` handles it, but a naive `Float64Array` view will not.

The `type` enum is itself the warning that both modes occur in normal operation: with two tags in
frame, **1078 observations were `MULTI_TAG` and zero were `SINGLE_TAG`.** A dashboard tested only on
single-tag frames will have silently conflated observations with tags.

### 7.4 Mapping `device_id` to camera location

Northstar's `device_id` is `northstar_<camera location>`; 3061-lib uses the bare camera location with
no prefix. The app therefore derives one from the other rather than maintaining a mapping table:

```
camera_location = device_id.removePrefix("northstar_")
```

The rule is confirmed against the live tree, which contained exactly `BR`, `BL`, `BCL`, and `BCH`:

| Config | Northstar `device_id` | Camera location | `Vision/` entry? | Why |
| --- | --- | --- | --- | --- |
| `configBR` | `northstar_BR` | `BR` | yes | |
| `configBL` | `northstar_BL` | `BL` | yes | |
| `configBCL` | `northstar_BCL` | `BCL` | yes | |
| `configBCH` | `northstar_BCH` | `BCH` | yes | |
| `configCenter` | `northstar_center` | `center` | **no** | Dropped as a requirement for this robot; config retained as a reference ([§2.1](#21-process-topology)) |
| `configPower` | `northstar_power` | — | **no** | Not a camera at all — a separate process publishing power metrics to `northstar_power` |

**The `Vision/` tree reflects what the robot code is configured for, not what Northstar could
provide.** A camera absent from the tree is a robot-side configuration choice, not a fault and not a
missing feature. `northstar_power` is a different kind of thing entirely: a metrics process, so it
should not be rendered as a camera with a broken status chain.

Consequences for the implementation:

- **An instance with no `Vision/` subtree is a normal state**, not missing data. The UI must say so
  plainly — "not tracked by robot code" — rather than showing an incomplete status chain.
- For those instances, `SystemStats/NTClients/<device_id>@<n>/Connected`
  ([§7.3](#73-robot-side-3061-lib-topics)) still supplies status signal 4, so they are not entirely
  dark. Use it as the **fallback** where there is no `Vision/` entry, and as corroboration elsewhere.
- **`northstar_power` should be presented separately** from the camera grid — it has no camera, no
  streams, and no meaningful status chain. Treat it as a host-metrics source feeding
  [§6.7](#67-system-health), not as a card in the camera grid.
- **Casing is preserved and is not uniform** (`BR` vs. `center`), so the derived location must be
  used verbatim — never normalized.

The app must **tolerate these keys being absent** — if the robot code is an older build or the robot
is off, those columns show "unknown" and the rest of the dashboard is unaffected.

---

### 7.5 Logging cost: ask for counters, not poses

Robot-side logging is not free, and the cost is wildly uneven. A `Pose3d` is 56 bytes and these are
logged as *arrays*, per cycle, at ~50 Hz; an `int` counter is 4 bytes and changes only when something
happens. Any request this project makes of 3061-lib should respect that difference.

**The dashboard does not need the pose arrays at all.** Everything FR-6 asks for can be served by two
monotonic integers per camera:

| Want | Expensive way | Cheap way |
| --- | --- | --- |
| Accepted rate per camera | Count `AprilTags` / `RobotPosesAccepted` entries per cycle | Δ`UpdatePoseCount` — **already exists** |
| Rejected rate per camera | Count `RejectedAprilTags` entries and divide out `numTags` | Δ`RejectedPoseCount` — **one integer, does not exist yet** |

So the entire robot-side ask reduces to: **add a per-camera `RejectedPoseCount`, symmetric with the
`UpdatePoseCount` already published.** One integer per camera, incremented where rejections are
already being counted. Nothing else is needed, and no additional pose logging is warranted.

**Counters are not merely cheaper here — they are the correct data structure for this consumer.**
A dashboard polls at roughly 1 Hz while the robot publishes at ~50 Hz, and the pose arrays are
per-cycle snapshots, so **any array-based count is lossy by construction**: whatever happens between
polls is invisible. A monotonic counter cannot be missed — the delta across a poll interval is exact
no matter how slowly the dashboard samples. Three problems disappear at once:

- No struct decoding, and no `numTags` arithmetic to convert tag counts into event counts.
- No correlation across topics that are [not sample-synchronized](#73-robot-side-3061-lib-topics).
- No sampling loss, so the accept/reject ratio is exact rather than indicative.

This supersedes options 2 and 3 in [§7.3.1](#731-consequence-for-fr-6), both of which existed only to
work around the absence of a rejected counter.

#### 7.5.1 Recommended 3061-lib changes

> **Status: changes 1 and 2 are implemented and verified** against a live run with
> `ENABLE_EXTRA_LOGGING` off. Measurements in [§7.5.2](#752-verification-of-the-counter-changes).

Grounded in [`Vision.java`](file:///Users/geoff/GitHub/3061-lib/src/main/java/frc/lib/team3061/vision/Vision.java)
as of this writing. All are `int` counters; **no additional `Pose3d` logging is proposed**, and
everything currently inside `if (ENABLE_EXTRA_LOGGING)` that emits pose arrays should stay there.

**1. Ungate `CyclesWithNoResults` — zero cost, highest value per effort.**

`this.cyclesWithNoResults[cameraIndex]` is *already maintained* as an `int` (incremented at ~line
265, reset at ~line 376) and *already logged* — but only inside the `ENABLE_EXTRA_LOGGING` block at
~line 425. Moving that single `Logger.recordOutput` outside the block adds **no new state, no new
computation, and one int per camera**.

It is arguably the single most useful per-camera health signal available: it answers "is this camera
producing results right now, and if not, for how long?" directly and numerically — better than
scraping `No frame received` out of a log file, and it works for cameras that are connected but
silent.

**2. Add `RejectedPoseCount`, symmetric with `UpdatePoseCount`.**

The accept branch (~line 333) increments and logs `updatePoseCount`; the `else` branch (~line 363)
counts nothing. Add a parallel `rejectedPoseCount[]` field and increment it there.

> **Gate the increment on eligibility.** `acceptPose` is false whenever `isEnabled` is false or the
> camera is not in `camerasToConsider` (~lines 306–318), so a naive counter would climb during normal
> disabled operation and whenever a camera is deliberately excluded. On a dashboard that reads as a
> flood of rejections when nothing is wrong — exactly the false alarm FR-28 exists to prevent. Count
> only observations that were *eligible* and failed on quality:
>
> ```java
> if (isEnabled && this.camerasToConsider.contains(cameraIndex)) {
>   this.rejectedPoseCount[cameraIndex]++;
>   Logger.recordOutput(
>       SUBSYSTEM_NAME + "/" + cameraLocation + "/RejectedPoseCount",
>       this.rejectedPoseCount[cameraIndex]);
> }
> ```
>
> The dashboard can already tell when a camera is excluded, because `IsEnabled` and
> `CamerasToConsider` are logged ungated (~lines 514–518).

Together with the existing `UpdatePoseCount`, this yields an exact per-camera accept/reject ratio
from two monotonic integers — closing FR-6 with no struct decoding and no `numTags` arithmetic.

**3. Optional: split the rejection reason into separate counters.**

`acceptPose` is currently one compound boolean, so a lumped `RejectedPoseCount` says *that* poses
were rejected but not *why*. Four more ints would make the dashboard diagnostic rather than merely
descriptive:

| Counter | Failing condition | What it tells the pit crew |
| --- | --- | --- |
| `RejectedAmbiguityCount` | `averageAmbiguity >= AMBIGUITY_THRESHOLD` (single-tag) | Tag too distant or too oblique |
| `RejectedReprojectionCount` | `reprojectionError >= REPROJECTION_ERROR_THRESHOLD` (multi-tag) | Calibration or tag-layout problem |
| `RejectedOffFieldCount` | `!poseIsOnField(...)` | Camera transform or calibration badly wrong |
| `RejectedRotationCount` | `!arePoseRotationsReasonable(...)` | Gyro and vision disagree |

This turns "12% rejected" into "12% rejected, all off-field," which points straight at a cause.
It is the most invasive of the three, since the compound boolean must be decomposed to know which
condition failed — reasonable as a follow-up rather than part of the first change.

**Not recommended:** ungating any of the `Pose3d[]` logging (`TagPoses`, `RejectedTagPoses`,
`CameraPoses`, `RobotPoses*`, `CameraAxes`). Those are the expensive ones, the dashboard does not
need them, and it should not subscribe to them.

#### 7.5.2 Verification of the counter changes

Measured over 75 s with `ENABLE_EXTRA_LOGGING` **off**, one camera (`BCH`) detecting and the other
three not running, then the tag removed from view partway through.

| Camera | `UpdatePoseCount` | `RejectedPoseCount` | `CyclesWithNoResults` |
| --- | --- | --- | --- |
| `BCH` (running, detecting) | ✅ 3852 | ✅ 458 | ✅ 0 while detecting |
| `BCL` / `BL` / `BR` (not running) | ❌ **absent** | ❌ **absent** | ✅ 7395 and climbing |

Three results:

1. **The accept/reject ratio works.** Deltas over the window gave a steady **91% accept rate** for
   `BCH`, from two integers — no struct decoding, no `numTags` arithmetic, no cross-topic
   correlation. FR-6 is satisfied per camera.
2. **`CyclesWithNoResults` is a real staleness signal.** On tag removal, `BCH`'s counters froze while
   `CyclesWithNoResults` climbed from 0 at **~50 per second**, matching the robot loop rate. So
   `cycles ÷ 50` converts to seconds — but derive that from the actual loop period rather than
   hard-coding 50.
3. **The critical one: for a camera that has never produced a pose, the counters do not exist at
   all** — they are *absent*, not zero. `CyclesWithNoResults` was the **only** per-camera signal
   present for the three cameras that were not running.

> **Design consequence of (3).** A camera that never came up is the single most important failure
> this dashboard must catch, and it is exactly the case where `UpdatePoseCount` and
> `RejectedPoseCount` are missing. **Never infer camera health from the presence of those counters,
> and never render their absence as an error** — treat absent as "nothing accepted or rejected yet,"
> which for a healthy camera at startup is simply true.
>
> `CyclesWithNoResults` is what covers that gap, and it does so for every camera the robot code knows
> about, from the first cycle. That is the strongest argument for having ungated it: it is the only
> per-camera signal that is present *before* anything has gone right, which is precisely when
> something has gone wrong.

**Corresponding rule for this app: subscribe narrowly.** The spike used a prefix subscription on `""`
purely for discovery, which pulled ~280 messages/second including every pose array. Production must
subscribe to an explicit topic list — the counters, the booleans, the FPS and config values — and
**never subscribe to the pose arrays**, which are the bulk of that traffic. That keeps the dashboard's
cost on the robot network negligible and makes on-field use ([§12](#12-deferred-features), item 6)
a realistic prospect rather than a bandwidth problem.

Note what the struct does **not** contain: any accepted/rejected flag. It carries the *inputs* to the
rejection decision — ambiguity, reprojection error, tag count, average distance — but not the
outcome. Re-deriving acceptance client-side would therefore mean reimplementing the robot's filter
rules in TypeScript, where they would silently drift out of agreement with the robot. **Do not do
this**; prefer option 1 above.

The schemas being published is still useful: if a later feature wants real decoded fields
(`averageAmbiguity` and `reprojectionError` would make a good per-camera quality indicator),
AdvantageScope's `StructDecoder.ts` can be vendored alongside `NT4.ts` on the same terms.

## 8. API Surface

Framework-agnostic, so the FastAPI fallback ([§5.1](#51-stack-nextjs)) could implement the same
contract unchanged.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/instances` | Discovered instances: key, discovery source, config, ports, PIDs, launchd state (when present), resolved log paths (when present) |
| `GET` | `/api/status` | Composite live status for all instances — the status chain plus vitals |
| `GET` | `/api/status/stream` | SSE: pushes the above on an interval / on change |
| `GET` | `/api/logs/{instance}/{out\|err}?lines=N` | Tail N lines from the end of the file |
| `GET` | `/api/logs/{instance}/{out\|err}/stream` | SSE: follow new lines |
| `GET` | `/api/logs/{instance}/{out\|err}/download` | Full log file download |
| `GET` | `/api/snapshot/{instance}/{apriltag\|objdetect}` | Single JPEG frame; connects, reads one frame, disconnects |
| `GET` | `/api/stream/{instance}/{apriltag\|objdetect}` | Proxied full-rate MJPEG |
| `GET` | `/api/calibrations` | Calibration files on disk + per-instance present/absent |
| `GET` | `/api/cabling` | USB link state per camera, joined to instances ([§6.10](#610-usb-link-diagnostics-whatcable)). `?refresh=1` forces past the cache |
| `GET` | `/api/cabling/history` | Link-state history and frame-loss correlation. `?hours=N` |
| `GET` | `/api/system` | Load, memory, uptime, thermal/power, disk free |
| `GET` | `/api/videos` | Recordings with parsed metadata |
| `GET` | `/api/videos/{filename}` | Recording download |

`{instance}` is the config basename (`configBL`), per FR-1a — stable across launchd and hand-run
environments.

**All endpoints are read-only.** No `POST`, `PUT`, or `DELETE` exists in v1 — this is an explicit
safety property, not an oversight.

### 8.1 Configuration

The app reads a small set of settings from the environment, so the same build runs on the Mac mini
and on a laptop with no code changes:

| Setting | Default | Notes |
| --- | --- | --- |
| NT server address | `10.30.61.2` | Set to `127.0.0.1` to point at a local WPILib simulation |
| Port | `5800` | [§3](#3-users-and-usage-context). **Use a different port in development** — the robot code binds 5800 locally when running in simulation |
| Discovery mode | `auto` | `launchd`, `process`, or `auto` (FR-1) |
| Repo root | derived | Used to resolve relative `calibration_folder` / `video_folder` paths |
| Expected-instance scan | off | The `cameras/robots/<profile>/` scan from FR-4b — **development only** |
| Startup grace window | 90s | FR-28 |
| WhatCable binary / cache / probing | `whatcable`, 30s, off | [§6.10](#610-usb-link-diagnostics-whatcable) |
| Frame-loss watch interval / trigger gap | 400ms, 3s | Event-triggered USB checks |
| Correlation window | 120s | How far before an episode a link change counts as preceding it |

The exact variable names are in [`webapp/README.md`](../webapp/README.md#settings); this table records
*what* is configurable and why, not the spelling.

---

## 9. User Interface

### 9.1 Dashboard (`/`) — the page that matters

A card per instance in a responsive grid. Each card carries:

- Instance name and `device_id`, plus a single dominant status color
- The status chain as a compact row of labeled indicators, first failure emphasized, spanning the
  full card width
- Vitals and detail text on the left, camera thumbnail on the right — the preview originally sat in
  a full-width row below everything, which left dead space either side of it and pushed the chain
  into a thin strip
- FPS, accepted/rejected rates and accept %, staleness, active `camera_id`, recording state
- An error-log badge when new error lines have appeared
- A note when the camera's USB link has degraded ([§6.10](#610-usb-link-diagnostics-whatcable))

Above the grid: a header strip with NT connection state, Mac mini load/thermal/disk, overall
"N of M instances healthy," and **time since power-on** — which, given [§2.8](#28-power-and-boot-behavior),
is often the single most useful number on the page. "Up 0:18, waiting for roboRIO" is a complete
and reassuring answer; the same state without the uptime reads as catastrophic failure.

Design constraints, given where this gets used:

- **Legible across a pit at a glance.** Large status indicators, high contrast, and no reliance on
  color alone — pair every color with a shape or label for colorblind users and for washed-out
  laptop screens under venue lighting.
- **Stable layout.** Cards must not reorder or resize as data updates; a student glancing back at the
  page should find the same camera in the same place.
- **Honest staleness.** Anything not currently live is visibly dimmed with an age, never rendered as
  though it were fresh.

### 9.2 Instance detail (`/instance/[instance]`)

Full log viewer (out and error, side by side or tabbed), the expanded video stream, complete NT
config and output values, calibration detail, and process/launchd detail.

### 9.3 Supporting pages

- **`/logs`** — instance picker plus stdout/stderr, live-following, with an error-count badge per
  instance. Added after the fact: the per-instance detail page buried the logs one click deep, and
  scrolling logs is the second most common reason to open this app.
- **`/cameras`** — calibration per instance, USB link quality, frame-loss correlation
  ([§6.10](#610-usb-link-diagnostics-whatcable)).
- **`/videos`** — recordings with parsed metadata.
- **`/system`** — Mac mini load, memory, disk, power and thermal.

These are secondary; the dashboard is the product.

---

## 10. Deployment

- **Port 5800**, chosen from the FRC team-use range (5800–5810) so on-field access remains possible
  later without change.
- **Own launchd job**, `org.team3061.northstar.webapp.plist`, with `RunAtLoad` and
  `KeepAlive`, running a `webapp.sh` that starts `next start -p 5800`. Its own stdout/stderr go to
  `logs/webappOut.log` / `logs/webappError.log`, matching the existing convention.
- **Deployment steps** (to be documented in the README alongside the existing Mac mini setup notes):
  install Node LTS, `npm ci`, `npm run build`, copy and `launchctl load` the plist.
- **Nice level:** the web app must not compete with the vision pipelines, which run at `nice -20`.
  Run it at default or lower priority.
- **Must come up unattended on every power-on**, with no manual step, since the Mac mini boots
  whenever the robot is switched on ([§2.8](#28-power-and-boot-behavior)). Follow the existing
  pattern and wrap `next start` in a `while true` shell loop under launchd, so a crash self-heals
  the same way the vision pipelines do.
- **launchd does not inherit your shell environment.** `PATH` is only
  `/usr/bin:/bin:/usr/sbin:/sbin`, which excludes both `/usr/local/bin` and `/opt/homebrew/bin`, so
  `node` and `npx` are not found. The failure is doubly confusing because hardcoding the path to
  `npx` does not fix it — `npx` has a `#!/usr/bin/env node` shebang that still resolves `node`
  through `PATH`. The launcher must locate node itself, export `PATH` for the workers Next spawns,
  and invoke Next's JS entry point with the resolved interpreter directly. Verified by running the
  launcher under `env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin"`.
- **macOS TCC blocks launchd agents from `~/Documents`** — resolved by moving the deployment to
  `~/Northstar`. TCC grants file access per executable: Terminal has it, a launchd agent does not and
  cannot prompt, so `node` got `EPERM` on files that plainly existed. The Python instances were
  unaffected only because `python3` had been granted at some point — a grant an OS update can reset,
  which made this a latent risk for the vision pipelines too, not just this app. Moving out of
  `~/Documents` removes the whole class of failure. `webapp/deploy/check-env.sh` distinguishes TCC
  from ordinary permission, ACL and quarantine problems.
- **Shell launchers derive their own paths** from `dirname "$0"` rather than hardcoding a repo
  location, so a future move needs no script edits — only the plists, which launchd requires to carry
  absolute paths.
- **`next start` requires a prior `next build`.** If `.next/` is missing, stale, or was corrupted by
  a power cut mid-build, the app silently fails to start and nobody notices until they need it.
  Never build on the robot right before an event; build, verify, and then power-cycle the Mac mini
  once to confirm the app comes back on its own. Add that power-cycle check to the pre-event
  checklist.
- **Resource ceiling:** the app should be measurably cheap when idle. Snapshot polling stops when no
  browser is connected, and the NT client is the only always-on background work.

**Development environment.** The app needs neither a robot nor the Mac mini to develop against. Run
3061-lib in WPILib simulation for the robot-side NT tree, and a real Northstar instance against a USB
camera on the same laptop for the Northstar side; point the app's NT server setting at `127.0.0.1`.
Setup and its two gotchas are in [§14.1](#141-test-fixture-simulation-plus-a-real-camera).

Because instances started by hand are discovered by the process scan (FR-1), `python3 __init__.py
--config …` in a terminal is fully supported — no LaunchAgents required on a development machine.
The only feature that degrades is log tailing, since a hand-run instance writes to the terminal
rather than to `logs/`. Two options, neither of which the app depends on:

- Accept it. The log panel reports itself unavailable (FR-4a); everything else works.
- Tee to the same paths the plists use, and the log features behave identically:

  ```bash
  python3 __init__.py --config cameras/robots/practice/configBL.json \
      > >(tee -a logs/configBLOut.log) 2> >(tee -a logs/configBLError.log)
  ```

The one genuinely Mac-mini-specific area is launchd state — last exit status, loaded-but-stopped
jobs — so plan on a recorded `launchctl print` fixture for testing that path off-robot.

---

## 11. Risks and Constraints

| Risk | Mitigation |
| --- | --- |
| MJPEG clients force per-frame JPEG encoding and steal CPU from vision | Snapshot-and-disconnect thumbnails; at most one full-rate stream open; visible indicator when a stream is attached ([§6.3](#63-video-streams)) |
| launchd job alive while Python crash-loops | Check the Python child process directly and detect restart loops (FR-3, FR-4) |
| Log files grow unbounded with no rotation | Always tail from the end; never read a whole file into memory. Log rotation itself is a separate operational issue worth addressing |
| Absolute paths in plists differ between machines and accounts | Read `StandardOutPath` / `StandardErrorPath` from launchd rather than assuming (FR-1) |
| Node toolchain adds a build step and a second runtime to the competition Mac mini | Documented FastAPI fallback ([§5.1](#51-stack-nextjs)); framework-agnostic API contract ([§8](#8-api-surface)) |
| Config schema duplicated between Python dataclasses and TypeScript types | Keep the TS types in one file, mirroring [`config/config.py`](../config/config.py), and note the coupling in both |
| Robot off / NT unreachable at the bench | Per-panel degradation and an explicit NT status indicator (FR-26, FR-27) |
| Adds an extra NT client on the robot's network | One shared server-side client regardless of browser count ([§5.2](#52-server-side-vs-browser-side-data-access)) |
| Unauthenticated app on the robot network | Acceptable for pit/bench use on an isolated network; **must be revisited before any on-field or routable exposure** |
| Dashboard shows all-red at every power-on and gets ignored as a false alarm | Startup grace window and an explicit *starting* state (FR-28) |
| Hard power cut corrupts app state or a mid-build `.next/` | App holds no persistent writable state (FR-29); build off-robot and verify with a power-cycle test ([§10](#10-deployment)) |
| Truncated logs and unfinalized recordings after power-off | Tolerate partial final lines and bad files (FR-30, FR-25a) |
| Dev uses the process-scan path while the robot uses the launchd path, so launchd-specific bugs never surface until an event | Merge both sources rather than branching on environment (FR-1); key instances identically in both (FR-1a); keep a recorded `launchctl print` fixture; smoke-test on the Mac mini before each event |
| Mac mini clock wrong or skewed — no NTP on the robot network | Compare local timestamps only against other local timestamps; timestamp NT data with `NT4.ts`'s RTT-synced `getServerTime_us()` and never mix the two ([§2.8](#28-power-and-boot-behavior)) |
| Vendored `NT4.ts` drifts from upstream, or local edits make future re-pulls painful | Keep it in one isolated directory, header intact, with origin and any modifications recorded; avoid gratuitous edits ([§7.1](#71-client)) |
| A hand-merge from 6328 changes a log string, NT topic name, or array layout the dashboard reads, and the reviewer has no reason to connect it to the web app | Make the coupling visible from the Northstar side, not just documented on the web app side ([§11.1](#111-coupling-to-northstar-internals)); fail loudly rather than silently on unrecognized input |

### 11.1 Coupling to Northstar internals

This app is a reader of another program's internals. It depends on Python source details, printed
log strings, and NT topic names — none of which are an API.

Because upstream changes are hand-merged, every one of these passes under a reviewer's eyes. The
problem is not that changes arrive unnoticed; it is that **noticing a change and recognizing its
consequence are different things**. Someone merging a vision improvement is thinking about detection
quality, not about a dashboard in a different language that greps for `"Running AprilTag pipeline
at"`. Documentation on the web app side is invisible at exactly the moment it matters.

| What the app depends on | Where it lives | Breaks if… |
| --- | --- | --- |
| `Running AprilTag pipeline at N fps`, `Running object detection pipeline at N fps` | [`__init__.py`](../__init__.py) | Wording or format changes — FPS parsing and log highlighting silently stop matching |
| `No frame received, waiting for capture` | [`__init__.py`](../__init__.py) | Status-chain signal 2 loses its main evidence |
| `No calibration found for camera <id>` / `Loaded calibration for camera <id> from <path>` | [`ConfigSource.py`](../config/ConfigSource.py) | Calibration status degrades to the filesystem check alone |
| `Starting Northstar...` as the restart banner | [`__init__.py`](../__init__.py) | Crash-loop detection (FR-4) and the boot divider (FR-12a) stop working |
| `%Y-%m-%d %H:%M:%S` log line prefix | [`__init__.py`](../__init__.py) | Boot-segment correlation (FR-12a) fails |
| Publishing gated on `local_config.has_calibration` | [`__init__.py`](../__init__.py) | If the gate moves, "connected but silent" stops meaning "uncalibrated" |
| MJPEG frames encoded only when `get_client_count() > 0` | [`StreamServer.py`](../output/StreamServer.py) | The entire snapshot-and-disconnect rationale ([§6.3](#63-video-streams)) changes |
| `/stream.mjpg` path and multipart boundary | [`StreamServer.py`](../output/StreamServer.py) | Snapshots and the stream proxy break |
| NT topic names under `/{device_id}/output` and `/config` | [`OutputPublisher.py`](../output/OutputPublisher.py), [`ConfigSource.py`](../config/ConfigSource.py) | Vitals and FPS go blank |
| `observations` array layout — variable-length, and the tail depends on `tagangle_enable` | [`OutputPublisher.py`](../output/OutputPublisher.py) | Tag-count decoding produces wrong numbers — **fails silently, unlike the others.** Must be walked field by field; length alone does not identify the shape |
| `power_metrics` array order and the 0–3 pressure encoding | [`OutputPublisher.py`](../output/OutputPublisher.py) | Thermal display is wrong, again silently |
| Config JSON keys | [`config.py`](../config/config.py), `cameras/robots/*/config*.json` | Discovery (FR-2) fails, loudly |
| `sanitize_camera_id` behavior and the `calibration<id>.yml` naming | [`config.py`](../config/config.py) | Calibration lookup misses |
| `<device_id>_<timestamp>[_event][_match][_raw].mkv` naming | [`VideoWriter.py`](../output/VideoWriter.py) | Recording metadata parsing degrades |
| `device_id` = `northstar_<camera location>` | Config JSONs + 3061-lib | Robot-side signal correlation breaks ([§7.4](#74-mapping-device_id-to-camera-location)) |

Three rules follow, in increasing order of how much they actually help:

- **Fail loudly, not silently.** Where a change would produce *wrong* numbers rather than missing
  ones — the `observations` layout and `power_metrics` encoding especially — validate the shape
  (expected length, plausible ranges) and show "unrecognized format" instead of a confident wrong
  value. A dashboard that lies is worse than one that admits ignorance.
- **Keep the coupling in one place.** All log patterns, topic names, and array layouts belong in a
  single constants/parsers module, not scattered through the UI, so this table stays mechanically
  checkable instead of requiring a code hunt.
- **Put the warning where the merger is looking.** Since merges are done by hand in the Python code,
  a one-line comment at each coupled site — `# NOTE: parsed by the web app (see claude/webAppDesign.md
  §11.1)` — reaches the reviewer at the moment of decision, which no amount of documentation over
  here will. Pair it with a `check-coupling` script that greps the Python sources for each expected
  literal and exits non-zero when one goes missing; run it after every upstream merge. Between them,
  a reworded `print` becomes a caught failure rather than a dashboard that quietly stops reporting
  FPS.

Worth considering separately: these items are string-scraped only because Northstar prints them
instead of publishing them. Since the fork is yours to change, publishing pipeline state to NT would
remove most of this table permanently — see deferred item 9 in [§12](#12-deferred-features). That is
the durable fix; the rules above are containment.

---

## 12. Deferred Features

Explicitly out of scope for v1, captured here so the v1 architecture does not preclude them. All of
these turn the app from read-only into a control surface, and each needs a confirmation step and a
guard against being triggered during a match.

1. **Restart / stop / start instances** — `launchctl kickstart -k gui/$UID/<label>` per instance,
   with confirmation. The single highest-value addition; today this requires a terminal.
2. **Trigger calibration** — start/stop calibration mode and capture frames by publishing to NT,
   replacing the current manual NT-poking workflow, with the port-7999 calibration stream embedded
   in the page.
3. **Edit NT config live** — `camera_id`, exposure, gain, white balance, `throttle_fps`,
   `is_recording`. Turns the app into a camera tuning tool. Requires publish capability from the NT
   client and careful thought about who owns these values versus the robot code.
4. **Edit `config<X>.json`** — with validation, plus the instance restart needed to apply it.
5. **Delete recordings** — to reclaim disk space between matches.
6. **On-field / match-time access** — already partly enabled by the port 5800 choice, but would need
   bandwidth discipline (no streams by default, minimal poll rates) and a security review.
7. **Multi-host view** — a single page covering both the competition and practice robots' Mac minis.
8. **Alerting** — push a notification when an instance goes unhealthy rather than requiring someone
   to be watching the page.
9. ~~**WhatCable integration**~~ — **implemented.** See
   [§6.10](#610-usb-link-diagnostics-whatcable).
10. **Publish pipeline state from Northstar structurally** — a change to *Northstar*, not this app:
   publish capture health, calibration status, and restart counts to NT instead of only printing
   them. This would delete most of [§11.1](#111-coupling-to-northstar-internals)'s fragile
   string-scraping and make the dashboard robust across upstream merges. Since the fork is ours to
   change, this is the durable fix rather than a workaround.

---

## 13. Open Questions

### Still open

1. **Rejection-ratio thresholds.** What accepted-vs-rejected ratio should read as a warning? The app
   currently warns below 50%, which is a guess. Needs a number from observed practice-match data.
2. **Startup grace window** (FR-28). The 90s default is a guess. Measure the real interval from
   Mac mini power-on to all signals established across a few cold boots, then set it from data with
   margin. Too short defeats the purpose; too long hides real failures.
3. **Snapshot cadence.** The 2.5s thumbnail refresh should be tuned against measured CPU impact on a
   fully loaded Mac mini, not chosen a priori.
4. **Log rotation.** The unbounded `logs/*.log` growth is a pre-existing problem this app makes
   visible rather than causes. Worth fixing separately (`newsyslog`, or truncation in the shell
   wrapper).
5. **Per-camera rejection *reasons*.** `RejectedPoseCount` says how many; it does not say why.
   Four more counters ([§7.5.1](#751-recommended-3061-lib-changes) item 3) would turn "9% rejected"
   into "9% rejected, all off-field", which points straight at a camera transform. The most valuable
   remaining robot-code change.
6. **Does the USB-2-fallback theory hold?** The instrumentation to answer it is built
   ([§6.10](#610-usb-link-diagnostics-whatcable)); the data is not in yet. Leave the app running
   through a practice session and read the correlation table.
7. **Cold-boot verification.** Nobody has yet power-cycled the Mac mini and confirmed the web app
   returns unattended. That is the only test that proves the deployment
   ([§10](#10-deployment)).

### Resolved

| # | Question | Outcome |
| --- | --- | --- |
| 1 | 3061-lib NT key paths | Measured against a live 536-topic dump. Several assumptions were wrong; corrected in [§7.3](#73-robot-side-3061-lib-topics) / [§7.4](#74-mapping-device_id-to-camera-location) |
| 2 | NT client viability | AdvantageScope's `NT4.ts` runs unmodified under bare Node 24 ([§14.3](#143-result)) |
| 3 | Node version on the Mac mini | Node ≥ 24 required and installed — `WebSocket` needs v22+, `CloseEvent` v23+ |
| 4 | Per-camera rejected poses | 3061-lib now publishes `RejectedPoseCount` and ungated `CyclesWithNoResults` ([§7.5.2](#752-verification-of-the-counter-changes)) |
| 5 | Multi-tag validation | Done. `RobotPoses*` counts observations, `*AprilTags` counts tags; the ratio is `numTags` |
| 6 | `ENABLE_EXTRA_LOGGING` gating | Not an issue — every measurement was taken with the flag **off**, so the documented topics are the competition baseline |
| 7 | Port 5800 collides in development | The robot sim binds 5800 locally; dev uses 5801, `start:sim` uses 5802 |
| 8 | WhatCable integration | Built ([§6.10](#610-usb-link-diagnostics-whatcable)), including event-triggered checks and frame-loss correlation |

---

## 14. NT Client Spike

**Status: run, and it paid for itself.** The spike lives in [`claude/spike/`](spike/) — a vendored
`NT4.ts`, one dependency, `dump-tree.ts` (topic inventory) and `watch-poses.ts` (peak values over a
window, for topics that only reveal themselves when a tag is actually visible). Results in
[§14.3](#143-result). Beyond confirming the client works, it corrected six wrong assumptions in this
document and surfaced two new open questions — none of which would have been found by reading code.

### 14.1 Test fixture: simulation plus a real camera

**The spike needs no robot, no Mac mini, and no mock.** 3061-lib runs in WPILib simulation on a
development laptop and publishes the same NT4 data it would on the robot, including the full
`/AdvantageKit/Vision/<camera location>/…` tree. Point the Node client at `localhost` instead of
`10.30.61.2` and everything else is identical.

This is strictly better than a hand-written fake server: real key strings, real types, real update
cadence, and no risk of the spike passing against a mock that is subtly wrong. **This turned out to
matter more than expected** — a mock built from this document's earlier assumptions would have
enshrined four wrong key names and passed every test.

Simulation covers the failure modes too, and more realistically than a mock would:

- **Server disappears / reconnects** — quit and relaunch the sim. This *is* the roboRIO-reboot case.
- **Late topic announcement** — start the Node client first, then the sim.
- **Topics stop updating** — disable the simulated robot, or stop a subsystem.
- **Server never present** — run the client with no sim at all.

Simulation does not produce the Northstar side of the tree
(`/{device_id}/output/fps_apriltags`, `observations`, `power_metrics`), but that side is equally easy
to stand up: **plug a USB camera into the development laptop and run a real Northstar instance
against the sim.** Set `server_ip` to `127.0.0.1` and `capture_impl` to `avfoundation` (or `default`)
in a scratch config JSON, and give it a `device_id` the robot code expects, such as `northstar_BL`.

Together, sim plus a real Northstar instance means **the entire web app — not just the NT spike — is
developable on a laptop with no robot and no Mac mini.** That is worth the setup cost on its own,
and it should be documented as the standard development environment.

Two setup traps, both worth knowing before losing an evening to them:

- **No calibration means no output topics.** In [`__init__.py`](../__init__.py), the FPS and
  observation publishing lives inside the `elif config.local_config.has_calibration:` branch. A
  laptop webcam with no `calibration<camera_id>.yml` will connect to NT and then publish *nothing*,
  which looks exactly like a broken NT client. Either calibrate the dev camera or copy an existing
  calibration to the right filename.
- **`camera_id` comes from NT, not the JSON.** It is published by the robot code under
  `/{device_id}/config/camera_id`, so the sim will supply whatever the real robot uses. For a laptop
  webcam it must be overridden by hand (via AdvantageScope or `ntcore`) to the ID the laptop's
  capture implementation expects.

Also worth running `northstar_power` in the mix: it deliberately has **no** corresponding `Vision/`
entry on the robot, which exercises the "instance with no robot-side signals" case from
[§7.4](#74-mapping-device_id-to-camera-location) that the UI must render as normal rather than as an
error.

### 14.2 Acceptance checklist

Items 1–5 and 7 are expected to pass on the strength of `NT4.ts`'s track record; run them anyway,
quickly, since they are the assumptions the whole app rests on. Items 6 and 8 are the ones actually
carrying risk — 6 because AdvantageScope runs this file in Electron's renderer rather than in bare
Node, and 8 because it is specific to this app.

1. **Connect and read** — ✅ **passed.** Negotiated `v4.1.networktables.first.wpi.edu`, opened the
   separate RTT socket, and `getServerTime_us()` returned a real offset rather than `null`, so
   server-time sync works. 536 topics announced via a single prefix subscription on `""`.
2. **Late announcement** — ✅ **passed.** Both test clients subscribed exactly once at startup and
   never again; after the server appeared, the full topic set was announced and data flowed, proving
   the client re-establishes subscriptions internally. Verified the count rather than assuming it:
   536 topics with Northstar stopped versus 542 with it running, the difference being exactly
   Northstar's own `output/*` and `calibration/*` publications.
3. **Types** — ✅ **passed, including the struct question.** `boolean`, `int`, `double`, `string`,
   `double[]`, `raw`, and `struct:…` all arrived correctly. As predicted, `NT4.ts` does not decode
   WPILib struct schemas (that is `StructDecoder.ts`), so struct topics arrive as `Uint8Array`. The
   byte-length ÷ struct-size approach is **confirmed and safe**, because both structs are
   fixed-layout per the published schema: `Pose3d` 56 B, `PoseObservation` 112 B.
   **Caveat: every capture used a single AprilTag.** Array *lengths* are correct in all cases, but
   any observed correspondence between observation count, pose count, and tag count is single-tag
   behavior and must not be generalized — see [§7.3](#73-robot-side-3061-lib-topics).
4. **Reconnection** — ✅ **passed.** Disconnect detected 0.7 s after the sim was quit; topic set
   cleared. The server stayed down for **238 s**. On relaunch the client reconnected on its own and
   data resumed at ~240 msgs/s, with no restart of the Node process and no re-subscribe. This was the
   most important test and it passed cleanly.
5. **Server not yet present** — ✅ **passed.** A second client was started from cold with no server
   at all, waited **220 s**, then connected and populated the moment the sim came up. CPU during the
   wait was **0.1–0.9%** (the client polls with a 250 ms-timeout `fetch` every ~350 ms), heap flat.
   No crash, no hang, no spin. This is the boot-race path and it works.
6. **Node runtime compatibility** — ✅ **passed, unmodified.** `NT4.ts` was copied verbatim from
   AdvantageScope and ran under **Node v24.17.0** with no shims, no bundler, and no `ws` package —
   executed directly via Node's native TypeScript type-stripping (the file uses no enums, namespaces,
   decorators, or parameter properties, so stripping suffices). Its `fetch`-based liveness probe and
   `AbortSignal.timeout` also work. Pin `engines.node >= 24`.
7. **Stability** — ⚠️ **partial.** Over a 420 s run spanning a connect, a 238 s outage, and a
   reconnect (46,674 messages), heap oscillated between 12.6 and 18.8 MB and ended at 13.6 MB; RSS
   settled at ~72 MB. No trend, no leaked handles, no growth across the disconnect. Encouraging but
   **not a substitute for the hour-long soak**, which should still be run before an event.
8. **Next.js integration** — only after 1–7 pass: confirm the singleton survives dev-mode
   double-instantiation and hot reload without opening duplicate connections, and that it initializes
   correctly under `next start`.

### 14.3 Result

**Items 1–7 passed** against 3061-lib in simulation, with a live Northstar instance (`configBCH`)
attached and a camera detecting a real AprilTag. Item 7 passed only over a 7-minute window rather
than the full hour. **Item 8 (Next.js singleton behavior) is not yet run** — it needs the app to
exist first.

`NT4.ts` runs unmodified under bare Node 24, survives a 238-second server outage, reconnects on its
own without re-subscribing, and starts cleanly with no server present. That settles the load-bearing
assumption behind the Next.js stack ([§5.1](#51-stack-nextjs)); the FastAPI fallback is no longer on
the critical path, though it remains documented.

**One defect found, and it needs handling in the app:** `getServerTime_us()` returns a stale offset
immediately after a reconnect — see the trap in [§7.1](#71-client). Everything else about the client
can be trusted as-is.

**What the spike changed in this document.** It was expected to answer one question and instead
rewrote a section:

| Assumption | Reality |
| --- | --- |
| `TagPoses` / `RejectedTagPoses`, per camera | Do not exist under those names. Accepted **is** per camera as `UpdatePoseCount`; rejected is system-wide ([§7.3.1](#731-consequence-for-fr-6)) |
| A topic absent from a full dump does not exist | **False.** AdvantageKit creates topics lazily on first record — 540 topics idle vs. 558 with a camera detecting. `UpdatePoseCount` was invisible until a pose was accepted |
| `RobotPoses*` and `*AprilTags` array lengths are interchangeable counts | **No.** `RobotPoses*` counts observations, `*AprilTags` counts tags; they differ by `numTags`. Identical only in single-tag frames |
| These topics can be compared instant-by-instant | **No.** They publish independently within a cycle; instantaneous reads are routinely inconsistent. Compare rolling windows |
| The measurements might reflect a debug-only build | **No** — `ENABLE_EXTRA_LOGGING` was **off** throughout, so everything documented is the competition baseline ([§7.3](#73-robot-side-3061-lib-topics)) |
| `receivingFrames` | `ReceivingFrames`, under `Vision/` not `RealOutputs/`; a separate `sending frames` (lowercase, with a space) also exists |
| Six camera locations including `center` | Only `BR`, `BL`, `BCL`, `BCH` — and the reason is a robot-code configuration choice, not a limitation ([§7.4](#74-mapping-device_id-to-camera-location)) |
| Robot-side data is limited to the four status signals | Also mirrors per-camera FPS, `CpuPower`/`GpuPower`/`AnePower`, and `ThermalPressure` as a readable string |
| No robot-independent source for NT connection status | `SystemStats/NTClients/<client>@<n>/Connected` covers **every** client, including instances the Vision subsystem does not track — but entries persist after disconnect, so presence is not liveness ([§7.3](#73-robot-side-3061-lib-topics)) |
| `/northstar_*/config/*` comes from Northstar | Published by the **robot**; survives Northstar being stopped entirely. Only the `output` subtree indicates a running instance |
| Update rate is a usable liveness signal on any topic | **No.** An empty array that stays empty produces exactly one update. `RobotPosesAccepted` updated once in 25 s while the system rejected poses at ~50 Hz ([§7.3](#73-robot-side-3061-lib-topics)) |
| Northstar waits when NT goes away | It **exits** on losing an established connection (though it *does* wait when the server was never there) — [§2.9](#29-northstar-depends-on-the-nt-server-being-up) |
| Server time can be trusted whenever it is non-null | Stale for a moment after every reconnect, i.e. exactly when the roboRIO reboots ([§7.1](#71-client)) |

Two of these were only visible with a camera **actually detecting a tag** — an idle system reports
zeros everywhere and looks identical to a broken one. Worth remembering when testing the dashboard
itself: a static scene proves very little.

**Then a second, subtler version of the same problem.** Every capture up to that point used exactly
one tag, which makes observation count, pose count, and tag count coincide — inviting one to be used
as a proxy for another. Re-running with two tags in frame showed `obs=1, numTags=2 →
rejectedPoses=1, rejTagPoses=2`: the two array families count **different things**, and the
single-tag 1:1 reading was an artifact throughout
([§7.3](#73-robot-side-3061-lib-topics)).

The pattern across all three rounds is the same, and worth stating as a rule for this project:
**a system observed in only one state teaches you the state, not the system.** Idle looked like
absent; single-tag looked like one-per-observation. Each round cost a couple of minutes of
measurement and each overturned a conclusion that had felt solid. Anything measured against a static
or simplified scene should be treated as provisional until seen under a realistic one.

The general lesson: **the NT tree is discoverable, so discover it rather than reasoning about it.**
Most of the rows above came from careful inference, and the inference was wrong. Check any future
assumption about robot-side data with `dump-tree.ts` or `watch-poses.ts` first — it takes seconds.
