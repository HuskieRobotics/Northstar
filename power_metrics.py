# Copyright (c) 2025 FRC 6328
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file at
# the root directory of this project.

import re
import subprocess
from typing import Optional


def run_power_metrics() -> Optional[dict]:
    """
    Run the powermetrics command to collect system power and thermal data.
    
    Measures CPU, GPU, and ANE power consumption along with thermal information.
    Requires sudo privileges to run.
    
    Command: sudo powermetrics -s cpu_power,gpu_power,ane_power,thermal -n 1
    
    Returns:
        Dictionary containing:
        - cpu_power: CPU power consumption (string with unit, e.g., "420 mW")
        - gpu_power: GPU power consumption (string with unit, e.g., "1 mW")
        - ane_power: ANE power consumption (string with unit, e.g., "0 mW")
        - pressure_level: Current pressure level (e.g., "Nominal")
        
        Returns None if the command fails.
    """
    try:
        result = subprocess.run(
            ["sudo", "powermetrics", "-s", "cpu_power,gpu_power,ane_power,thermal", "-n", "1"],
            check=True,
            capture_output=True,
            text=True
        )
        
        output = result.stdout
        
        # Extract the four values from the output
        cpu_power = None
        gpu_power = None
        ane_power = None
        pressure_level = None
        
        # Parse CPU Power
        cpu_match = re.search(r'CPU Power:\s*([\d.]+)\s*mW', output)
        if cpu_match:
            cpu_power = cpu_match.group(1)
        
        # Parse GPU Power
        gpu_match = re.search(r'GPU Power:\s*([\d.]+)\s*mW', output)
        if gpu_match:
            gpu_power = gpu_match.group(1)
        
        # Parse ANE Power
        ane_match = re.search(r'ANE Power:\s*([\d.]+)\s*mW', output)
        if ane_match:
            ane_power = ane_match.group(1)
        
        # Parse Current pressure level
        pressure_match = re.search(r'Current pressure level:\s*(\w+)', output)
        if pressure_match:
            pressure_level = pressure_match.group(1)
        
        return {
            "cpu_power": cpu_power,
            "gpu_power": gpu_power,
            "ane_power": ane_power,
            "pressure_level": pressure_level
        }
        
    except subprocess.CalledProcessError as e:
        print(f"Error running powermetrics: {e}")
        return None
    except FileNotFoundError:
        print("powermetrics command not found. This tool is only available on macOS.")
        return None
