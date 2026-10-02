# Copyright (c) 2025 FRC 6328
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file at
# the root directory of this project.

import random
import socketserver
import string
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from typing import Dict

import cv2
from PIL import Image


CLIENT_COUNTS: Dict[str, int] = {}


class StreamServer:
    """Interface for outputing camera frames."""

    def start(self, port: int) -> None:
        """Starts the output stream."""
        raise NotImplementedError

    def set_frame(self, frame: cv2.Mat) -> None:
        """Sets the frame to serve."""
        raise NotImplementedError


class MjpegServer(StreamServer):
    _frame: cv2.Mat
    _frame_seq: int = 0
    _uuid: str = ""

    def __init__(self) -> None:
        # Guards _frame/_frame_seq and wakes streaming handlers when a new frame
        # arrives, so each frame is encoded once per client instead of in a
        # busy loop.
        self._frame_cond = threading.Condition()

    def _make_handler(self_mjpeg, uuid: str):  # type: ignore
        class StreamingHandler(BaseHTTPRequestHandler):
            HTML = """
    <html>
        <head>
            <title>Northstar Debug</title>
            <style>
                body {
                    background-color: black;
                }

                img {
                    position: absolute;
                    left: 50%;
                    top: 50%;
                    transform: translate(-50%, -50%);
                    max-width: 100%;
                    max-height: 100%;
                }
            </style>
        </head>
        <body>
            <img src="stream.mjpg" />
        </body>
    </html>
            """

            def log_request(self, code="-", size="-") -> None:
                """Drop the access-log line for requests that succeeded.

                BaseHTTPRequestHandler writes every request to stderr, which
                launchd captures into logs/config<X>Error.log. The dashboard
                connects, takes one frame and disconnects for each snapshot, so
                a successful "GET /stream.mjpg" is by far the most common line
                in the file that exists to surface real faults.

                Only accepted requests are silenced. Failures still appear:
                send_error() calls log_error() separately, and log_error() is
                left alone.
                """
                pass

            def do_GET(self):
                global CLIENT_COUNTS
                if self.path == "/":
                    content = self.HTML.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                elif self.path == "/stream.mjpg":
                    self.send_response(200)
                    self.send_header("Age", "0")
                    self.send_header("Cache-Control", "no-cache, private")
                    self.send_header("Pragma", "no-cache")
                    self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=FRAME")
                    self.end_headers()
                    try:
                        # The vision workers only call set_frame() while a
                        # client is attached, so whatever is stored now was
                        # captured before this client connected (possibly long
                        # before). Start from the current sequence number so
                        # the first frame sent is one produced after connecting.
                        with self_mjpeg._frame_cond:
                            last_seq = self_mjpeg._frame_seq
                        CLIENT_COUNTS[uuid] += 1
                        while True:
                            with self_mjpeg._frame_cond:
                                if not self_mjpeg._frame_cond.wait_for(
                                    lambda: self_mjpeg._frame_seq > last_seq, timeout=1.0
                                ):
                                    continue
                                frame = self_mjpeg._frame
                                last_seq = self_mjpeg._frame_seq

                            pil_im = Image.fromarray(frame)
                            stream = BytesIO()
                            pil_im.save(stream, format="JPEG")
                            frame_data = stream.getvalue()

                            self.wfile.write(b"--FRAME\r\n")
                            self.send_header("Content-Type", "image/jpeg")
                            self.send_header("Content-Length", str(len(frame_data)))
                            self.end_headers()
                            self.wfile.write(frame_data)
                            self.wfile.write(b"\r\n")
                    except Exception as e:
                        print(f"Removed streaming client {self.client_address}: {e}")
                    finally:
                        CLIENT_COUNTS[uuid] -= 1
                else:
                    self.send_error(404)
                    self.end_headers()

        return StreamingHandler

    class StreamingServer(socketserver.ThreadingMixIn, HTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    def _run(self, port: int) -> None:
        self._uuid = "".join(random.choice(string.ascii_lowercase) for i in range(12))
        CLIENT_COUNTS[self._uuid] = 0
        server = self.StreamingServer(("", port), self._make_handler(self._uuid))
        server.serve_forever()

    def start(self, port: int) -> None:
        threading.Thread(target=self._run, daemon=True, args=(port,)).start()

    def set_frame(self, frame: cv2.Mat) -> None:
        with self._frame_cond:
            self._frame = frame
            self._frame_seq += 1
            self._frame_cond.notify_all()

    def get_client_count(self) -> int:
        if len(self._uuid) > 0:
            return CLIENT_COUNTS[self._uuid]
        else:
            return 0
