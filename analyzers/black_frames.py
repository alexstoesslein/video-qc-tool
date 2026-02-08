import re
import subprocess


def detect_black_frames(filepath, config, timeout=600):
    cmd = [
        'ffmpeg',
        '-i', filepath,
        '-vf', 'blackdetect=d=0.5:pix_th=0.10:pic_th=0.98',
        '-an',
        '-f', 'null',
        '-'
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "Black frame detection timed out"}

    pattern = re.compile(
        r'black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)'
    )
    intervals = []
    for line in result.stderr.splitlines():
        match = pattern.search(line)
        if match:
            intervals.append({
                "start": float(match.group(1)),
                "end": float(match.group(2)),
                "duration": float(match.group(3)),
            })

    total = sum(i['duration'] for i in intervals)
    return {
        "intervals": intervals,
        "total_black_duration": round(total, 2),
        "count": len(intervals),
    }
