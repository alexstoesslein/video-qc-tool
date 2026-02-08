from config import PASS, WARN, FAIL


def run_quality_checks(metadata, black_frames, media_offline,
                       noise_results, loudness, clipping, fuck_frames, config,
                       enabled_steps=None):
    checks = []

    # Metadata-based checks always run
    checks.append(_check_resolution(metadata, config))
    checks.append(_check_bitrate(metadata, config))
    checks.append(_check_framerate(metadata, config))
    checks.append(_check_audio_sample_rate(metadata, config))
    checks.append(_check_audio_channels(metadata, config))

    # Audio analysis checks
    if enabled_steps is None or "loudness" in enabled_steps:
        checks.append(_check_loudness(loudness, config))
        checks.append(_check_true_peak(loudness, config))

    # Video analysis checks
    if enabled_steps is None or "black_frames" in enabled_steps:
        checks.append(_check_black_frames(black_frames, config))
    if enabled_steps is None or "media_offline" in enabled_steps:
        checks.append(_check_media_offline(media_offline, config))
    if enabled_steps is None or "noise" in enabled_steps:
        checks.append(_check_noise(noise_results, config))

    # Audio clipping check
    if enabled_steps is None or "clipping" in enabled_steps:
        checks.append(_check_clipping(clipping))

    # Fuck frames check
    if enabled_steps is None or "fuck_frames" in enabled_steps:
        checks.append(_check_fuck_frames(fuck_frames))

    return checks


def aggregate_results(checks):
    statuses = [c['status'] for c in checks]
    if FAIL in statuses:
        overall = FAIL
    elif WARN in statuses:
        overall = WARN
    else:
        overall = PASS

    score_map = {PASS: 1.0, WARN: 0.5, FAIL: 0.0}
    scores = [score_map.get(s, 0) for s in statuses]
    numeric_score = round(sum(scores) / len(scores) * 100) if scores else 0

    return {
        "status": overall,
        "score": numeric_score,
        "total_checks": len(checks),
        "pass_count": statuses.count(PASS),
        "warning_count": statuses.count(WARN),
        "fail_count": statuses.count(FAIL),
        "summary": f"{statuses.count(PASS)} bestanden, {statuses.count(WARN)} Warnungen, {statuses.count(FAIL)} fehlgeschlagen",
    }


# --- Individual check functions ---

def _check_resolution(metadata, config):
    video = metadata.get('video')
    if not video and config.get('video_optional'):
        return _result("Auflösung", "video", PASS,
                        "Kein Video-Stream (akzeptabel für diesen Kanal)")
    if not video:
        return _result("Auflösung", "video", FAIL, "Kein Video-Stream erkannt")

    w, h = video['width'], video['height']
    min_w = config['min_resolution']['width']
    min_h = config['min_resolution']['height']

    landscape_ok = w >= min_w and h >= min_h
    portrait_ok = w >= min_h and h >= min_w
    pixel_ok = (w * h) >= (min_w * min_h)

    if landscape_ok or portrait_ok:
        return _result("Auflösung", "video", PASS,
                        f"{w}x{h} erfüllt Minimum {min_w}x{min_h}",
                        {"actual": f"{w}x{h}", "required": f"{min_w}x{min_h}"})
    elif pixel_ok:
        return _result("Auflösung", "video", WARN,
                        f"{w}x{h} hat genug Pixel, aber ungewöhnliches Seitenverhältnis",
                        {"actual": f"{w}x{h}", "required": f"{min_w}x{min_h}"})
    else:
        return _result("Auflösung", "video", FAIL,
                        f"{w}x{h} liegt unter Minimum {min_w}x{min_h}",
                        {"actual": f"{w}x{h}", "required": f"{min_w}x{min_h}"})


def _check_bitrate(metadata, config):
    bitrate = metadata.get('overall_bitrate_kbps', 0)
    min_br = config['min_bitrate_kbps']

    if bitrate >= min_br:
        return _result("Bitrate", "video", PASS,
                        f"{bitrate:.0f} kbps erfüllt Minimum {min_br} kbps",
                        {"actual_kbps": bitrate, "required_kbps": min_br})
    elif bitrate >= min_br * 0.75:
        return _result("Bitrate", "video", WARN,
                        f"{bitrate:.0f} kbps liegt knapp unter Minimum {min_br} kbps",
                        {"actual_kbps": bitrate, "required_kbps": min_br})
    else:
        return _result("Bitrate", "video", FAIL,
                        f"{bitrate:.0f} kbps liegt deutlich unter Minimum {min_br} kbps",
                        {"actual_kbps": bitrate, "required_kbps": min_br})


