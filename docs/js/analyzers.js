/**
 * Browser-side analysis engine using ffmpeg.wasm
 *
 * Uses @ffmpeg/ffmpeg v0.12 (ESM via CDN).
 * SharedArrayBuffer is required — enabled via coi-serviceworker.js
 */

class BrowserAnalyzer {
    constructor() {
        this._ffmpeg = null;
        this._loaded = false;
        this.onProgress = null; // callback(stepKey, stepLabel, percent)
    }

    async load() {
        if (this._loaded) return;

        // Dynamic import of ffmpeg.wasm ESM build from CDN
        const { FFmpeg } = await import(
            'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js'
        );

        this._ffmpeg = new FFmpeg();

        this._ffmpeg.on('log', ({ message }) => {
            this._lastLog = message;
        });

        this._ffmpeg.on('progress', ({ progress }) => {
            this._currentProgress = Math.round(progress * 100);
        });

        // Load the multi-threaded core (requires SharedArrayBuffer via coi-serviceworker)
        await this._ffmpeg.load({
            coreURL: 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.js',
            wasmURL: 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.wasm',
            workerURL: 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.worker.js',
        });

        this._loaded = true;
    }

    _report(stepKey, label) {
        if (this.onProgress) this.onProgress(stepKey, label, this._currentProgress || 0);
    }

    /**
     * Run full analysis pipeline on a File object.
     * Returns the same result structure as the Flask backend.
     */
    async analyze(file, channelKey, enabledSteps) {
        if (!this._loaded) throw new Error("ffmpeg.wasm not loaded");

        const config = CHANNEL_CONFIGS[channelKey];
        if (!config) throw new Error(`Unknown channel: ${channelKey}`);

        const inputName = 'input' + this._getExtension(file.name);
        const data = new Uint8Array(await file.arrayBuffer());
        await this._ffmpeg.writeFile(inputName, data);

        const results = {};

        // 1. Metadata via ffprobe emulation
        this._report("metadata", "Metadaten werden extrahiert...");
        results.metadata = await this._extractMetadata(inputName, file);

        const hasVideo = results.metadata.video != null;
        const hasAudio = results.metadata.audio != null;
        const duration = results.metadata.duration || 0;

        // 2. Black frames
        if (hasVideo && (!enabledSteps || enabledSteps.includes("black_frames"))) {
            this._report("black_frames", "Schwarzbilder werden gesucht...");
            results.black_frames = await this._detectBlackFrames(inputName);
        } else {
            results.black_frames = { intervals: [], total_black_duration: 0, count: 0 };
        }

        // 3. Media offline (freeze detect)
        if (hasVideo && (!enabledSteps || enabledSteps.includes("media_offline"))) {
            this._report("media_offline", "Media Offline wird gepr\u00fcft...");
            results.media_offline = await this._detectFreezeFrames(inputName);
        } else {
            results.media_offline = { frozen_intervals: [], frozen_count: 0, total_frozen_duration: 0 };
        }

        // 4. Noise
        if (hasVideo && (!enabledSteps || enabledSteps.includes("noise"))) {
            this._report("noise", "Videorauschen wird analysiert...");
            results.noise = await this._detectNoise(inputName, config);
        } else {
            results.noise = { avg_tout: 0, max_tout: 0, noisy_frame_count: 0, total_frames: 0, noisy_percentage: 0, noisy_segments: [] };
        }

        // 5. Loudness
        if (hasAudio && (!enabledSteps || enabledSteps.includes("loudness"))) {
            this._report("loudness", "Audiolautst\u00e4rke wird gemessen...");
            results.loudness = await this._measureLoudness(inputName);
        } else {
            results.loudness = { status: "error", message: "Kein Audio-Stream" };
        }

        // 6. Clipping
        if (hasAudio && (!enabledSteps || enabledSteps.includes("clipping"))) {
            this._report("clipping", "Audio-\u00dcbersteuerung wird gepr\u00fcft...");
            results.clipping = await this._detectClipping(inputName, duration);
        } else {
            results.clipping = { status: "error", message: "Kein Audio-Stream" };
        }

        // 7. Fuck frames
        if (hasVideo && (!enabledSteps || enabledSteps.includes("fuck_frames"))) {
            this._report("fuck_frames", "Fehlschnitte werden gesucht...");
            results.fuck_frames = await this._detectFuckFrames(inputName, config, results.metadata);
        } else {
            results.fuck_frames = { flash_frames: [], flash_count: 0 };
        }

        // 8. Quality checks
        this._report("checks", "Qualit\u00e4tspr\u00fcfungen werden ausgef\u00fchrt...");
        const checks = runQualityChecks(
            results.metadata, results.black_frames, results.media_offline,
            results.noise, results.loudness, results.clipping, results.fuck_frames,
            config, enabledSteps
        );
        const overall = aggregateResults(checks);

        // Cleanup
        try { await this._ffmpeg.deleteFile(inputName); } catch (e) {}

        return {
            status: "complete",
            channel: channelKey,
            channel_label: config.label,
            metadata: results.metadata,
            checks,
            overall,
            has_waveform: false,
            clipping_segments: (results.clipping.clipping_segments || []),
            loud_segments: (results.clipping.loud_segments || []),
        };
    }

