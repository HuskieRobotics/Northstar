#!/bin/bash
#
# Northstar web app launcher. Mirrors the pattern used by the vision instances:
# a `while true` wrapper so a crash self-heals the same way theirs do.
#
# ---------------------------------------------------------------------------
# launchd does NOT run your login shell, so ~/.zshrc and ~/.zprofile are never
# sourced and PATH is only:
#
#     /usr/bin:/bin:/usr/sbin:/sbin
#
# Node installs to /usr/local/bin (official installer) or /opt/homebrew/bin
# (Homebrew), neither of which is on that list. That produces two confusing
# errors in the log, in this order:
#
#     npx: command not found                  <- npx itself is not on PATH
#     env: node: No such file or directory    <- npx's #!/usr/bin/env node shebang
#
# The second one appears even after hardcoding the full path to npx, because the
# shebang still resolves `node` through PATH. So we find node ourselves, export
# PATH for the worker processes Next spawns, and invoke Next's JS entry point
# directly rather than going through npx.
# ---------------------------------------------------------------------------

# Derive paths from this script's own location rather than hardcoding them, so
# the same file works on the Mac mini and on a developer checkout.
APP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP/.." && pwd)"

log() { echo "$(date +'%Y-%m-%d %H:%M:%S') webapp: $*"; }

# --- locate node ------------------------------------------------------------
NODE=""
for candidate in \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  [ -x "$candidate" ] && NODE="$candidate" && break
done

# nvm keeps node under a versioned path and is a shell function, so it is a poor
# fit for unattended boot. Support it as a last resort, newest version first.
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE=$(find "$HOME/.nvm/versions/node" -maxdepth 2 -name node -type f -perm -u+x 2>/dev/null | sort -V | tail -1)
fi

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  log "FATAL: could not find a node binary."
  log "  launchd PATH is minimal and does not include /usr/local/bin or /opt/homebrew/bin."
  log "  Run 'which node' in a terminal and add that directory to the loop above."
  exit 1
fi

# Export so Next's spawned workers can find node too — this is not optional.
export PATH="$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:$PATH"
log "using node $("$NODE" --version) at $NODE"

# --- preflight --------------------------------------------------------------
cd "$APP" || { log "FATAL: $APP not found"; exit 1; }

if [ ! -d "$APP/.next" ]; then
  log "FATAL: no .next/ build output. Run 'npm ci && npm run build' first."
  log "  'next start' cannot run without it, and would fail silently at every boot."
  exit 1
fi

# --- settings ---------------------------------------------------------------
# roboRIO NT server. Set to 127.0.0.1 to develop against a WPILib simulation.
export NORTHSTAR_NT_SERVER=${NORTHSTAR_NT_SERVER:-10.30.61.2}
export NORTHSTAR_REPO_ROOT="$REPO"
export PORT=${PORT:-5800}

# Next's own entry point, invoked directly with the resolved interpreter so no
# `#!/usr/bin/env node` shebang has to be resolved through PATH.
NEXT_BIN="$APP/node_modules/next/dist/bin/next"
if [ ! -f "$NEXT_BIN" ]; then
  log "FATAL: $NEXT_BIN missing. Run 'npm ci' in $APP."
  exit 1
fi

# Deliberately NOT nice -20: the vision pipelines run at that priority and this
# dashboard must never compete with them.
while true; do
  log "starting next on port $PORT"
  "$NODE" "$NEXT_BIN" start -p "$PORT"
  log "next exited ($?) — restarting in 2s"
  sleep 2
done