def _check_framerate(metadata, config):
    video = metadata.get('video')
    if not video and config.get('video_optional'):
        return _result("Framerate", "video", PASS,
                        "Kein Video-Stream (akzeptabel für diesen Kanal)")
    if not video:
        return _result("Framerate", "video", FAIL, "Kein Video-Stream erkannt")

    fps = video['framerate']
    accepted = config.get('accepted_framerates', [])
    min_fps = config.get('min_framerate', 24.0)

    exact_match = any(abs(fps - a) < 0.05 for a in accepted)
    close_match = any(abs(fps - a) < 1.0 for a in accepted)

    if exact_match:
        return _result("Framerate", "video", PASS,
                        f"{fps} fps ist ein akzeptierter Wert",
                        {"actual_fps": fps, "accepted": accepted})
    elif close_match and fps >= min_fps:
        return _result("Framerate", "video", WARN,
                        f"{fps} fps weicht leicht von akzeptierten Werten ab",
                        {"actual_fps": fps, "accepted": accepted})
    else:
        return _result("Framerate", "video", FAIL,
                        f"{fps} fps ist kein akzeptierter Wert (erwartet: {accepted})",
                        {"actual_fps": fps, "accepted": accepted})


def _check_audio_sample_rate(metadata, config):
    audio = metadata.get('audio')
    if not audio:
        return _result("Audio Sample Rate", "audio", FAIL, "Kein Audio-Stream erkannt")

    rate = audio['sample_rate']
    min_rate = config.get('min_audio_sample_rate', 44100)

    if rate >= min_rate:
        return _result("Audio Sample Rate", "audio", PASS,
                        f"{rate} Hz erfüllt Minimum {min_rate} Hz",
                        {"actual_hz": rate, "required_hz": min_rate})
    elif rate >= 22050:
        return _result("Audio Sample Rate", "audio", WARN,
                        f"{rate} Hz liegt unter empfohlenem Minimum {min_rate} Hz",
                        {"actual_hz": rate, "required_hz": min_rate})
    else:
        return _result("Audio Sample Rate", "audio", FAIL,
                        f"{rate} Hz ist zu niedrig (Minimum: {min_rate} Hz)",
                        {"actual_hz": rate, "required_hz": min_rate})


def _check_audio_channels(metadata, config):
    audio = metadata.get('audio')
    if not audio:
        return _result("Audio-Kanäle", "audio", FAIL, "Kein Audio-Stream erkannt")

    channels = audio['channels']
    min_ch = config.get('min_audio_channels', 2)
    pref_ch = config.get('preferred_audio_channels')

    if pref_ch and channels >= pref_ch:
        return _result("Audio-Kanäle", "audio", PASS,
                        f"{channels} Kanäle ({audio.get('channel_layout', '')}) - bevorzugte Konfiguration",
                        {"actual": channels, "minimum": min_ch, "preferred": pref_ch})
    elif channels >= min_ch:
        msg = f"{channels} Kanäle ({audio.get('channel_layout', '')}) erfüllt Minimum"
        if pref_ch:
            msg += f" (bevorzugt: {pref_ch} Kanäle)"
            return _result("Audio-Kanäle", "audio", WARN, msg,
                            {"actual": channels, "minimum": min_ch, "preferred": pref_ch})
        return _result("Audio-Kanäle", "audio", PASS, msg,
                        {"actual": channels, "minimum": min_ch})
    else:
        return _result("Audio-Kanäle", "audio", FAIL,
                        f"{channels} Kanäle liegt unter Minimum {min_ch}",
                        {"actual": channels, "minimum": min_ch})


def _check_loudness(loudness, config):
    if loudness.get('status') == 'error':
        return _result("Lautstärke (LUFS)", "audio", FAIL,
                        f"Messung fehlgeschlagen: {loudness.get('message', '')}")

    target = config['target_lufs']
    tolerance = config['lufs_tolerance']
    integrated = loudness.get('integrated_lufs')

    if integrated is None:
        return _result("Lautstärke (LUFS)", "audio", FAIL,
                        "Keine LUFS-Daten verfügbar")

    diff = abs(integrated - target)
    if diff <= tolerance:
        return _result("Lautstärke (LUFS)", "audio", PASS,
                        f"{integrated:.1f} LUFS im Zielbereich {target:.0f} ±{tolerance:.0f} LUFS",
                        {"measured_lufs": integrated, "target": target, "tolerance": tolerance, "deviation": round(diff, 1)})
    elif diff <= tolerance * 2:
        return _result("Lautstärke (LUFS)", "audio", WARN,
                        f"{integrated:.1f} LUFS außerhalb Zielbereich ({target - tolerance:.0f} bis {target + tolerance:.0f} LUFS)",
                        {"measured_lufs": integrated, "target": target, "tolerance": tolerance, "deviation": round(diff, 1)})
    else:
        return _result("Lautstärke (LUFS)", "audio", FAIL,
                        f"{integrated:.1f} LUFS weicht stark vom Ziel {target:.0f} LUFS ab",
                        {"measured_lufs": integrated, "target": target, "tolerance": tolerance, "deviation": round(diff, 1)})


