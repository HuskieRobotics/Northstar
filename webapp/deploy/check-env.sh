#!/bin/bash
#
# Diagnose "EPERM: operation not permitted" and PATH problems when the web app
# runs under launchd but works fine from a terminal.
#
# Run it BOTH ways and compare:
#   1. From Terminal:            bash deploy/check-env.sh
#   2. As launchd sees things:   env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
#                                    USER="$USER" bash deploy/check-env.sh
#
# If (1) passes and (2) fails on the READ test, it is macOS TCC privacy
# protection, not file permissions.

APP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP/.." && pwd)"
TARGET="$APP/node_modules/next/dist/bin/next"

echo "app:  $APP"
echo "repo: $REPO"
echo

# --- is the repo inside a TCC-protected folder? -----------------------------
case "$REPO" in
  "$HOME"/Documents/*|"$HOME"/Desktop/*|"$HOME"/Downloads/*|\
  "$HOME"/Documents|"$HOME"/Desktop|"$HOME"/Downloads)
    echo "⚠️  The repo is inside a macOS privacy-protected folder."
    echo "    ~/Documents, ~/Desktop and ~/Downloads are gated by TCC, and access is"
    echo "    granted PER EXECUTABLE. Terminal has that grant; a launchd agent does not,"
    echo "    and cannot prompt for it — so node gets EPERM while the same command works"
    echo "    interactively."
    PROTECTED=1
    ;;
  *) echo "✅ Repo is outside ~/Documents, ~/Desktop and ~/Downloads."; PROTECTED=0 ;;
esac
echo

# --- node -------------------------------------------------------------------
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && NODE="$c" && break
done
if [ -n "$NODE" ]; then
  echo "✅ node: $NODE ($("$NODE" --version 2>/dev/null))"
else
  echo "❌ node not found on PATH=$PATH"
fi
echo

# --- ownership / ACLs / quarantine (rules out non-TCC causes) ---------------
if [ -e "$TARGET" ]; then
  echo "target exists: $TARGET"
  echo "  owner/mode: $(stat -f '%Su:%Sg %Sp' "$TARGET")"
  echo "  running as: $(id -un) (uid $(id -u))"
  acl=$(ls -le "$TARGET" | grep -c ' [0-9]: ')
  echo "  ACL entries: $acl  $( [ "$acl" -gt 0 ] && echo '<- non-zero: inspect with ls -le' )"
  xattr=$(xattr "$TARGET" 2>/dev/null | tr '\n' ' ')
  echo "  xattrs: ${xattr:-none}"
  case "$xattr" in *quarantine*) echo "  ⚠️  quarantined — xattr -dr com.apple.quarantine \"$REPO\"";; esac
else
  echo "❌ target missing: $TARGET   (run 'npm ci' in $APP)"
fi
echo

# --- the actual read test ---------------------------------------------------
if [ -e "$TARGET" ]; then
  if head -c 1 "$TARGET" >/dev/null 2>&1; then
    echo "✅ READ OK — this context can read the app files."
  else
    echo "❌ READ DENIED (EPERM) — this context cannot read the app files."
    [ "$PROTECTED" = 1 ] && cat <<'EOF'

   This is TCC, not file permissions. Two fixes:

   A. Move the repo out of ~/Documents  (recommended for a robot)
        mv ~/Documents/GitHub/Northstar ~/Northstar
      then update the paths in every plist and config*.sh, and reload the agents.
      This removes the whole class of failure permanently — including for the
      vision instances, which currently depend on a grant an OS update could reset.

   B. Grant Full Disk Access to the node binary
        System Settings > Privacy & Security > Full Disk Access > +
        Press Cmd+Shift+G and enter the node path printed above.
      Faster, but the grant is tied to that binary and a node upgrade can reset it.
EOF
  fi
fi
