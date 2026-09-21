#!/bin/bash

# Paths are derived from this script's own location, so the repo can live
# anywhere without editing every script and plist.
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

export GENICAM_CACHE_V3_1=/tmp/tmp2;
cd "$REPO";
source ./venv/bin/activate;

# Timestamp every stderr line. Python timestamps its own stdout prints, but
# stderr comes from OpenCV, Pylon and tracebacks, none of which do. Without a
# timestamp there is no way to tell a live error from one left over from a
# previous season, since launchd appends to these files forever and never
# truncates them.
exec 3>&2
exec 2> >(while IFS= read -r line || [ -n "$line" ]; do
            printf '%s %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$line"
          done >&3)
while [ True ];
   do date +'%Y-%m-%d %H:%M:%S'
   "$REPO"/reenumerate/reenumerate -v -l 0x00100000
   sleep 1;
   "$REPO"/reenumerate/reenumerate -v -l 0x00200000
   sleep 1;
   date +'%Y-%m-%d %H:%M:%S'
   nice -20 python3 __init__.py --config cameras/robots/competition/configCenter.json;
   date +'%Y-%m-%d %H:%M:%S'
   sleep 1;
done
