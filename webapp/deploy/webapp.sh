#!/bin/bash
#
# Northstar web app launcher. Mirrors the pattern used by the vision instances:
# a `while true` wrapper so a crash self-heals the same way theirs do.
#
# Requires a prior `npm ci && npm run build` — `next start` will not run without
# a valid .next/ directory. Build off-robot, then power-cycle the Mac mini once
# to confirm the app comes back on its own.

cd ~/Documents/GitHub/Northstar/webapp || exit 1

# roboRIO NT server. Set to 127.0.0.1 to develop against a WPILib simulation.
export NORTHSTAR_NT_SERVER=10.30.61.2
export NORTHSTAR_REPO_ROOT=~/Documents/GitHub/Northstar
export PORT=5800

# Deliberately NOT nice -20: the vision pipelines run at that priority and this
# dashboard must never compete with them.
while true; do
  date +'%Y-%m-%d %H:%M:%S'
  npx next start -p "$PORT"
  date +'%Y-%m-%d %H:%M:%S'
  sleep 2
done
