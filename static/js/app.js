document.addEventListener('DOMContentLoaded', async () => {
    const uploader = new FileUploader();
    const renderer = new ResultsRenderer();
    const analyzeBtn = document.getElementById('analyze-btn');
    const channelSelect = document.getElementById('channel-select');
    const channelDesc = document.getElementById('channel-description');
    const toggleAllBtn = document.getElementById('toggle-all-checks');

    const sections = {
        upload: document.getElementById('upload-section'),
        progress: document.getElementById('progress-section'),
        results: document.getElementById('results-section'),
        error: document.getElementById('error-section'),
    };

    let pollInterval = null;

    // Load channels
    try {
        const res = await fetch('/api/channels');
        const channels = await res.json();
        channels.forEach(ch => {
            const opt = document.createElement('option');
            opt.value = ch.id;
            opt.textContent = ch.label;
            channelSelect.appendChild(opt);
        });

        channelSelect.addEventListener('change', () => {
            const ch = channels.find(c => c.id === channelSelect.value);
            channelDesc.textContent = ch ? ch.description : '';
        });
        channelSelect.dispatchEvent(new Event('change'));
    } catch (e) {
        console.error('Failed to load channels:', e);
    }

    // Toggle all checks button
    toggleAllBtn.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('#analysis-checks input[type="checkbox"]');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        checkboxes.forEach(cb => cb.checked = !allChecked);
        toggleAllBtn.textContent = allChecked ? 'Alle auswählen' : 'Alle abwählen';
    });

    // Update toggle button text when individual checkboxes change
    document.getElementById('analysis-checks').addEventListener('change', () => {
        const checkboxes = document.querySelectorAll('#analysis-checks input[type="checkbox"]');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        toggleAllBtn.textContent = allChecked ? 'Alle abwählen' : 'Alle auswählen';
    });

    // File events
    uploader.onFileSelected = () => { analyzeBtn.disabled = false; };
    uploader.onFileRemoved = () => { analyzeBtn.disabled = true; };

    // Get enabled steps from checkboxes
    function getEnabledSteps() {
        const checkboxes = document.querySelectorAll('#analysis-checks input[type="checkbox"]:checked');
        return Array.from(checkboxes).map(cb => cb.value);
    }

    // Analyze
    analyzeBtn.addEventListener('click', async () => {
        if (!uploader.selectedFile) return;

        // Determine if this is audio-only
        const file = uploader.selectedFile;
        const isAudioOnly = file.type.startsWith('audio/') ||
            /\.(mp3|wav|aac|flac|ogg|wma|m4a|aiff|aif)$/i.test(file.name);

        // Set file for the player (video or audio)
        renderer.setMediaFile(file, isAudioOnly);

        showSection('progress');
        resetProgressUI();

        const formData = new FormData();
        formData.append('file', file);
        formData.append('channel', channelSelect.value);

        // Send enabled steps
        const enabledSteps = getEnabledSteps();
        formData.append('enabled_steps', JSON.stringify(enabledSteps));

        // Use XMLHttpRequest for upload progress on large files
        const xhr = new XMLHttpRequest();
        const progressText = document.getElementById('progress-text');
        const progressBar = document.getElementById('progress-bar');

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = `${pct}%`;
                const loaded = formatFileSize(e.loaded);
                const total = formatFileSize(e.total);
                progressText.textContent = `Datei wird hochgeladen... ${loaded} / ${total} (${pct}%)`;
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
                renderer.setJobId(jobId);
                startPolling(jobId);
            } catch (e) {
                showError('Ungültige Server-Antwort');
            }
        });

        xhr.addEventListener('error', () => {
            showError('Verbindungsfehler beim Hochladen');
        });

        xhr.addEventListener('timeout', () => {
            showError('Upload-Timeout — Datei zu groß oder Verbindung zu langsam');
        });

        xhr.open('POST', '/api/analyze');
        xhr.timeout = 0; // no timeout for large uploads
        xhr.send(formData);
    });

    // Reset
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

    function startPolling(jobId) {
        stopPolling();
        // Poll every 500ms
        pollInterval = setInterval(() => pollStatus(jobId), 500);
        // Also poll immediately
        pollStatus(jobId);
    }

    function stopPolling() {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
    }

    async function pollStatus(jobId) {
        try {
            const res = await fetch(`/api/status/${jobId}`);
            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Status-Abfrage fehlgeschlagen');
                return;
            }

            updateProgressUI(data);

            if (data.status === 'complete') {
                stopPolling();

                // Check if server detected audio-only (no video stream)
                const serverAudioOnly = data.result.metadata && !data.result.metadata.video && data.result.metadata.audio;
                if (serverAudioOnly && !renderer._isAudioOnly) {
                    // File had a video extension but no video stream — switch to audio mode
                    renderer._isAudioOnly = true;
                    const audio = document.getElementById('qc-audio');
                    if (audio && renderer._videoUrl) {
                        audio.src = renderer._videoUrl;
                        renderer._audioElement = audio;
                    }
                }

                // Short delay to show 100% before switching
                setTimeout(() => {
                    showSection('results');
                    renderer.renderOverall(data.result.overall, data.result.channel_label);
                    renderer.renderMetadata(data.result.metadata);
                    renderer.renderChecks(data.result.checks);

                    // Pass clipping/loudness data for waveform markers
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
            // Network error - keep polling, might be transient
            console.warn('Poll error:', e);
        }
    }

    function updateProgressUI(data) {
        const bar = document.getElementById('progress-bar');
        const text = document.getElementById('progress-text');
        const elapsed = document.getElementById('elapsed-time');
        const remaining = document.getElementById('remaining-time');
        const stepList = document.getElementById('step-list');

        // Progress bar
        bar.style.width = `${Math.min(data.progress_percent, 100)}%`;

        // Current step text
        text.textContent = data.current_step_label || 'Wird vorbereitet...';

        // Time displays
        elapsed.textContent = data.elapsed_formatted || '0s';

        if (data.remaining_seconds > 0) {
            remaining.textContent = `~${data.remaining_formatted}`;
        } else if (data.status === 'complete') {
            remaining.textContent = 'Fertig!';
        } else {
            remaining.textContent = 'Berechnung...';
        }

        // Step list
        if (data.steps && data.steps.length > 0) {
            stepList.innerHTML = data.steps.map(step => {
                const icon = stepIcon(step.status);
                const timeStr = stepTimeStr(step);
                return `
                    <div class="step-item" data-status="${step.status}">
                        <span class="step-icon step-icon-${step.status}">${icon}</span>
                        <span class="step-label">${stripEllipsis(step.label)}</span>
                        <span class="step-time">${timeStr}</span>
                    </div>
                `;
            }).join('');
        }
    }

    function stepIcon(status) {
        switch (status) {
            case 'done':
                return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
            case 'running':
                return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
            case 'skipped':
                return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
            default: // pending
                return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
        }
    }

    function stepTimeStr(step) {
        if (step.status === 'done' && step.actual_duration != null) {
            return formatSeconds(step.actual_duration);
        }
        if (step.status === 'running') {
            return `~${formatSeconds(step.estimated_duration)}`;
        }
        if (step.status === 'skipped') {
            return '\u2014';
        }
        // pending
        if (step.estimated_duration > 0) {
            return `~${formatSeconds(step.estimated_duration)}`;
        }
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

    function stripEllipsis(label) {
        return label.replace(/\.\.\.$/g, '');
    }

    function formatFileSize(bytes) {
        if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
        if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
        return (bytes / 1e3).toFixed(0) + ' KB';
    }

    function initFilters() {
        document.querySelectorAll('.filter-btn').forEach(btn => {
            // Clone & replace to remove any prior listeners
            const fresh = btn.cloneNode(true);
            btn.parentNode.replaceChild(fresh, btn);
            fresh.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                fresh.classList.add('active');
                const filter = fresh.dataset.filter;
                document.querySelectorAll('.check-item').forEach(item => {
                    if (filter === 'all') {
                        item.hidden = false;
                    } else {
                        item.hidden = item.dataset.status !== filter;
                    }
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
                    const formData = new FormData();
                    formData.append('file', uploader.selectedFile);
                    formData.append('channel', channelSelect.value);

                    const response = await fetch('/api/normalize', {
                        method: 'POST',
                        body: formData,
                    });

                    if (!response.ok) {
                        const err = await response.json().catch(() => ({}));
                        throw new Error(err.error || 'Normalisierung fehlgeschlagen');
                    }

                    // Download the normalized file
                    const blob = await response.blob();
                    const baseName = uploader.selectedFile.name.replace(/\.[^.]+$/, '');
                    const ext = uploader.selectedFile.name.match(/\.[^.]+$/)?.[0] || '.wav';
                    const outExt = ['.mp4','.mov','.mkv','.wav','.flac','.m4a'].includes(ext.toLowerCase()) ? ext : '.wav';
                    const downloadName = `${baseName}_normalized${outExt}`;

                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = downloadName;
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
                    // Allow retry after 3 seconds
                    setTimeout(() => {
                        btn.querySelector('.normalize-btn-text').textContent = 'Audio normalisieren';
                    }, 3000);
                }
            });
        });
    }
});