def _check_true_peak(loudness, config):
    if loudness.get('status') == 'error':
        return _result("True Peak", "audio", FAIL,
                        f"Messung fehlgeschlagen: {loudness.get('message', '')}")

    max_tp = config.get('max_true_peak_dbfs', -1.0)
    tp = loudness.get('true_peak_dbfs')

    if tp is None:
        return _result("True Peak", "audio", WARN, "Keine True-Peak-Daten verfügbar")

    if tp <= max_tp:
        return _result("True Peak", "audio", PASS,
                        f"{tp:.1f} dBFS unter Maximum {max_tp:.1f} dBFS",
                        {"measured_dbfs": tp, "max_dbfs": max_tp})
    elif tp <= max_tp + 1.0:
        return _result("True Peak", "audio", WARN,
                        f"{tp:.1f} dBFS überschreitet Maximum {max_tp:.1f} dBFS leicht",
                        {"measured_dbfs": tp, "max_dbfs": max_tp})
    else:
        return _result("True Peak", "audio", FAIL,
                        f"{tp:.1f} dBFS überschreitet Maximum {max_tp:.1f} dBFS deutlich",
                        {"measured_dbfs": tp, "max_dbfs": max_tp})


def _check_black_frames(black_frames, config):
    if black_frames.get('status') == 'error':
        return _result("Schwarzbilder", "content", WARN,
                        f"Analyse fehlgeschlagen: {black_frames.get('message', '')}")

    count = black_frames.get('count', 0)
    total_dur = black_frames.get('total_black_duration', 0)
    max_dur = config.get('black_frame_max_duration', 3.0)
    intervals = black_frames.get('intervals', [])

    timestamps = [{"start": iv['start'], "end": iv['end'],
                    "description": f"Schwarzbild ({iv['duration']:.1f}s)"}
                   for iv in intervals]

    if count == 0:
        return _result("Schwarzbilder", "content", PASS,
                        "Keine Schwarzbilder erkannt", timestamps=timestamps)
    elif total_dur <= max_dur:
        return _result("Schwarzbilder", "content", WARN,
                        f"{count} Schwarzbild-Segment(e) erkannt ({total_dur:.1f}s gesamt)",
                        {"count": count, "total_duration": total_dur, "max_allowed": max_dur},
                        timestamps)
    else:
        return _result("Schwarzbilder", "content", FAIL,
                        f"{count} Schwarzbild-Segment(e) mit {total_dur:.1f}s gesamt (Max: {max_dur:.1f}s)",
                        {"count": count, "total_duration": total_dur, "max_allowed": max_dur},
                        timestamps)


def _check_media_offline(media_offline, config):
    if media_offline.get('status') == 'error':
        return _result("Media Offline", "content", WARN,
                        f"Analyse fehlgeschlagen: {media_offline.get('message', '')}")

    frozen_count = media_offline.get('frozen_count', 0)
    total_dur = media_offline.get('total_frozen_duration', 0)
    intervals = media_offline.get('frozen_intervals', [])

    timestamps = [{"start": iv['start'], "end": iv['end'],
                    "description": f"Eingefrorenes Bild ({iv['duration']:.1f}s)"}
                   for iv in intervals]

    if frozen_count == 0:
        return _result("Media Offline", "content", PASS,
                        "Keine eingefrorenen Frames erkannt", timestamps=timestamps)
    elif total_dur <= 5.0:
        return _result("Media Offline", "content", WARN,
                        f"{frozen_count} eingefrorene(s) Segment(e) erkannt ({total_dur:.1f}s)",
                        {"frozen_count": frozen_count, "total_duration": total_dur},
                        timestamps)
    else:
        return _result("Media Offline", "content", FAIL,
                        f"{frozen_count} eingefrorene(s) Segment(e) mit {total_dur:.1f}s (mögliches Media Offline)",
                        {"frozen_count": frozen_count, "total_duration": total_dur},
                        timestamps)


