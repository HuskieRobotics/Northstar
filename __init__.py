# Copyright (c) 2025 FRC 6328
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file at
# the root directory of this project.

import argparse
import queue
import sys
import threading
import time
from typing import List, Tuple, Union

import ntcore
from apriltag_worker import apriltag_worker
from calibration.CalibrationCommandSource import CalibrationCommandSource, NTCalibrationCommandSource
from calibration.CalibrationSession import CalibrationSession
from config.config import ConfigStore, LocalConfig, RemoteConfig
from config.ConfigSource import CalibrationConfigSource, ConfigSource, FileConfigSource, NTConfigSource
from objdetect_worker import objdetect_worker
from output.OutputPublisher import NTOutputPublisher, OutputPublisher
from output.StreamServer import MjpegServer, StreamServer
from output.overlay_util import *
from output.VideoWriter import FFmpegVideoWriter, VideoWriter
from pipeline.Capture import CAPTURE_IMPLS
from power_metrics import run_power_metrics

if __name__ == "__main__":
    DEBUG = True

    sys.stdout.reconfigure(line_buffering=True)
    timeString = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time()))
    print(timeString, "Starting Northstar...")

    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config.json")
    args = parser.parse_args()

    config = ConfigStore(LocalConfig(), RemoteConfig())
    local_config_source: ConfigSource = FileConfigSource(args.config)
    remote_config_source: ConfigSource = NTConfigSource()
    calibration_config_source: ConfigSource = CalibrationConfigSource()
    calibration_command_source: CalibrationCommandSource = NTCalibrationCommandSource()
    local_config_source.update(config)

    capture = CAPTURE_IMPLS[config.local_config.capture_impl]()
    output_publisher: OutputPublisher = NTOutputPublisher()
    video_writer: VideoWriter = FFmpegVideoWriter()
    calibration_session = CalibrationSession()
    calibration_session_server: Union[StreamServer, None] = None

    if config.local_config.apriltags_enable:
        apriltag_worker_in = queue.Queue(maxsize=1)
        apriltag_worker_out = queue.Queue(maxsize=1)
        apriltag_worker = threading.Thread(
            target=apriltag_worker,
            args=(apriltag_worker_in, apriltag_worker_out, config.local_config.apriltags_stream_port),
            daemon=True,
        )
        apriltag_worker.start()

    if config.local_config.objdetect_enable:
        objdetect_worker_in = queue.Queue(maxsize=1)
        objdetect_worker_out = queue.Queue(maxsize=1)
        objdetect_worker = threading.Thread(
            target=objdetect_worker,
            args=(objdetect_worker_in, objdetect_worker_out, config.local_config.objdetect_stream_port),
            daemon=True,
        )
        objdetect_worker.start()

    ntcore.NetworkTableInstance.getDefault().setServer(config.local_config.server_ip)
    ntcore.NetworkTableInstance.getDefault().startClient4(config.local_config.device_id)

    if config.local_config.powermetrics_enable:
        # Power metrics configuration
        POWER_METRICS_INTERVAL = 1  # seconds

        # Power metrics thread setup
        latest_power_metrics = None
        power_metrics_lock = threading.Lock()
        power_metrics_last_publish = 0

        def power_metrics_worker():
            """Background worker thread that periodically collects power metrics."""
            global latest_power_metrics
            while True:
                time.sleep(POWER_METRICS_INTERVAL)
                metrics = run_power_metrics()
                with power_metrics_lock:
                    latest_power_metrics = metrics

        power_metrics_thread = threading.Thread(target=power_metrics_worker, daemon=True)
        power_metrics_thread.start()

    apriltags_frame_count = 0
    apriltags_last_print = 0
    apriltags_last_frame_time = 0
    objdetect_frame_count = -1
    objdetect_last_print = 0
    objdetect_last_frame_time = 0
    was_calibrating = False
    was_recording = False
    no_calibration_last_print = 0
    last_image_observations: List[FiducialImageObservation] = []
    last_objdetect_observations: List[ObjDetectObservation] = []
    video_frame_cache: List[cv2.Mat] = []

    while True:
        remote_config_source.update(config)

        # Load the calibration for the current camera before capturing from it
        calibration_config_source.update(config)

        success, image = capture.get_frame(config)
        timestamp = time.time()
        # get a time string with current date and time with seconds
        timeString = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp))

        if config.local_config.powermetrics_enable:
            # Check power metrics from background thread
            if time.time() - power_metrics_last_publish > POWER_METRICS_INTERVAL:
                with power_metrics_lock:
                    if latest_power_metrics is not None:
                        metrics = latest_power_metrics
                        output_publisher.send_power_metrics(config, timestamp, metrics)
                        power_metrics_last_publish = time.time()
                        if metrics:
                            if DEBUG: print(f"Power Metrics - CPU: {metrics['cpu_power']}, GPU: {metrics['gpu_power']}, ANE: {metrics['ane_power']}, Pressure: {metrics['pressure_level']}")



        # Start and stop recording
        should_record = (
            success
            and config.remote_config.is_recording
            and config.remote_config.camera_resolution_width > 0
            and config.remote_config.camera_resolution_height > 0
            and config.remote_config.timestamp > 0
        )
        if should_record and not was_recording:
            print(timeString, "Starting recording")
            video_writer.start(config, len(image.shape) == 2)
        elif not should_record and was_recording:
            print(timeString, "Stopping recording")
            video_writer.stop()
        was_recording = should_record

        # Exit if no frame
        if not success:
            print(timeString, "No frame received, waiting for capture")
            time.sleep(1.0)
            continue

        if calibration_command_source.get_calibrating(config):
            # Calibration mode
            if not was_calibrating:
                calibration_session_server = MjpegServer()
                calibration_session_server.start(7999)
            was_calibrating = True
            calibration_session.process_frame(
                image, config.local_config.device_id, config.remote_config.camera_id
            )
            calibration_session_server.set_frame(image)

        elif was_calibrating:
            # restart after calibration
            capture._camera.DestroyDevice()
            sys.exit(0)

        elif config.local_config.has_calibration:
            # AprilTag pipeline
            if config.local_config.apriltags_enable:
                # Apply FPS limit for apriltag detection
                throttle_fps = config.remote_config.throttle_fps
                apriltag_max_fps = config.local_config.apriltag_max_fps
                if throttle_fps < 0 and apriltag_max_fps < 0:
                    effective_max_fps = -1
                elif throttle_fps < 0:
                    effective_max_fps = apriltag_max_fps
                elif apriltag_max_fps < 0:
                    effective_max_fps = throttle_fps
                else:
                    effective_max_fps = min(throttle_fps, apriltag_max_fps)
                if effective_max_fps < 0 or (timestamp - apriltags_last_frame_time) >= (1.0 / effective_max_fps):
                    apriltags_last_frame_time = timestamp
                try:
                    apriltag_worker_in.put((timestamp, image, config), block=False)
                except:  # No space in queue
                    pass
                try:
                    (
                        timestamp_out,
                        image_observations,
                        pose_observation,
                        tag_angle_observations,
                        demo_pose_observation,
                    ) = apriltag_worker_out.get(block=False)
                except:  # No new frames
                    pass
                else:
                    # Publish observation
                    output_publisher.send_apriltag_observation(
                        config, timestamp_out, image_observations, pose_observation, tag_angle_observations, demo_pose_observation
                    )

                    # Store last observations
                    last_image_observations = image_observations

                    # Measure FPS
                    fps = None
                    apriltags_frame_count += 1
                    if time.time() - apriltags_last_print > 1:
                        apriltags_last_print = time.time()
                        if DEBUG: print(timeString, "Running AprilTag pipeline at", apriltags_frame_count, "fps")
                        output_publisher.send_apriltag_fps(config, timestamp_out, apriltags_frame_count)
                        apriltags_frame_count = 0

            # Object detection pipeline
            if config.local_config.objdetect_enable:
                # Apply FPS limit for object detection
                throttle_fps = config.remote_config.throttle_fps
                obj_max_fps = config.local_config.obj_detect_max_fps
                if throttle_fps < 0 and obj_max_fps < 0:
                    effective_max_fps = -1
                elif throttle_fps < 0:
                    effective_max_fps = obj_max_fps
                elif obj_max_fps < 0:
                    effective_max_fps = throttle_fps
                else:
                    effective_max_fps = min(throttle_fps, obj_max_fps)
                if effective_max_fps < 0 or (timestamp - objdetect_last_frame_time) >= (1.0 / effective_max_fps):
                    objdetect_last_frame_time = timestamp
                    try:
                        objdetect_worker_in.put((timestamp, image, config), block=False)
                    except:  # No space in queue
                        pass
                try:
                    timestamp_out, observations = objdetect_worker_out.get(block=False)
                except:  # No new frames
                    pass
                else:
                    # Publish observation
                    output_publisher.send_objdetect_observation(config, timestamp_out, observations)

                    # Store last observations
                    last_objdetect_observations = observations

                    # Measure FPS
                    fps = None
                    objdetect_frame_count += 1
                    if time.time() - objdetect_last_print > 1:
                        objdetect_last_print = time.time()
                        if DEBUG: print(timeString, "Running object detection pipeline at", objdetect_frame_count, "fps")
                        output_publisher.send_objdetect_fps(config, timestamp, objdetect_frame_count)
                        objdetect_frame_count = 0

            # Save frame to video
            if config.remote_config.is_recording:
                if len(video_frame_cache) >= 2:
                    # Delay output by two frames to improve alignment with overlays
                    video_writer.write_frame(
                        timestamp, video_frame_cache.pop(0), last_image_observations, last_objdetect_observations
                    )
                video_frame_cache.append(image)
            else:
                video_frame_cache = []

        else:
            # No calibration (CalibrationConfigSource logs the reason when the camera changes)
            if time.time() - no_calibration_last_print > 5:
                no_calibration_last_print = time.time()
                print(timeString, "No calibration found for camera", config.remote_config.camera_id)
            time.sleep(0.5)
