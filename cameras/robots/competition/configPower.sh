#!/bin/bash

cd ~/Documents/GitHub/Northstar;
source ./venv/bin/activate;
while [ True ];
   do date +'%Y-%m-%d %H:%M:%S'
   python3 __init__.py --config cameras/robots/competition/configPower.json;
   date +'%Y-%m-%d %H:%M:%S'
   sleep 1;
done
