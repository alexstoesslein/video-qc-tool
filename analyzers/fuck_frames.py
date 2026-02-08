"""
Fuck Frames Detector — finds accidental flash/miscut frames.

Uses ffmpeg scene detection to find very short scene changes (1-5 frames)
that indicate a miscut or accidental frame left in the edit.

Strategy:
1. Run ffmpeg scene detection filter to find all scene change timestamps
2. Look for pairs of scene changes that are only 1-5 frames apart
   (i.e., a very brief "flash" between two cuts)
3. Report these as potential fuck frames / flash frames
"""

import re
import subprocess


def detect_fuck_frames(filepath, config, max_flash_frames=5, timeout=600):
    """
    Detect accidental flash frames (fuck frames) in a video.

    A fuck frame is a very short segment (1-5 frames) between two scene changes,
    indicating a miscut where a few frames accidentally ended up in the export.

    Args:
        filepath: Path to the video file
        config: Channel config dict
        max_flash_frames: Maximum number of frames for a segment to be considered
                         a fuck frame (default: 5)

    Returns:
        dict with flash_frames list, flash_count
    """
    try:
        # First get framerate from ffprobe
        fps = _get_framerate(filepath)
        if fps <= 0:
            return {"status": "error", "message": "Framerate konnte nicht ermittelt werden"}

        # Maximum duration in seconds for a fuck frame
        max_flash_duration = max_flash_frames / fps

        # Scene detection threshold — lower = more sensitive
        scene_threshold = config.get('scene_threshold', 0.35)

        # Run ffmpeg scene detection
        cmd = [
            'ffmpeg',
            '-i', filepath,
            '-vf', f"select='gt(scene,{scene_threshold})',showinfo",
            '-vsync', 'vfr',
            '-f', 'null',
            '-'
        ]

        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout
        )

        # Parse scene change timestamps from showinfo output
        # Format: [Parsed_showinfo...] n:   X pts:   Y pts_time:Z.ZZZ ...
        scene_times = []
        for line in result.stderr.split('\n'):
            m = re.search(r'pts_time:\s*([\d.]+)', line)
            if m:
                t = float(m.group(1))
                scene_times.append(t)

        if len(scene_times) < 2:
            return {
                "flash_frames": [],
                "flash_count": 0,
                "scene_changes": len(scene_times),
                "fps": fps,
            }

        # Sort scene times
        scene_times.sort()

        # Find fuck frames: very short segments between scene changes
        flash_frames = []
        for i in range(len(scene_times) - 1):
            gap = scene_times[i + 1] - scene_times[i]
            frame_count = round(gap * fps)

            if 0 < frame_count <= max_flash_frames:
                flash_frames.append({
                    "start": round(scene_times[i], 3),
                    "end": round(scene_times[i + 1], 3),
                    "duration": round(gap, 4),
                    "frame_count": frame_count,
                })

        return {
            "flash_frames": flash_frames,
            "flash_count": len(flash_frames),
            "scene_changes": len(scene_times),
            "fps": fps,
            "max_flash_frames": max_flash_frames,
        }

    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "Analyse-Timeout (>5min)"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


def _get_framerate(filepath):
    """Get video framerate via ffprobe."""
    cmd = [
        'ffprobe',
        '-v', 'quiet',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=r_frame_rate',
        '-print_format', 'default=noprint_wrappers=1:nokey=1',
        filepath
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        rate_str = result.stdout.strip()
        if '/' in rate_str:
            num, den = rate_str.split('/')
            num, den = float(num), float(den)
            if den == 0:
                return 0.0
            return num / den
        return float(rate_str) if rate_str else 0.0
    except Exception:
        return 0.0
