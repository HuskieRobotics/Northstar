#!/bin/bash

# Paths are derived from this script's own location, so the repo can live
# anywhere without editing every script and plist.
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

cd "$REPO";

# Timestamp every stderr line. `top` timestamps its own stdout samples, but
# anything it writes to stderr is bare. Without this there is no way to tell a
# live error from one left over from a previous season, since launchd appends
# to these files forever and never truncates them.
exec 3>&2
exec 2> >(while IFS= read -r line || [ -n "$line" ]; do
            printf '%s %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$line"
          done >&3)
top -l 0 -n 10;
