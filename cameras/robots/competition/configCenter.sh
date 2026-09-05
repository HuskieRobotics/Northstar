#!/bin/bash

# Paths are derived from this script's own location, so the repo can live
# anywhere without editing every script and plist.
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

export GENICAM_CACHE_V3_1=/tmp/tmp2;
cd "$REPO";
source ./venv/bin/activate;
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
