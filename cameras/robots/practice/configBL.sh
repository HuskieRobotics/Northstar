#!/bin/bash

# Paths are derived from this script's own location, so the repo can live
# anywhere without editing every script and plist.
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

export GENICAM_CACHE_V3_1=/tmp/tmp2;
cd "$REPO";
source ./venv/bin/activate;
while [ True ];
   do "$REPO"/reenumerate/reenumerate -v -l 0x00200000
   nice -20 python3 __init__.py --config cameras/robots/practice/configBL.json;
   sleep 1;
done
