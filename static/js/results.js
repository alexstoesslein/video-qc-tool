class ResultsRenderer {
    constructor() {
        this._videoElement = null;
        this._audioElement = null;
        this._videoUrl = null;
        this._isAudioOnly = false;
        this._waveformDrawn = false;
        this._clippingData = null;
        this._loudnessData = null;
    }

    /**
     * Set media file — handles both video and audio-only files.
     */
    setMediaFile(file, isAudioOnly) {
        if (this._videoUrl) {
            URL.revokeObjectURL(this._videoUrl);
        }
        this._videoUrl = URL.createObjectURL(file);
        this._isAudioOnly = isAudioOnly;
        this._jobId = null;

        if (isAudioOnly) {
            this._audioElement = document.getElementById('qc-audio');
            this._audioElement.src = this._videoUrl;
            this._videoElement = null;
        } else {
            this._videoElement = document.getElementById('qc-video');
            this._videoElement.src = this._videoUrl;
            this._audioElement = null;
        }
    }

    /**
     * Set the job ID for waveform loading.
     */
    setJobId(jobId) {
        this._jobId = jobId;
    }

    /**
     * Legacy method — calls setMediaFile with video mode.
     */
    setVideoFile(file) {
        this.setMediaFile(file, false);
    }

    /**
     * Seek the media (video or audio) to a given timestamp and show overlay.
     */
    seekTo(seconds, label, status) {
        const media = this._isAudioOnly
            ? (this._audioElement || document.getElementById('qc-audio'))
            : (this._videoElement || document.getElementById('qc-video'));
        if (!media || !media.src) return;

        media.currentTime = Math.max(0, seconds);
        media.play().catch(() => {});

        // Scroll into view
        const section = document.getElementById('timeline-section');
        if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Show overlay badge (video only)
        if (label && !this._isAudioOnly) {
            const overlay = document.getElementById('player-overlay');
            const overlayText = document.getElementById('player-overlay-text');
            overlay.hidden = false;
            overlay.dataset.status = status || 'warning';
            overlayText.textContent = label;
            // Reset animation
            overlay.style.animation = 'none';
            overlay.offsetHeight; // trigger reflow
            overlay.style.animation = '';
        }
    }

    renderOverall(overall, channelLabel) {
        const card = document.getElementById('overall-card');
        const badge = document.getElementById('overall-badge');
        const text = document.getElementById('overall-text');
        const summary = document.getElementById('overall-summary');
        const channel = document.getElementById('overall-channel');

        card.dataset.status = overall.status;
        badge.className = `badge badge-${overall.status}`;

        const icons = { pass: '\u2713', warning: '!', fail: '\u2717' };
        badge.textContent = icons[overall.status] || '?';

        const labels = {
            pass: 'Alle Pr\u00fcfungen bestanden',
            warning: 'Bestanden mit Warnungen',
            fail: 'Qualit\u00e4tspr\u00fcfung fehlgeschlagen'
        };
        text.textContent = labels[overall.status] || 'Unbekannt';
        summary.textContent = overall.summary;
        channel.textContent = `Kanal: ${channelLabel}`;

        this._renderScoreRing(overall.score);

        document.getElementById('stat-pass').textContent = overall.pass_count;
        document.getElementById('stat-warn').textContent = overall.warning_count;
        document.getElementById('stat-fail').textContent = overall.fail_count;
    }

    _renderScoreRing(score) {
        const ring = document.getElementById('score-ring');
        const r = 36;
        const circ = 2 * Math.PI * r;
        const offset = circ * (1 - score / 100);
        const status = score >= 80 ? 'pass' : score >= 50 ? 'warning' : 'fail';

        ring.innerHTML = `
            <svg viewBox="0 0 90 90">
                <circle class="ring-bg" cx="45" cy="45" r="${r}"
                    stroke-dasharray="${circ}" stroke-dashoffset="0"/>
                <circle class="ring-fg" cx="45" cy="45" r="${r}"
                    stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
                    data-status="${status}"/>
                <text x="45" y="45" class="ring-text"
                    text-anchor="middle" dominant-baseline="central"
                    transform="rotate(90 45 45)">${score}%</text>
            </svg>`;
    }

    renderMetadata(metadata) {
        const grid = document.getElementById('metadata-grid');
        const items = [
            ['Dateiname', metadata.filename],
            ['Dauer', metadata.duration_formatted],
            ['Dateigr\u00f6\u00dfe', this._formatSize(metadata.file_size_bytes)],
            ['Gesamt-Bitrate', `${Math.round(metadata.overall_bitrate_kbps)} kbps`],
        ];

        if (metadata.video) {
            items.push(
                ['Video-Codec', `${metadata.video.codec}${metadata.video.profile ? ' (' + metadata.video.profile + ')' : ''}`],
                ['Aufl\u00f6sung', `${metadata.video.width}x${metadata.video.height}`],
                ['Framerate', `${metadata.video.framerate} fps`],
                ['Video-Bitrate', metadata.video.bitrate_kbps ? `${Math.round(metadata.video.bitrate_kbps)} kbps` : 'N/A'],
                ['Pixel-Format', metadata.video.pix_fmt || 'N/A'],
                ['Farbraum', metadata.video.color_space || 'N/A'],
            );
        }

        if (metadata.audio) {
            items.push(
                ['Audio-Codec', metadata.audio.codec],
                ['Sample Rate', `${metadata.audio.sample_rate} Hz`],
                ['Audio-Kan\u00e4le', `${metadata.audio.channels}${metadata.audio.channel_layout ? ' (' + metadata.audio.channel_layout + ')' : ''}`],
                ['Audio-Bitrate', metadata.audio.bitrate_kbps ? `${Math.round(metadata.audio.bitrate_kbps)} kbps` : 'N/A'],
            );
        }

        grid.innerHTML = items.map(([label, value]) => `
            <div class="meta-item">
                <span class="meta-label">${label}</span>
                <span class="meta-value">${value}</span>
            </div>
        `).join('');
    }

    renderChecks(checks) {
        const list = document.getElementById('checks-list');
        const self = this;

        list.innerHTML = checks.map(check => `
            <div class="check-item" data-status="${check.status}" data-category="${check.category}">
                <span class="check-icon check-icon-${check.status}">
                    ${this._statusIcon(check.status)}
                </span>
                <div class="check-body">
                    <span class="check-name">${check.name}</span>
                    <span class="check-category">${check.category}</span>
                    <p class="check-message">${check.message}</p>
                    ${check.timestamps && check.timestamps.length > 0 ? this._renderTimestamps(check.timestamps, check.status) : ''}
                </div>
            </div>
        `).join('');

        // Attach click handlers to timestamp items
        list.querySelectorAll('[data-seek-to]').forEach(el => {
            el.addEventListener('click', () => {
                const t = parseFloat(el.dataset.seekTo);
                const label = el.dataset.seekLabel || '';
                const status = el.dataset.seekStatus || 'warning';
                self.seekTo(t, label, status);
            });
        });
    }

    /**
     * Store clipping/loudness analysis data for waveform markers.
     */
    setAnalysisData(clippingData, loudnessData) {
        this._clippingData = clippingData;
        this._loudnessData = loudnessData;
    }

    renderTimeline(checks, totalDuration) {
        const section = document.getElementById('timeline-section');
        const sectionTitle = section.querySelector('h3');
        const videoWrapper = document.getElementById('video-player-wrapper');
        const audioWrapper = document.getElementById('audio-waveform-wrapper');
        const allTs = [];
        checks.forEach(c => {
            if (c.timestamps) {
                c.timestamps.forEach(ts => {
                    allTs.push({ ...ts, checkName: c.name, status: c.status });
                });
            }
        });

        // Always show for audio-only files; for video, show if there are issues or media
        const hasMedia = this._videoUrl != null;
        if (!this._isAudioOnly && allTs.length === 0 && !hasMedia) {
            section.hidden = true;
            return;
        }

        section.hidden = false;

        // Toggle video vs audio player and update title
        if (this._isAudioOnly) {
            videoWrapper.hidden = true;
            audioWrapper.hidden = false;
            sectionTitle.textContent = 'Audiowiedergabe';
            this._loadWaveformImage(totalDuration);
            this._startWaveformPlayhead();
            this._renderWaveformMarkers(totalDuration);
        } else {
            videoWrapper.hidden = false;
            audioWrapper.hidden = true;
            sectionTitle.textContent = allTs.length > 0
                ? 'Erkannte Probleme (Timeline)'
                : 'Medienwiedergabe';
        }

        const bar = document.getElementById('timeline-bar');
        const endLabel = document.getElementById('timeline-end');
        const list = document.getElementById('timeline-list');
        const timelineContainer = document.querySelector('.timeline-container');
        const self = this;

        endLabel.textContent = this._formatTime(totalDuration);

        if (allTs.length > 0) {
            if (timelineContainer) timelineContainer.hidden = false;
            // Render timeline markers (clickable)
            bar.innerHTML = allTs.map((ts, i) => {
                const left = totalDuration > 0 ? (ts.start / totalDuration) * 100 : 0;
                const width = totalDuration > 0 ? Math.max(((ts.end - ts.start) / totalDuration) * 100, 0.5) : 0.5;
                return `<div class="timeline-marker timeline-marker-${ts.status}"
                            style="left:${left}%;width:${width}%"
                            data-marker-idx="${i}"
                            title="${ts.checkName}: ${ts.description}"></div>`;
            }).join('');

            // Timeline list items (clickable)
            list.innerHTML = allTs.map((ts, i) => `
                <div class="timeline-item" data-timeline-idx="${i}">
                    <span class="timeline-dot timeline-dot-${ts.status}"></span>
                    <strong>${this._formatTime(ts.start)} - ${this._formatTime(ts.end)}</strong>
                    <span>${ts.checkName}: ${ts.description}</span>
                    <span class="jump-icon">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>
                    </span>
                </div>
            `).join('');

            // Attach click handlers to markers
            bar.querySelectorAll('[data-marker-idx]').forEach(el => {
                const idx = parseInt(el.dataset.markerIdx);
                const ts = allTs[idx];
                el.style.cursor = 'pointer';
                el.addEventListener('click', () => {
                    self.seekTo(ts.start, `${ts.checkName}: ${ts.description}`, ts.status);
                });
            });

            // Attach click handlers to list items
            list.querySelectorAll('[data-timeline-idx]').forEach(el => {
                const idx = parseInt(el.dataset.timelineIdx);
                const ts = allTs[idx];
                el.addEventListener('click', () => {
                    self.seekTo(ts.start, `${ts.checkName}: ${ts.description}`, ts.status);
                });
            });
        } else {
            if (timelineContainer) timelineContainer.hidden = true;
            bar.innerHTML = '';
            list.innerHTML = '';
        }
    }

    cleanup() {
        if (this._videoUrl) {
            URL.revokeObjectURL(this._videoUrl);
            this._videoUrl = null;
        }
        this._isAudioOnly = false;
        this._jobId = null;
        this._clippingData = null;
        this._loudnessData = null;
        if (this._waveformRAF) {
            cancelAnimationFrame(this._waveformRAF);
            this._waveformRAF = null;
        }
        const video = document.getElementById('qc-video');
        if (video) {
            video.removeAttribute('src');
            video.load();
        }
        const audio = document.getElementById('qc-audio');
        if (audio) {
            audio.removeAttribute('src');
            audio.load();
        }
        const img = document.getElementById('waveform-img');
        if (img) img.removeAttribute('src');
    }

    /**
     * Load server-generated waveform image.
     */
    _loadWaveformImage(totalDuration) {
        const img = document.getElementById('waveform-img');
        const container = document.getElementById('waveform-img-container');
        if (!img || !this._jobId) return;

        img.src = `/api/waveform/${this._jobId}`;
        img.onerror = () => {
            // Waveform not available — show fallback
            img.style.display = 'none';
            container.innerHTML = '<div class="waveform-loading">Keine Waveform verfügbar</div>';
        };

        // Click on waveform to seek
        const self = this;
        container.addEventListener('click', (e) => {
            const audio = self._audioElement || document.getElementById('qc-audio');
            if (!audio || !audio.duration) return;
            const rect = container.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const progress = x / rect.width;
            audio.currentTime = progress * audio.duration;
            audio.play().catch(() => {});
        });
    }

    /**
     * Animate playhead over waveform image synced to audio playback.
     */
    _startWaveformPlayhead() {
        const audio = this._audioElement || document.getElementById('qc-audio');
        const playhead = document.getElementById('waveform-playhead');
        const container = document.getElementById('waveform-img-container');
        if (!audio || !playhead || !container) return;

        const update = () => {
            if (audio.duration && audio.duration > 0) {
                const progress = audio.currentTime / audio.duration;
                const pct = progress * 100;
                playhead.style.left = `${pct}%`;
            }
            this._waveformRAF = requestAnimationFrame(update);
        };

        this._waveformRAF = requestAnimationFrame(update);
    }

    /**
     * Render clipping/loudness markers as overlays on the waveform image.
     */
    _renderWaveformMarkers(totalDuration) {
        const container = document.getElementById('waveform-img-container');
        const legend = document.getElementById('waveform-legend');
        if (!container || !totalDuration || totalDuration <= 0) return;

        // Remove any existing markers
        container.querySelectorAll('.waveform-marker').forEach(el => el.remove());

        let hasClipping = false;
        let hasLoud = false;

        // Clipping markers (red)
        if (this._clippingData && this._clippingData.segments && this._clippingData.segments.length > 0) {
            hasClipping = true;
            this._clippingData.segments.forEach(seg => {
                const left = (seg.start / totalDuration) * 100;
                const width = Math.max(((seg.end - seg.start) / totalDuration) * 100, 0.3);
                const marker = document.createElement('div');
                marker.className = 'waveform-marker waveform-marker-clipping';
                marker.style.left = `${left}%`;
                marker.style.width = `${width}%`;
                marker.title = `\u00dcbersteuerung: ${this._formatTime(seg.start)} - ${this._formatTime(seg.end)}`;
                container.appendChild(marker);
            });
        }

        // Loudness markers (amber) — extreme loudness segments
        if (this._loudnessData && this._loudnessData.segments && this._loudnessData.segments.length > 0) {
            hasLoud = true;
            this._loudnessData.segments.forEach(seg => {
                const left = (seg.start / totalDuration) * 100;
                const width = Math.max(((seg.end - seg.start) / totalDuration) * 100, 0.3);
                const marker = document.createElement('div');
                marker.className = 'waveform-marker waveform-marker-loud';
                marker.style.left = `${left}%`;
                marker.style.width = `${width}%`;
                marker.title = `Extreme Lautst\u00e4rke: ${this._formatTime(seg.start)} (${seg.level.toFixed(1)} dB)`;
                container.appendChild(marker);
            });
        }

        // Show legend if there are any markers
        if (legend) {
            legend.hidden = !(hasClipping || hasLoud);
        }
    }

    _renderTimestamps(timestamps, checkStatus) {
        return `<ul class="timestamp-list">
            ${timestamps.map(ts =>
                `<li data-seek-to="${ts.start}" data-seek-label="${ts.description}" data-seek-status="${checkStatus}">${this._formatTime(ts.start)} - ${this._formatTime(ts.end)}: ${ts.description}</li>`
            ).join('')}
        </ul>`;
    }

    _statusIcon(status) {
        const svgs = {
            pass: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>',
            warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            fail: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        };
        return svgs[status] || '';
    }

    _formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    _formatSize(bytes) {
        if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
        if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
        return (bytes / 1e3).toFixed(0) + ' KB';
    }
}
