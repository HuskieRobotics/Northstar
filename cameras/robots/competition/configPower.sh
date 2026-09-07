#!/bin/bash

# Paths are derived from this script's own location, so the repo can live
# anywhere without editing every script and plist.
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

cd "$REPO";
source ./venv/bin/activate;
while [ True ];
   do date +'%Y-%m-%d %H:%M:%S'
   python3 __init__.py --config cameras/robots/competition/configPower.json;
   date +'%Y-%m-%d %H:%M:%S'
   sleep 1;
done
