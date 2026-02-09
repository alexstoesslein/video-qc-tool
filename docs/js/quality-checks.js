/**
 * Quality checks — ported from Python analyzers/quality_checks.py
 */

const PASS = "pass";
const WARN = "warning";
const FAIL = "fail";

function runQualityChecks(metadata, blackFrames, mediaOffline, noiseResults, loudness, clipping, fuckFrames, config, enabledSteps) {
    const checks = [];

    // Metadata-based checks always run
    checks.push(checkResolution(metadata, config));
    checks.push(checkBitrate(metadata, config));
    checks.push(checkFramerate(metadata, config));
    checks.push(checkAudioSampleRate(metadata, config));
    checks.push(checkAudioChannels(metadata, config));

    if (!enabledSteps || enabledSteps.includes("loudness")) {
        checks.push(checkLoudness(loudness, config));
        checks.push(checkTruePeak(loudness, config));
    }
    if (!enabledSteps || enabledSteps.includes("black_frames")) {
        checks.push(checkBlackFrames(blackFrames, config));
    }
    if (!enabledSteps || enabledSteps.includes("media_offline")) {
        checks.push(checkMediaOffline(mediaOffline, config));
    }
    if (!enabledSteps || enabledSteps.includes("noise")) {
        checks.push(checkNoise(noiseResults, config));
    }
    if (!enabledSteps || enabledSteps.includes("clipping")) {
        checks.push(checkClipping(clipping));
    }
    if (!enabledSteps || enabledSteps.includes("fuck_frames")) {
        checks.push(checkFuckFrames(fuckFrames));
    }

    return checks;
}

function aggregateResults(checks) {
    const statuses = checks.map(c => c.status);
    let overall;
    if (statuses.includes(FAIL)) overall = FAIL;
    else if (statuses.includes(WARN)) overall = WARN;
    else overall = PASS;

    const scoreMap = { [PASS]: 1.0, [WARN]: 0.5, [FAIL]: 0.0 };
    const scores = statuses.map(s => scoreMap[s] || 0);
    const numericScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100) : 0;

    const passCount = statuses.filter(s => s === PASS).length;
    const warnCount = statuses.filter(s => s === WARN).length;
    const failCount = statuses.filter(s => s === FAIL).length;

    return {
        status: overall,
        score: numericScore,
        total_checks: checks.length,
        pass_count: passCount,
        warning_count: warnCount,
        fail_count: failCount,
        summary: `${passCount} bestanden, ${warnCount} Warnungen, ${failCount} fehlgeschlagen`,
    };
}

function _result(name, category, status, message, details, timestamps) {
    return { name, category, status, message, details: details || {}, timestamps: timestamps || [] };
}

function checkResolution(metadata, config) {
    const video = metadata.video;
    if (!video && config.video_optional)
        return _result("Aufl\u00f6sung", "video", PASS, "Kein Video-Stream (akzeptabel f\u00fcr diesen Kanal)");
    if (!video)
        return _result("Aufl\u00f6sung", "video", FAIL, "Kein Video-Stream erkannt");

    const w = video.width, h = video.height;
    const minW = config.min_resolution.width, minH = config.min_resolution.height;
    const landscapeOk = w >= minW && h >= minH;
    const portraitOk = w >= minH && h >= minW;
    const pixelOk = (w * h) >= (minW * minH);

    if (landscapeOk || portraitOk)
        return _result("Aufl\u00f6sung", "video", PASS, `${w}x${h} erf\u00fcllt Minimum ${minW}x${minH}`, { actual: `${w}x${h}`, required: `${minW}x${minH}` });
    else if (pixelOk)
        return _result("Aufl\u00f6sung", "video", WARN, `${w}x${h} hat genug Pixel, aber ungew\u00f6hnliches Seitenverh\u00e4ltnis`, { actual: `${w}x${h}`, required: `${minW}x${minH}` });
    else
        return _result("Aufl\u00f6sung", "video", FAIL, `${w}x${h} liegt unter Minimum ${minW}x${minH}`, { actual: `${w}x${h}`, required: `${minW}x${minH}` });
}

function checkBitrate(metadata, config) {
    const bitrate = metadata.overall_bitrate_kbps || 0;
    const minBr = config.min_bitrate_kbps;
    if (bitrate >= minBr)
        return _result("Bitrate", "video", PASS, `${Math.round(bitrate)} kbps erf\u00fcllt Minimum ${minBr} kbps`, { actual_kbps: bitrate, required_kbps: minBr });
    else if (bitrate >= minBr * 0.75)
        return _result("Bitrate", "video", WARN, `${Math.round(bitrate)} kbps liegt knapp unter Minimum ${minBr} kbps`, { actual_kbps: bitrate, required_kbps: minBr });
    else
        return _result("Bitrate", "video", FAIL, `${Math.round(bitrate)} kbps liegt deutlich unter Minimum ${minBr} kbps`, { actual_kbps: bitrate, required_kbps: minBr });
}

