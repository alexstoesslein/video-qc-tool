import json
import os
import time
import uuid
import threading

from flask import Flask, jsonify, render_template, request

from config import CHANNEL_CONFIGS, MAX_CONTENT_LENGTH, UPLOAD_FOLDER
from analyzers.metadata import extract_metadata
from analyzers.black_frames import detect_black_frames
from analyzers.media_offline import detect_media_offline
from analyzers.noise import detect_noise
from analyzers.audio_loudness import measure_loudness
from analyzers.audio_clipping import detect_clipping
from analyzers.fuck_frames import detect_fuck_frames
from analyzers.waveform import generate_waveform
from analyzers.quality_checks import run_quality_checks, aggregate_results

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# In-memory job store
jobs = {}

# Time estimates per step (seconds per second of video duration)
# These are rough multipliers: step_time ≈ factor * video_duration
STEP_ESTIMATES = {
    "metadata":      {"factor": 0.01, "min": 1,  "label": "Metadaten werden extrahiert..."},
    "black_frames":  {"factor": 0.4,  "min": 3,  "label": "Schwarzbilder werden gesucht..."},
    "media_offline": {"factor": 0.4,  "min": 3,  "label": "Media Offline wird geprüft..."},
    "noise":         {"factor": 0.5,  "min": 4,  "label": "Videorauschen wird analysiert..."},
    "loudness":      {"factor": 0.15, "min": 2,  "label": "Audiolautstärke wird gemessen..."},
    "clipping":      {"factor": 0.15, "min": 2,  "label": "Audio-Übersteuerung wird geprüft..."},
    "fuck_frames":   {"factor": 0.3,  "min": 3,  "label": "Fehlschnitte werden gesucht..."},
    "checks":        {"factor": 0.01, "min": 1,  "label": "Qualitätsprüfungen werden ausgeführt..."},
}

STEP_ORDER = ["metadata", "black_frames", "media_offline", "noise", "loudness", "clipping", "fuck_frames", "checks"]


def estimate_step_time(step_key, duration):
    """Estimate how long a step will take based on video duration."""
    est = STEP_ESTIMATES[step_key]
    return max(est["factor"] * duration, est["min"])


def estimate_total_time(duration, has_video=True, has_audio=True):
    """Estimate total analysis time."""
    total = 0
    for step in STEP_ORDER:
        if step in ("black_frames", "media_offline", "noise", "fuck_frames") and not has_video:
            continue
        if step in ("loudness", "clipping") and not has_audio:
            continue
        total += estimate_step_time(step, duration)
    return total


def run_analysis(job_id, filepath, channel, original_filename=None, enabled_steps=None):
    """Run the full analysis pipeline in a background thread."""
    job = jobs[job_id]
    config = CHANNEL_CONFIGS[channel]

    # If no enabled_steps specified, run all
    if enabled_steps is None:
        enabled_steps = set(STEP_ORDER)
    else:
        enabled_steps = set(enabled_steps)
    # metadata and checks always run
    enabled_steps.add("metadata")
    enabled_steps.add("checks")

    try:
        # --- Step 1: Metadata ---
        _start_step(job, "metadata")
        metadata = extract_metadata(filepath, original_filename=original_filename)
        _finish_step(job, "metadata")

        if metadata.get('status') == 'error':
            job["status"] = "error"
            job["error"] = f"Metadaten-Extraktion fehlgeschlagen: {metadata.get('message')}"
            return

        has_video = metadata.get('video') is not None
        has_audio = metadata.get('audio') is not None
        duration = metadata.get('duration', 0)

        # Calculate timeout for ffmpeg analyzers based on duration
        # At least 10 minutes, plus ~3x the media duration (for slow analysis)
        analysis_timeout = max(600, int(duration * 3) + 120)

        # Generate waveform for audio-only files (or any file with audio)
        if has_audio:
            try:
                waveform_path = generate_waveform(filepath, job_id)
                job["waveform_path"] = waveform_path
            except Exception:
                job["waveform_path"] = None

        # Recalculate estimates now that we know the actual duration and streams
        _recalculate_estimates(job, duration, has_video, has_audio)

        # --- Step 2: Black frames ---
        if has_video and "black_frames" in enabled_steps:
            _start_step(job, "black_frames")
            black_frames = detect_black_frames(filepath, config, timeout=analysis_timeout)
            _finish_step(job, "black_frames")
        else:
            _skip_step(job, "black_frames")
            black_frames = {"intervals": [], "total_black_duration": 0, "count": 0}

        # --- Step 3: Media offline ---
        if has_video and "media_offline" in enabled_steps:
            _start_step(job, "media_offline")
            media_offline = detect_media_offline(filepath, config, timeout=analysis_timeout)
            _finish_step(job, "media_offline")
        else:
            _skip_step(job, "media_offline")
            media_offline = {"frozen_intervals": [], "frozen_count": 0, "total_frozen_duration": 0}

        # --- Step 4: Noise ---
        if has_video and "noise" in enabled_steps:
            _start_step(job, "noise")
            noise_results = detect_noise(filepath, config, timeout=analysis_timeout)
            _finish_step(job, "noise")
        else:
            _skip_step(job, "noise")
            noise_results = {"avg_tout": 0, "max_tout": 0, "noisy_frame_count": 0, "total_frames": 0, "noisy_percentage": 0, "noisy_segments": []}

        # --- Step 5: Loudness ---
        if has_audio and "loudness" in enabled_steps:
            _start_step(job, "loudness")
            loudness = measure_loudness(filepath, timeout=analysis_timeout)
            _finish_step(job, "loudness")
        else:
            _skip_step(job, "loudness")
            loudness = {"status": "error", "message": "Kein Audio-Stream"}

        # --- Step 6: Clipping ---
        if has_audio and "clipping" in enabled_steps:
            _start_step(job, "clipping")
            clipping = detect_clipping(filepath, duration=duration, timeout=analysis_timeout)
            _finish_step(job, "clipping")
        else:
            _skip_step(job, "clipping")
            clipping = {"status": "error", "message": "Kein Audio-Stream"}

        # --- Step 6b: Fuck Frames ---
        if has_video and "fuck_frames" in enabled_steps:
            _start_step(job, "fuck_frames")
            fuck_frames = detect_fuck_frames(filepath, config, timeout=analysis_timeout)
            _finish_step(job, "fuck_frames")
        else:
            _skip_step(job, "fuck_frames")
            fuck_frames = {"flash_frames": [], "flash_count": 0}

        # --- Step 7: Quality checks ---
        _start_step(job, "checks")
        checks = run_quality_checks(
            metadata, black_frames, media_offline,
            noise_results, loudness, clipping, fuck_frames, config,
            enabled_steps=enabled_steps
        )
        overall = aggregate_results(checks)
        _finish_step(job, "checks")

        # Done
        job["status"] = "complete"
        job["result"] = {
            "status": "complete",
            "channel": channel,
            "channel_label": config["label"],
            "metadata": metadata,
            "checks": checks,
            "overall": overall,
            "has_waveform": job.get("waveform_path") is not None,
            "clipping_segments": clipping.get("clipping_segments", []),
            "loud_segments": clipping.get("loud_segments", []),
        }

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)

    finally:
        if os.path.exists(filepath):
            os.remove(filepath)


