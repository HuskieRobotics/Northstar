pip install pybind11
pip install setuptools
python setup.py build_ext --inplace
cd ..
pip install -e ./aruco_max_cpp --no-build-isolation