function checkFramerate(metadata, config) {
    const video = metadata.video;
    if (!video && config.video_optional)
        return _result("Framerate", "video", PASS, "Kein Video-Stream (akzeptabel f\u00fcr diesen Kanal)");
    if (!video)
        return _result("Framerate", "video", FAIL, "Kein Video-Stream erkannt");

    const fps = video.framerate;
    const accepted = config.accepted_framerates || [];
    const minFps = config.min_framerate || 24.0;
    const exactMatch = accepted.some(a => Math.abs(fps - a) < 0.05);
    const closeMatch = accepted.some(a => Math.abs(fps - a) < 1.0);

    if (exactMatch)
        return _result("Framerate", "video", PASS, `${fps} fps ist ein akzeptierter Wert`, { actual_fps: fps, accepted });
    else if (closeMatch && fps >= minFps)
        return _result("Framerate", "video", WARN, `${fps} fps weicht leicht von akzeptierten Werten ab`, { actual_fps: fps, accepted });
    else
        return _result("Framerate", "video", FAIL, `${fps} fps ist kein akzeptierter Wert (erwartet: ${JSON.stringify(accepted)})`, { actual_fps: fps, accepted });
}

function checkAudioSampleRate(metadata, config) {
    const audio = metadata.audio;
    if (!audio) return _result("Audio Sample Rate", "audio", FAIL, "Kein Audio-Stream erkannt");
    const rate = audio.sample_rate;
    const minRate = config.min_audio_sample_rate || 44100;
    if (rate >= minRate)
        return _result("Audio Sample Rate", "audio", PASS, `${rate} Hz erf\u00fcllt Minimum ${minRate} Hz`, { actual_hz: rate, required_hz: minRate });
    else if (rate >= 22050)
        return _result("Audio Sample Rate", "audio", WARN, `${rate} Hz liegt unter empfohlenem Minimum ${minRate} Hz`, { actual_hz: rate, required_hz: minRate });
    else
        return _result("Audio Sample Rate", "audio", FAIL, `${rate} Hz ist zu niedrig (Minimum: ${minRate} Hz)`, { actual_hz: rate, required_hz: minRate });
}

function checkAudioChannels(metadata, config) {
    const audio = metadata.audio;
    if (!audio) return _result("Audio-Kan\u00e4le", "audio", FAIL, "Kein Audio-Stream erkannt");
    const channels = audio.channels;
    const minCh = config.min_audio_channels || 2;
    const prefCh = config.preferred_audio_channels;
    const layout = audio.channel_layout || '';

    if (prefCh && channels >= prefCh)
        return _result("Audio-Kan\u00e4le", "audio", PASS, `${channels} Kan\u00e4le (${layout}) - bevorzugte Konfiguration`, { actual: channels, minimum: minCh, preferred: prefCh });
    else if (channels >= minCh) {
        let msg = `${channels} Kan\u00e4le (${layout}) erf\u00fcllt Minimum`;
        if (prefCh) {
            msg += ` (bevorzugt: ${prefCh} Kan\u00e4le)`;
            return _result("Audio-Kan\u00e4le", "audio", WARN, msg, { actual: channels, minimum: minCh, preferred: prefCh });
        }
        return _result("Audio-Kan\u00e4le", "audio", PASS, msg, { actual: channels, minimum: minCh });
    } else
        return _result("Audio-Kan\u00e4le", "audio", FAIL, `${channels} Kan\u00e4le liegt unter Minimum ${minCh}`, { actual: channels, minimum: minCh });
}