def _start_step(job, step_key):
    """Mark a step as started."""
    job["current_step"] = step_key
    job["current_step_label"] = STEP_ESTIMATES[step_key]["label"]
    job["steps"][step_key]["status"] = "running"
    job["steps"][step_key]["started_at"] = time.time()


def _finish_step(job, step_key):
    """Mark a step as completed, record actual duration."""
    step = job["steps"][step_key]
    step["status"] = "done"
    step["actual_duration"] = time.time() - step["started_at"]
    job["completed_steps"] += 1

    # Update remaining time estimate based on actual measurements
    _update_remaining_estimate(job)


def _skip_step(job, step_key):
    """Mark a step as skipped."""
    job["steps"][step_key]["status"] = "skipped"
    job["steps"][step_key]["estimated_duration"] = 0
    job["completed_steps"] += 1
    job["total_steps_active"] = job.get("total_steps_active", len(STEP_ORDER))
    _update_remaining_estimate(job)


def _recalculate_estimates(job, duration, has_video, has_audio):
    """Recalculate time estimates after knowing video duration & streams."""
    active_count = 0
    for step_key in STEP_ORDER:
        skip = False
        if step_key in ("black_frames", "media_offline", "noise", "fuck_frames") and not has_video:
            skip = True
        if step_key in ("loudness", "clipping") and not has_audio:
            skip = True

        if skip:
            job["steps"][step_key]["estimated_duration"] = 0
        else:
            est = estimate_step_time(step_key, duration)
            job["steps"][step_key]["estimated_duration"] = est
            active_count += 1

    job["total_steps_active"] = active_count
    job["estimated_total"] = sum(
        s["estimated_duration"] for s in job["steps"].values()
    )
    _update_remaining_estimate(job)


def _update_remaining_estimate(job):
    """Calculate remaining time based on completed step durations + estimates for pending."""
    elapsed_total = 0
    remaining = 0
    correction_factor = 1.0

    # Calculate correction factor from completed steps
    completed_estimated = 0
    completed_actual = 0
    for step_key in STEP_ORDER:
        step = job["steps"][step_key]
        if step["status"] == "done":
            completed_estimated += step["estimated_duration"]
            completed_actual += step.get("actual_duration", step["estimated_duration"])
            elapsed_total += step.get("actual_duration", 0)

    # Correction: if actual took 2x estimated, scale remaining estimates up
    if completed_estimated > 0:
        correction_factor = completed_actual / completed_estimated

    # Sum remaining estimates with correction
    for step_key in STEP_ORDER:
        step = job["steps"][step_key]
        if step["status"] in ("pending", "running"):
            est = step["estimated_duration"] * correction_factor
            if step["status"] == "running":
                # Subtract time already spent on current step
                running_for = time.time() - step.get("started_at", time.time())
                est = max(est - running_for, 0)
            remaining += est

    job["elapsed_seconds"] = elapsed_total
    job["remaining_seconds"] = round(remaining, 1)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/channels')
