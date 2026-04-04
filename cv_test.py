import cv2
from cv2_enumerate_cameras import enumerate_cameras

# define a function to search for a camera
def find_camera(vid, pid, apiPreference=cv2.CAP_ANY):
    for i in enumerate_cameras(apiPreference):
        if i.vid == vid and i.pid == pid:
            print(f"Found camera: {i.index} with VID {vid} and PID {pid}")
            print(f"Camera backend: {i.backend}")
            print(f"Camera name: {i.name}")
            return cv2.VideoCapture(i.index, i.backend)
    return None

# find the camera with VID 0x0C45 and PID 0x6366
cap = find_camera(0x0C45, 0x6366)

# read and display the camera frame
while True:
    result, frame = cap.read()
    if not result:
        print("Failed to capture frame")
        break
    cv2.imshow('frame', frame)
    if cv2.waitKey(1) == ord('q'):
        break