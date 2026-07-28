#!/bin/bash

export GENICAM_CACHE_V3_1=/tmp/tmp2;
cd ~/Documents/GitHub/Northstar;
source ./venv/bin/activate;
while [ True ];
   do date +'%Y-%m-%d %H:%M:%S'
   /Users/nnrobot/Documents/GitHub/Northstar/reenumerate/reenumerate -v -l 0x02220000
   date +'%Y-%m-%d %H:%M:%S'
   nice -20 python3 __init__.py --config cameras/robots/competition/configBCL.json;
   date +'%Y-%m-%d %H:%M:%S'
   sleep 1;
done
