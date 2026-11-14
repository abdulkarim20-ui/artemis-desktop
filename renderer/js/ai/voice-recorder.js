const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export class VoiceRecorder {
  constructor({ apiBase, onState, onText, onError, onLevel, mediaDevices, MediaRecorder: Recorder, fetchImpl } = {}) {
    this.apiBase = String(apiBase || '').replace(/\/+$/, '');
    this.onState = onState || (() => {});
    this.onText = onText || (() => {});
    this.onError = onError || (() => {});
    this.onLevel = onLevel || (() => {});
    this.mediaDevices = mediaDevices || globalThis.navigator?.mediaDevices;
    this.MediaRecorder = Recorder || globalThis.MediaRecorder;
    this.fetch = fetchImpl || globalThis.fetch?.bind(globalThis);
    this.state = 'idle';
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.recordedBytes = 0;
    this.cancelled = false;
    this.oversized = false;
    this.recordingError = null;
    this.destroyed = false;
    this.generation = 0;
    this.abortController = null;
    this.visualizerFrame = null;
    this.audioContext = null;
    this.audioSource = null;
  }

  setState(state) {
    this.state = state;
    if (!this.destroyed) this.onState(state);
  }

  async toggle() {
    if (this.state === 'recording') {
      this.stop();
    } else if (this.state === 'idle') {
      await this.start();
    }
  }

  async start() {
    if (this.destroyed || this.state !== 'idle') return;

    const generation = ++this.generation;
    this.cancelled = false;
    this.oversized = false;
    this.recordingError = null;
    this.chunks = [];
    this.recordedBytes = 0;
    this.setState('requesting');

    if (!this.mediaDevices?.getUserMedia || typeof this.MediaRecorder !== 'function') {
      this.setState('idle');
      this.onError('Voice input is not supported on this device.');
      return;
    }

    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });

      if (this.destroyed || generation !== this.generation) {
        this.stopTracks(stream);
        return;
      }

      this.stream = stream;
      const mimeType = MIME_TYPES.find((type) => this.MediaRecorder.isTypeSupported?.(type)) || '';
      const recorder = new this.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (!event.data?.size) return;
        this.chunks.push(event.data);
        this.recordedBytes += event.data.size;
        if (this.recordedBytes > MAX_AUDIO_BYTES) {
          this.oversized = true;
          this.stop();
        }
      };
      recorder.onerror = () => {
        this.recordingError = new Error('Audio recording failed. Check your microphone and try again.');
        this.stop();
      };
      recorder.onstop = () => { void this.finish(recorder); };
      recorder.start();
      this.setState('recording');
      this.startLevelMeter(stream);
    } catch (error) {
      this.stopTracks(stream);
      this.stream = null;
      this.recorder = null;
      if (this.destroyed || generation !== this.generation) return;
      this.setState('idle');
      this.onError(this.getMicrophoneError(error));
    }
  }

  stop() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
  }

  cancel() {
    if (this.state !== 'recording' && this.state !== 'requesting') return false;
    this.cancelled = true;
    this.generation += 1;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    } else {
      this.setState('idle');
    }
    return true;
  }

  async finish(recorder) {
    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type: mimeType });
    const wasCancelled = this.cancelled || this.destroyed;
    const tooLarge = this.oversized;
    const recordingError = this.recordingError;
    this.chunks = [];
    this.recordedBytes = 0;
    this.recorder = null;
    this.stopLevelMeter();
    this.stopTracks(this.stream);
    this.stream = null;

    if (wasCancelled) {
      this.setState('idle');
      return;
    }
    if (tooLarge) {
      this.onError('Recording is larger than 25 MB. Try a shorter recording.');
      this.setState('idle');
      return;
    }
    if (recordingError) {
      this.onError(recordingError.message);
      this.setState('idle');
      return;
    }
    if (blob.size < 1000) {
      this.onError("Didn't catch anything. Try recording for a little longer.");
      this.setState('idle');
      return;
    }

    this.setState('transcribing');
    this.abortController = new AbortController();
    try {
      const response = await this.fetch(`${this.apiBase}/api/speech/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': mimeType },
        body: blob,
        signal: this.abortController.signal,
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('The transcription service returned an invalid response.');
      }
      if (!response.ok) throw new Error(data.error || 'Speech transcription failed.');
      if (typeof data.text !== 'string' || !data.text.trim()) {
        this.onError('No speech detected. Try again.');
      } else {
        this.onText(data.text.trim());
      }
    } catch (error) {
      if (!this.abortController.signal.aborted && !this.destroyed) {
        this.onError(error?.message || 'Speech transcription failed. Please try again.');
      }
    } finally {
      this.abortController = null;
      this.setState('idle');
    }
  }

  stopTracks(stream) {
    for (const track of stream?.getTracks?.() || []) track.stop();
  }

  startLevelMeter(stream) {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (
      !AudioContext
      || typeof globalThis.requestAnimationFrame !== 'function'
      || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) return;

    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      this.audioContext = context;
      this.audioSource = source;
      const samples = new Uint8Array(analyser.fftSize);

      const update = () => {
        if (this.destroyed || this.state !== 'recording' || this.audioContext !== context) return;
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          const amplitude = (sample - 128) / 128;
          energy += amplitude * amplitude;
        }
        this.onLevel(Math.min(1, Math.sqrt(energy / samples.length) * 14));
        this.visualizerFrame = globalThis.requestAnimationFrame(update);
      };

      this.visualizerFrame = globalThis.requestAnimationFrame(update);
      context.resume().catch((error) => {
        console.warn('[voice] audio level meter could not resume:', error?.message || error);
      });
    } catch (error) {
      console.warn('[voice] audio level meter is unavailable:', error?.message || error);
    }
  }

  stopLevelMeter() {
    if (this.visualizerFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.visualizerFrame);
      this.visualizerFrame = null;
    }
    this.audioSource?.disconnect();
    this.audioSource = null;
    const context = this.audioContext;
    this.audioContext = null;
    this.onLevel(0);
    if (context && context.state !== 'closed') {
      context.close().catch((error) => {
        console.warn('[voice] audio level meter could not close:', error?.message || error);
      });
    }
  }

  getMicrophoneError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      return 'Microphone permission denied. Allow microphone access for Artemis in system settings.';
    }
    if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
      return 'No microphone was found. Connect a microphone and try again.';
    }
    if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
      return 'The microphone is busy or unavailable. Close other apps using it and try again.';
    }
    return 'Could not start microphone recording. Check your microphone and try again.';
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.cancelled = true;
    this.abortController?.abort();
    this.stopLevelMeter();
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.stopTracks(this.stream);
    this.stream = null;
    this.chunks = [];
  }
}