def _check_noise(noise_results, config):
    if noise_results.get('status') == 'error':
        return _result("Rauschen", "content", WARN,
                        f"Analyse fehlgeschlagen: {noise_results.get('message', '')}")

    avg_tout = noise_results.get('avg_tout', 0)
    noisy_pct = noise_results.get('noisy_percentage', 0)
    threshold = config.get('noise_threshold_tout', 0.10)
    segments = noise_results.get('noisy_segments', [])

    timestamps = [{"start": s['start'], "end": s['end'],
                    "description": f"Verrauschtes Segment (TOUT: {s['avg_tout']:.3f})"}
                   for s in segments]

    if avg_tout <= threshold and noisy_pct <= 5:
        return _result("Rauschen", "content", PASS,
                        f"Durchschn. TOUT: {avg_tout:.4f} (Schwelle: {threshold}), {noisy_pct:.1f}% verrauscht",
                        {"avg_tout": avg_tout, "threshold": threshold, "noisy_pct": noisy_pct},
                        timestamps)
    elif avg_tout <= threshold * 2 and noisy_pct <= 25:
        return _result("Rauschen", "content", WARN,
                        f"Erhöhtes Rauschen: TOUT {avg_tout:.4f}, {noisy_pct:.1f}% der Frames betroffen",
                        {"avg_tout": avg_tout, "threshold": threshold, "noisy_pct": noisy_pct},
                        timestamps)
    else:
        return _result("Rauschen", "content", FAIL,
                        f"Starkes Rauschen: TOUT {avg_tout:.4f}, {noisy_pct:.1f}% der Frames betroffen",
                        {"avg_tout": avg_tout, "threshold": threshold, "noisy_pct": noisy_pct},
                        timestamps)


def _check_clipping(clipping):
    if clipping.get('status') == 'error':
        return _result("Audio-Übersteuerung", "audio", WARN,
                        f"Analyse fehlgeschlagen: {clipping.get('message', '')}")

    has_clip = clipping.get('has_clipping', False)
    clip_pct = clipping.get('clipping_percentage', 0)
    max_peak = clipping.get('max_peak_level_db', -100)

    if not has_clip and max_peak < -0.5:
        return _result("Audio-Übersteuerung", "audio", PASS,
                        f"Keine Übersteuerung erkannt (Peak: {max_peak:.1f} dB)",
                        {"max_peak_db": max_peak, "clipping_pct": clip_pct})
    elif not has_clip or clip_pct < 0.1:
        return _result("Audio-Übersteuerung", "audio", WARN,
                        f"Peak nahe an 0 dBFS ({max_peak:.1f} dB), {clip_pct:.3f}% Clipping",
                        {"max_peak_db": max_peak, "clipping_pct": clip_pct})
    else:
        return _result("Audio-Übersteuerung", "audio", FAIL,
                        f"Übersteuerung erkannt! Peak: {max_peak:.1f} dB, {clip_pct:.2f}% der Frames betroffen",
                        {"max_peak_db": max_peak, "clipping_pct": clip_pct})


def _check_fuck_frames(fuck_frames):
    if fuck_frames.get('status') == 'error':
        return _result("Fehlschnitte (Fuck Frames)", "content", WARN,
                        f"Analyse fehlgeschlagen: {fuck_frames.get('message', '')}")

    count = fuck_frames.get('flash_count', 0)
    frames_list = fuck_frames.get('flash_frames', [])

    timestamps = [{"start": max(0, ff['start'] - 0.5), "end": ff['end'] + 0.5,
                    "description": f"Fehlschnitt ({ff['frame_count']} Frame{'s' if ff['frame_count'] != 1 else ''}, {ff['duration']:.3f}s)"}
                   for ff in frames_list]

    if count == 0:
        return _result("Fehlschnitte (Fuck Frames)", "content", PASS,
                        "Keine Fehlschnitte erkannt",
                        {"flash_count": 0}, timestamps)
    elif count <= 2:
        return _result("Fehlschnitte (Fuck Frames)", "content", WARN,
                        f"{count} mögliche(r) Fehlschnitt(e) erkannt — bitte manuell prüfen",
                        {"flash_count": count, "frames": frames_list}, timestamps)
    else:
        return _result("Fehlschnitte (Fuck Frames)", "content", FAIL,
                        f"{count} Fehlschnitte erkannt — Einzelframes im Export",
                        {"flash_count": count, "frames": frames_list}, timestamps)


def _result(name, category, status, message, details=None, timestamps=None):
    return {
        "name": name,
        "category": category,
        "status": status,
        "message": message,
        "details": details or {},
        "timestamps": timestamps or [],
    }
