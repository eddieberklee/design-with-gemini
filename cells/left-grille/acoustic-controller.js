/**
 * Web Audio Hardware & Lifecycle Controller (`cells/left-grille/acoustic-controller.js`)
 *
 * Responsibilities:
 * - Requests raw unprocessed 48 kHz capture (`echoCancellation: false`, `noiseSuppression: false`,
 *   `autoGainControl: false`) so macOS VoiceProcessingIO never cancels speaker pilots or erases
 *   broadband skin-on-aluminum grille friction.
 * - Guards async `getUserMedia` / `AudioWorklet` startup with `sessionEpoch` so navigating Back
 *   or pressing `Escape` mid-permission-prompt aborts immediately without leaking mic capture.
 * - Auto-pins Built-in MacBook Microphone & Built-in MacBook Speakers (`enumerateDevices` +
 *   `AudioContext.setSinkId`) when Bluetooth AirPods or external displays are system defaults.
 * - Hard-pans ultrasonic pilot comb to Left Speaker (`StereoPannerNode.pan = -1.0`, Right = `0.0`).
 * - Executes a smooth zero-pop TX ramp-down before closing `AudioContext` and stopping tracks.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./acoustic-engine.js'));
  } else {
    root.LeftGrilleController = factory(root.LeftGrilleAcousticEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  const STORAGE_KEY = 'dwg.leftGrilleCalibration.v1';
  const BUILTIN_RE = /(macbook|built-in|internal)/i;
  const EXTERNAL_HEADSET_RE = /(airpods|bluetooth|headphone|headset|earbuds|iphone|continuity|usb|display)/i;

  function loadStoredCalibration() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function saveStoredCalibration(data) {
    try {
      if (!data) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  class LeftGrilleSensorController {
    constructor(callbacks = {}) {
      this.onTelemetry = callbacks.onTelemetry || function () {};
      this.onSwipe = callbacks.onSwipe || function () {};
      this.onStateChange = callbacks.onStateChange || function () {};
      this.onCalibrationResult = callbacks.onCalibrationResult || function () {};

      this.state = 'idle'; // 'idle' | 'requesting' | 'listening' | 'error'
      this.errorMessage = '';
      this.sessionEpoch = 0;
      this.audioCtx = null;
      this.stream = null;
      this.micSource = null;
      this.workletNode = null;
      this.scriptNode = null;
      this.pannerNode = null;
      this.fallbackCore = null;
      this.simTimer = null;
      this.txEnabled = true;
      this.txGain = 0.036;
      this.activeMicLabel = '';
      this.activeSpeakerLabel = 'Left Speaker';
      this.sampleRate = 48000;

      const saved = typeof localStorage !== 'undefined' ? loadStoredCalibration() : null;
      this.polarity = saved && typeof saved.polarity === 'number' ? saved.polarity : 1;
      this.calibration = saved && saved.calibration ? saved.calibration : null;
    }

    _emitState(nextState, extra = {}) {
      this.state = nextState;
      if (extra.error !== undefined) this.errorMessage = extra.error;
      this.onStateChange({
        state: this.state,
        error: this.errorMessage,
        txEnabled: this.txEnabled,
        polarity: this.polarity,
        calibrated: Boolean(this.calibration),
        micLabel: this.activeMicLabel,
        speakerLabel: this.activeSpeakerLabel,
        sampleRate: this.sampleRate
      });
    }

    async start(options = {}) {
      if (this.state === 'listening' || this.state === 'requesting') return true;
      const myEpoch = ++this.sessionEpoch;
      this._emitState('requesting', { error: '' });

      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const isFile = typeof location !== 'undefined' && location.protocol === 'file:';
        this._emitState('error', {
          error: isFile
            ? 'Mic blocked on file:// — serve on localhost, or drag rail / use Sim ↑↓.'
            : 'Microphone API unavailable — drag rail or use Sim ↑↓.'
        });
        return false;
      }

      let tempStream = null;
      try {
        tempStream = await this._requestRawMic(options.deviceId || null);
        if (myEpoch !== this.sessionEpoch) {
          tempStream.getTracks().forEach((t) => t.stop());
          return false;
        }

        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (myEpoch !== this.sessionEpoch) {
          tempStream.getTracks().forEach((t) => t.stop());
          return false;
        }

        const audioInputs = devices.filter((d) => d.kind === 'audioinput');
        const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

        if (!options.deviceId && audioInputs.length > 1) {
          const currentTrack = tempStream.getAudioTracks()[0];
          const currentLabel = (currentTrack && currentTrack.label) || '';
          const builtInMic = audioInputs.find((d) => BUILTIN_RE.test(d.label));
          if (builtInMic && !BUILTIN_RE.test(currentLabel) && EXTERNAL_HEADSET_RE.test(currentLabel)) {
            try {
              const betterStream = await this._requestRawMic(builtInMic.deviceId);
              if (myEpoch !== this.sessionEpoch) {
                betterStream.getTracks().forEach((t) => t.stop());
                tempStream.getTracks().forEach((t) => t.stop());
                return false;
              }
              tempStream.getTracks().forEach((t) => t.stop());
              tempStream = betterStream;
            } catch (_) {}
          }
        }

        const activeTrack = tempStream.getAudioTracks()[0];
        this.activeMicLabel = (activeTrack && activeTrack.label) || 'Built-in Mic Array';
        this.stream = tempStream;
        tempStream = null;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx({
          latencyHint: 'interactive',
          sampleRate: 48000
        });
        this.audioCtx = ctx;
        this.sampleRate = ctx.sampleRate;

        // Disable ultrasonic pilot if Bluetooth HFP forced low sample rate (<40 kHz)
        if (this.sampleRate < 40000) {
          this.txEnabled = false;
        }

        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        if (myEpoch !== this.sessionEpoch) {
          await this.stop({ silent: true });
          return false;
        }

        const builtInOut = audioOutputs.find((d) => BUILTIN_RE.test(d.label));
        if (builtInOut && typeof ctx.setSinkId === 'function' && builtInOut.deviceId) {
          try {
            await ctx.setSinkId(builtInOut.deviceId);
            this.activeSpeakerLabel = `${builtInOut.label} (L)`;
          } catch (_) {
            this.activeSpeakerLabel = 'Left Speaker';
          }
        } else {
          this.activeSpeakerLabel = 'Left Speaker (Ch 1)';
        }

        if (myEpoch !== this.sessionEpoch) {
          await this.stop({ silent: true });
          return false;
        }

        if (ctx.destination && ctx.destination.maxChannelCount >= 2) {
          try {
            ctx.destination.channelCount = 2;
            ctx.destination.channelCountMode = 'explicit';
            ctx.destination.channelInterpretation = 'speakers';
          } catch (_) {}
        }

        const micSource = ctx.createMediaStreamSource(this.stream);
        this.micSource = micSource;

        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (panner) {
          panner.pan.value = -1.0;
          panner.connect(ctx.destination);
          this.pannerNode = panner;
        }
        const targetOut = panner || ctx.destination;

        let workletStarted = false;
        if (ctx.audioWorklet && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
          let blobUrl = '';
          try {
            const src = Engine.createWorkletSource();
            const blob = new Blob([src], { type: 'application/javascript' });
            blobUrl = URL.createObjectURL(blob);
            await ctx.audioWorklet.addModule(blobUrl);
            if (myEpoch !== this.sessionEpoch) {
              if (blobUrl) URL.revokeObjectURL(blobUrl);
              await this.stop({ silent: true });
              return false;
            }
            const node = new AudioWorkletNode(ctx, 'left-grille-swipe-processor', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [2],
              processorOptions: {
                txEnabled: this.txEnabled,
                txGain: this.txGain,
                polarity: this.polarity,
                calibration: this.calibration
              }
            });
            node.port.onmessage = (ev) => this._handleDspEvent(ev.data);
            micSource.connect(node);
            node.connect(targetOut);
            this.workletNode = node;
            workletStarted = true;
          } catch (_) {
            workletStarted = false;
          } finally {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
          }
        }

        if (!workletStarted) {
          const core = new Engine.AcousticDspCore({
            sampleRate: ctx.sampleRate,
            txEnabled: this.txEnabled,
            txGain: this.txGain,
            polarity: this.polarity,
            calibration: this.calibration || undefined
          });
          this.fallbackCore = core;
          const sp = ctx.createScriptProcessor(512, 1, 2);
          sp.onaudioprocess = (audioEv) => {
            const outL = audioEv.outputBuffer.getChannelData(0);
            const outR =
              audioEv.outputBuffer.numberOfChannels > 1 ? audioEv.outputBuffer.getChannelData(1) : null;
            core.fillTxBlock(outL, outR);
            const inCh = audioEv.inputBuffer.getChannelData(0);
            const events = core.processSamples(inCh);
            for (let i = 0; i < events.length; i++) {
              this._handleDspEvent(events[i]);
            }
          };
          micSource.connect(sp);
          sp.connect(targetOut);
          this.scriptNode = sp;
        }

        this._emitState('listening', { error: '' });
        return true;
      } catch (err) {
        if (tempStream) {
          try {
            tempStream.getTracks().forEach((t) => t.stop());
          } catch (_) {}
        }
        await this.stop({ silent: true });
        if (myEpoch !== this.sessionEpoch) return false;
        const msg =
          err && err.name === 'NotAllowedError'
            ? 'Mic permission denied — allow mic access, or drag rail / use Sim ↑↓.'
            : (err && err.message) || 'Audio initialization failed.';
        this._emitState('error', { error: msg });
        return false;
      }
    }

    async _requestRawMic(exactDeviceId) {
      const audioConstraints = {
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 }
      };
      if (exactDeviceId) {
        audioConstraints.deviceId = { exact: exactDeviceId };
      }
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      } catch (_) {
        const fallback = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        };
        if (exactDeviceId) fallback.deviceId = { ideal: exactDeviceId };
        return await navigator.mediaDevices.getUserMedia({ audio: fallback, video: false });
      }
    }

    _handleDspEvent(msg) {
      if (!msg) return;
      if (msg.type === 'calibrationResult') {
        if (msg.result && msg.result.ok) {
          this.polarity = msg.result.polarity;
          this.calibration = msg.result.calibration;
          saveStoredCalibration({ polarity: this.polarity, calibration: this.calibration });
          this._emitState(this.state);
        }
        this.onCalibrationResult(msg.result);
        return;
      }
      this.onTelemetry(msg);
      if (msg.type === 'swipe' && msg.swipe) {
        this.onSwipe(msg.swipe);
      }
    }

    setSonarEnabled(enabled) {
      this.txEnabled = Boolean(enabled);
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'setTx', enabled: this.txEnabled, gain: this.txGain });
      }
      if (this.fallbackCore) {
        this.fallbackCore.txEnabled = this.txEnabled;
      }
      this._emitState(this.state);
    }

    togglePolarity() {
      this.polarity = this.polarity === 1 ? -1 : 1;
      const payload = Object.assign({}, this.calibration || {}, { polarity: this.polarity });
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'setCalibration', calibration: payload });
      }
      if (this.fallbackCore) {
        this.fallbackCore.setCalibration(payload);
      }
      saveStoredCalibration({ polarity: this.polarity, calibration: this.calibration });
      this._emitState(this.state);
    }

    startCalibrationStep(step) {
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'startCalStep', step });
      } else if (this.fallbackCore) {
        this.fallbackCore.startCalibrationStep(step);
      }
    }

    finishCalibrationStep() {
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'finishCalStep' });
      } else if (this.fallbackCore) {
        const res = this.fallbackCore.finishCalibrationStep();
        this._handleDspEvent({ type: 'calibrationResult', result: res });
      }
    }

    resetCalibration() {
      this.polarity = 1;
      this.calibration = null;
      saveStoredCalibration(null);
      const defaults = {
        polarity: 1,
        specBottomDb: -8.2,
        specTopDb: 3.8,
        snrBottomDb: 7.5,
        snrTopDb: 29.0
      };
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'setCalibration', calibration: defaults });
      }
      if (this.fallbackCore) {
        this.fallbackCore.setCalibration(defaults);
      }
      this._emitState(this.state);
    }

    /**
     * Synthesizes a realistic 48 kHz waveform and feeds it through `AcousticDspCore`
     * with real-time frame pacing (~340ms) so simulated swipes exercise the genuine DSP path.
     */
    runSimulatedSwipe(direction = 'up', options = {}) {
      if (this.simTimer) {
        clearInterval(this.simTimer);
        this.simTimer = null;
      }
      const sr = 48000;
      const simCore = new Engine.AcousticDspCore({ sampleRate: sr, polarity: 1 });
      const dur = options.durationSec || 0.34;
      const yStart = options.yStart !== undefined ? options.yStart : direction === 'up' ? 0.88 : 0.12;
      const yEnd = options.yEnd !== undefined ? options.yEnd : direction === 'up' ? 0.12 : 0.88;
      const preSec = 0.16;
      const postSec = 0.12;
      const totalSamples = Math.floor((preSec + dur + postSec) * sr);
      const txBuf = new Float32Array(Engine.QUANTUM);
      const allSamples = new Float32Array(totalSamples);

      let lpMid = 0;
      let lpSub = 0;
      let prevW = 0;
      const alphaMid = 1 - Math.exp((-2 * Math.PI * 1900) / sr);
      const alphaSub = 1 - Math.exp((-2 * Math.PI * 130) / sr);
      const crestPhases = simCore.carrierMultiples.map((_, k) => (Math.PI * k * k) / simCore.numCarriers);

      const s0 = Math.floor(preSec * sr);
      const s1 = s0 + Math.floor(dur * sr);

      for (let n = 0; n < totalSamples; n++) {
        if ((n & 127) === 0) simCore.fillTxBlock(txBuf, null);
        let x = (Math.random() - 0.5) * 0.001;
        const inSwipe = n >= s0 && n < s1;
        const prog = inSwipe ? (n - s0) / Math.max(1, s1 - s0) : n < s0 ? 0 : 1;
        let env = 0;
        if (inSwipe) {
          env = prog < 0.1 ? prog / 0.1 : prog > 0.9 ? (1 - prog) / 0.1 : 1;
        }
        const y = yStart + (yEnd - yStart) * prog;
        const distCm = Math.max(0.8, y * simCore.grilleLengthCm);
        const pinholeCover = inSwipe ? Math.exp(-Math.pow((y - 0.13) / 0.11, 2)) : 0;
        x += txBuf[n & 127] * 0.35 * (1 - 0.62 * pinholeCover * env);

        if (inSwipe) {
          for (let k = 0; k < simCore.numCarriers; k++) {
            const f = simCore.carrierFreqs[k];
            const delay = (2 * Math.PI * f * (1.65 * distCm)) / Engine.SPEED_OF_SOUND_CMS;
            const th = (2 * Math.PI * simCore.carrierMultiples[k] * (n & 127)) / 128 + crestPhases[k];
            x += ((0.0042 * env) / simCore.numCarriers) * Math.cos(th - delay);
          }
          const rw = (Math.random() - 0.5) * 2;
          lpMid += alphaMid * (rw - lpMid);
          lpSub += alphaSub * (rw - lpSub);
          const hp = rw - prevW;
          prevW = rw;
          const topProx = Math.max(0, Math.min(1, 1 - y));
          x +=
            env *
            ((0.0045 + 0.014 * Math.pow(topProx, 1.3)) * lpMid +
              (0.0004 + 0.026 * Math.pow(topProx, 2.4)) * hp +
              0.035 * pinholeCover * lpSub);
        }
        allSamples[n] = x;
      }

      const events = simCore.processSamples(allSamples);
      const playback = events.filter((e) => e.timeSec >= preSec * 0.85);
      const stepMs = Math.max(8, Math.round(((dur + postSec) * 1000) / Math.max(1, playback.length)));
      let idx = 0;
      this.simTimer = setInterval(() => {
        if (idx >= playback.length) {
          clearInterval(this.simTimer);
          this.simTimer = null;
          return;
        }
        this._handleDspEvent(playback[idx++]);
      }, stepMs);
      return events.find((e) => e.type === 'swipe')?.swipe || null;
    }

    async stop(opts = {}) {
      this.sessionEpoch++;
      if (this.simTimer) {
        clearInterval(this.simTimer);
        this.simTimer = null;
      }
      if (this.workletNode) {
        try {
          this.workletNode.port.postMessage({ type: 'setTx', enabled: false, gain: 0 });
        } catch (_) {}
      }
      if (this.fallbackCore) {
        this.fallbackCore.txEnabled = false;
      }
      // Brief 24 ms fade window if audioCtx is actively running to prevent speaker click
      if (this.audioCtx && this.audioCtx.state === 'running' && !opts.immediate) {
        await new Promise((r) => setTimeout(r, 24));
      }
      if (this.workletNode) {
        try {
          this.workletNode.port.onmessage = null;
          this.workletNode.disconnect();
        } catch (_) {}
        this.workletNode = null;
      }
      if (this.scriptNode) {
        try {
          this.scriptNode.onaudioprocess = null;
          this.scriptNode.disconnect();
        } catch (_) {}
        this.scriptNode = null;
      }
      if (this.pannerNode) {
        try {
          this.pannerNode.disconnect();
        } catch (_) {}
        this.pannerNode = null;
      }
      if (this.micSource) {
        try {
          this.micSource.disconnect();
        } catch (_) {}
        this.micSource = null;
      }
      if (this.stream) {
        try {
          this.stream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        this.stream = null;
      }
      if (this.audioCtx) {
        try {
          await this.audioCtx.close();
        } catch (_) {}
        this.audioCtx = null;
      }
      this.fallbackCore = null;
      if (!opts.silent) {
        this._emitState('idle', { error: '' });
      }
    }
  }

  return {
    LeftGrilleSensorController
  };
});
