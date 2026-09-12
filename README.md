# Northstar — Huskie Robotics, FRC Team 3061

Team 3061's fork of [6328's Northstar](https://github.com/Mechanical-Advantage/Northstar), the
AprilTag tracking and object-detection coprocessor system, running on a Mac mini on the robot.

> Upstream's notice still applies to their code: it is provided for reference and **6328 does not
> support other teams using it**. If you are arriving here looking for a vision solution, use
> [PhotonVision](https://photonvision.org) or [Limelight](https://limelightvision.io).
>
> This fork carries local changes and is periodically hand-merged from upstream. Where this
> repository and upstream differ, **this repository is what runs on our robot** — do not assume
> upstream documentation describes our behaviour.

Object detection models are **not** in this repo (they are large). They live
[in Google Drive](https://drive.google.com/drive/folders/1l3Bx3FGBGiY3hcpaPtvrNNPMZHChCi9w) under an
AGPL-3.0 licence, alongside their licence file.

---

## Contents

- [How it runs](#how-it-runs) — the process model, in one picture
- [Bringing up a new Mac mini](#bringing-up-a-new-mac-mini) — the full checklist
- [Day-to-day operation](#day-to-day-operation)
- [Reference](#reference) — ports, cameras, robot configurations
- [Development notes](#development-notes) — the things that were hard to work out
- [Calibration](#calibration) — the target, the capture strategy, producing the intrinsics
- [History](#history) — superseded configurations, kept for context

Further reading in this repo:

| Document | What it covers |
| --- | --- |
| [`webapp/README.md`](webapp/README.md) | The status dashboard: running it, deploying it, troubleshooting |
| [`claude/webAppDesign.md`](claude/webAppDesign.md) | Design record — how Northstar behaves, every NT key, and *why* each decision was made. The most complete description of this system's runtime behaviour |
| [`claude/MOVE-TO-HOME.md`](claude/MOVE-TO-HOME.md) | One-time migration of the deployment off `~/Documents` |
| [`MacMiniPorts.md`](MacMiniPorts.md) | Physical port layout, front and back |

---

## How it runs

Northstar is **not one process**. It is one Python process per camera, each with its own config
file, NetworkTables device ID, and MJPEG stream ports:

```
launchd  →  cameras/robots/<profile>/config<X>.sh  →  python3 __init__.py --config config<X>.json
 (plist)      (while-true wrapper, re-enumerates USB)         (the actual pipeline)
```

Three consequences that catch people out:

- **The launchd PID is the shell wrapper, not Python.** The wrapper restarts Python in a `while true`
  loop, so launchd can report a service as running while Python crash-loops.
- **Northstar exits when it loses NetworkTables.** The wrapper restarts it. One restart per instance
  follows every roboRIO reboot or code redeploy — that is normal, not a fault.
- **stdout and stderr go to `logs/config<X>Out.log` and `logs/config<X>Error.log`**, appended
  indefinitely with no rotation.

Each instance publishes to `/{device_id}/output` and reads camera settings from `/{device_id}/config`
on the roboRIO's NetworkTables server. Full key list in
[`claude/webAppDesign.md` §7](claude/webAppDesign.md).

---

## Bringing up a new Mac mini

Ordered so each step only depends on earlier ones. Budget a couple of hours.

### 1. Hardware and macOS

- 2024 Mac mini (M-series). Ours is **MU9D3LL/A**.
- macOS Sequoia 15.7.1 *(spare unit runs macOS 26.2)*.
- **System Settings → Energy:**
  - ✅ *Start up automatically after a power failure* — this is what powers the mini on when the robot
    is switched on. Without it nothing else here matters.
  - ✅ *Prevent automatic sleeping when the display is off*

### 2. Network

The Mac mini needs a **static IP** so the dashboard is always at a known address and nothing depends
on the radio's DHCP lease.

**System Settings → Network → Ethernet → Details… → TCP/IP**

| Setting | Value |
| --- | --- |
| Configure IPv4 | **Manually** |
| IP Address | **`10.30.61.10`** |
| Subnet Mask | `255.255.255.0` |
| Router | `10.30.61.1` |

This follows the FRC `10.TE.AM.x` convention for team 3061: the radio is `.1`, the roboRIO is `.2`,
and `.10` sits below the radio's DHCP pool so it cannot collide with a leased address.

Wire it to the robot radio or the onboard switch — this is the interface the roboRIO is reached on,
not Wi-Fi.

Verify once the robot is powered:

```bash
ping -c 3 10.30.61.2         # the roboRIO
```

The dashboard is then at **`http://10.30.61.10:5800`**, and each camera's debug stream at
`http://10.30.61.10:<port>/stream.mjpg`.

> `server_ip` in every `cameras/robots/*/config*.json` must point at the roboRIO — `10.30.61.2`.
> Check this before an event: a config left at `127.0.0.1` from bench testing will start cleanly,
> connect to nothing, and look like a camera fault.

### 3. Accounts and permissions

- User account: `nnrobot`.
- **Passwordless sudo** — `power_metrics.py` shells out to `sudo powermetrics`:
  ```bash
  sudo visudo
  # add:
  nnrobot ALL=(ALL) NOPASSWD: ALL
  ```
  ([background](https://stackoverflow.com/questions/30731782/run-sudo-as-specific-user-without-password))
- **Full Disk Access** for `/bin/bash` — on macOS 26.2 add **Terminal** instead.
  ([why this is invisible in Settings](https://apple.stackexchange.com/questions/376474/enabling-bin-bash-on-catalina-invisible-to-system-preferences-security-p))

  > 🗑️ **Probably obsolete — verify, then delete this step.** It existed to work around TCC while the
  > repo lived in `~/Documents`. With the repo at `~/Northstar` nothing should need the grant. Confirm
  > on a fresh bring-up by leaving it out and checking that the launch agents still start, then remove
  > this bullet. Do not remove it on assumption: a silent TCC failure looks like a camera that never
  > comes up.

> ⚠️ **Clone the repo to `~/Northstar`, not `~/Documents`.** macOS protects `~/Documents` with TCC and
> grants access **per executable**. Terminal has that grant, so everything works interactively, but a
> launchd agent has none and cannot prompt for one — it simply gets `EPERM` on files that plainly
> exist. See [`claude/MOVE-TO-HOME.md`](claude/MOVE-TO-HOME.md).

### 4. Performance and noise reduction

```bash
sudo pmset -a sleep 0 displaysleep 0 disksleep 0
sudo mdutil -i off -a                       # disable Spotlight indexing
defaults write com.apple.Accessibility DifferentiateWithoutColor -int 1
defaults write com.apple.Accessibility ReduceMotionEnabled -int 1
defaults write com.apple.universalaccess reduceMotion -int 1
defaults write com.apple.universalaccess reduceTransparency -int 1
```

Also disable the screensaver.

### 5. Toolchain

| Tool | Notes |
| --- | --- |
| **Xcode** | Install and **accept the licence agreement** — builds fail cryptically otherwise |
| **Homebrew** | |
| **Python 3.12.10** | **From [python.org](https://www.python.org/downloads/), not Homebrew** — installs to `/Library/Frameworks/Python.framework/Versions/3.12/`, which is the path the venv step below uses. Newest version Core ML Tools 8.1 supports |
| **cmake 3.31.8** | Download the source and build per its README |
| **ffmpeg** | `brew install ffmpeg` — used for match recording |
| **opencv@4** | `brew install opencv@4` — needed to build `aruco_max_cpp` |
| **Pylon 25.09** | From Basler, for the cameras. Includes the pylon Viewer |
| **Node ≥ 24** | Only for the web dashboard. System-wide install, **not nvm** |
| **GitHub Desktop, VS Code** | Convenience |

> ⚠️ **Create the virtualenv with Python 3.12 explicitly.** Homebrew puts a newer `python3` (3.14 at
> time of writing) first on `PATH`, and `python3 -m venv venv` will either fail in `ensurepip` or
> silently build the wrong interpreter. Every pin in `requirements.txt` — `coremltools==8.1`,
> `pyntcore`, `pypylon` — is a 3.12-era wheel with no 3.14 build.
>
> ```bash
> cd ~/Northstar
> /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 -m venv venv
> source venv/bin/activate
> python -V                        # must print 3.12.x
> pip install -r requirements.txt
> ```
>
> The launcher scripts are unaffected by the Homebrew Python because `source ./venv/bin/activate`
> puts `venv/bin` first. The exposure is only when creating the venv or running Python outside it.

### 6. Build the native helpers

```bash
cd ~/Northstar/reenumerate && make          # USB port re-enumeration
cd ~/Northstar/ns-iokit-ctl && mkdir -p build && cd build && cmake .. && make
cd ~/Northstar/aruco_max_cpp && ./install.sh
```

Verify `reenumerate` before trusting it — see [Development notes](#reenumerate).

### 7. Cameras

1. Mount the cameras and connect them to the intended ports
   ([port map](#mac-mini-usb-ports-and-locations)).

2. **Focus each lens** using the camera focus target:
   - Focus against the target, then tighten the stop nut to hold it.
   - **Hot glue the stop nut.** Robot vibration will otherwise walk the lens out of focus over a
     session, and a slowly defocusing camera degrades tag detection long before anyone thinks to
     re-check focus.

3. **Exposure and gain are set from the roboRIO**, not on the camera. They are tunable over
   NetworkTables as `camera_exposure` and `camera_gain` under `/{device_id}/config`, so they can be
   adjusted for the venue without touching the Mac mini. Nothing needs configuring in pylon Viewer.

   pylon Viewer is still useful for confirming a camera enumerates and for eyeballing an image, but
   do not use its *Automatic Image Adjustment* to set operating values — they would be overwritten by
   the values NT publishes.

4. Note each camera's serial number — it is the `camera_id` the robot code publishes, and the
   filename of its calibration (`cameras/calibrations/calibration<serial>.yml`).

5. Calibrate ([Calibration](#calibration)).

### 8. Install the launch agents

```bash
cp ~/Northstar/cameras/robots/competition/org.team3061.northstar.*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/org.team3061.northstar.<name>.plist
```

Copy **only the plists for cameras this robot actually has** — the config folder is a superset.
([background](https://stackoverflow.com/questions/6442364/running-script-upon-login-in-mac-os-x/13372744#13372744))

The `.sh` launchers derive their own paths from their location, so they need no editing if the repo
moves. The `.plist` files carry absolute paths, because launchd requires them.

### 9. The web dashboard *(optional but recommended)*

See [`webapp/README.md`](webapp/README.md). Briefly:

```bash
cd ~/Northstar/webapp
npm ci && npm run build
cp deploy/org.team3061.northstar.webapp.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/org.team3061.northstar.webapp.plist
```

Then browse to `http://10.30.61.10:5800`.

### 10. Prove it

**Power-cycle the Mac mini and confirm everything returns unattended.** This is the only test that
proves the deployment, and it is worth doing before an event rather than at one.

---

## Day-to-day operation

```bash
# What is loaded and running?
launchctl list | grep org.team3061.northstar

# Watch an instance
tail -f ~/Northstar/logs/configBCHOut.log
tail -f ~/Northstar/logs/configBCHError.log

# Restart one instance
launchctl kickstart -k gui/$(id -u)/org.team3061.northstar.configBCH
```

Or open the dashboard, which shows all of the above at once plus stream previews, calibration status,
USB link quality and disk space.

**Camera debug streams** are served per instance on the ports in its config JSON (8000–8009,
9000–9001), at `http://10.30.61.10:<port>/stream.mjpg`. Note that frames are only encoded while a
client is attached, so leaving a stream open costs real CPU on a machine already running several
pipelines at `nice -20`.

---

## Reference

### Mac mini USB ports and locations

Port numbering below is ours, left to right as you look at the ports.
[`MacMiniPorts.md`](MacMiniPorts.md) has the physical layout including the non-USB ports.

| Port | Face | USB 3 location | USB 2 location |
| --- | --- | --- | --- |
| 0 | back | `0x01200000` | `0x01100000` |
| 1 | back | `0x00200000` | `0x00100000` |
| 2 | back | `0x03200000` | `0x03100000` |
| 3 | front | `0x02220000` | `0x02120000` |
| 4 | front | `0x02210000` | `0x02110000` |

A device reports the USB 3 location when it enumerates at USB 3 and the USB 2 location when it falls
back — which is why both are listed, and why a camera silently dropping to USB 2 is worth detecting.
The dashboard does exactly that; see [`webapp/README.md`](webapp/README.md#usb-link-diagnostics-whatcable).

### Camera hardware

| Model | Vendor ID | Product ID |
| --- | --- | --- |
| Basler daA1920-160um | `0x2676` | `0xba06` |
| Basler daA1280-54um / 54uc | `0x2676` | `0xba03` |

Serial number = `camera_id` in NetworkTables = the `calibration<serial>.yml` filename.

### 2026 competition robot

| Instance | Location | Pipeline | Stream ports | Capture | Deployed |
| --- | --- | --- | --- | --- | --- |
| `configBR` | `BR` | AprilTags | 8000 / 8001 | `pylon-cropped` | ✅ |
| `configBL` | `BL` | AprilTags | 8004 / 8005 | `pylon-cropped` | ✅ |
| `configBCL` | `BCL` | AprilTags | 8006 / 8007 | `pylon` | ✅ |
| `configBCH` | `BCH` | AprilTags | 8008 / 8009 | `pylon-cropped` | ✅ |
| `configPower` | — | Power metrics only | 9000 / 9001 | `pylon` | ✅ |
| `configCenter` | `center` | Object detection | 8002 / 8003 | `pylon-color` | ❌ [see below](#configcenter--retained-not-deployed) |

Camera assignments as last recorded:

| Instance | Model | Serial | Port |
| --- | --- | --- | --- |
| BL | daA1920-160um | 40708556 | 2 (`0x03200000`) |
| BR | daA1920-160um | 40708542 | 0 (`0x01200000`) |
| BCL | daA1280-54um | 24608727 | 3 (`0x02220000`) |
| BCH | daA1920-160um | 40777399 | 4 (`0x02210000`) |

#### `configCenter` — retained, not deployed

The centre camera was **dropped as a requirement** for the competition robot, so its plist is not
installed and no instance runs. Its files are kept deliberately:

- It is the only **colour** camera configuration (`pylon-color`) and the only **object detection**
  pipeline we have working end to end.
- Reconstructing that setup from scratch — capture implementation, model path, stream ports — would
  be avoidable work if object detection is wanted again.

Treat it as a working reference, not dead code. This is also the concrete reason the config folder is
a *superset* of what any given robot runs, and why instance discovery must come from the installed
launch agents rather than from a directory listing.

> **A config nothing runs gets no validation.** `configCenter.json` and both `practice/` configs had
> drifted and were missing required keys, so they would have raised `KeyError` in
> [`FileConfigSource.update()`](config/ConfigSource.py) before the camera was even opened. Nobody
> noticed because no agent loads them. If you revive one of these, load it once before trusting it.

> The authoritative source is always the robot itself: the dashboard's Cameras page shows the live
> `camera_id` per instance alongside whether its calibration exists. Bench testing with a substitute
> camera will show a different serial, which is expected and not a discrepancy.

### Network addressing

| Device | Address |
| --- | --- |
| Robot radio | `10.30.61.1` |
| roboRIO (NetworkTables server) | `10.30.61.2` |
| Mac mini (static) | `10.30.61.10` |

The Mac mini's address is set manually ([bring-up step 2](#2-network)). The roboRIO's address is what
every `server_ip` in `cameras/robots/*/config*.json` must point at, and the default the dashboard
uses unless `NORTHSTAR_NT_SERVER` says otherwise.

### NetworkTables

Northstar publishes `/{device_id}/output/*` and subscribes to `/{device_id}/config/*`. 3061-lib
publishes per-camera status under `/AdvantageKit/Vision/<location>/` and
`/AdvantageKit/RealOutputs/Vision/<location>/`.

`device_id` is `northstar_<camera location>`; 3061-lib uses the bare location.

The complete key list, with measured behaviour and the traps (counters that are *absent* rather than
zero, booleans that oscillate at frame rate, arrays that count different things), is in
[`claude/webAppDesign.md` §7](claude/webAppDesign.md).

---

## Development notes

The things that were genuinely hard to work out, kept because they will be needed again.

### reenumerate

Power-cycles a USB port so a camera re-enumerates. The launcher scripts call it before starting
Python, which is how a wedged camera gets recovered at startup.

```bash
# Find a device's location ID by vendor/product
./reenumerate -v 0x2676,0xba06
#   Found "Arducam OV2311 USB Camera" @ 0x00110000

# Re-enumerate that port
./reenumerate -v -l 0x00110000
```

### ns-iokit-ctl

Sets camera properties directly via IOKit:

```bash
./ns_iokit_ctl <vendorID> <productID> <locationID> <?> <property> <value>
./ns_iokit_ctl 0x0C45 0x6366 0x00110000 0 157 2
```

### Capture backends

`capture_impl` in each config JSON selects the backend. We use the **Pylon** variants
(`pylon`, `pylon-cropped`, `pylon-color`) for the Basler cameras.

Two earlier findings, kept because the code paths still exist:

- **`DefaultCapture`** passes the NT `camera_id` string straight to `cv2.VideoCapture`, which needs an
  integer. Converting it fixed capture. 6328 presumably never hit this because they use Basler
  cameras through Pylon.
- **`AVFoundationCapture`** wants a device id shaped `"0x110000:0c45:6366"` — location, vendor,
  product. **No leading zeros on the location, no `0x` on vendor or product, all lowercase.** Getting
  this exactly right took a while. Setting gain to 0 raised the frame rate from 16 to 50 fps.

### NetworkTables timing

Subscribed values are **not** available immediately after subscribing. `get_frame` needs a guard for
an empty `camera_id` and must return early rather than trying to open a camera with no id.

### Calibration is gated

Publishing lives inside `if config.local_config.has_calibration:` in `__init__.py`. A camera without
`cameras/calibrations/calibration<serial>.yml` connects to NetworkTables and then publishes
**nothing**, logging only once every five seconds. This looks exactly like a broken NT client and is
the most common silent failure — the dashboard has a dedicated indicator for it.

### Testing capture outside Northstar

```bash
./openpnp-capture-test              # list device IDs and format IDs
./openpnp-capture-test 0 8          # device 0, format 8 (1600x1200 @ 50 FPS)
```

### Throughput

System Information reports each camera drawing **4.48 W (896 mA)** and negotiating **5 Gb/s**. The
dashboard now reports negotiated link speed per camera continuously and records when it changes, so
a camera dropping to USB 2 is caught rather than inferred.

---

## Calibration

Camera calibration is a **two-step process**: Northstar captures the image set, and a separate
desktop app turns it into the intrinsics file.

The result lands at `cameras/calibrations/calibration<serial>.yml`, matched at runtime against
whatever `camera_id` NetworkTables reports for that instance. A camera without a matching file
connects and then publishes **nothing** — see
[Calibration is gated](#calibration-is-gated).

### The calibration target

> ⚠️ **Using the wrong board silently produces a wrong calibration.** The detector is configured for
> one specific board; a different dictionary or square size will either fail to detect or, worse,
> detect and produce plausible-looking garbage.

From [`calibration/CalibrationSession.py`](calibration/CalibrationSession.py):

| Property | Value |
| --- | --- |
| ArUco dictionary | `DICT_4X4_1000` |
| Board layout | **15 × 15** squares |
| Square length | **0.030 m** (30 mm) |
| Marker length | **0.020 m** (20 mm) |

```python
self._aruco_dict    = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_1000)
self._charuco_board = cv2.aruco.CharucoBoard((15, 15), 0.030, 0.020, self._aruco_dict)
```

We have a large printed ChArUco target matching this. **Measure a square on the physical board before
trusting it** — printing at anything other than 100% scale changes the real square length, and the
calibration silently inherits the error.

### Step 1 — capture images with Northstar

1. Set `/{device_id}/calibration/active` to **true** in NetworkTables.
2. A live preview appears on **port 7999** (`http://10.30.61.10:7999/stream.mjpg`). Detected markers
   and interpolated ChArUco corners are drawn on it, so use it to confirm the board is being seen.
3. Move the board through the frame — varied angles, distances and positions, including the corners
   of the image where distortion is greatest. See [Capture strategy](#capture-strategy) below for the
   specific poses to cover.
4. Frames are saved **automatically, roughly one per second**, to:

   ```
   calibrations/<timestamp>_<device_id>_<camera_id>/calibration_<n>.jpg
   ```

   Note this is the top-level `calibrations/` folder (gitignored), **not** `cameras/calibrations/`
   where the finished `.yml` files live.
5. Set `active` back to **false** when done.

> **`capture_flag` is vestigial.** The NT entry still exists and `CalibrationCommandSource` still
> implements `get_capture_flag()`, but `__init__.py` never calls it — every frame is saved while
> `active` is true. Ignore any older instructions that tell you to toggle it.

> **Ending calibration exits the instance.** When `active` goes false, Northstar destroys the capture
> device and calls `sys.exit(0)`; the `while true` wrapper then restarts it. That is by design, not a
> crash.

### Capture strategy

Where you put the board matters more than how many frames you collect. The following zone-based plan
is from a vendor guide ([CalibVision](https://calibvision.com), who sell ChArUco boards) — treat the
image counts as a sensible starting recipe rather than something we have measured on our cameras.

**Zone-based approach** *(recommended for most applications)*

| Zone | Images | What to do |
| --- | --- | --- |
| **Central region** | 4–5 | Board filling **40–70% of the frame**, perpendicular to the camera, at varied depths |
| **Edge regions** | 8–10 | Board positioned to place corners in **all four quadrants'** peripheral areas, with moderate tilt angles (**30–45°**) |
| **Extreme angles** | 4–6 | Strong tilt (**45–60°**), board rotated around various axes, partial occlusion intentional |
| **Close / far range** | 3–4 | Minimum and maximum working distances for your application |

That totals roughly **20–25 usable images**. The edge regions get the largest share deliberately:
distortion coefficients are determined almost entirely by what happens away from the optical centre,
and a set shot only head-on in the middle of the frame will look excellent in the solver and be wrong
everywhere it matters.

**Adapting this to Northstar's auto-capture.** Northstar saves a frame roughly **once per second** for
as long as `active` is true — there is no per-image trigger. So translate the table into *dwell time*:
**hold each pose still for 2–3 seconds**, then move to the next one. Two consequences follow:

- **Motion blur is the main risk here**, more so than in a triggered workflow. Blurred frames still get
  saved and still get fed to the solver. Move between poses deliberately and pause before counting.
- **Expect to discard frames.** Budget for more wall-clock time than the image counts suggest, and cull
  the obviously blurred or partially-detected frames before importing into Calib.

Watch the port-7999 preview while you work — it draws detected markers and interpolated corners, so
you can confirm each pose actually resolved before moving on.

> **Auto exposure/gain is already off.** The guide's advice to disable automatic camera settings during
> calibration is satisfied by construction: our exposure and gain are fixed values pushed from the
> roboRIO over NetworkTables, and they stay fixed through a match. See [Future work](#future-work) for
> the separate idea of using Pylon's auto function profile **once during on-field setup** to choose
> those fixed values — a one-time measurement, not a running control loop.

### Step 2 — produce the intrinsics

Feed the folder of captured images into the **Calib Camera Calibration** app:

- *Optimize Cameras* with the **OpenCV model**: `f, cx, cy, k1, k2, k3, p1, p2`.
- Export and save the result as `cameras/calibrations/calibration<serial>.yml`.

> 📝 **To document:** step-by-step navigation of the Calib app — importing the image folder, setting
> the board definition to match the table above, which optimisation settings we use, how to read the
> reported error, and how to export in the format Northstar expects. This is currently tribal
> knowledge and is the most likely thing to block someone doing calibration for the first time.

### What gets stored

```
camera_matrix  A = ⎡ fx  0  cx ⎤
                   ⎢ 0   fy cy ⎥
                   ⎣ 0   0   1 ⎦

distortion_coefficients = (k1, k2, p1, p2, k3)
```

Loaded by [`config/ConfigSource.py`](config/ConfigSource.py) whenever the reported `camera_id`
changes.

---

## History

Superseded configurations, kept because calibration files and older branches still refer to them.

<details>
<summary><strong>Fall 2025 practice bot</strong></summary>

Config files were numbered (`config0.json`…) before being named by position.

| Position | Model | Serial | Old config | Port |
| --- | --- | --- | --- | --- |
| FR | daA1920-160um | 40686739 | `config0` | 0 (`0x01200000`) |
| FL | daA1920-160um | 40708556 | `config2` | 2 (`0x03200000`) |
| BR | daA1920-160um | 40708542 | `config3` | 3 (`0x02220000`) |
| center *(really BL)* | daA1280-54uc | 25249734 | `config4` | 4 (`0x02210000`) |
| not installed | daA1920-160um | 40708569 | `config1` | 1 (`0x00200000`) |

Note: BR's calibration was recorded as `calibration1.json` when it should have been
`calibration3.json`.

Later practice configuration moved BL to serial 40708569 on port 1 and kept BR on 40708542.
</details>

<details>
<summary><strong>northstar_launch.scpt</strong> — removed</summary>

Instances were once started by an AppleScript run by hand from the terminal
(`osascript northstar_launch.scpt`), which did the `reenumerate` call before launching Python.

**Permanently replaced** by launchd agents plus the `config<X>.sh` wrappers, which re-enumerate and
restart automatically and need no one logged in. The file is gone; older notes and branches may still
mention it.
</details>

---

## Future work

- **Explore Pylon auto-exposure and auto-gain.** Exposure and gain are currently fixed values pushed
  from the roboRIO over NT, which means tuning them by hand for each venue.

  Basler cameras support an *auto function profile* that can be biased toward **minimising exposure
  time** against a target brightness. The motivation is **on-field setup at a competition**: it could
  automate that tuning, make it faster, and plausibly produce results as good or better than manual
  values chosen under time pressure.

  Minimising exposure time is the right bias for us twice over — shorter exposure means less motion
  blur on a moving robot, *and* it allows higher frame rates.

  > **Scope: a one-time measurement, not a running control loop.** The intended use is to let auto
  > converge **once** during on-field calibration, read the values it settles on, and then write those
  > back as the fixed exposure and gain — auto off again before the first match. Exposure and gain
  > must **not** move during a match: brightness changes from lighting, alliance-station LEDs or other
  > robots would change detection behaviour mid-run, and a pipeline whose parameters drift is one you
  > cannot reason about from the logs afterwards.
  >
  > So the open work is the capture-and-freeze mechanism — how to run auto on demand, read back the
  > converged values, and hand them to the existing NT-tunable path — not making the runtime adaptive.

  ([auto function profile](https://docs.baslerweb.com/gain-auto),
  [auto exposure](https://docs.baslerweb.com/exposure-auto))
- **Document the Calib Camera Calibration workflow** — see the note in
  [Calibration](#step-2--produce-the-intrinsics). The board parameters are written down now; the app
  navigation is not.
- **Train our own CoreML models.** We currently use the models 6328 provides.
  [Core ML Tools quickstart](https://apple.github.io/coremltools/docs-guides/source/introductory-quickstart.html)
  is a reasonable starting point.
- **Per-camera rejection reasons in 3061-lib.** `RejectedPoseCount` says how many poses were
  rejected; four more counters would say *why* (ambiguity, reprojection error, off-field, rotation),
  turning "9% rejected" into something that points at a cause. See
  [`claude/webAppDesign.md` §7.5.1](claude/webAppDesign.md).
- **Log rotation.** `logs/*.log` grow without bound across an entire event.
- **Publish pipeline state to NetworkTables** rather than only printing it, which would remove most
  of the dashboard's dependence on log strings.
