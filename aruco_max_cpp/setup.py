# Copyright (c) 2022-2026 Littleton Robotics
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file at
# the root directory of this project.

from pybind11.setup_helpers import Pybind11Extension, build_ext
from setuptools import setup
import os
import sys

script_dir = os.path.abspath(os.path.dirname(__file__))
sources = [os.path.join(script_dir, "wrapper.cpp")]

if sys.platform == "darwin":
    # Homebrew OpenCV, plus the Metal threshold kernel.
    sources.append(os.path.join(script_dir, "metal_context.cpp"))
    opencv_prefix = "/opt/homebrew"
    extra_link_args = ["-framework", "Metal", "-framework", "Foundation"]
    extra_compile_args = ["-O3", "-std=c++14", "-ObjC++"]
else:
    # OpenCV built from source into /usr/local: distribution packages can be
    # older than 4.7, which this needs for opencv2/objdetect/aruco_dictionary.hpp.
    # See claude/NUC-PORT.md. The extension is always built on the machine
    # that runs it, so -march=native is safe.
    opencv_prefix = "/usr/local"
    extra_link_args = ["-Wl,-rpath," + opencv_prefix + "/lib"]
    extra_compile_args = ["-O3", "-std=c++14", "-march=native"]

ext_modules = [
    Pybind11Extension(
        "aruco_max",
        sources,
        include_dirs=[opencv_prefix + "/include/opencv4", script_dir],
        libraries=["opencv_core", "opencv_imgproc", "opencv_calib3d", "opencv_objdetect"],
        library_dirs=[opencv_prefix + "/lib"],
        extra_link_args=extra_link_args,
        extra_compile_args=extra_compile_args,
    ),
]

setup(
    name="aruco_max",
    ext_modules=ext_modules,
    cmdclass={"build_ext": build_ext},
)
