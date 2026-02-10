document.addEventListener('DOMContentLoaded', async () => {
    const uploader = new FileUploader();
    const renderer = new ResultsRenderer();
    const analyzeBtn = document.getElementById('analyze-btn');
    const channelSelect = document.getElementById('channel-select');
    const channelDesc = document.getElementById('channel-description');
    const toggleAllBtn = document.getElementById('toggle-all-checks');
    const modeInfo = document.getElementById('mode-info');

    const sections = {
        upload: document.getElementById('upload-section'),
        loading: document.getElementById('loading-section'),
        progress: document.getElementById('progress-section'),
        results: document.getElementById('results-section'),
        error: document.getElementById('error-section'),
    };

    let currentMode = 'browser'; // 'browser' or 'cloud'
    let browserAnalyzer = null;
    let pollInterval = null;

    // --- Mode Switcher ---
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentMode = btn.dataset.mode;

            if (currentMode === 'browser') {
                modeInfo.textContent = 'Analyse direkt im Browser via ffmpeg.wasm \u2014 keine Daten werden hochgeladen.';
            } else {
                modeInfo.textContent = 'Analyse auf Cloud-Server \u2014 Datei wird verschl\u00fcsselt hochgeladen und nach der Analyse gel\u00f6scht.';
            }
        });
    });

    // --- Load channels from config.js (client-side) ---
    for (const [key, cfg] of Object.entries(CHANNEL_CONFIGS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = cfg.label;
        channelSelect.appendChild(opt);
    }

    channelSelect.addEventListener('change', () => {
        const cfg = CHANNEL_CONFIGS[channelSelect.value];
        channelDesc.textContent = cfg ? cfg.description : '';
    });
    channelSelect.dispatchEvent(new Event('change'));

    // --- Toggle all checks ---
    toggleAllBtn.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('#analysis-checks input[type="checkbox"]');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        checkboxes.forEach(cb => cb.checked = !allChecked);
        toggleAllBtn.textContent = allChecked ? 'Alle ausw\u00e4hlen' : 'Alle abw\u00e4hlen';
    });

    document.getElementById('analysis-checks').addEventListener('change', () => {
        const checkboxes = document.querySelectorAll('#analysis-checks input[type="checkbox"]');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        toggleAllBtn.textContent = allChecked ? 'Alle abw\u00e4hlen' : 'Alle ausw\u00e4hlen';
    });

    // --- File events ---
    uploader.onFileSelected = () => { analyzeBtn.disabled = false; };
    uploader.onFileRemoved = () => { analyzeBtn.disabled = true; };

    function getEnabledSteps() {
        return Array.from(document.querySelectorAll('#analysis-checks input[type="checkbox"]:checked')).map(cb => cb.value);
    }

    // --- Analyze ---
    analyzeBtn.addEventListener('click', async () => {
        if (!uploader.selectedFile) return;

        const file = uploader.selectedFile;
        const isAudioOnly = file.type.startsWith('audio/') ||
            /\.(mp3|wav|aac|flac|ogg|wma|m4a|aiff|aif)$/i.test(file.name);

        renderer.setMediaFile(file, isAudioOnly);

        if (currentMode === 'browser') {
            await analyzeBrowser(file, isAudioOnly);
        } else {
            await analyzeCloud(file, isAudioOnly);
        }
    });

    // --- Browser Mode (ffmpeg.wasm) ---
    async function analyzeBrowser(file, isAudioOnly) {
        try {
            // Load ffmpeg.wasm if needed
            if (!browserAnalyzer || !browserAnalyzer.isLoaded) {
                showSection('loading');
                browserAnalyzer = new BrowserAnalyzer();
                try {
                    await browserAnalyzer.load();
                } catch (loadErr) {
                    browserAnalyzer = null; // Reset so next attempt retries loading
                    throw loadErr;
                }
            }

            showSection('progress');
            resetProgressUI();

            const startTime = Date.now();
            const enabledSteps = getEnabledSteps();

            // Track progress via callbacks
            browserAnalyzer.onProgress = (stepKey, label, pct) => {
                document.getElementById('progress-text').textContent = label;
                document.getElementById('progress-bar').style.width = `${pct}%`;
                const elapsed = (Date.now() - startTime) / 1000;
                document.getElementById('elapsed-time').textContent = formatSeconds(elapsed);
            };

            const result = await browserAnalyzer.analyze(file, channelSelect.value, enabledSteps);

            // Check if server detected audio-only
            if (result.metadata && !result.metadata.video && result.metadata.audio) {
                if (!isAudioOnly) {
                    renderer._isAudioOnly = true;
                    const audio = document.getElementById('qc-audio');
                    if (audio && renderer._videoUrl) {
                        audio.src = renderer._videoUrl;
                        renderer._audioElement = audio;
                    }
                }
            }

            showSection('results');
            renderer.renderOverall(result.overall, result.channel_label);
            renderer.renderMetadata(result.metadata);
            renderer.renderChecks(result.checks);

            renderer.setAnalysisData(
                { segments: result.clipping_segments || [] },
                { segments: result.loud_segments || [] }
            );

            renderer.renderTimeline(result.checks, result.metadata.duration);
            initFilters();
            initNormalizeButton();

        } catch (e) {
            console.error('Browser analysis error:', e);
            showError(`Analyse fehlgeschlagen: ${e.message}`);
        }
    }

    // --- Cloud Mode (Flask backend on Render) ---
    async function analyzeCloud(file, isAudioOnly) {
        showSection('progress');
        resetProgressUI();

        const formData = new FormData();
        formData.append('file', file);
        formData.append('channel', channelSelect.value);
        formData.append('enabled_steps', JSON.stringify(getEnabledSteps()));

        const xhr = new XMLHttpRequest();
        const progressText = document.getElementById('progress-text');
        const progressBar = document.getElementById('progress-bar');

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = `${pct}%`;
                progressText.textContent = `Datei wird hochgeladen... ${formatFileSize(e.loaded)} / ${formatFileSize(e.total)} (${pct}%)`;
            }
        });

        xhr.addEventListener('load', () => {
            try {
                const data = JSON.parse(xhr.responseText);
                if (xhr.status !== 200) {
                    showError(data.error || 'Analyse fehlgeschlagen');
                    return;
                }
                progressBar.style.width = '0%';
                progressText.textContent = 'Wird vorbereitet...';
                const jobId = data.job_id;
                startPolling(jobId, isAudioOnly);
            } catch (e) {
                showError('Ung\u00fcltige Server-Antwort');
            }
        });

        xhr.addEventListener('error', () => {
            showError('Verbindungsfehler \u2014 Cloud-Server nicht erreichbar. Versuche den Browser-Modus.');
        });

        xhr.addEventListener('timeout', () => {
            showError('Upload-Timeout \u2014 Datei zu gro\u00df oder Verbindung zu langsam');
        });

        xhr.open('POST', `${CLOUD_API_URL}/api/analyze`);
        xhr.timeout = 0;
        xhr.send(formData);
    }

    function startPolling(jobId, isAudioOnly) {
        stopPolling();
        pollInterval = setInterval(() => pollStatus(jobId, isAudioOnly), 500);
        pollStatus(jobId, isAudioOnly);
    }

    function stopPolling() {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }

    async function pollStatus(jobId, isAudioOnly) {
        try {
            const res = await fetch(`${CLOUD_API_URL}/api/status/${jobId}`);
            const data = await res.json();

            if (!res.ok) { showError(data.error || 'Status-Abfrage fehlgeschlagen'); return; }

            updateProgressUI(data);

            if (data.status === 'complete') {
                stopPolling();

                const serverAudioOnly = data.result.metadata && !data.result.metadata.video && data.result.metadata.audio;
                if (serverAudioOnly && !renderer._isAudioOnly) {
                    renderer._isAudioOnly = true;
                    const audio = document.getElementById('qc-audio');
                    if (audio && renderer._videoUrl) {
                        audio.src = renderer._videoUrl;
                        renderer._audioElement = audio;
                    }
                }

                setTimeout(() => {
                    showSection('results');
                    renderer.renderOverall(data.result.overall, data.result.channel_label);
                    renderer.renderMetadata(data.result.metadata);
                    renderer.renderChecks(data.result.checks);
                    renderer.setAnalysisData(
                        { segments: data.result.clipping_segments || [] },
                        { segments: data.result.loud_segments || [] }
                    );
                    renderer.renderTimeline(data.result.checks, data.result.metadata.duration);
                    initFilters();
                    initNormalizeButton();
                }, 400);
            }

            if (data.status === 'error') {
                showError(data.error || 'Analyse fehlgeschlagen');
            }
        } catch (e) {
            console.warn('Poll error:', e);
        }
    }

    function updateProgressUI(data) {
        const bar = document.getElementById('progress-bar');
        const text = document.getElementById('progress-text');
        const elapsed = document.getElementById('elapsed-time');
        const remaining = document.getElementById('remaining-time');
        const stepList = document.getElementById('step-list');

        bar.style.width = `${Math.min(data.progress_percent, 100)}%`;
        text.textContent = data.current_step_label || 'Wird vorbereitet...';
        elapsed.textContent = data.elapsed_formatted || '0s';

        if (data.remaining_seconds > 0) remaining.textContent = `~${data.remaining_formatted}`;
        else if (data.status === 'complete') remaining.textContent = 'Fertig!';
        else remaining.textContent = 'Berechnung...';

        if (data.steps && data.steps.length > 0) {
            stepList.innerHTML = data.steps.map(step => {
                const icon = stepIcon(step.status);
                const timeStr = stepTimeStr(step);
                return `<div class="step-item" data-status="${step.status}">
                    <span class="step-icon step-icon-${step.status}">${icon}</span>
                    <span class="step-label">${step.label.replace(/\.\.\.$/g, '')}</span>
                    <span class="step-time">${timeStr}</span>
                </div>`;
            }).join('');
        }
    }

    // --- Reset ---
    document.getElementById('reset-btn').addEventListener('click', reset);
    document.getElementById('error-reset-btn').addEventListener('click', reset);

    function reset() {
        stopPolling();
        renderer.cleanup();
        showSection('upload');
        uploader.clear();
        analyzeBtn.disabled = true;
    }

    function showSection(name) {
        Object.values(sections).forEach(s => s.hidden = true);
        if (sections[name]) sections[name].hidden = false;
    }

    function showError(msg) {
        stopPolling();
        document.getElementById('error-message').textContent = msg;
        showSection('error');
    }

    function resetProgressUI() {
        document.getElementById('progress-bar').style.width = '0%';
        document.getElementById('progress-text').textContent = 'Wird vorbereitet...';
        document.getElementById('elapsed-time').textContent = '0s';
        document.getElementById('remaining-time').textContent = 'Berechnung...';
        document.getElementById('step-list').innerHTML = '';
    }

    function stepIcon(status) {
        switch (status) {
            case 'done': return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
            case 'running': return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
            case 'skipped': return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
            default: return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
        }
    }

    function stepTimeStr(step) {
        if (step.status === 'done' && step.actual_duration != null) return formatSeconds(step.actual_duration);
        if (step.status === 'running') return `~${formatSeconds(step.estimated_duration)}`;
        if (step.status === 'skipped') return '\u2014';
        if (step.estimated_duration > 0) return `~${formatSeconds(step.estimated_duration)}`;
        return '';
    }

    function formatSeconds(s) {
        if (s == null) return '';
        s = Math.max(0, Math.round(s));
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}m ${sec.toString().padStart(2, '0')}s`;
    }

    function formatFileSize(bytes) {
        if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
        if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
        return (bytes / 1e3).toFixed(0) + ' KB';
    }

    function initFilters() {
        document.querySelectorAll('.filter-btn').forEach(btn => {
            const fresh = btn.cloneNode(true);
            btn.parentNode.replaceChild(fresh, btn);
            fresh.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                fresh.classList.add('active');
                const filter = fresh.dataset.filter;
                document.querySelectorAll('.check-item').forEach(item => {
                    if (filter === 'all') item.hidden = false;
                    else item.hidden = item.dataset.status !== filter;
                });
            });
        });
    }

    function initNormalizeButton() {
        document.querySelectorAll('.normalize-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (btn.classList.contains('processing') || btn.classList.contains('done')) return;
                if (!uploader.selectedFile) return;

                btn.classList.add('processing');
                btn.querySelector('.normalize-btn-text').textContent = 'Normalisierung l\u00e4uft...';
                btn.querySelector('.normalize-spinner').hidden = false;

                try {
                    const config = CHANNEL_CONFIGS[channelSelect.value];
                    const targetLufs = config.target_lufs;
                    const targetTp = config.max_true_peak_dbfs || -1.0;

                    let blob, filename;

                    if (currentMode === 'browser') {
                        // Browser mode: use ffmpeg.wasm
                        if (!browserAnalyzer || !browserAnalyzer.isLoaded) {
                            browserAnalyzer = new BrowserAnalyzer();
                            await browserAnalyzer.load();
                        }
                        const result = await browserAnalyzer.normalize(uploader.selectedFile, targetLufs, targetTp);
                        blob = result.blob;
                        filename = result.filename;
                    } else {
                        // Cloud mode: upload to server
                        const formData = new FormData();
                        formData.append('file', uploader.selectedFile);
                        formData.append('channel', channelSelect.value);

                        const response = await fetch(`${CLOUD_API_URL}/api/normalize`, {
                            method: 'POST',
                            body: formData,
                        });

                        if (!response.ok) {
                            const err = await response.json().catch(() => ({}));
                            throw new Error(err.error || 'Normalisierung fehlgeschlagen');
                        }

                        blob = await response.blob();
                        const baseName = uploader.selectedFile.name.replace(/\.[^.]+$/, '');
                        const ext = uploader.selectedFile.name.match(/\.[^.]+$/)?.[0] || '.wav';
                        const outExt = ['.mp4','.mov','.mkv','.wav','.flac','.m4a'].includes(ext.toLowerCase()) ? ext : '.wav';
                        filename = `${baseName}_normalized${outExt}`;
                    }

                    // Trigger download
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);

                    btn.classList.remove('processing');
                    btn.classList.add('done');
                    btn.querySelector('.normalize-btn-text').textContent = 'Download gestartet \u2713';
                    btn.querySelector('.normalize-spinner').hidden = true;

                } catch (e) {
                    btn.classList.remove('processing');
                    btn.querySelector('.normalize-btn-text').textContent = `Fehler: ${e.message}`;
                    btn.querySelector('.normalize-spinner').hidden = true;
                    setTimeout(() => {
                        btn.querySelector('.normalize-btn-text').textContent = 'Audio normalisieren';
                    }, 3000);
                }
            });
        });
    }
});