function checkLoudness(loudness, config) {
    if (loudness.status === 'error')
        return _result("Lautst\u00e4rke (LUFS)", "audio", FAIL, `Messung fehlgeschlagen: ${loudness.message || ''}`);

    const target = config.target_lufs;
    const tolerance = config.lufs_tolerance;
    const integrated = loudness.integrated_lufs;
    if (integrated == null)
        return _result("Lautst\u00e4rke (LUFS)", "audio", FAIL, "Keine LUFS-Daten verf\u00fcgbar");

    const diff = Math.abs(integrated - target);
    if (diff <= tolerance)
        return _result("Lautst\u00e4rke (LUFS)", "audio", PASS, `${integrated.toFixed(1)} LUFS im Zielbereich ${target.toFixed(0)} \u00b1${tolerance.toFixed(0)} LUFS`, { measured_lufs: integrated, target, tolerance, deviation: Math.round(diff * 10) / 10 });
    else if (diff <= tolerance * 2)
        return _result("Lautst\u00e4rke (LUFS)", "audio", WARN, `${integrated.toFixed(1)} LUFS au\u00dferhalb Zielbereich (${(target - tolerance).toFixed(0)} bis ${(target + tolerance).toFixed(0)} LUFS)`, { measured_lufs: integrated, target, tolerance, deviation: Math.round(diff * 10) / 10 });
    else
        return _result("Lautst\u00e4rke (LUFS)", "audio", FAIL, `${integrated.toFixed(1)} LUFS weicht stark vom Ziel ${target.toFixed(0)} LUFS ab`, { measured_lufs: integrated, target, tolerance, deviation: Math.round(diff * 10) / 10 });
}

function checkTruePeak(loudness, config) {
    if (loudness.status === 'error')
        return _result("True Peak", "audio", FAIL, `Messung fehlgeschlagen: ${loudness.message || ''}`);

    const maxTp = config.max_true_peak_dbfs || -1.0;
    const tp = loudness.true_peak_dbfs;
    if (tp == null)
        return _result("True Peak", "audio", WARN, "Keine True-Peak-Daten verf\u00fcgbar");

    if (tp <= maxTp)
        return _result("True Peak", "audio", PASS, `${tp.toFixed(1)} dBFS unter Maximum ${maxTp.toFixed(1)} dBFS`, { measured_dbfs: tp, max_dbfs: maxTp });
    else if (tp <= maxTp + 1.0)
        return _result("True Peak", "audio", WARN, `${tp.toFixed(1)} dBFS \u00fcberschreitet Maximum ${maxTp.toFixed(1)} dBFS leicht`, { measured_dbfs: tp, max_dbfs: maxTp });
    else
        return _result("True Peak", "audio", FAIL, `${tp.toFixed(1)} dBFS \u00fcberschreitet Maximum ${maxTp.toFixed(1)} dBFS deutlich`, { measured_dbfs: tp, max_dbfs: maxTp });
}

function checkBlackFrames(blackFrames, config) {
    if (blackFrames.status === 'error')
        return _result("Schwarzbilder", "content", WARN, `Analyse fehlgeschlagen: ${blackFrames.message || ''}`);

    const count = blackFrames.count || 0;
    const totalDur = blackFrames.total_black_duration || 0;
    const maxDur = config.black_frame_max_duration || 3.0;
    const intervals = blackFrames.intervals || [];

    const timestamps = intervals.map(iv => ({ start: iv.start, end: iv.end, description: `Schwarzbild (${iv.duration.toFixed(1)}s)` }));

    if (count === 0)
        return _result("Schwarzbilder", "content", PASS, "Keine Schwarzbilder erkannt", {}, timestamps);
    else if (totalDur <= maxDur)
        return _result("Schwarzbilder", "content", WARN, `${count} Schwarzbild-Segment(e) erkannt (${totalDur.toFixed(1)}s gesamt)`, { count, total_duration: totalDur, max_allowed: maxDur }, timestamps);
    else
        return _result("Schwarzbilder", "content", FAIL, `${count} Schwarzbild-Segment(e) mit ${totalDur.toFixed(1)}s gesamt (Max: ${maxDur.toFixed(1)}s)`, { count, total_duration: totalDur, max_allowed: maxDur }, timestamps);
}

function checkMediaOffline(mediaOffline, config) {
    if (mediaOffline.status === 'error')
        return _result("Media Offline", "content", WARN, `Analyse fehlgeschlagen: ${mediaOffline.message || ''}`);

    const frozenCount = mediaOffline.frozen_count || 0;
    const totalDur = mediaOffline.total_frozen_duration || 0;
    const intervals = mediaOffline.frozen_intervals || [];
    const timestamps = intervals.map(iv => ({ start: iv.start, end: iv.end, description: `Eingefrorenes Bild (${iv.duration.toFixed(1)}s)` }));

    if (frozenCount === 0)
        return _result("Media Offline", "content", PASS, "Keine eingefrorenen Frames erkannt", {}, timestamps);
    else if (totalDur <= 5.0)
        return _result("Media Offline", "content", WARN, `${frozenCount} eingefrorene(s) Segment(e) erkannt (${totalDur.toFixed(1)}s)`, { frozen_count: frozenCount, total_duration: totalDur }, timestamps);
    else
        return _result("Media Offline", "content", FAIL, `${frozenCount} eingefrorene(s) Segment(e) mit ${totalDur.toFixed(1)}s (m\u00f6gliches Media Offline)`, { frozen_count: frozenCount, total_duration: totalDur }, timestamps);
}