def get_channels():
    channels = []
    for key, cfg in CHANNEL_CONFIGS.items():
        channels.append({
            "id": key,
            "label": cfg["label"],
            "description": cfg["description"],
        })
    return jsonify(channels)


@app.route('/api/analyze', methods=['POST'])
def analyze():
    if 'file' not in request.files:
        return jsonify({"error": "Keine Datei hochgeladen"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "Kein Dateiname"}), 400

    channel = request.form.get('channel', 'youtube')
    if channel not in CHANNEL_CONFIGS:
        return jsonify({"error": f"Unbekannter Kanal: {channel}"}), 400

    ext = os.path.splitext(file.filename)[1] or '.mp4'
    temp_name = f"{uuid.uuid4().hex}{ext}"
    filepath = os.path.join(UPLOAD_FOLDER, temp_name)

    # Stream-save large files in chunks to avoid memory issues
    CHUNK_SIZE = 64 * 1024 * 1024  # 64 MB chunks
    with open(filepath, 'wb') as dest:
        while True:
            chunk = file.stream.read(CHUNK_SIZE)
            if not chunk:
                break
            dest.write(chunk)

    job_id = uuid.uuid4().hex[:12]

    # Initialize job with step tracking
    steps = {}
    for step_key in STEP_ORDER:
        steps[step_key] = {
            "status": "pending",
            "estimated_duration": estimate_step_time(step_key, 60),  # Default 60s estimate
            "actual_duration": None,
            "started_at": None,
        }

    jobs[job_id] = {
        "status": "running",
        "job_id": job_id,
        "started_at": time.time(),
        "current_step": None,
        "current_step_label": "Wird vorbereitet...",
        "steps": steps,
        "completed_steps": 0,
        "total_steps": len(STEP_ORDER),
        "total_steps_active": len(STEP_ORDER),
        "estimated_total": sum(s["estimated_duration"] for s in steps.values()),
        "elapsed_seconds": 0,
        "remaining_seconds": sum(s["estimated_duration"] for s in steps.values()),
        "result": None,
        "error": None,
    }

    # Parse enabled steps from form data
    enabled_steps_json = request.form.get('enabled_steps', None)
    enabled_steps = None
    if enabled_steps_json:
        try:
            enabled_steps = json.loads(enabled_steps_json)
        except (ValueError, TypeError):
            enabled_steps = None

    thread = threading.Thread(
        target=run_analysis,
        args=(job_id, filepath, channel),
        kwargs={"original_filename": file.filename, "enabled_steps": enabled_steps}
    )
    thread.daemon = True
    thread.start()

    return jsonify({"job_id": job_id})


@app.route('/api/status/<job_id>')
def get_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job nicht gefunden"}), 404

    # Live-update remaining for running step
    if job["status"] == "running":
        _update_remaining_estimate(job)

    elapsed = time.time() - job["started_at"]

    # Build step summary
    step_summary = []
    for step_key in STEP_ORDER:
        s = job["steps"][step_key]
        step_summary.append({
            "key": step_key,
            "label": STEP_ESTIMATES[step_key]["label"],
            "status": s["status"],
            "estimated_duration": round(s["estimated_duration"], 1),
            "actual_duration": round(s["actual_duration"], 1) if s["actual_duration"] else None,
        })

    response = {
        "job_id": job_id,
        "status": job["status"],
        "current_step": job["current_step"],
        "current_step_label": job["current_step_label"],
        "completed_steps": job["completed_steps"],
        "total_steps": job["total_steps_active"],
        "progress_percent": round(
            job["completed_steps"] / max(job["total_steps_active"], 1) * 100
        ),
        "elapsed_seconds": round(elapsed, 1),
        "remaining_seconds": round(job["remaining_seconds"], 1),
        "elapsed_formatted": _format_time(elapsed),
        "remaining_formatted": _format_time(job["remaining_seconds"]),
        "steps": step_summary,
    }

    if job["status"] == "complete":
        response["result"] = job["result"]
        # Cleanup job + waveform after result is fetched (keep for 5 min)
        def cleanup_job():
            j = jobs.pop(job_id, None)
            if j and j.get("waveform_path") and os.path.exists(j["waveform_path"]):
                os.remove(j["waveform_path"])
        threading.Timer(300, cleanup_job).start()

    if job["status"] == "error":
        response["error"] = job["error"]

    return jsonify(response)


@app.route('/api/waveform/<job_id>')
def get_waveform(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job nicht gefunden"}), 404

    waveform_path = job.get("waveform_path")
    if not waveform_path or not os.path.exists(waveform_path):
        return jsonify({"error": "Keine Waveform verfügbar"}), 404

    from flask import send_file
    return send_file(waveform_path, mimetype='image/png')


def _format_time(seconds):
    seconds = max(0, seconds)
    if seconds < 60:
        return f"{int(seconds)}s"
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}m {s:02d}s"


if __name__ == '__main__':
    app.run(debug=True, port=5000)
