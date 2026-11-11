# Per-frame RMS (30fps, first 22s) of an audio file, normalised 0..1, printed as JSON.
import subprocess, sys, json, numpy as np
sr, fps, dur = 44100, 30, 22
raw = subprocess.run(["ffmpeg","-v","quiet","-i",sys.argv[1],"-t",str(dur),"-ac","1","-ar",str(sr),"-f","f32le","-"],capture_output=True,check=True).stdout
x = np.frombuffer(raw, np.float32); n = sr // fps
r = np.array([np.sqrt(np.mean(x[i*n:(i+1)*n]**2)) for i in range(len(x)//n)])
r = r / r.max(); assert 0 <= r.min() and r.max() == 1
print(json.dumps([round(float(v),3) for v in r]))
