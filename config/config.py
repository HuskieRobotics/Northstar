# Copyright (c) 2025 FRC 6328
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file at
# the root directory of this project.

import re
from dataclasses import dataclass

import numpy
import numpy.typing


def sanitize_camera_id(camera_id: str) -> str:
    """Convert a camera ID to a form that is safe to use in a filename.

    Pylon camera IDs are bare serial numbers, but AVFoundation IDs are colon
    separated (location:vendor:product) and the default capture uses an index.
    """
    return re.sub(r"[^A-Za-z0-9_-]", "", camera_id)


@dataclass
class LocalConfig:
    device_id: str = ""
    server_ip: str = ""
    apriltags_stream_port: int = 8000
    objdetect_stream_port: int = 8001
    capture_impl: str = ""
    apriltag_max_fps: int = -1
    obj_detect_model: str = ""
    obj_detect_max_fps: int = -1
    apriltags_enable: bool = False
    objdetect_enable: bool = True
    tagangle_enable: bool = False
    powermetrics_enable: bool = False
    video_folder: str = ""
    calibration_folder: str = "cameras/calibrations/"

    # Populated by CalibrationConfigSource based on remote_config.camera_id
    has_calibration: bool = False
    camera_matrix: numpy.typing.NDArray[numpy.float64] = None
    distortion_coefficients: numpy.typing.NDArray[numpy.float64] = None


@dataclass
class RemoteConfig:
    event_name: str = ""
    match_type: int = 0
    match_number: int = 0
    camera_id: str = ""
    camera_resolution_width: int = 0
    camera_resolution_height: int = 0
    camera_auto_exposure: int = 0
    camera_exposure: int = 0
    camera_gain: float = 0
    camera_denoise: float = 0
    camera_balance_red: float = 1
    camera_balance_blue: float = 1
    fiducial_size_m: float = 0
    tag_layout: any = None
    is_recording: bool = False
    timestamp: int = 0
    throttle_fps: float = 0.0


@dataclass
class ConfigStore:
    local_config: LocalConfig
    remote_config: RemoteConfig
