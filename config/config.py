# Copyright (c) 2025 FRC 6328
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file at
# the root directory of this project.

import re
from dataclasses import dataclass
from typing import Tuple, Union

import numpy
import numpy.typing


def sanitize_camera_id(camera_id: str) -> str:
    """Convert a camera ID to a form that is safe to use in a filename.

    Pylon camera IDs are bare serial numbers, but AVFoundation IDs are colon
    separated (location:vendor:product) and the default capture uses an index.
    """
    return re.sub(r"[^A-Za-z0-9_-]", "", camera_id)


@dataclass
class ImageROI:
    """Where a captured image sits on the camera's sensor, in pixels."""

    offset_x: int
    offset_y: int
    width: int
    height: int
    sensor_width: int
    sensor_height: int


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

    # Set by the main loop from the calibration command source
    calibrating: bool = False

    # Populated by CalibrationConfigSource based on remote_config.camera_id.
    # camera_matrix is what the pipelines use: the file's matrix adjusted for
    # image_roi by update_camera_matrix().
    has_calibration: bool = False
    camera_matrix: numpy.typing.NDArray[numpy.float64] = None
    distortion_coefficients: numpy.typing.NDArray[numpy.float64] = None
    calibration_camera_matrix: numpy.typing.NDArray[numpy.float64] = None
    calibration_resolution: Union[None, Tuple[int, int]] = None  # (width, height), if the file records it

    # Populated by the capture once it has configured the camera. None means
    # the capture cannot report one, and the image is taken to be the full
    # sensor.
    image_roi: Union[None, ImageROI] = None


def update_camera_matrix(local_config: LocalConfig, timeString: str) -> None:
    """Derive camera_matrix from the calibration and the current image ROI.

    Calibrations describe the full sensor. A cropped image starts offset_x
    columns and offset_y rows into it, so the principal point, which stays at
    the same physical spot on the sensor, sits that much closer to the image's
    origin. Focal length and distortion are unchanged: a crop does not rescale
    pixels, and distortion is applied relative to the principal point.
    """
    if local_config.calibration_camera_matrix is None:
        local_config.camera_matrix = None
        return

    camera_matrix = local_config.calibration_camera_matrix.copy()
    roi = local_config.image_roi
    if roi is not None:
        resolution = local_config.calibration_resolution
        if resolution is not None and resolution != (roi.sensor_width, roi.sensor_height):
            print(
                timeString,
                f"Warning: calibration is for {resolution[0]}x{resolution[1]} but the sensor is "
                f"{roi.sensor_width}x{roi.sensor_height}; the crop correction assumes a full-sensor calibration",
            )
        camera_matrix[0, 2] -= roi.offset_x
        camera_matrix[1, 2] -= roi.offset_y
        if roi.offset_x != 0 or roi.offset_y != 0:
            print(timeString, f"Shifted principal point by ({-roi.offset_x}, {-roi.offset_y}) for the cropped image")
    local_config.camera_matrix = camera_matrix


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
