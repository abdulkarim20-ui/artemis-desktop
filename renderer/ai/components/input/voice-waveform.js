/**
 * ============================================================================
 * VOICE WAVEFORM (renderer/ai/components/input/voice-waveform.js)
 * ============================================================================
 * Ported from Codie's scrolling live waveform canvas.
 * Adapts automatically to the host container size (88px x 24px in Artemis).
 * ============================================================================
 */

(function (global) {
    'use strict';

    const PITCH = 6;
    const BAR_W = 2;
    const DOT = 2.4;
    const SCROLL_MS = 96;
    const REVEAL_MS = 720;
    const REVEAL_SOFT = 36;
    const EDGE_FADE = 18;
    const VOICE_GATE = 0.02;
    const MIN_BAR = 0.05;

    class VoiceWaveform {
        /**
         * @param {HTMLCanvasElement} canvas
         */
        constructor(canvas) {
            this.canvas = canvas;
            this.context = canvas ? canvas.getContext('2d') : null;
            this.audioContext = null;
            this.analyser = null;
            this.source = null;
            this.samples = null;
            this.frameId = null;
            this.startedAt = 0;
            this.lastPush = 0;
            this.level = 0;
            this.externalLevel = null;
            this.history = [];
            this.color = '#9a98a3';
            this.active = false;
            this.generation = 0;
            this.reducedMotion = Boolean(
                global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches
            );

            this.draw = this.draw.bind(this);
            this.resizeObserver = typeof ResizeObserver !== 'undefined'
                ? new ResizeObserver(() => this.resize())
                : null;

            if (this.canvas && this.resizeObserver) {
                this.resizeObserver.observe(this.canvas);
            }
        }

        /**
         * Start animating with a live MediaStream (or fallback to level-driven mode).
         * @param {MediaStream} [stream]
         */
        async start(stream) {
            this.stop();
            const generation = this.generation;
            this.active = true;
            this.startedAt = performance.now();
            this.lastPush = 0;
            this.history = [];
            this.externalLevel = null;

            if (this.canvas && typeof getComputedStyle === 'function') {
                this.color = getComputedStyle(this.canvas).color || this.color;
            }
            this.resize();

            const AudioCtx = global.AudioContext || global.webkitAudioContext;
            if (stream && AudioCtx) {
                let audioContext = null;
                let source = null;
                let analyser = null;
                try {
                    audioContext = new AudioCtx();
                    this.audioContext = audioContext;
                    source = audioContext.createMediaStreamSource(stream);
                    this.source = source;
                    analyser = audioContext.createAnalyser();
                    this.analyser = analyser;
                    analyser.fftSize = 512;
                    analyser.smoothingTimeConstant = 0.5;
                    source.connect(analyser);
                    this.samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
                    if (typeof audioContext.resume === 'function') {
                        audioContext.resume().catch(() => {});
                    }
                } catch (_) {
                    source?.disconnect();
                    analyser?.disconnect();
                    if (audioContext && this.audioContext === audioContext) {
                        this.disposeAudioGraph();
                    } else if (audioContext && audioContext.state !== 'closed') {
                        audioContext.close().catch(() => {});
                    }
                }
            }

            if (this.active && generation === this.generation && typeof requestAnimationFrame === 'function') {
                this.frameId = requestAnimationFrame(this.draw);
            }
        }

        /**
         * Optional fallback if an external normalized level (0..1) is pushed
         * when no MediaStream AudioContext is attached.
         * @param {number} level
         */
        setLevel(level) {
            this.externalLevel = Math.max(0, Math.min(1, Number(level) || 0));
        }

        stop() {
            this.generation += 1;
            this.active = false;
            if (this.frameId !== null && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(this.frameId);
            }
            this.frameId = null;
            this.disposeAudioGraph();
            this.level = 0;
            this.externalLevel = null;
            this.history = [];
            this.lastPush = 0;
            if (this.context && this.canvas) {
                this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
            }
        }

        destroy() {
            this.stop();
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
            }
        }

        resize() {
            if (!this.canvas) return;
            const rect = this.canvas.getBoundingClientRect();
            const cssWidth = rect.width || this.canvas.clientWidth || 88;
            const cssHeight = rect.height || this.canvas.clientHeight || 24;
            if (!cssWidth || !cssHeight) return;

            const dpr = global.devicePixelRatio || 1;
            const width = Math.round(cssWidth * dpr);
            const height = Math.round(cssHeight * dpr);

            if (this.canvas.width !== width || this.canvas.height !== height) {
                this.canvas.width = width;
                this.canvas.height = height;
            }
            if (this.context && typeof this.context.setTransform === 'function') {
                this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
            }

            const slots = Math.ceil(cssWidth / PITCH) + 2;
            if (this.history.length < slots) {
                this.history = new Array(slots - this.history.length).fill(0).concat(this.history);
            } else if (this.history.length > slots) {
                this.history = this.history.slice(this.history.length - slots);
            }
        }

        disposeAudioGraph() {
            try { this.source?.disconnect(); } catch (_) {}
            try { this.analyser?.disconnect(); } catch (_) {}
            this.source = null;
            this.analyser = null;
            this.samples = null;
            if (this.audioContext && this.audioContext.state !== 'closed') {
                this.audioContext.close().catch(() => {});
            }
            this.audioContext = null;
        }

        updateLevel() {
            let target = 0;
            if (this.analyser && this.samples) {
                this.analyser.getByteTimeDomainData(this.samples);
                let sumSquares = 0;
                for (let i = 0; i < this.samples.length; i += 1) {
                    const centered = (this.samples[i] - 128) / 128;
                    sumSquares += centered * centered;
                }
                const rms = this.samples.length ? Math.sqrt(sumSquares / this.samples.length) : 0;
                target = rms < VOICE_GATE ? 0 : Math.min(1, (rms - VOICE_GATE) * 7);
            } else if (this.externalLevel !== null) {
                target = this.externalLevel;
            }

            this.level += (target - this.level) * (target > this.level ? 0.45 : 0.18);
            if (this.level < 0.004) this.level = 0;
        }

        pushSample() {
            const value = this.level > MIN_BAR ? this.level * (0.55 + 0.45 * Math.random()) : 0;
            this.history.shift();
            this.history.push(value);
        }

        draw(now) {
            if (!this.active || !this.context || !this.canvas) return;

            const rect = this.canvas.getBoundingClientRect();
            const width = rect.width || this.canvas.clientWidth || 88;
            const height = rect.height || this.canvas.clientHeight || 24;
            if (!width || !height) {
                this.frameId = requestAnimationFrame(this.draw);
                return;
            }

            this.resize();
            this.updateLevel();

            if (this.lastPush === 0) this.lastPush = now;
            let pushes = 0;
            while (now - this.lastPush >= SCROLL_MS && pushes < 8) {
                this.pushSample();
                this.lastPush += SCROLL_MS;
                pushes += 1;
            }
            if (pushes >= 8) this.lastPush = now;

            const offset = this.reducedMotion ? 0 : ((now - this.lastPush) / SCROLL_MS) * PITCH;
            const ctx = this.context;
            const midY = height / 2;
            const maxBar = height - 4;
            const elapsed = now - this.startedAt;
            const reveal = this.reducedMotion
                ? Infinity
                : Math.min(1, elapsed / REVEAL_MS) * (width + REVEAL_SOFT);
            const n = this.history.length;

            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = this.color;

            for (let i = 0; i < n; i += 1) {
                const cx = width - PITCH / 2 - (n - 1 - i) * PITCH - offset;
                if (cx < -PITCH || cx > width + PITCH) continue;

                const sweep = Math.max(0, Math.min(1, (reveal - cx) / REVEAL_SOFT));
                const edge = Math.max(0, Math.min(1, cx / EDGE_FADE));
                const value = this.history[i];
                if (sweep <= 0 || edge <= 0) continue;

                ctx.beginPath();
                if (value > MIN_BAR) {
                    const barHeight = Math.max(DOT, value * maxBar);
                    ctx.globalAlpha = (0.55 + 0.45 * value) * sweep * edge;
                    if (typeof ctx.roundRect === 'function') {
                        ctx.roundRect(cx - BAR_W / 2, midY - barHeight / 2, BAR_W, barHeight, BAR_W / 2);
                    } else {
                        ctx.rect(cx - BAR_W / 2, midY - barHeight / 2, BAR_W, barHeight);
                    }
                } else {
                    ctx.globalAlpha = 0.42 * sweep * edge;
                    ctx.arc(cx, midY, DOT / 2, 0, Math.PI * 2);
                }
                ctx.fill();
            }

            ctx.globalAlpha = 1;
            this.frameId = requestAnimationFrame(this.draw);
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = VoiceWaveform;
    } else {
        global.VoiceWaveform = VoiceWaveform;
    }
})(typeof window !== 'undefined' ? window : globalThis);
