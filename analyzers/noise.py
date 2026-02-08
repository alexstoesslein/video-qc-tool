import re
import subprocess


def detect_noise(filepath, config, timeout=600):
    cmd = [
        'ffmpeg',
        '-i', filepath,
        '-vf', 'signalstats=stat=tout,metadata=mode=print',
        '-an',
        '-f', 'null',
        '-'
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "Noise analysis timed out"}

    tout_pattern = re.compile(r'TOUT=([\d.]+)')
    pts_pattern = re.compile(r'pts_time:([\d.]+)')

    tout_values = []
    timestamps = []
    current_pts = 0.0

    for line in result.stderr.splitlines():
        pts_match = pts_pattern.search(line)
        if pts_match:
            current_pts = float(pts_match.group(1))
        tout_match = tout_pattern.search(line)
        if tout_match:
            tout_values.append(float(tout_match.group(1)))
            timestamps.append(current_pts)

    if not tout_values:
        return {
            "avg_tout": 0,
            "max_tout": 0,
            "noisy_frame_count": 0,
            "total_frames": 0,
            "noisy_percentage": 0,
            "noisy_segments": [],
        }

    threshold = config.get('noise_threshold_tout', 0.10)
    avg_tout = sum(tout_values) / len(tout_values)
    max_tout = max(tout_values)
    noisy_count = sum(1 for v in tout_values if v > threshold)

    noisy_segments = _find_noisy_segments(tout_values, timestamps, threshold)

    return {
        "avg_tout": round(avg_tout, 4),
        "max_tout": round(max_tout, 4),
        "noisy_frame_count": noisy_count,
        "total_frames": len(tout_values),
        "noisy_percentage": round(noisy_count / len(tout_values) * 100, 2),
        "noisy_segments": noisy_segments,
    }


def _find_noisy_segments(tout_values, timestamps, threshold, min_frames=5):
    segments = []
    in_segment = False
    seg_start = 0
    seg_values = []

    for i, val in enumerate(tout_values):
        if val > threshold:
            if not in_segment:
                in_segment = True
                seg_start = i
                seg_values = []
            seg_values.append(val)
        else:
            if in_segment and len(seg_values) >= min_frames:
                segments.append({
                    "start": round(timestamps[seg_start], 2) if seg_start < len(timestamps) else 0,
                    "end": round(timestamps[i - 1], 2) if (i - 1) < len(timestamps) else 0,
                    "avg_tout": round(sum(seg_values) / len(seg_values), 4),
                    "frames": len(seg_values),
                })
            in_segment = False
            seg_values = []

    if in_segment and len(seg_values) >= min_frames:
        segments.append({
            "start": round(timestamps[seg_start], 2) if seg_start < len(timestamps) else 0,
            "end": round(timestamps[-1], 2) if timestamps else 0,
            "avg_tout": round(sum(seg_values) / len(seg_values), 4),
            "frames": len(seg_values),
        })

    return segments
