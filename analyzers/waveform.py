"""
Waveform generator — creates a PNG waveform image using ffmpeg's showwavespic filter.
Works reliably with any audio format ffmpeg supports, regardless of file size.
"""

import os
import subprocess

UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'uploads')


def generate_waveform(filepath, job_id, width=1600, height=240):
    """
    Generate a waveform PNG image from an audio/video file.

    Uses ffmpeg's showwavespic filter which is extremely efficient —
    it processes the audio stream directly without full decoding into memory.

    Args:
        filepath: Path to the media file
        job_id: Job ID for naming the output file
        width: Image width in pixels
        height: Image height in pixels

    Returns:
        Path to the generated PNG file
    """
    output_path = os.path.join(UPLOAD_FOLDER, f"waveform_{job_id}.png")

    cmd = [
        'ffmpeg',
        '-i', filepath,
        '-filter_complex',
        f'showwavespic=s={width}x{height}:colors=#6366f1|#818cf8:scale=sqrt:split_channels=0',
        '-frames:v', '1',
        '-y',
        output_path
    ]

    # Determine timeout based on file size (larger files need more time)
    try:
        file_size_gb = os.path.getsize(filepath) / (1024 ** 3)
    except OSError:
        file_size_gb = 0
    timeout = max(120, int(file_size_gb * 60) + 120)  # at least 2 min, +1 min per GB

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0:
            # Try without split_channels (older ffmpeg versions)
            cmd[5] = f'showwavespic=s={width}x{height}:colors=#6366f1:scale=sqrt'
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout
            )

        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            return output_path
        else:
            return None

    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None
