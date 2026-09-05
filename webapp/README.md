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

## After merging upstream Northstar changes

```bash
npm run check-coupling
```

This app parses Northstar's printed log strings, NetworkTables key names, and array layouts — none
of which are an API. Upstream 6328 changes are hand-merged, and a reviewer looking at a vision diff
has no reason to connect a reworded `print` to a TypeScript dashboard. The checker greps the Python
sources for every literal the app depends on and exits non-zero when one disappears.

Everything it checks is declared in one place: [`lib/contract.ts`](lib/contract.ts).

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
