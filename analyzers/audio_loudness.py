import re
import subprocess


def measure_loudness(filepath, timeout=600):
    cmd = [
        'ffmpeg',
        '-i', filepath,
        '-af', 'ebur128=peak=true',
        '-vn',
        '-f', 'null',
        '-'
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "Loudness measurement timed out"}

    stderr = result.stderr
    summary = _parse_ebur128_summary(stderr)

    if summary is None:
        return {"status": "error", "message": "Could not parse loudness data"}

    return {
        "integrated_lufs": summary["integrated"],
        "loudness_range_lu": summary["lra"],
        "true_peak_dbfs": summary["true_peak"],
        "lra_low_lufs": summary.get("lra_low"),
        "lra_high_lufs": summary.get("lra_high"),
    }


def _parse_ebur128_summary(stderr):
    lines = stderr.splitlines()
    summary_idx = None
    for i, line in enumerate(lines):
        if 'Summary:' in line:
            summary_idx = i
            # Keep searching - use the LAST Summary block
    if summary_idx is None:
        return None

    block = '\n'.join(lines[summary_idx:])

    integrated = _extract_float(block, r'I:\s+([-\d.]+)\s+LUFS')
    lra = _extract_float(block, r'LRA:\s+([-\d.]+)\s+LU')
    true_peak = _extract_float(block, r'Peak:\s+([-\d.]+)\s+dBFS')
    lra_low = _extract_float(block, r'LRA low:\s+([-\d.]+)\s+LUFS')
    lra_high = _extract_float(block, r'LRA high:\s+([-\d.]+)\s+LUFS')

    if integrated is None:
        return None

    return {
        "integrated": integrated,
        "lra": lra,
        "true_peak": true_peak,
        "lra_low": lra_low,
        "lra_high": lra_high,
    }


def _extract_float(text, pattern):
    match = re.search(pattern, text)
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            return None
    return None
