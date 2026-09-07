# Moving the Mac mini deployment to `~/Northstar`

One-time migration off `~/Documents/GitHub/Northstar`.

## Why

macOS protects `~/Documents` with TCC, and access is granted **per executable**. Terminal has that
grant, so everything works interactively; a launchd agent has none and cannot prompt for one. The web
app surfaced this as `EPERM: operation not permitted` reading a file that plainly exists.

The vision pipelines were unaffected only because `python3` had been granted at some point. **That is
a grant a macOS update can reset** — at which point every camera would fail at once, at boot, with a
permission error nobody would think to look for. Moving out of `~/Documents` removes the risk for the
whole system, not just the dashboard.

## What already changed in the repo

- **All `cameras/robots/*/config*.sh` are now self-locating.** They derive the repo root from
  `dirname "$0"` instead of `cd ~/Documents/GitHub/Northstar`, and call
  `"$REPO"/reenumerate/reenumerate` rather than an absolute path. They need no edits if the repo ever
  moves again.
- **All `.plist` files point at `/Users/nnrobot/Northstar/…`** — for the vision agents, the perf
  monitor, the power instance, and the web app. launchd requires absolute paths, so these are the only
  files that name a location.
- `webapp/deploy/webapp.sh` was already self-locating.

## Steps on the Mac mini

```bash
# 1. Stop everything
for p in ~/Library/LaunchAgents/org.team3061.northstar.*.plist; do
  launchctl unload "$p"
done

# 2. Move the repo
mv ~/Documents/GitHub/Northstar ~/Northstar

# 3. Pull the updated scripts and plists
cd ~/Northstar && git pull

# 4. Re-copy the plists (they carry the new absolute paths) and reload
cp ~/Northstar/cameras/robots/competition/org.team3061.northstar.*.plist ~/Library/LaunchAgents/
cp ~/Northstar/webapp/deploy/org.team3061.northstar.webapp.plist ~/Library/LaunchAgents/
for p in ~/Library/LaunchAgents/org.team3061.northstar.*.plist; do
  launchctl load "$p"
done
```

### The virtualenv

It is referenced as `./venv` relative to the repo root, so it moves with the repo and normally needs
no rebuild. If you do recreate it, **name the interpreter explicitly**:

```bash
cd ~/Northstar
rm -rf venv
/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 -m venv venv
source venv/bin/activate
python -V                        # must print 3.12.x
pip install -r requirements.txt
```

> **Do not use bare `python3`.** On this machine Homebrew has put Python **3.14** first on `PATH`,
> and `python3 -m venv venv` fails with
> `Command '.../venv/bin/python3.14' -m ensurepip ... returned non-zero exit status 1`.
>
> Even if it succeeded it would be the wrong interpreter: this project needs **3.12.10**, the newest
> version Core ML Tools 8.1 supports, and every pin in `requirements.txt` — `coremltools==8.1`,
> `pyntcore==2025.1.1.0`, `pypylon==26.1.0` — is a 3.12-era wheel with no 3.14 build.
>
> The vision launchers are unaffected by the Homebrew Python, because `source ./venv/bin/activate`
> puts `venv/bin` ahead of everything else on `PATH`. The exposure is only when creating the venv or
> running Python outside it.

## Verify

```bash
# Optional: USB link diagnostics for the dashboard
brew install darrylmorley/whatcable/whatcable-cli
whatcable --json | head -c 120          # should print JSON

# TCC and PATH are both clean now?
bash ~/Northstar/webapp/deploy/check-env.sh
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" USER="$USER" \
    bash ~/Northstar/webapp/deploy/check-env.sh     # must also pass

# Agents loaded and running?
launchctl list | grep org.team3061.northstar

# Vision publishing, dashboard serving?
tail -f ~/Northstar/logs/configBCHOut.log
curl -s localhost:5800/api/status | head -c 200
```

Then **power-cycle the Mac mini once** and confirm everything returns unattended. That is the only
test that proves the deployment, and it is worth doing before an event rather than at one.

## Watch for

- **Stale log paths.** The old `~/Documents/.../logs/*.log` files stay behind; new output goes to
  `~/Northstar/logs/`. Delete the old tree once you are satisfied, so nobody tails a file that will
  never update again.
- **Anything outside this repo** that referenced the old path — shell aliases, VS Code workspaces,
  GitHub Desktop's clone location, `northstar_launch.scpt`.
- **Full Disk Access grants** previously added for `python3` or `node` can be removed once the move is
  confirmed; they are no longer doing anything.
