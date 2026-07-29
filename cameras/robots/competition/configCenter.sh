#!/bin/bash

export GENICAM_CACHE_V3_1=/tmp/tmp2;
cd ~/Documents/GitHub/Northstar;
source ./venv/bin/activate;
while [ True ];
   do date +'%Y-%m-%d %H:%M:%S'
   /Users/nnrobot/Documents/GitHub/Northstar/reenumerate/reenumerate -v -l 0x00100000
   sleep 1;
   /Users/nnrobot/Documents/GitHub/Northstar/reenumerate/reenumerate -v -l 0x00200000
   sleep 1;
   date +'%Y-%m-%d %H:%M:%S'
   nice -20 python3 __init__.py --config cameras/robots/competition/configCenter.json;
   date +'%Y-%m-%d %H:%M:%S'
   sleep 1;
done