    // --- Metadata ---
    async _extractMetadata(inputName, file) {
        // Use ffprobe-like approach: run ffmpeg with no output to get info from logs
        this._logs = [];
        const logHandler = ({ message }) => { this._logs.push(message); };
        this._ffmpeg.on('log', logHandler);

        try {
            // Run a no-op ffmpeg command that prints stream info
            await this._ffmpeg.exec(['-i', inputName, '-f', 'null', '-t', '0', '-']);
        } catch (e) {
            // ffmpeg returns non-zero for null output, that's fine
        }

        this._ffmpeg.off('log', logHandler);
        const logText = this._logs.join('\n');

        // Parse duration
        let duration = 0;
        const durMatch = logText.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durMatch) {
            duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
        }

        // Parse bitrate
        let overallBitrateKbps = 0;
        const brMatch = logText.match(/bitrate:\s*(\d+)\s*kb\/s/);
        if (brMatch) overallBitrateKbps = parseInt(brMatch[1]);

        // Parse video stream
        let videoInfo = null;
        const videoMatch = logText.match(/Stream\s+#\d+[:\d]*.*?Video:\s*(\w+).*?,\s*(\w+).*?,\s*(\d+)x(\d+)/);
        if (videoMatch) {
            const codec = videoMatch[1];
            const pixFmt = videoMatch[2];
            const width = parseInt(videoMatch[3]);
            const height = parseInt(videoMatch[4]);

            let framerate = 0;
            const fpsMatch = logText.match(/(\d+(?:\.\d+)?)\s*(?:fps|tbr)/);
            if (fpsMatch) framerate = parseFloat(fpsMatch[1]);

            let vBitrate = 0;
            const vBrMatch = logText.match(/Video:.*?(\d+)\s*kb\/s/);
            if (vBrMatch) vBitrate = parseInt(vBrMatch[1]);

            videoInfo = {
                codec, width, height,
                framerate: Math.round(framerate * 1000) / 1000,
                bitrate_kbps: vBitrate,
                pix_fmt: pixFmt,
                color_space: '', color_range: '', profile: '',
            };
        }

        // Parse audio stream
        let audioInfo = null;
        const audioMatch = logText.match(/Stream\s+#\d+[:\d]*.*?Audio:\s*(\w+).*?,\s*(\d+)\s*Hz,\s*(\w+)/);
        if (audioMatch) {
            const codec = audioMatch[1];
            const sampleRate = parseInt(audioMatch[2]);
            const layoutStr = audioMatch[3];
            let channels = 2;
            if (layoutStr === 'mono') channels = 1;
            else if (layoutStr === 'stereo') channels = 2;
            else if (layoutStr === '5.1') channels = 6;
            else if (layoutStr === '7.1') channels = 8;

            let aBitrate = 0;
            const aBrMatch = logText.match(/Audio:.*?(\d+)\s*kb\/s/);
            if (aBrMatch) aBitrate = parseInt(aBrMatch[1]);

            audioInfo = {
                codec, sample_rate: sampleRate, channels,
                channel_layout: layoutStr,
                bitrate_kbps: aBitrate,
            };
        }

        const formatDuration = (s) => {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = Math.floor(s % 60);
            if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
            return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        };

        return {
            filename: file.name,
            duration,
            duration_formatted: formatDuration(duration),
            file_size_bytes: file.size,
            overall_bitrate_kbps: overallBitrateKbps || (file.size * 8 / 1000 / Math.max(duration, 1)),
            video: videoInfo,
            audio: audioInfo,
        };
    }

    // --- Black Frames ---
    async _detectBlackFrames(inputName) {
        this._logs = [];
        const logHandler = ({ message }) => { this._logs.push(message); };
        this._ffmpeg.on('log', logHandler);

        try {
            await this._ffmpeg.exec([
                '-i', inputName,
                '-vf', 'blackdetect=d=0.5:pix_th=0.10:pic_th=0.98',
                '-an', '-f', 'null', '-'
            ]);
        } catch (e) {}

        this._ffmpeg.off('log', logHandler);
        const text = this._logs.join('\n');

        const pattern = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
        const intervals = [];
        let match;
        while ((match = pattern.exec(text)) !== null) {
            intervals.push({
                start: parseFloat(match[1]),
                end: parseFloat(match[2]),
                duration: parseFloat(match[3]),
            });
        }

        const total = intervals.reduce((s, i) => s + i.duration, 0);
        return { intervals, total_black_duration: Math.round(total * 100) / 100, count: intervals.length };
    }

    // --- Freeze Detect (Media Offline) ---
    async _detectFreezeFrames(inputName) {
        this._logs = [];
        const logHandler = ({ message }) => { this._logs.push(message); };
        this._ffmpeg.on('log', logHandler);

        try {
            await this._ffmpeg.exec([
                '-i', inputName,
                '-vf', 'freezedetect=n=0.003:d=2',
                '-an', '-f', 'null', '-'
            ]);
        } catch (e) {}

        this._ffmpeg.off('log', logHandler);
        const text = this._logs.join('\n');

        const starts = [], ends = [], durations = [];
        for (const line of text.split('\n')) {
            let m = line.match(/freeze_start:\s*([\d.]+)/);
            if (m) starts.push(parseFloat(m[1]));
            m = line.match(/freeze_end:\s*([\d.]+)/);
            if (m) ends.push(parseFloat(m[1]));
            m = line.match(/freeze_duration:\s*([\d.]+)/);
            if (m) durations.push(parseFloat(m[1]));
        }

        const intervals = [];
        const count = Math.min(starts.length, ends.length, durations.length);
        for (let i = 0; i < count; i++) {
            intervals.push({ start: starts[i], end: ends[i], duration: durations[i] });
        }
        const total = intervals.reduce((s, iv) => s + iv.duration, 0);

        return {
            frozen_intervals: intervals,
            frozen_count: intervals.length,
            total_frozen_duration: Math.round(total * 100) / 100,
        };
    }

    // --- Noise (signalstats TOUT) ---
    async _detectNoise(inputName, config) {
        this._logs = [];
        const logHandler = ({ message }) => { this._logs.push(message); };
        this._ffmpeg.on('log', logHandler);

        try {
            await this._ffmpeg.exec([
                '-i', inputName,
                '-vf', 'signalstats=stat=tout,metadata=mode=print',
                '-an', '-f', 'null', '-'
            ]);
        } catch (e) {}

        this._ffmpeg.off('log', logHandler);
        const text = this._logs.join('\n');

        const toutValues = [];
        const timestamps = [];
        let currentPts = 0;

        for (const line of text.split('\n')) {
            const ptsMatch = line.match(/pts_time:([\d.]+)/);
            if (ptsMatch) currentPts = parseFloat(ptsMatch[1]);
            const toutMatch = line.match(/TOUT=([\d.]+)/);
            if (toutMatch) {
                toutValues.push(parseFloat(toutMatch[1]));
                timestamps.push(currentPts);
            }
        }

        if (toutValues.length === 0) {
            return { avg_tout: 0, max_tout: 0, noisy_frame_count: 0, total_frames: 0, noisy_percentage: 0, noisy_segments: [] };
        }

        const threshold = config.noise_threshold_tout || 0.10;
        const avgTout = toutValues.reduce((a, b) => a + b, 0) / toutValues.length;
        const maxTout = Math.max(...toutValues);
        const noisyCount = toutValues.filter(v => v > threshold).length;

        // Find noisy segments
        const segments = [];
        let inSeg = false, segStart = 0, segValues = [];
        for (let i = 0; i < toutValues.length; i++) {
            if (toutValues[i] > threshold) {
                if (!inSeg) { inSeg = true; segStart = i; segValues = []; }
                segValues.push(toutValues[i]);
            } else {
                if (inSeg && segValues.length >= 5) {
                    segments.push({
                        start: Math.round((timestamps[segStart] || 0) * 100) / 100,
                        end: Math.round((timestamps[i - 1] || 0) * 100) / 100,
                        avg_tout: Math.round(segValues.reduce((a, b) => a + b, 0) / segValues.length * 10000) / 10000,
                        frames: segValues.length,
                    });
                }
                inSeg = false; segValues = [];
            }
        }
        if (inSeg && segValues.length >= 5) {
            segments.push({
                start: Math.round((timestamps[segStart] || 0) * 100) / 100,
                end: Math.round((timestamps[timestamps.length - 1] || 0) * 100) / 100,
                avg_tout: Math.round(segValues.reduce((a, b) => a + b, 0) / segValues.length * 10000) / 10000,
                frames: segValues.length,
            });
        }

        return {
            avg_tout: Math.round(avgTout * 10000) / 10000,
            max_tout: Math.round(maxTout * 10000) / 10000,
            noisy_frame_count: noisyCount,
            total_frames: toutValues.length,
            noisy_percentage: Math.round(noisyCount / toutValues.length * 10000) / 100,
            noisy_segments: segments,
        };
    }

    // --- Loudness (ebur128) ---
    async _measureLoudness(inputName) {
        this._logs = [];
        const logHandler = ({ message }) => { this._logs.push(message); };
        this._ffmpeg.on('log', logHandler);

        try {
            await this._ffmpeg.exec([
                '-i', inputName,
                '-af', 'ebur128=peak=true',
                '-vn', '-f', 'null', '-'
            ]);
        } catch (e) {}

        this._ffmpeg.off('log', logHandler);
        const text = this._logs.join('\n');

        // Find last Summary block
        const lines = text.split('\n');
        let summaryIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('Summary:')) summaryIdx = i;
        }
        if (summaryIdx === -1) return { status: "error", message: "Could not parse loudness data" };