function checkNoise(noiseResults, config) {
    if (noiseResults.status === 'error')
        return _result("Rauschen", "content", WARN, `Analyse fehlgeschlagen: ${noiseResults.message || ''}`);

    const avgTout = noiseResults.avg_tout || 0;
    const noisyPct = noiseResults.noisy_percentage || 0;
    const threshold = config.noise_threshold_tout || 0.10;
    const segments = noiseResults.noisy_segments || [];
    const timestamps = segments.map(s => ({ start: s.start, end: s.end, description: `Verrauschtes Segment (TOUT: ${s.avg_tout.toFixed(3)})` }));

    if (avgTout <= threshold && noisyPct <= 5)
        return _result("Rauschen", "content", PASS, `Durchschn. TOUT: ${avgTout.toFixed(4)} (Schwelle: ${threshold}), ${noisyPct.toFixed(1)}% verrauscht`, { avg_tout: avgTout, threshold, noisy_pct: noisyPct }, timestamps);
    else if (avgTout <= threshold * 2 && noisyPct <= 25)
        return _result("Rauschen", "content", WARN, `Erh\u00f6htes Rauschen: TOUT ${avgTout.toFixed(4)}, ${noisyPct.toFixed(1)}% der Frames betroffen`, { avg_tout: avgTout, threshold, noisy_pct: noisyPct }, timestamps);
    else
        return _result("Rauschen", "content", FAIL, `Starkes Rauschen: TOUT ${avgTout.toFixed(4)}, ${noisyPct.toFixed(1)}% der Frames betroffen`, { avg_tout: avgTout, threshold, noisy_pct: noisyPct }, timestamps);
}

function checkClipping(clipping) {
    if (clipping.status === 'error')
        return _result("Audio-\u00dcbersteuerung", "audio", WARN, `Analyse fehlgeschlagen: ${clipping.message || ''}`);

    const hasClip = clipping.has_clipping || false;
    const clipPct = clipping.clipping_percentage || 0;
    const maxPeak = clipping.max_peak_level_db || -100;

    if (!hasClip && maxPeak < -0.5)
        return _result("Audio-\u00dcbersteuerung", "audio", PASS, `Keine \u00dcbersteuerung erkannt (Peak: ${maxPeak.toFixed(1)} dB)`, { max_peak_db: maxPeak, clipping_pct: clipPct });
    else if (!hasClip || clipPct < 0.1)
        return _result("Audio-\u00dcbersteuerung", "audio", WARN, `Peak nahe an 0 dBFS (${maxPeak.toFixed(1)} dB), ${clipPct.toFixed(3)}% Clipping`, { max_peak_db: maxPeak, clipping_pct: clipPct });
    else
        return _result("Audio-\u00dcbersteuerung", "audio", FAIL, `\u00dcbersteuerung erkannt! Peak: ${maxPeak.toFixed(1)} dB, ${clipPct.toFixed(2)}% der Frames betroffen`, { max_peak_db: maxPeak, clipping_pct: clipPct });
}

function checkFuckFrames(fuckFrames) {
    if (fuckFrames.status === 'error')
        return _result("Fehlschnitte (Fuck Frames)", "content", WARN, `Analyse fehlgeschlagen: ${fuckFrames.message || ''}`);

    const count = fuckFrames.flash_count || 0;
    const framesList = fuckFrames.flash_frames || [];
    const timestamps = framesList.map(ff => ({
        start: Math.max(0, ff.start - 0.5),
        end: ff.end + 0.5,
        description: `Fehlschnitt (${ff.frame_count} Frame${ff.frame_count !== 1 ? 's' : ''}, ${ff.duration.toFixed(3)}s)`
    }));

    if (count === 0)
        return _result("Fehlschnitte (Fuck Frames)", "content", PASS, "Keine Fehlschnitte erkannt", { flash_count: 0 }, timestamps);
    else if (count <= 2)
        return _result("Fehlschnitte (Fuck Frames)", "content", WARN, `${count} m\u00f6gliche(r) Fehlschnitt(e) erkannt \u2014 bitte manuell pr\u00fcfen`, { flash_count: count, frames: framesList }, timestamps);
    else
        return _result("Fehlschnitte (Fuck Frames)", "content", FAIL, `${count} Fehlschnitte erkannt \u2014 Einzelframes im Export`, { flash_count: count, frames: framesList }, timestamps);
}
