import json
import os
import subprocess


def extract_metadata(filepath, original_filename=None):
    cmd = [
        'ffprobe',
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filepath
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return {"status": "error", "message": f"ffprobe failed: {result.stderr[:200]}"}

    data = json.loads(result.stdout)
    fmt = data.get('format', {})
    streams = data.get('streams', [])

    video_stream = None
    audio_stream = None
    for s in streams:
        if s.get('codec_type') == 'video' and video_stream is None:
            video_stream = s
        elif s.get('codec_type') == 'audio' and audio_stream is None:
            audio_stream = s

    video_info = None
    if video_stream:
        video_info = {
            "codec": video_stream.get('codec_name', 'unknown'),
            "codec_long": video_stream.get('codec_long_name', ''),
            "width": int(video_stream.get('width', 0)),
            "height": int(video_stream.get('height', 0)),
            "framerate": _parse_framerate(video_stream.get('r_frame_rate', '0/1')),
            "bitrate_kbps": int(video_stream.get('bit_rate', 0)) / 1000 if video_stream.get('bit_rate') else 0,
            "pix_fmt": video_stream.get('pix_fmt', 'unknown'),
            "color_space": video_stream.get('color_space', ''),
            "color_range": video_stream.get('color_range', ''),
            "profile": video_stream.get('profile', ''),
        }

    audio_info = None
    if audio_stream:
        audio_info = {
            "codec": audio_stream.get('codec_name', 'unknown'),
            "sample_rate": int(audio_stream.get('sample_rate', 0)),
            "channels": int(audio_stream.get('channels', 0)),
            "channel_layout": audio_stream.get('channel_layout', ''),
            "bitrate_kbps": int(audio_stream.get('bit_rate', 0)) / 1000 if audio_stream.get('bit_rate') else 0,
        }

    duration = float(fmt.get('duration', 0))
    return {
        "filename": original_filename or os.path.basename(filepath),
        "duration": duration,
        "duration_formatted": _format_duration(duration),
        "file_size_bytes": int(fmt.get('size', 0)),
        "overall_bitrate_kbps": int(fmt.get('bit_rate', 0)) / 1000 if fmt.get('bit_rate') else 0,
        "video": video_info,
        "audio": audio_info,
    }


def _parse_framerate(rate_str):
    try:
        if '/' in rate_str:
            num, den = rate_str.split('/')
            num, den = float(num), float(den)
            if den == 0:
                return 0.0
            return round(num / den, 3)
        return round(float(rate_str), 3)
    except (ValueError, ZeroDivisionError):
        return 0.0


def _format_duration(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"
