# Copyright (c) 2025 FRC 6328
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file at
# the root directory of this project.

import datetime
import os
import time
from typing import List

import cv2
import numpy
from config.config import sanitize_camera_id


class CalibrationSession:
    _frames_saved: int = 0
    _imsize = None
    _folder: str = None

    def __init__(self) -> None:
        self._aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_1000)
        self._aruco_params = cv2.aruco.DetectorParameters()
        self._charuco_board = cv2.aruco.CharucoBoard((15, 15), 0.030, 0.020, self._aruco_dict)
        self._timestamp = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(time.time()))

    def process_frame(self, image: cv2.Mat, device_id: str, camera_id: str) -> None:
        # Get image size
        if self._imsize == None:
            self._imsize = (image.shape[0], image.shape[1])

        # save the raw image for debugging purposes; name the file calibration_ followed by the number of saved frames
        # make a new folder for this calibration session using the timestamp, device, and camera
        if self._frames_saved == 0:
            self._folder = f"./calibrations/{self._timestamp}_{device_id}_{sanitize_camera_id(camera_id)}"
            os.makedirs(self._folder, exist_ok=True)
        cv2.imwrite(f"{self._folder}/calibration_{self._frames_saved}.jpg", image)
        self._frames_saved += 1
        time.sleep(1.0) # capture a frame every second

        # Detect tags
        (corners, ids, rejected) = cv2.aruco.detectMarkers(image, self._aruco_dict, parameters=self._aruco_params)
        if len(corners) > 0:            
            cv2.aruco.drawDetectedMarkers(image, corners)

            # Find Charuco corners
            (retval, charuco_corners, charuco_ids) = cv2.aruco.interpolateCornersCharuco(
                corners, ids, image, self._charuco_board
            )
            if retval:
                cv2.aruco.drawDetectedCornersCharuco(image, charuco_corners, charuco_ids)
