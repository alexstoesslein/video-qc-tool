import re
import subprocess


def detect_media_offline(filepath, config, timeout=600):
    frozen = _detect_frozen_frames(filepath, timeout=timeout)
    return {
        "frozen_intervals": frozen.get("intervals", []),
        "frozen_count": frozen.get("count", 0),
        "total_frozen_duration": frozen.get("total_duration", 0),
    }


def _detect_frozen_frames(filepath, timeout=600):
    cmd = [
        'ffmpeg',
        '-i', filepath,
        '-vf', 'freezedetect=n=0.003:d=2',
        '-an',
        '-f', 'null',
        '-'
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "Freeze detection timed out", "intervals": [], "count": 0, "total_duration": 0}

    start_pattern = re.compile(r'freeze_start:\s*([\d.]+)')
    end_pattern = re.compile(r'freeze_end:\s*([\d.]+)')
    dur_pattern = re.compile(r'freeze_duration:\s*([\d.]+)')

    starts = []
    ends = []
    durations = []

    for line in result.stderr.splitlines():
        sm = start_pattern.search(line)
        if sm:
            starts.append(float(sm.group(1)))
        em = end_pattern.search(line)
        if em:
            ends.append(float(em.group(1)))
        dm = dur_pattern.search(line)
        if dm:
            durations.append(float(dm.group(1)))

    intervals = []
    for i in range(min(len(starts), len(ends), len(durations))):
        intervals.append({
            "start": starts[i],
            "end": ends[i],
            "duration": durations[i],
        })

    total = sum(iv['duration'] for iv in intervals)
    return {
        "intervals": intervals,
        "count": len(intervals),
        "total_duration": round(total, 2),
    }
