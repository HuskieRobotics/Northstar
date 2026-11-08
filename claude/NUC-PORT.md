# Porting Northstar to the ASUS NUC 15 Pro

**Status:** plan, not started. The Mac mini remains the competition coprocessor until the NUC
passes the acceptance tests in [Phase 10](#phase-10--acceptance-tests).

**Why:** a new base Mac mini now lists at $899, over FRC's $600 per-item limit. If the Mac minis we
already own are ruled illegal for 2027, or one fails and can't be replaced, we need a legal
coprocessor that already runs our code. The NUC is that fallback.

**Goal:** one codebase that runs on both macOS and Linux. Don't fork it. Every change below is
guarded by platform, so the Mac keeps working while the NUC is brought up, and either machine can go
on the robot.

---

## Contents

- [The hardware](#the-hardware)
- [Operating system: Ubuntu 24.04 LTS](#operating-system-ubuntu-2404-lts)
- [What is Mac-specific today](#what-is-mac-specific-today)
- [Phase 0 — Before you start](#phase-0--before-you-start)
- [Phase 1 — Hardware and BIOS](#phase-1--hardware-and-bios)
- [Phase 2 — Install and harden Ubuntu](#phase-2--install-and-harden-ubuntu)
- [Phase 3 — Toolchain and Python environment](#phase-3--toolchain-and-python-environment)
- [Phase 4 — Code changes for Linux](#phase-4--code-changes-for-linux)
- [Phase 5 — USB port map and camera reset](#phase-5--usb-port-map-and-camera-reset)
- [Phase 6 — systemd services](#phase-6--systemd-services)
- [Phase 7 — Web dashboard](#phase-7--web-dashboard)
- [Phase 8 — Object detection with OpenVINO](#phase-8--object-detection-with-openvino)
- [Phase 9 — Match recording with VA-API](#phase-9--match-recording-with-va-api)
- [Phase 10 — Acceptance tests](#phase-10--acceptance-tests)
- [Phase 11 — Putting it on the robot](#phase-11--putting-it-on-the-robot)
- [Open questions and risks](#open-questions-and-risks)
- [Appendix — file-by-file checklist](#appendix--file-by-file-checklist)

---

## The hardware

**ASUS NUC 15 Pro, RNUC15CRKU50000U.** This is the slim barebone kit: no RAM, no SSD, no OS.

| | |
| --- | --- |
| CPU | Intel Core Ultra 5 225H (Arrow Lake-H): 14 cores, 14 threads (4 P-cores, 8 E-cores, 2 low-power E-cores), up to 4.9 GHz, cTDP 40 W |
| GPU | Intel Arc 130T integrated. **Both SO-DIMM slots must be filled** for it to run as Arc; with a single DIMM it runs as plain Intel Graphics and is slower |
| NPU | Intel AI Boost NPU (in-tree Linux driver `intel_vpu`) |
| Memory | 2 × DDR5-5600 SO-DIMM, 48 GB max |
| Storage | M.2 2280 PCIe 5.0 x4 (main); M.2 2242 PCIe 4.0 x4 (second) |
| Front ports | 1 × USB 3.2 Gen2x2 Type-C, 2 × USB 3.2 Gen2 Type-A |
| Back ports | 2 × Thunderbolt 4 / USB4, 1 × USB 3.2 Gen2 Type-A, 1 × USB 2.0 Type-A, 2 × HDMI 2.1, 1 × 2.5 GbE (Intel I226), DC-in |
| Wireless | Intel Wi-Fi 7 (BE201/BE202) + Bluetooth 5.4. **Must be disabled for competition**; see [Phase 1](#phase-1--hardware-and-bios) |
| Power | **19 V DC**, 120 W adapter for this CPU. No wide-range DC input |
| Size | 117 × 112 × 37 mm, 0.51 kg |
| OS support | ASUS lists Windows 11, RHEL and **Ubuntu 24.04 LTS** |

That gives **six USB 3 ports** for 4–5 cameras. The back USB 2.0 port is not for cameras.

**How it compares with the M4 Mac mini.** In total CPU throughput, the 225H should be roughly in the
same class as the base M4 (4 P + 6 E cores). Each P-core is somewhat slower than an M4 P-core, but
there are more cores. That's an estimate from specs, not a benchmark; [Phase 10](#phase-10--acceptance-tests)
measures it. For reference, measured on the Mac during a match with recording off:

| Detector | CPU used by 4 camera processes | Mac CPU busy |
| --- | --- | --- |
| Generic OpenCV `ArucoFiducialDetector` | ~630 % | ~65 % |
| `aruco_max` with the Metal threshold | ~171 % | ~22 % |
| `aruco_max` CPU-only (what the NUC will run) | **not yet measured**; see [Phase 0](#phase-0--before-you-start) | |

---

## Operating system: Ubuntu 24.04 LTS

**Ubuntu is the right choice. Use Ubuntu Server 24.04 LTS with the HWE kernel.**

- **ASUS lists it as supported** for this NUC. Nothing else on the list is a better fit.
- **Its system Python is 3.12**, the version every pin in `requirements.txt` was chosen for
  (`pypylon`, `pyntcore`, `robotpy-wpimath`). On the Mac we work around Homebrew to get 3.12; on 24.04
  it's simply `python3`.
- **Basler, Intel and RobotPy all test on Ubuntu LTS.** That covers the pylon `.deb`, Intel's GPU, NPU
  and OpenVINO packages, and the manylinux wheels.
- **HWE kernel.** Arrow Lake is newer than 24.04's original 6.8 kernel. The hardware-enablement kernel
  (`linux-generic-hwe-24.04`) carries much newer GPU, NPU and power-management support. Always run it.
- **Server, not Desktop.** No GUI means nothing competes with the camera pipelines for CPU, and there's
  no desktop session to log into or to lock. The one GUI tool we use, pylon Viewer, can run over
  `ssh -X` from a laptop when needed. If that turns out to be too painful, install a minimal desktop
  later and leave the default boot target at `multi-user.target`.

Alternatives considered:

| OS | Why not |
| --- | --- |
| Ubuntu 26.04 LTS | Newer kernel and Intel stack out of the box, but not on ASUS's support list for this model, and its newer system Python would need a separately installed 3.12 (e.g. `uv`) to match the pins. Revisit when RobotPy's 2027 wheels settle |
| Debian / Fedora | Work fine, but are less tested by Basler and Intel, and nobody on the team gains anything from the difference |
| Windows 11 | No `SIGALRM` (the restart watchdog depends on it), no bash wrappers, and no good unattended-service story. A rewrite, not a port |

---

## What is Mac-specific today

Everything else is portable Python, OpenCV and pylon. 6328 ran Northstar on Linux coprocessors before
moving to Mac minis, so the core pipeline started out on Linux.

| Area | Today (macOS) | On the NUC (Linux) | Where | Effort |
| --- | --- | --- | --- | --- |
| AprilTag threshold | Metal GPU kernel in `aruco_max` | The CPU path that already exists in `aruco_max.h` | [aruco_max.h](../aruco_max_cpp/aruco_max.h), [setup.py](../aruco_max_cpp/setup.py) | Small |
| Building `aruco_max` | Homebrew OpenCV, `-ObjC++`, Metal framework | OpenCV 4.10 built from source (Ubuntu's 4.6 is too old) | [setup.py](../aruco_max_cpp/setup.py) | Small |
| Capture imports | `import AVFoundation` at module top, which fails on Linux | Guard the import; register `avfoundation` only on macOS | [Capture.py](../pipeline/Capture.py) | Trivial |
| Python deps | `coremltools`, `pyobjc-framework-AVFoundation` | Platform markers; add `openvino` on Linux | [requirements.txt](../requirements.txt) | Trivial |
| Object detection | CoreML (`.mlpackage`, Neural Engine) | OpenVINO on the Arc iGPU or NPU, re-exported from the `.pt` weights | [ObjectDetector.py](../pipeline/ObjectDetector.py), [objdetect_worker.py](../objdetect_worker.py) | Medium |
| Recording | `/opt/homebrew/bin/ffmpeg`, `hevc_videotoolbox` | `ffmpeg` from `PATH`, `hevc_vaapi` | [VideoWriter.py](../output/VideoWriter.py) | Small |
| USB camera reset | `reenumerate` (IOKit), by location ID | sysfs port disable/enable, by port path | `config*.sh`, new script | Small |
| Camera properties | `ns-iokit-ctl` (IOKit) | Not needed; only `AVFoundationCapture` uses it | — | None |
| Supervision | launchd `.plist` user agents | systemd template unit | `cameras/robots/*/*.plist` | Small |
| Power/thermal | `sudo powermetrics` | RAPL energy counters plus thermal zones in sysfs | [power_metrics.py](../power_metrics.py) | Small |
| Perf log | `top -l 0 -n 10` | `top -b` | [configPerfMonitor.sh](../cameras/robots/competition/configPerfMonitor.sh) | Trivial |
| Dashboard discovery | `launchctl list` / `print` | `systemctl` | [webapp/lib/discovery.ts](../webapp/lib/discovery.ts) | Medium |
| USB link diagnostics | WhatCable (macOS only) | `/sys/bus/usb/devices/*/speed` and `serial` | [webapp/lib/whatcable.ts](../webapp/lib/whatcable.ts) | Medium |
| Pylon grab thread priority | Ignored or best-effort on macOS | Real-time (`SCHED_FIFO`): needs `LimitRTPRIO` | systemd unit | Trivial |
| `nice -20` | Probably silently refused (non-root agent) | Works with `LimitNICE=-20` | systemd unit | Trivial |

Things that need **no** change: NetworkTables, pose estimation, calibration, the MJPEG servers, the
stderr timestamping block in the launchers (bash 5 runs it unchanged), the `SIGALRM` restart path, and
config JSON.

---

## Phase 0 — Before you start

1. **Run the CPU-only `aruco_max` test on the Mac.** This is the most useful single number. Build
   `aruco_max` with the CPU threshold path forced on (see the `NORTHSTAR_ARUCO_CPU` switch in
   [4.1](#41-aruco_max-cpu-threshold-path)), run a match or a practice session with recording off, and
   capture `top` as before.
   - **Near the ~171 % Metal figure:** the leaner detection pipeline was most of the gain, and the NUC
     will have plenty of headroom.
   - **Much higher:** the GPU threshold mattered. The fallback is an OpenCL threshold on the Arc iGPU
     (see [Open questions](#open-questions-and-risks)).
2. **Find the original YOLO training weights** (`.pt`) for any model we might use in 2027. CoreML
   models can't be converted back usefully; OpenVINO needs the `.pt`. Check the Google Drive folder
   linked from the README.
3. **Buy RAM and an SSD separately.** Use 2 × 8 GB DDR5-5600 SO-DIMMs (two are needed for Arc graphics)
   and a 512 GB–1 TB M.2 2280 NVMe. **Confirm with the FRC Q&A** that a barebone plus separately bought
   RAM and SSD is valued per item, or that the assembled total stays under $600. The barebone alone
   lists at about $515–525.
4. **Decide the robot power path** ([Phase 11](#phase-11--putting-it-on-the-robot)) early. It's the
   longest-lead hardware item.

---

## Phase 1 — Hardware and BIOS

1. Install both SO-DIMMs and the NVMe SSD. **Tighten the M.2 screw**, and put Kapton tape across the
   SO-DIMMs or fit a retention bracket, so impacts can't unseat them.
2. Enter the BIOS (F2 at power-on). Setting names below are what ASUS NUC BIOSes have used; they may
   be labeled slightly differently.
   - **Power → After Power Failure → Power On.** This is essential: it's what powers the NUC on when
     the robot is switched on. It's the equivalent of the Mac's *Start up automatically after a power
     failure*.
   - **Disable Wi-Fi and Bluetooth.** FRC rules don't allow wireless devices on the robot other than
     the radio. Disabling them in the BIOS is cleaner than relying on Linux, and inspectors may ask.
   - **Performance:** select the highest performance or power mode and the most aggressive fan
     profile available. Leave cTDP at the maximum (40 W).
   - **Boot:** NVMe first; disable network (PXE) boot so a dead SSD fails fast instead of hanging.
   - Secure Boot can stay on. Everything below uses signed kernels and in-tree drivers.
3. Note the BIOS version. Update it once on the bench if ASUS has a newer release, then leave it alone.

---

## Phase 2 — Install and harden Ubuntu

### 2.1 Install

- Ubuntu Server 24.04 LTS from USB. Hostname `northstar`, user **`nnrobot`** (same as the Mac).
- Use the whole disk, ext4, no LVM encryption (nobody can type a passphrase on a robot).
- Enable OpenSSH in the installer.
- Then:

  ```bash
  sudo apt update && sudo apt full-upgrade -y
  sudo apt install -y linux-generic-hwe-24.04
  sudo reboot
  uname -r          # confirm the HWE kernel is running
  ```

### 2.2 Robot-specific hardening

The robot cuts power at the end of every session, has no internet, and nobody sees a screen. Each
item below fixes a way a stock Ubuntu install fails in those conditions.

```bash
# 1. GRUB: after an unclean shutdown Ubuntu shows the boot menu and waits
#    FOREVER by default. On a robot that's every boot.
#    /etc/default/grub: set these lines
GRUB_TIMEOUT=0
GRUB_RECORDFAIL_TIMEOUT=0
GRUB_CMDLINE_LINUX_DEFAULT="usbcore.usbfs_memory_mb=1000 usbcore.autosuspend=-1 fsck.mode=auto fsck.repair=yes"
#    then:
sudo update-grub

# 2. Never sleep.
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# 3. Don't wait two minutes for a network that may not be up yet (the radio
#    can boot after us). Northstar retries NetworkTables on its own.
sudo systemctl mask systemd-networkd-wait-online.service

# 4. No surprise updates at an event.
sudo apt remove -y unattended-upgrades
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer
sudo snap refresh --hold || true

# 5. cloud-init slows boot and does nothing useful here.
sudo touch /etc/cloud/cloud-init.disabled

# 6. Cap the journal so it can't fill the disk.
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' | sudo tee /etc/systemd/journald.conf.d/size.conf

# 7. CPU: always prefer performance over power saving.
echo 'w /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference - - - - performance' \
  | sudo tee /etc/tmpfiles.d/northstar-epp.conf
```

Why each kernel parameter matters:

| Parameter | Why |
| --- | --- |
| `usbcore.usbfs_memory_mb=1000` | Linux allows only 16 MB of USB buffer memory **in total** by default. Basler requires raising it for multiple cameras; without it, grabs fail intermittently under load |
| `usbcore.autosuspend=-1` | Stops the kernel from suspending idle USB devices, which can drop a camera |
| `fsck.mode=auto fsck.repair=yes` | Repairs the filesystem automatically after a power cut instead of stopping for a person to answer a prompt |

Check after a reboot: `cat /sys/module/usbcore/parameters/usbfs_memory_mb` should print `1000`.

### 2.3 Network

Same address plan as the Mac. In `/etc/netplan/01-robot.yaml` (find the interface name with `ip link`):

```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    enp86s0:                 # replace with the real interface name
      dhcp4: false
      addresses: [10.30.61.10/24]
      routes:
        - to: default
          via: 10.30.61.1
      optional: true         # don't block boot if the radio isn't up yet
```

```bash
sudo chmod 600 /etc/netplan/01-robot.yaml
sudo netplan apply
ping -c 3 10.30.61.2
```

**Only one of the Mac or the NUC can be on the robot network at `.10`.** For bench testing both at
once, give the NUC `.11` temporarily.

### 2.4 Groups

```bash
sudo usermod -aG render,video,plugdev nnrobot     # GPU, NPU, and USB device access
```

---

## Phase 3 — Toolchain and Python environment

### 3.1 System packages

```bash
sudo apt install -y build-essential cmake ninja-build pkg-config git \
  python3-venv python3-dev ffmpeg usbutils lm-sensors linux-tools-generic
```

`linux-tools-generic` provides `turbostat`, used in Phase 10 to watch throttling.

### 3.2 Intel GPU, media and NPU stack

Arrow Lake needs newer Intel user-space drivers than 24.04 ships. Intel's client-GPU instructions for
24.04 use the `kobuk-team` PPA. Check Intel's current
[client GPU install guide](https://dgpu-docs.intel.com/driver/client/overview.html) before running
this, in case the package names have changed:

```bash
sudo add-apt-repository -y ppa:kobuk-team/intel-graphics
sudo apt install -y libze-intel-gpu1 libze1 intel-opencl-icd clinfo \
  intel-media-va-driver-non-free libvpl2 vainfo
clinfo | grep -i 'device name'      # should list the Arc GPU
vainfo | grep -i hevc               # should list HEVC encode (VAEntrypointEncSlice)
```

NPU (optional; only needed if object detection runs there): install the user-space driver `.deb`s from
[intel/linux-npu-driver releases](https://github.com/intel/linux-npu-driver/releases) for Ubuntu 24.04,
then check that `/dev/accel/accel0` exists.

### 3.3 Basler pylon

- Install the **pylon Camera Software Suite for Linux x86_64 (`.deb`)** from Basler. `pypylon` bundles
  its own runtime, but the `.deb` provides the **udev rules** (so cameras open without root) and
  **pylon Viewer**.
- Re-plug the cameras, or run `sudo udevadm control --reload && sudo udevadm trigger`.
- Check: `lsusb | grep 2676` lists each Basler camera.

### 3.4 OpenCV for building `aruco_max`

`wrapper.cpp` includes `opencv2/objdetect/aruco_dictionary.hpp`, which appeared in **OpenCV 4.7**.
Ubuntu 24.04's `libopencv-dev` is 4.6, so it won't compile. Build the four modules we need, at the same
version as the `opencv-python` pin:

```bash
cd ~ && git clone --depth 1 -b 4.10.0 https://github.com/opencv/opencv.git
cmake -S opencv -B opencv/build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DBUILD_LIST=core,imgproc,calib3d,objdetect,features2d,flann \
  -DOPENCV_GENERATE_PKGCONFIG=ON -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF \
  -DBUILD_opencv_python3=OFF -DBUILD_opencv_apps=OFF
cmake --build opencv/build
sudo cmake --install opencv/build && sudo ldconfig
```

This is the same arrangement as on the Mac: the extension links its own OpenCV, separate from the
pip `cv2`. They only exchange numpy buffers, so the two copies don't conflict.

### 3.5 Clone and create the venv

```bash
git clone https://github.com/<org>/Northstar.git ~/Northstar
cd ~/Northstar
python3 -m venv venv            # system python3 is 3.12; no Homebrew trap here
source venv/bin/activate
python -V                       # 3.12.x
pip install -r requirements.txt # after the requirements change in 4.3
cd aruco_max_cpp && ./install.sh
python -c "import aruco_max, pypylon, ntcore; print('ok')"
```

### 3.6 Node (dashboard only)

Node ≥ 24 system-wide from NodeSource's apt repository, not nvm (same reason as on the Mac:
supervised services don't get a login shell).

---

## Phase 4 — Code changes for Linux

Do these **on the Mac first**, in small PRs, and check that the Mac still runs a match after each one.
Then pull them onto the NUC. This keeps one codebase and finds Mac regressions while the Mac is still
the robot's computer.

### 4.1 `aruco_max` CPU threshold path

[aruco_max.h](../aruco_max_cpp/aruco_max.h) already has a CPU threshold branch; it's unreachable only
because `metalCtxPtr` is never null. Guard the Metal pieces by platform, and add an environment switch
so the Mac can run the CPU path for the [Phase 0](#phase-0--before-you-start) comparison:

```cpp
// top of file
#ifdef __APPLE__
#include "metal_context.h"
#endif

// class members
#ifdef __APPLE__
  mutable ArucoMaxMetalContext _metalCtx;
  bool _forceCpu = std::getenv("NORTHSTAR_ARUCO_CPU") != nullptr;
#endif

// detectImpl, step 2
#ifdef __APPLE__
  if (!_forceCpu) {
    uint8_t *outData = _metalCtx.adaptiveThreshold(
        bwimage.ptr<uint8_t>(), bwimage.cols, bwimage.rows,
        _params.boxFilterSize, _params.thres);
    thresImage = cv::Mat(bwimage.rows, bwimage.cols, CV_8UC1, outData);
  } else
#endif
  {
    cv::boxFilter(/* ...existing CPU path, unchanged... */);
  }
```

**Verify parity.** Run both paths on the Mac against the same recorded footage. The Metal kernel and
`cv::boxFilter` may round differently, so check that detected tag IDs and corners match (or differ
only sub-pixel) before trusting the CPU path in a match.

### 4.2 `aruco_max` build

Branch [setup.py](../aruco_max_cpp/setup.py) by platform:

```python
import sys

if sys.platform == "darwin":
    sources = [wrapper, metal_context]
    include_dirs = ["/opt/homebrew/include/opencv4", script_dir]
    library_dirs = ["/opt/homebrew/lib"]
    extra_link_args = ["-framework", "Metal", "-framework", "Foundation"]
    extra_compile_args = ["-O3", "-std=c++14", "-ObjC++"]
else:
    sources = [wrapper]
    include_dirs = ["/usr/local/include/opencv4", script_dir]
    library_dirs = ["/usr/local/lib"]
    extra_link_args = ["-Wl,-rpath,/usr/local/lib"]
    extra_compile_args = ["-O3", "-std=c++14", "-march=native"]
```

`-march=native` is safe because the extension is always built on the machine that runs it.

### 4.3 Requirements

```text
coremltools==8.1; sys_platform == "darwin"
pyobjc-framework-AVFoundation==10.3.2; sys_platform == "darwin"
openvino==<pin when Phase 8 starts>; sys_platform == "linux"
```

Everything else (`numpy`, `opencv-*`, `pillow`, `pyntcore`, `pypylon`, `robotpy-wpimath`) has
manylinux x86_64 wheels for 3.12. Check this with the `pip install` in 3.5.

### 4.4 Capture imports

[Capture.py](../pipeline/Capture.py) does `import AVFoundation` at module top, so **the whole
pipeline fails to import on Linux**. Guard it:

```python
if sys.platform == "darwin":
    import AVFoundation
```

and only add `"avfoundation": AVFoundationCapture` to `CAPTURE_IMPLS` on macOS. `PylonCapture` itself
needs no change; it selects cameras by serial number on every OS.

The grab-thread priorities (`GrabLoopThreadPriority = 85`, `InternalGrabEngineThreadPriority = 95`)
become real `SCHED_FIFO` priorities on Linux. They work only if the service allows real-time priority
(`LimitRTPRIO=99`, [Phase 6](#phase-6--systemd-services)). Check the error log after first start: if
pylon complains about thread priority, that limit is missing.

### 4.5 Object detection imports

`__init__.py` imports `objdetect_worker`, which imports `CoreMLObjectDetector`, which imports
`coremltools`. Make the detector selection platform-aware (CoreML on macOS, OpenVINO on Linux; see
[Phase 8](#phase-8--object-detection-with-openvino)), with the import inside the branch so neither
platform needs the other's package.

### 4.6 Recording

[VideoWriter.py](../output/VideoWriter.py) hardcodes `/opt/homebrew/bin/ffmpeg` and
`hevc_videotoolbox`. Look up `ffmpeg` with `shutil.which()` and pick the encoder arguments by
platform. Details are in [Phase 9](#phase-9--match-recording-with-va-api).

### 4.7 Power metrics

[power_metrics.py](../power_metrics.py) shells out to `sudo powermetrics`. Add a Linux branch that
returns the same four values, so the NT array `[cpu_mW, gpu_mW, ane_mW, pressureLevel]` and the
dashboard don't change:

| Field | Linux source |
| --- | --- |
| `cpu_power` | Package energy delta over 1 s from `/sys/class/powercap/intel-rapl:0/energy_uj` |
| `gpu_power` | `intel-rapl:0:1` (uncore) if present, else `0` |
| `ane_power` | `0` (no NPU power counter) |
| `pressure_level` | From the hottest `/sys/class/thermal/thermal_zone*/temp` and the CPU throttle counters: Nominal / Fair / Serious / Critical |

`energy_uj` is root-only by default. Rather than needing sudo, make it readable at boot:

```bash
echo 'z /sys/class/powercap/intel-rapl:0/energy_uj 0444 - - -' | sudo tee /etc/tmpfiles.d/northstar-rapl.conf
```

Linux doesn't need passwordless sudo for everything as the Mac does. The only sudo rule needed is for
the USB reset script in [Phase 5](#phase-5--usb-port-map-and-camera-reset).

### 4.8 Perf monitor

`configPerfMonitor.sh` runs macOS `top -l 0 -n 10`. On Linux, keep the timestamp block and use:

```bash
while true; do top -b -n 1 -o %CPU -w 200 | head -n 17; sleep 1; done
```

---

## Phase 5 — USB port map and camera reset

### 5.1 Map the ports

Linux names a USB port by **bus and port number** (`4-1` means bus 4, port 1), not by a location ID.
Each physical USB 3 port appears twice: once on a SuperSpeed bus and once on a High-Speed companion
bus. That's the same pairing as the Mac's USB 3 and USB 2 location IDs.

1. Run `lsusb -t` with nothing plugged in. Note **how many xHCI host controllers** there are and which
   buses belong to each. The Thunderbolt ports most likely sit on the CPU's integrated Thunderbolt/USB4
   controller, and the Type-A and front Type-C ports on a separate controller; confirm that here.
2. Plug a Basler camera into each port in turn and record its path from `lsusb -t`, or with
   `for d in /sys/bus/usb/devices/*-*; do [ -f $d/serial ] && echo "$d $(cat $d/serial) $(cat $d/speed)"; done`.
3. Write the results to a new `NUCPorts.md`, matching [MacMiniPorts.md](../MacMiniPorts.md): physical
   position, SuperSpeed path, High-Speed path, and host controller.

**Spread the cameras across host controllers**, for example 2 on Thunderbolt and 2 on Type-A. That's
the closest we can get to Basler's one-camera-per-controller advice, and it's probably why the Mac has
been stable. The busiest uncropped camera (BCL) should get the least-shared controller.

Basler cameras have USB Micro-B connectors, and the NUC has a mix of Type-A, Type-C and Thunderbolt
ports. **Check that every camera cable end matches the port it's assigned**, and use locking or
strain-relieved cables. A USB-C to Micro-B cable from the current Mac setup works in a Thunderbolt
port.

### 5.2 Reset script (replaces `reenumerate`)

Linux exposes a `disable` switch on each hub port. Turning it on and back off re-enumerates whatever
is on that port, which is what `reenumerate -l` does on the Mac. Install as
`/usr/local/sbin/ns-usb-port-cycle`, owned by root:

```bash
#!/bin/bash
# Usage: ns-usb-port-cycle <bus>-<port>    e.g. 4-1
# Disables and re-enables one root-hub port so the camera on it re-enumerates.
set -eu
[[ "${1:-}" =~ ^([0-9]+)-([0-9]+)$ ]] || { echo "usage: $0 <bus>-<port>" >&2; exit 2; }
bus=${BASH_REMATCH[1]}; port=${BASH_REMATCH[2]}
f="/sys/bus/usb/devices/${bus}-0:1.0/usb${bus}-port${port}/disable"
[ -w "$f" ] || { echo "no port control at $f" >&2; exit 1; }
echo 1 > "$f"; sleep 1; echo 0 > "$f"
```

```bash
sudo install -m 0755 ns-usb-port-cycle /usr/local/sbin/
echo 'nnrobot ALL=(root) NOPASSWD: /usr/local/sbin/ns-usb-port-cycle' | sudo tee /etc/sudoers.d/northstar
sudo chmod 440 /etc/sudoers.d/northstar
```

The script validates its argument because it runs as root.

Test it with a camera streaming: run the script on its port; the camera should drop off and come back
in `lsusb` within a few seconds. **If the `disable` file doesn't exist** for the root ports on this
machine, fall back to toggling the device's `authorized` attribute
(`/sys/bus/usb/devices/<path>/authorized`) or to `usbreset` from `usbutils`. Both act on the device
rather than the port, so they can't recover a camera that has fully dropped off the bus.

**One behavior difference.** On the Mac, `reenumerate` refuses to reset a device that another process
has open. The Linux port disable doesn't ask. That's fine as long as each launcher only resets **its
own** camera's port, which is how the scripts are written. Keep it that way.

### 5.3 Launchers

Keep one set of `config*.sh` files and branch on the OS around the reset:

```bash
while [ True ];
   do date +'%Y-%m-%d %H:%M:%S'
   case "$(uname)" in
     Darwin)
       "$REPO"/reenumerate/reenumerate -v -l 0x00100000; sleep 1
       "$REPO"/reenumerate/reenumerate -v -l 0x00200000 ;;
     Linux)
       sudo -n /usr/local/sbin/ns-usb-port-cycle 3-1; sleep 1   # High-Speed path
       sudo -n /usr/local/sbin/ns-usb-port-cycle 4-1 ;;         # SuperSpeed path
   esac
   sleep 1;
   date +'%Y-%m-%d %H:%M:%S'
   nice -20 python3 __init__.py --config cameras/robots/competition/configBCH.json;
   date +'%Y-%m-%d %H:%M:%S'
   sleep 1;
done
```

The port paths above are placeholders; use the ones from `NUCPorts.md`. Leave the stderr timestamp
block above the loop exactly as it is: `npm run check-coupling` enforces it.

---

## Phase 6 — systemd services

One **template unit** replaces the per-camera plists. Commit it as `deploy/linux/northstar@.service`
and install it to `/etc/systemd/system/`:

```ini
[Unit]
Description=Northstar %i
After=local-fs.target
# Deliberately not After=network-online.target: Northstar retries NetworkTables
# itself, and the robot radio can come up after us.

[Service]
User=nnrobot
Group=nnrobot
SupplementaryGroups=render video plugdev
WorkingDirectory=/home/nnrobot/Northstar
Environment=NORTHSTAR_PROFILE=competition
ExecStart=/bin/bash /home/nnrobot/Northstar/cameras/robots/${NORTHSTAR_PROFILE}/%i.sh
# Same log files as on the Mac, appended forever, which the dashboard depends on.
StandardOutput=append:/home/nnrobot/Northstar/logs/%iOut.log
StandardError=append:/home/nnrobot/Northstar/logs/%iError.log
Restart=always
RestartSec=1
# pylon's grab threads ask for real-time priority 85/95, and the launcher runs nice -20.
LimitRTPRIO=99
LimitNICE=-20
KillMode=control-group
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp ~/Northstar/deploy/linux/northstar@.service /etc/systemd/system/
sudo systemctl daemon-reload
# Enable only the cameras this robot has. Same rule as copying plists.
for i in configBR configBL configBCL configBCH configPower configPerfMonitor; do
  sudo systemctl enable --now "northstar@$i"
done
```

Differences from launchd to note in the README:

- **System services start at boot with nobody logged in.** launchd user agents need the `nnrobot`
  session. This is simpler, and there's no TCC.
- The wrapper's `while true` loop still restarts Python. `Restart=always` only matters if bash itself
  dies. As on the Mac, a running unit doesn't mean Python is healthy; the dashboard's process check
  still applies.
- Day-to-day commands:

  | macOS | Linux |
  | --- | --- |
  | `launchctl list \| grep org.team3061.northstar` | `systemctl list-units 'northstar@*'` |
  | `launchctl kickstart -k gui/$(id -u)/org.team3061.northstar.configBCH` | `sudo systemctl restart northstar@configBCH` |
  | `tail -f ~/Northstar/logs/configBCHOut.log` | unchanged |

The web dashboard gets its own `northstar-webapp.service` with the same shape: `ExecStart` is
`webapp/deploy/webapp.sh`, and it needs no RT or nice limits.

---

## Phase 7 — Web dashboard

| Change | File | Notes |
| --- | --- | --- |
| systemd discovery source alongside launchd | [lib/discovery.ts](../webapp/lib/discovery.ts), [lib/contract.ts](../webapp/lib/contract.ts) | `systemctl list-units --all --plain --no-legend 'northstar@*'` lists the units; `systemctl show northstar@X -p MainPID,ActiveState,SubState,ExecMainStatus` gives state. Log paths follow from the unit name, since the template fixes them. Keep the merge-by-config-basename rule (FR-1a), so instance keys are identical on both OSes |
| `ps` flags | [lib/discovery.ts](../webapp/lib/discovery.ts), [lib/system.ts](../webapp/lib/system.ts) | `ps -Ao pid=,ppid=,etime=,command=` already works on Linux procps. No change; test it |
| USB link diagnostics without WhatCable | [lib/whatcable.ts](../webapp/lib/whatcable.ts) | On Linux, read `/sys/bus/usb/devices/*/{serial,speed,idVendor,devpath}`. `speed` is `5000` for USB 3 and `480` when a camera has fallen back to USB 2, which is the condition the cameras page exists to catch. Return the same report shape so the UI and the frame-loss watcher don't change |
| Power panel | [lib/system.ts](../webapp/lib/system.ts) | Unchanged if 4.7 keeps the NT array shape. Show "NPU" instead of "ANE", or hide it |
| Page titles | [app/system/page.tsx](../webapp/app/system/page.tsx), various strings | "Mac mini" → the hostname, or "Coprocessor" |
| Launcher and env check | [deploy/webapp.sh](../webapp/deploy/webapp.sh), [deploy/check-env.sh](../webapp/deploy/check-env.sh) | `webapp.sh` already searches `/usr/bin/node`. Make the TCC and Homebrew messages in `check-env.sh` macOS-only |

---

## Phase 8 — Object detection with OpenVINO

`configCenter` isn't deployed, but object detection may matter in 2027. On the NUC it should run on the
**Arc iGPU** (or the NPU) through OpenVINO, which keeps it off the CPU cores AprilTags need. This is
the main reason an Intel machine was chosen over a Ryzen one.

1. **Export** from the original weights, on any machine with Ultralytics installed:

   ```bash
   yolo export model=best.pt format=openvino imgsz=640 half=True
   ```

   Copy the resulting `best_openvino_model/` folder to `models/` on the NUC.
2. **Benchmark** on the NUC before writing code. `benchmark_app` ships with the `openvino` pip
   package:

   ```bash
   benchmark_app -m models/best_openvino_model/best.xml -d GPU -hint latency
   benchmark_app -m models/best_openvino_model/best.xml -d NPU -hint latency
   ```

   Use whichever gives the lower latency with acceptable CPU use. Expect a few milliseconds for
   YOLO11n on the GPU.
3. **Add `OpenVINOObjectDetector`** in [ObjectDetector.py](../pipeline/ObjectDetector.py). The
   CoreML model returns post-NMS boxes as normalized `coordinates` (center x, center y, w, h) plus
   per-class `confidence`. The OpenVINO export returns the raw YOLO head instead: shape
   `(1, 4 + classes, 8400)`, in 640-pixel units. So the new detector:
   - reuses the existing letterbox code unchanged;
   - transposes the output, keeps rows above a confidence threshold, and runs `cv2.dnn.NMSBoxes`;
   - divides the boxes by 640 so they're in the same normalized form as CoreML's `coordinates`.

   From there the existing undistortion and angle code runs unchanged. Pull that shared tail out of
   `CoreMLObjectDetector.detect()` into the base class, so both detectors share one copy.
4. Add a config key `obj_detect_device` (`GPU`, `NPU` or `CPU`, default `GPU`). Point
   `obj_detect_model` at the `.xml` file.
5. **Check parity** with the CoreML model on the same recorded frames: same objects, similar
   confidences, and boxes within a few pixels.

If 2027 needs several detection cameras or a much bigger model, the fallback is a second coprocessor
(e.g. an Orin Nano) for detection only. Each camera is its own process talking to NetworkTables, so
splitting cameras across machines needs almost no code change.

---

## Phase 9 — Match recording with VA-API

Recording is nice-to-have, so do this last. The Arc iGPU has a hardware HEVC encoder, reached through
VA-API. The ffmpeg arguments differ from VideoToolbox:

| | macOS (today) | Linux |
| --- | --- | --- |
| Binary | `/opt/homebrew/bin/ffmpeg` | `ffmpeg` on `PATH` |
| Device | — | `-vaapi_device /dev/dri/renderD128` (before `-i`) |
| Filter | `-vf setpts=PTS-STARTPTS` | `-vf setpts=PTS-STARTPTS,format=nv12,hwupload` |
| Encoder | `-c:v hevc_videotoolbox` | `-c:v hevc_vaapi` |
| Pixel format | `-pix_fmt yuv420p` | Remove; `hwupload` handles it |
| Quality | `-q:v 50` (overlay) / `65` (raw); higher is better | `-qp 28` / `24`; **lower** is better. Starting points; tune by eye |

Notes:

- The `gray` and `rgb24` to `nv12` conversion runs on the CPU in ffmpeg, as it does on the Mac.
  Measure the cost with 4 cameras × 2 streams; if it's too high, record only the raw stream.
- Check the encoder by hand first:
  `ffmpeg -vaapi_device /dev/dri/renderD128 -f lavfi -i testsrc=size=1920x1200:rate=50 -t 5 -vf format=nv12,hwupload -c:v hevc_vaapi -qp 28 /tmp/t.mkv`
- `nnrobot` must be in the `render` group (Phase 2.4).

---

## Phase 10 — Acceptance tests

The NUC replaces the Mac on the robot only after all of these pass. Record the results in this file.

| # | Test | Pass criterion |
| --- | --- | --- |
| 1 | **Cold boot**: cut power at the wall (later, at the robot breaker) 20 times | All enabled units running and publishing to NT every time, with no keyboard or monitor. Boot-to-publishing time noted; it must be shorter than the roboRIO's |
| 2 | **Full camera load**: all 4 AprilTag cameras at competition settings, dashboard streams closed, 30 minutes | Every camera holds its configured FPS; the dashboard frame-loss watcher reports nothing; total CPU noted, with a target under 60 % |
| 3 | **Thermals**: test 2 inside the robot enclosure, or a box simulating it | `sudo turbostat --quiet --show PkgWatt,PkgTmp,Busy%,Bzy_MHz -i 5` shows no sustained throttling; package temperature noted |
| 4 | **USB links** | Every camera reports `speed` = `5000` throughout test 2 |
| 5 | **Hung or pulled camera**: unplug one camera mid-run, then plug it back in | That instance restarts and recovers on its own; the other cameras don't drop a frame |
| 6 | **Port cycle** | `ns-usb-port-cycle` on each camera's port brings the camera back each time |
| 7 | **Pose parity**: same robot, same field position, Mac vs NUC | The robot's pose estimates agree within normal noise; accepted and rejected pose counts are similar |
| 8 | **Live tuning** | Changing `camera_exposure` and `camera_gain` over NT applies without a restart (same as on the Mac) |
| 9 | **Dashboard** | Instances, logs, streams, cabling and system pages all populate |
| 10 | **Power brownout**: on the robot, with the DC-DC converter | Hard acceleration or pushing matches don't reboot the NUC |
| 11 | *(if used)* **Object detection** | `configCenter` at its target FPS, with CPU impact on the AprilTag cameras noted |
| 12 | *(if used)* **Recording** | 4 cameras recording for a full match with no extra frame loss |

---

## Phase 11 — Putting it on the robot

### Power

The NUC needs **19 V DC** and ships with a 120 W adapter. A robot battery is 12 V nominal and can sag to
around 7 V under load.

- Use a **buck-boost DC-DC converter with a regulated 19 V output** that holds up from about 7 V to
  14 V input. Rate it **at least 100 W**: the 225H at its 40 W cTDP plus turbo, plus about 4.5 W of USB
  bus power per camera (measured on the Mac), plus margin.
- Measure actual draw under test 2 with an inline meter and size the converter from that, not from the
  adapter label.
- Feed it from the PDH through an appropriately rated breaker, and check the current FRC rules on
  custom circuits and electronics placement.
- Use a DC barrel connector that matches the NUC's jack (check the supplied adapter's plug size) with
  strain relief. A barrel plug that backs out under vibration is the most likely single point of
  failure.

### Mounting

- Vibration-isolating mounts; nothing pressing on the case.
- Keep the fan intake clear and away from carpet debris. Consider a fine mesh filter.
- RAM and SSD retention from Phase 1.
- Label the USB ports on the case with the instance names from `NUCPorts.md`.

### Rules checklist

- [ ] FRC Q&A answer on how a barebone plus separately bought RAM and SSD is valued
- [ ] Wi-Fi and Bluetooth disabled in the BIOS; confirmed with `rfkill list` (nothing listed) and
  `ip link` (no `wl*` interface)
- [ ] Power wiring meets current custom-circuit rules

---

## Open questions and risks

| Question | Why it matters | How to settle it |
| --- | --- | --- |
| CPU cost of `aruco_max` without Metal | Decides whether the NUC has headroom or needs a GPU threshold | Phase 0 measurement on the Mac, then test 2 |
| If CPU-only is too slow: OpenCL threshold | The Arc iGPU can run the box filter and threshold, much as Metal does on the Mac. `cv::UMat` with `cv::boxFilter` uses OpenCL transparently, so it's a small change, but it shares the iGPU with object detection | Only if test 2 fails |
| How many xHCI controllers, and which ports share them | Basler recommends one camera per controller; we'll have at least two cameras per controller | Phase 5.1 `lsusb -t`, then test 2 |
| Does the root-hub port `disable` attribute exist on this machine | Determines whether camera reset is port-level (like the Mac) or device-level | Phase 5.2 |
| Arrow Lake support in the Intel media and compute packages | Needed for recording and OpenVINO on the GPU, not for AprilTags | Phase 3.2 `vainfo` / `clinfo` |
| 2027 control system | FRC's move to SystemCore for 2027 changes `pyntcore` and `robotpy-wpimath` versions, and possibly the NT server address, regardless of which coprocessor we use | Update the pins and `server_ip` when the 2027 RobotPy wheels ship; do it on both platforms at once |
| Ubuntu 24.04 vs RobotPy 2027 wheels | If 2027 wheels drop Python 3.12, we need a newer Python | Check when they ship; `uv` can provide any Python version in the venv without changing the OS |

---

## Appendix — file-by-file checklist

| File | Change | Phase |
| --- | --- | --- |
| `aruco_max_cpp/aruco_max.h` | `#ifdef __APPLE__` around Metal; `NORTHSTAR_ARUCO_CPU` switch | 4.1 |
| `aruco_max_cpp/setup.py` | Platform branch: sources, include/lib dirs, flags | 4.2 |
| `requirements.txt` | Platform markers; `openvino` on Linux | 4.3 |
| `pipeline/Capture.py` | Guard `import AVFoundation`; `avfoundation` impl macOS-only | 4.4 |
| `pipeline/ObjectDetector.py` | Shared post-processing; `OpenVINOObjectDetector` | 4.5, 8 |
| `objdetect_worker.py` | Choose detector by platform or config | 4.5, 8 |
| `config/config.py`, `config/ConfigSource.py` | Optional `obj_detect_device` key | 8 |
| `output/VideoWriter.py` | `shutil.which("ffmpeg")`; VA-API arguments on Linux | 4.6, 9 |
| `power_metrics.py` | Linux branch: RAPL + thermal | 4.7 |
| `cameras/robots/*/config*.sh` | OS `case` around the camera reset; Linux port paths | 5.3 |
| `cameras/robots/competition/configPerfMonitor.sh` | Linux `top -b` | 4.8 |
| `deploy/linux/northstar@.service` *(new)* | Template unit | 6 |
| `deploy/linux/northstar-webapp.service` *(new)* | Dashboard unit | 6 |
| `deploy/linux/ns-usb-port-cycle` *(new)* | Port reset script | 5.2 |
| `NUCPorts.md` *(new)* | Physical port → Linux bus path → controller | 5.1 |
| `webapp/lib/discovery.ts`, `webapp/lib/contract.ts` | systemd discovery source | 7 |
| `webapp/lib/whatcable.ts` | Linux sysfs backend with the same report shape | 7 |
| `webapp/lib/system.ts`, `webapp/app/system/page.tsx` | NPU label; host name instead of "Mac mini" | 7 |
| `webapp/deploy/check-env.sh` | macOS-only checks behind `uname` | 7 |
| `README.md` | "Bringing up a NUC" section next to the Mac one; Linux day-to-day commands | After Phase 10 |
| `claude/webAppDesign.md` | systemd alongside launchd in §2.2 and FR-1 | 7 |
