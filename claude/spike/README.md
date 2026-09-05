# NT4 Spike

Throwaway verification for the web app design ([../webAppDesign.md](../webAppDesign.md) §14).
Not part of the web app — delete once the app has its own NT client.

Answers two questions:

1. Does AdvantageScope's `NT4.ts` run unmodified under bare Node? (Yes — Node v24.17.0, no shims.)
2. What does 3061-lib *actually* publish? (See §7.3; several documented assumptions were wrong.)

## Run

With 3061-lib running in WPILib simulation, and optionally a Northstar instance pointed at it:

```bash
node dump-tree.ts  [serverAddr] [seconds]    # defaults: 127.0.0.1, 12
node watch-poses.ts [serverAddr] [seconds]   # defaults: 127.0.0.1, 20
```

`dump-tree` prints connection state, `getServerTime_us()`, every `Vision`/`northstar` topic with its
type, update count, and last value, plus the top-level roots.

`watch-poses` tracks peak values over a window for the pose-related topics. Use it with a tag
actually in view — **an idle system reports zeros everywhere and looks identical to a broken one**,
which is how several wrong assumptions survived the first pass.

Node's native TypeScript type-stripping runs the `.ts` files directly — no build step, no bundler.
Requires Node ≥ 24 (`WebSocket` needs v22+, `CloseEvent` v23+).

## Contents

- `vendor/NT4.ts` — copied verbatim from `AdvantageScope/src/hub/dataSources/nt4/NT4.ts`,
  BSD-licensed by Littleton Robotics / FRC 6328. Header intact, **unmodified**. Re-pull from
  upstream rather than editing in place.
- `dump-tree.ts` — topic inventory.
- `watch-poses.ts` — peak-value watcher for pose topics.
- `test-resilience.ts` — connect/disconnect/reconnect harness.
- `check-ntclients.ts` — proves `SystemStats/NTClients` entries persist after disconnect, so
  presence is not liveness.
- `snapshot-topics.ts` — every announced topic name + type, sorted. Diff idle vs. active.
- `watch-accept.ts` — correlates per-camera `UpdatePoseCount` against the global accepted/rejected
  arrays.
- `read-schema.ts` — reads published struct schemas from `/AdvantageKit/.schema/`.
- `decode-multitag.ts` — decodes `PoseObservation` structs (`numTags`, `tagsSeenBitMap`, `type`) and
  correlates them against the global tag-pose arrays. Run with 2+ tags in one frame.

## Measure under realistic conditions, not convenient ones

Two rounds of conclusions were overturned by testing in a more realistic state. Both took minutes.

**1. AdvantageKit creates topics lazily on first record.** 540 topics idle, 558 with one camera
detecting. `UpdatePoseCount` — the per-camera accepted-pose counter — is invisible until a pose is
accepted, so an idle dump will convince you it does not exist:

```bash
node snapshot-topics.ts > /tmp/idle.txt          # nothing detecting
node snapshot-topics.ts > /tmp/active.txt        # tag in view
comm -13 <(cut -f1 /tmp/idle.txt) <(cut -f1 /tmp/active.txt)
```

**2. Single-tag frames make different counts coincide.** With one tag, observations and tag poses are
1:1 and look interchangeable. With two tags in frame: `obs=1, numTags=2 → rejectedPoses=1,
rejTagPoses=2`. `RobotPoses*` counts observations; `*AprilTags` counts tags. Run
`decode-multitag.ts` with 2+ tags before trusting any count.

`test-resilience.ts` covers acceptance items 2, 4, 5 and 7 — subscribes once and never again, so any
data after a reconnect proves the client re-established subscriptions itself. Run two copies: one
started while the server is up (tests reconnect) and one started while it is down (tests the boot
race).

```bash
node test-resilience.ts [serverAddr] [seconds]   # defaults: 127.0.0.1, 300
```

## Results

Items 1–7 passed. Survived a 238 s outage, reconnected unaided, started cleanly with no server, and
held CPU at 0.1–0.9% while waiting. One defect: `getServerTime_us()` returns a **stale** offset right
after a reconnect (reported 1304.9 s of robot uptime for a just-restarted roboRIO). See §7.1.

Item 8 — Next.js singleton behavior under dev-mode double-instantiation and HMR — needs the app to
exist first. The hour-long soak for item 7 is also still owed.
