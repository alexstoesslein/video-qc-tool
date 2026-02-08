import re
import subprocess


def detect_clipping(filepath, duration=None, timeout=600):
    cmd = [
        'ffmpeg',
        '-i', filepath,
        '-af', 'astats=metadata=1:reset=1',
        '-vn',
        '-f', 'null',
        '-'
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "Clipping detection timed out"}

    # ffmpeg astats outputs in log format: "Peak level dB: -17.98"
    peak_pattern = re.compile(r'Peak level dB:\s*([-\d.]+)')
    flat_pattern = re.compile(r'Flat factor:\s*([\d.]+)')

    peak_levels = []
    flat_factors = []

    for line in result.stderr.splitlines():
        pm = peak_pattern.search(line)
        if pm:
            try:
                peak_levels.append(float(pm.group(1)))
            except ValueError:
                pass
        fm = flat_pattern.search(line)
        if fm:
            try:
                flat_factors.append(float(fm.group(1)))
            except ValueError:
                pass

    clipping_count = sum(1 for p in peak_levels if p >= 0.0)
    max_peak = max(peak_levels) if peak_levels else -100.0
    max_flat = max(flat_factors) if flat_factors else 0.0

    total_frames = len(peak_levels)
    # Calculate seconds per frame for time-based segments
    spf = (duration / total_frames) if (duration and total_frames > 0) else 0

    # Find clipping segments (time-based)
    clipping_segments = []
    if clipping_count > 0 and total_frames > 0:
        in_clip = False
        clip_start = 0
        for i, p in enumerate(peak_levels):
            if p >= 0.0:
                if not in_clip:
                    in_clip = True
                    clip_start = i
            else:
                if in_clip:
                    clipping_segments.append({
                        "start_frame": clip_start,
                        "end_frame": i - 1,
                        "frame_count": i - clip_start,
                        "start": round(clip_start * spf, 3),
                        "end": round((i - 1) * spf, 3),
                    })
                    in_clip = False
        if in_clip:
            clipping_segments.append({
                "start_frame": clip_start,
                "end_frame": total_frames - 1,
                "frame_count": total_frames - clip_start,
                "start": round(clip_start * spf, 3),
                "end": round((total_frames - 1) * spf, 3),
            })

    # Find extreme loudness segments (peak > -3 dB but not clipping)
    loud_segments = []
    if total_frames > 0:
        in_loud = False
        loud_start = 0
        loud_peak = -100
        for i, p in enumerate(peak_levels):
            if p >= -3.0 and p < 0.0:
                if not in_loud:
                    in_loud = True
                    loud_start = i
                    loud_peak = p
                else:
                    loud_peak = max(loud_peak, p)
            else:
                if in_loud:
                    loud_segments.append({
                        "start": round(loud_start * spf, 3),
                        "end": round((i - 1) * spf, 3),
                        "level": round(loud_peak, 1),
                    })
                    in_loud = False
        if in_loud:
            loud_segments.append({
                "start": round(loud_start * spf, 3),
                "end": round((total_frames - 1) * spf, 3),
                "level": round(loud_peak, 1),
            })

    return {
        "max_peak_level_db": round(max_peak, 2),
        "max_flat_factor": round(max_flat, 2),
        "clipping_frame_count": clipping_count,
        "total_frames_analyzed": total_frames,
        "has_clipping": clipping_count > 0,
        "clipping_percentage": round(clipping_count / max(total_frames, 1) * 100, 3),
        "clipping_segments": clipping_segments,
        "loud_segments": loud_segments,
    }
