#!/bin/bash

# Paths are derived from this script's own location, so the repo can live
# anywhere without editing every script and plist.
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

cd "$REPO";
top -l 0 -n 10;