        const block = lines.slice(summaryIdx).join('\n');

        const extractFloat = (pattern) => {
            const m = block.match(pattern);
            return m ? parseFloat(m[1]) : null;
        };

        const integrated = extractFloat(/I:\s+([-\d.]+)\s+LUFS/);
        if (integrated == null) return { status: "error", message: "Could not parse integrated loudness" };

        return {
            integrated_lufs: integrated,
            loudness_range_lu: extractFloat(/LRA:\s+([-\d.]+)\s+LU/),
            true_peak_dbfs: extractFloat(/Peak:\s+([-\d.]+)\s+dBFS/),
            lra_low_lufs: extractFloat(/LRA low:\s+([-\d.]+)\s+LUFS/),
            lra_high_lufs: extractFloat(/LRA high:\s+([-\d.]+)\s+LUFS/),
        };
    }

    // --- Clipping (astats) ---
    async _detectClipping(inputName, duration) {
        this._logs = [];
        const logHandler = ({ message }) => { this._logs.push(message); };
        this._ffmpeg.on('log', logHandler);

        try {
            await this._ffmpeg.exec([
                '-i', inputName,
                '-af', 'astats=metadata=1:reset=1',
                '-vn', '-f', 'null', '-'
            ]);
        } catch (e) {}

        this._ffmpeg.off('log', logHandler);
        const text = this._logs.join('\n');

        const peakLevels = [];
        const flatFactors = [];

        for (const line of text.split('\n')) {
            const pm = line.match(/Peak level dB:\s*([-\d.]+)/);
            if (pm) peakLevels.push(parseFloat(pm[1]));
            const fm = line.match(/Flat factor:\s*([\d.]+)/);
            if (fm) flatFactors.push(parseFloat(fm[1]));
        }

        const clippingCount = peakLevels.filter(p => p >= 0.0).length;
        const maxPeak = peakLevels.length > 0 ? Math.max(...peakLevels) : -100;
        const maxFlat = flatFactors.length > 0 ? Math.max(...flatFactors) : 0;
        const totalFrames = peakLevels.length;
        const spf = (duration && totalFrames > 0) ? duration / totalFrames : 0;

        // Find clipping segments
        const clippingSegments = [];
        if (clippingCount > 0 && totalFrames > 0) {
            let inClip = false, clipStart = 0;
            for (let i = 0; i < peakLevels.length; i++) {
                if (peakLevels[i] >= 0.0) {
                    if (!inClip) { inClip = true; clipStart = i; }
                } else if (inClip) {
                    clippingSegments.push({
                        start: Math.round(clipStart * spf * 1000) / 1000,
                        end: Math.round((i - 1) * spf * 1000) / 1000,
                    });
                    inClip = false;
                }
            }
            if (inClip) {
                clippingSegments.push({
                    start: Math.round(clipStart * spf * 1000) / 1000,
                    end: Math.round((totalFrames - 1) * spf * 1000) / 1000,
                });
            }
        }

        // Find loud segments
        const loudSegments = [];
        if (totalFrames > 0) {
            let inLoud = false, loudStart = 0, loudPeak = -100;
            for (let i = 0; i < peakLevels.length; i++) {
                const p = peakLevels[i];
                if (p >= -3.0 && p < 0.0) {
                    if (!inLoud) { inLoud = true; loudStart = i; loudPeak = p; }
                    else loudPeak = Math.max(loudPeak, p);
                } else if (inLoud) {
                    loudSegments.push({
                        start: Math.round(loudStart * spf * 1000) / 1000,
                        end: Math.round((i - 1) * spf * 1000) / 1000,
                        level: Math.round(loudPeak * 10) / 10,
                    });
                    inLoud = false;
                }
            }
            if (inLoud) {
                loudSegments.push({
                    start: Math.round(loudStart * spf * 1000) / 1000,
                    end: Math.round((totalFrames - 1) * spf * 1000) / 1000,
                    level: Math.round(loudPeak * 10) / 10,
                });
            }
        }

        return {
            max_peak_level_db: Math.round(maxPeak * 100) / 100,
            max_flat_factor: Math.round(maxFlat * 100) / 100,
            clipping_frame_count: clippingCount,
            total_frames_analyzed: totalFrames,
            has_clipping: clippingCount > 0,
            clipping_percentage: Math.round(clippingCount / Math.max(totalFrames, 1) * 100000) / 1000,
            clipping_segments: clippingSegments,
            loud_segments: loudSegments,
        };
    }

    // --- Fuck Frames (scene detection) ---
    async _detectFuckFrames(inputName, config, metadata) {
        const fps = metadata.video ? metadata.video.framerate : 0;
        if (fps <= 0) return { status: "error", message: "Framerate konnte nicht ermittelt werden" };

        const maxFlashFrames = 5;
        const sceneThreshold = config.scene_threshold || 0.35;

        this._logs = [];
        const logHandler = ({ message }) => { this._logs.push(message); };
        this._ffmpeg.on('log', logHandler);

        try {
            await this._ffmpeg.exec([
                '-i', inputName,
                '-vf', `select='gt(scene,${sceneThreshold})',showinfo`,
                '-vsync', 'vfr',
                '-f', 'null', '-'
            ]);
        } catch (e) {}

        this._ffmpeg.off('log', logHandler);
        const text = this._logs.join('\n');

        const sceneTimes = [];
        for (const line of text.split('\n')) {
            const m = line.match(/pts_time:\s*([\d.]+)/);
            if (m) sceneTimes.push(parseFloat(m[1]));
        }

        if (sceneTimes.length < 2) {
            return { flash_frames: [], flash_count: 0, scene_changes: sceneTimes.length, fps };
        }

        sceneTimes.sort((a, b) => a - b);

        const flashFrames = [];
        for (let i = 0; i < sceneTimes.length - 1; i++) {
            const gap = sceneTimes[i + 1] - sceneTimes[i];
            const frameCount = Math.round(gap * fps);
            if (frameCount > 0 && frameCount <= maxFlashFrames) {
                flashFrames.push({
                    start: Math.round(sceneTimes[i] * 1000) / 1000,
                    end: Math.round(sceneTimes[i + 1] * 1000) / 1000,
                    duration: Math.round(gap * 10000) / 10000,
                    frame_count: frameCount,
                });
            }
        }

        return {
            flash_frames: flashFrames,
            flash_count: flashFrames.length,
            scene_changes: sceneTimes.length,
            fps,
            max_flash_frames: maxFlashFrames,
        };
    }

    /**
     * Normalize audio using ffmpeg loudnorm (2-pass).
     * Returns { blob, filename } with the normalized file.
     */
    async normalize(file, targetLufs, targetTp) {
        if (!this._loaded) throw new Error("ffmpeg.wasm not loaded");

        const inputName = 'norm_input' + this._getExtension(file.name);
        const data = new Uint8Array(await file.arrayBuffer());
        await this._ffmpeg.writeFile(inputName, data);

        // Determine output format
        const ext = this._getExtension(file.name).toLowerCase();
        const isVideo = ['.mp4', '.mov', '.mkv', '.webm', '.ts', '.m2ts', '.avi'].includes(ext);
        const outExt = ['.mp4', '.mov', '.mkv', '.wav', '.flac', '.m4a'].includes(ext) ? ext : '.wav';
        const outputName = 'norm_output' + outExt;

        // Pass 1: Measure loudness with loudnorm
        this._logs = [];
        const logHandler = ({ message }) => { this._logs.push(message); };
        this._ffmpeg.on('log', logHandler);

        try {
            await this._ffmpeg.exec([
                '-i', inputName,
                '-af', `loudnorm=I=${targetLufs}:TP=${targetTp}:LRA=11:print_format=json`,
                '-f', 'null', '-'
            ]);
        } catch (e) {}

        this._ffmpeg.off('log', logHandler);
        const pass1Text = this._logs.join('\n');

        // Extract JSON measurement from loudnorm output
        const jsonMatch = pass1Text.match(/\{[^}]*"input_i"[^}]*\}/s);
        if (!jsonMatch) throw new Error("Loudnorm-Messung fehlgeschlagen (Pass 1)");

        const measured = JSON.parse(jsonMatch[0]);

        // Pass 2: Normalize with measured values
        const loudnormFilter = [
            `loudnorm=I=${targetLufs}:TP=${targetTp}:LRA=11`,
            `measured_I=${measured.input_i}`,
            `measured_TP=${measured.input_tp}`,
            `measured_LRA=${measured.input_lra}`,
            `measured_thresh=${measured.input_thresh}`,
            `offset=${measured.target_offset}`,
            `linear=true`
        ].join(':');

        const pass2Args = ['-i', inputName, '-af', loudnormFilter, '-ar', '48000'];

        // For video containers, copy video stream
        if (isVideo) {
            pass2Args.push('-c:v', 'copy');
        }

        pass2Args.push('-y', outputName);

        await this._ffmpeg.exec(pass2Args);

        // Read the output file
        const outputData = await this._ffmpeg.readFile(outputName);
        const mimeTypes = {
            '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
            '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
            '.mkv': 'video/x-matroska', '.webm': 'video/webm',
        };
        const blob = new Blob([outputData.buffer], { type: mimeTypes[outExt] || 'application/octet-stream' });

        // Cleanup
        try { await this._ffmpeg.deleteFile(inputName); } catch (e) {}
        try { await this._ffmpeg.deleteFile(outputName); } catch (e) {}

        const baseName = file.name.replace(/\.[^.]+$/, '');
        return { blob, filename: `${baseName}_normalized${outExt}` };
    }

    _getExtension(filename) {
        const dot = filename.lastIndexOf('.');
        return dot >= 0 ? filename.substring(dot) : '.mp4';
    }
}
