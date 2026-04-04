#!/bin/bash

export GENICAM_CACHE_V3_1=/tmp/tmp2;
cd ~/Documents/GitHub/Northstar2025/northstar;
source ./venv/bin/activate;
while [ True ];
   date +'%Y-%m-%d %H:%M:%S'
   do /Users/nnrobot/Documents/GitHub/Northstar2025/northstar/reenumerate/reenumerate -v -l 0x01200000
   date +'%Y-%m-%d %H:%M:%S'
   nice -20 python3 __init__.py --config cameras/robots/competition/configBR.json --calibration cameras/calibrations/calibration40708542.yml;
   date +'%Y-%m-%d %H:%M:%S'
   sleep 1;
done
