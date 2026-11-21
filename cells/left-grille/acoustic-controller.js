/**
 * Web Audio Hardware & Lifecycle Controller (`cells/left-grille/acoustic-controller.js`)
 *
 * Responsibilities:
 * - Requests raw unprocessed 48 kHz capture (`echoCancellation: false`, `noiseSuppression: false`,
 *   `autoGainControl: false`) without double-prompting on `NotAllowedError`.
 * - Isolates async `start()` local handles per `sessionEpoch` and detaches instance handles
 *   synchronously at the top of `stop()` so mid-prompt Back/Escape or rapid stop->start cycles
 *   never clobber a newer active session or trap UI state in `'requesting'`.
 * - Auto-pins Built-in MacBook Microphone & Built-in MacBook Speakers (`enumerateDevices` +
 *   `AudioContext.setSinkId`) when AirPods or external displays are system defaults.
 * - Blocks ultrasonic pilot synthesis whenever hardware sampleRate < 40 kHz (Bluetooth HFP).
 * - Suppresses live room-noise telemetry while `simTimer` is playing (`Sim ↑` / `Sim ↓`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./acoustic-engine.js'));
  } else {
    root.LeftGrilleController = factory(root.LeftGrilleAcousticEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  const STORAGE_KEY_V2 = 'dwg.leftGrilleCalibration.v2';
  const STORAGE_KEY_V1 = 'dwg.leftGrilleCalibration.v1';
  const DEFAULT_COLLECTOR_URL = 'http://127.0.0.1:8792';
  const BUILTIN_RE = /(macbook|built-in|internal)/i;
  const EXTERNAL_HEADSET_RE = /(airpods|bluetooth|headphone|headset|earbuds|iphone|continuity|usb|display)/i;

  function makeCalSessionId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `lg-${ts}-${rand}`;
  }

  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function clampNum(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function allFiniteNumbers(arr, expectedLen, positiveOnly) {
    if (!Array.isArray(arr) || arr.length !== expectedLen) return false;
    for (let i = 0; i < expectedLen; i++) {
      if (!(i in arr)) return false;
      const v = arr[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      if (positiveOnly && v <= 0) return false;
    }
    return true;
  }

  function sanitizePlainStats(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const out = {};
    let count = 0;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (FORBIDDEN_KEYS.has(k)) continue;
      const v = obj[k];
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) continue;
        out[k] = v;
        count++;
      } else if (typeof v === 'boolean' || typeof v === 'string') {
        out[k] = v;
        count++;
      }
    }
    return count > 0 ? out : null;
  }

  function sanitizeCalibrationObj(cal) {
    if (!cal || typeof cal !== 'object' || Array.isArray(cal)) return null;
    const out = {};
    let count = 0;
    for (const k of ['specBottomDb', 'specTopDb', 'snrBottomDb', 'snrTopDb']) {
      if (Number.isFinite(cal[k])) {
        out[k] = cal[k];
        count++;
      }
    }
    return count > 0 ? out : null;
  }

  function sanitizeEmpiricalModel(model) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
    let rbf = null;
    if (
      model.rbf &&
      typeof model.rbf === 'object' &&
      !Array.isArray(model.rbf) &&
      Array.isArray(model.rbf.prototypes) &&
      model.rbf.prototypes.length >= 2 &&
      allFiniteNumbers(model.rbf.scale, 11, true)
    ) {
      const protos = [];
      for (let i = 0; i < model.rbf.prototypes.length; i++) {
        const p = model.rbf.prototypes[i];
        if (
          p &&
          typeof p === 'object' &&
          !Array.isArray(p) &&
          typeof p.anchorY === 'number' &&
          Number.isFinite(p.anchorY) &&
          allFiniteNumbers(p.vector, 11, false)
        ) {
          protos.push({ anchorY: clampNum(p.anchorY, 0, 1), vector: p.vector.slice() });
        }
      }
      if (protos.length >= 2) {
        rbf = {
          prototypes: protos,
          scale: model.rbf.scale.slice(),
          temp: Number.isFinite(model.rbf.temp) ? clampNum(model.rbf.temp, 0.08, 4.0) : 0.45
        };
      }
    }

    let lda = null;
    if (
      model.lda &&
      typeof model.lda === 'object' &&
      !Array.isArray(model.lda) &&
      allFiniteNumbers(model.lda.weights, 8, false) &&
      allFiniteNumbers(model.lda.featMean, 8, false) &&
      allFiniteNumbers(model.lda.featStd, 8, true) &&
      typeof model.lda.bias === 'number' &&
      Number.isFinite(model.lda.bias)
    ) {
      lda = {
        weights: model.lda.weights.slice(),
        bias: model.lda.bias,
        featMean: model.lda.featMean.slice(),
        featStd: model.lda.featStd.slice(),
        lambda: Number.isFinite(model.lda.lambda) ? model.lda.lambda : 0.35
      };
    }

    if (!rbf && !lda) return null;
    return {
      version: Number.isFinite(model.version) && model.version > 0 ? Math.floor(model.version) : 2,
      fittedAt: Number.isFinite(model.fittedAt) ? model.fittedAt : 0,
      polarity: model.polarity === -1 ? -1 : 1,
      rbf,
      lda,
      speedScale: Number.isFinite(model.speedScale) ? clampNum(model.speedScale, 0.55, 1.85) : 1.0,
      minStrokeDurationSec: Number.isFinite(model.minStrokeDurationSec)
        ? clampNum(model.minStrokeDurationSec, 0.055, 0.16)
        : 0.068,
      legacyCalibration: sanitizeCalibrationObj(model.legacyCalibration),
      stats: sanitizePlainStats(model.stats)
    };
  }

  function loadStoredCalibration() {
    try {
      if (typeof localStorage === 'undefined') return null;
      const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
      const raw = rawV2 || localStorage.getItem(STORAGE_KEY_V1);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const polarity =
        typeof parsed.polarity === 'number' && Number.isFinite(parsed.polarity)
          ? parsed.polarity < 0
            ? -1
            : 1
          : 1;
      const calibration = sanitizeCalibrationObj(parsed.calibration);
      const empiricalModel = sanitizeEmpiricalModel(parsed.empiricalModel);
      const calSummary = sanitizePlainStats(parsed.calSummary);
      return { polarity, calibration, empiricalModel, calSummary };
    } catch (_) {
      return null;
    }
  }

  function saveStoredCalibration(data) {
    try {
      if (typeof localStorage === 'undefined') return;
      if (!data) {
        localStorage.removeItem(STORAGE_KEY_V2);
        localStorage.removeItem(STORAGE_KEY_V1);
      } else {
        localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(data));
      }
    } catch (_) {}
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    if (typeof fetch !== 'function') return null;
    let ctrl = null;
    let timer = null;
    const opts = Object.assign({}, options || {});
    if (typeof AbortController === 'function' && timeoutMs > 0) {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(() => {
        try {
          ctrl.abort();
        } catch (_) {}
      }, timeoutMs);
    }
    try {
      return await fetch(url, opts);
    } catch (_) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function disposeLocalHandles(handles) {
    if (!handles) return;
    if (handles.workletNode) {
      try {
        handles.workletNode.port.onmessage = null;
        handles.workletNode.disconnect();
      } catch (_) {}
    }
    if (handles.scriptNode) {
      try {
        handles.scriptNode.onaudioprocess = null;
        handles.scriptNode.disconnect();
      } catch (_) {}
    }
    if (handles.pannerNode) {
      try {
        handles.pannerNode.disconnect();
      } catch (_) {}
    }
    if (handles.micSource) {
      try {
        handles.micSource.disconnect();
      } catch (_) {}
    }
    if (handles.stream) {
      try {
        handles.stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
    }
    if (handles.audioCtx) {
      try {
        handles.audioCtx.close().catch(() => {});
      } catch (_) {}
    }
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
      this._startPromise = null;
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
      this.hiddenMuted = false;
      this._ctxSuspendedByVisibility = null;
      this.activeMicLabel = '';
      this.activeSpeakerLabel = 'Left Speaker';
      this.sampleRate = 48000;
      this.trackSettings = {};

      const saved = loadStoredCalibration();
      this.polarity = saved ? saved.polarity : 1;
      this.calibration = saved ? saved.calibration : null;
      this.empiricalModel = saved ? saved.empiricalModel : null;
      this.calSummary = saved ? saved.calSummary : null;

      this.collectorUrl = callbacks.collectorUrl || DEFAULT_COLLECTOR_URL;
      this.collectorOnline = false;
      this.calSessionId = makeCalSessionId();
      this.recordedEvents = [];
      this._recReqId = 0;
      this._pendingRecResolvers = new Map();
      this._activeRecStepMeta = null;
    }

    _emitState(nextState, extra = {}) {
      this.state = nextState;
      if (extra.error !== undefined) this.errorMessage = extra.error;
      this.onStateChange({
        state: this.state,
        error: this.errorMessage,
        txEnabled: this.txEnabled && this.sampleRate >= 40000,
        canUseSonar: this.sampleRate >= 40000,
        polarity: this.polarity,
        calibrated: Boolean(this.calibration || this.empiricalModel),
        empiricalCalibrated: Boolean(this.empiricalModel),
        calSummary: this.calSummary,
        micLabel: this.activeMicLabel,
        speakerLabel: this.activeSpeakerLabel,
        sampleRate: this.sampleRate
      });
    }

    start(options = {}) {
      if (this.state === 'listening') return Promise.resolve(true);
      if (this.state === 'requesting' && this._startPromise) {
        return this._startPromise;
      }
      const p = this._runStart(options).finally(() => {
        if (this._startPromise === p) this._startPromise = null;
      });
      this._startPromise = p;
      return p;
    }

    async _runStart(options = {}) {
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

      const local = {
        stream: null,
        audioCtx: null,
        micSource: null,
        pannerNode: null,
        workletNode: null,
        scriptNode: null
      };

      try {
        local.stream = await this._requestRawMic(options.deviceId || null);
        if (myEpoch !== this.sessionEpoch) {
          disposeLocalHandles(local);
          return false;
        }

        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (myEpoch !== this.sessionEpoch) {
          disposeLocalHandles(local);
          return false;
        }

        const audioInputs = devices.filter((d) => d.kind === 'audioinput');
        const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

        if (!options.deviceId && audioInputs.length > 1) {
          const currentTrack = local.stream.getAudioTracks()[0];
          const currentLabel = (currentTrack && currentTrack.label) || '';
          const builtInMic = audioInputs.find((d) => BUILTIN_RE.test(d.label));
          if (builtInMic && !BUILTIN_RE.test(currentLabel) && EXTERNAL_HEADSET_RE.test(currentLabel)) {
            try {
              const betterStream = await this._requestRawMic(builtInMic.deviceId);
              if (myEpoch !== this.sessionEpoch) {
                betterStream.getTracks().forEach((t) => t.stop());
                disposeLocalHandles(local);
                return false;
              }
              local.stream.getTracks().forEach((t) => t.stop());
              local.stream = betterStream;
            } catch (_) {}
          }
        }

        const activeTrack = local.stream.getAudioTracks()[0];
        const micLabel = (activeTrack && activeTrack.label) || 'Built-in Mic Array';
        const trackSettings =
          activeTrack && typeof activeTrack.getSettings === 'function' ? activeTrack.getSettings() : {};

        const AudioCtx =
          (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
          globalThis.AudioContext ||
          globalThis.webkitAudioContext;
        const ctx = new AudioCtx({
          latencyHint: 'interactive',
          sampleRate: 48000
        });
        local.audioCtx = ctx;
        const sr = ctx.sampleRate || 48000;
        const effectiveTx = this.txEnabled && sr >= 40000 && !this.hiddenMuted;

        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          // resume() never settles while autoplay policy blocks audio: wait at most 2 s
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            Promise.resolve(ctx.resume()).then(
              () => {
                clearTimeout(timer);
                resolve();
              },
              () => {
                clearTimeout(timer);
                resolve();
              }
            );
          });
        }
        if (myEpoch !== this.sessionEpoch) {
          disposeLocalHandles(local);
          return false;
        }
        if (ctx.state === 'suspended') {
          throw new Error('Audio is blocked until you click the page — press ARM MIC again.');
        }

        let speakerLabel = 'Left Speaker (Ch 1)';
        const builtInOut = audioOutputs.find((d) => BUILTIN_RE.test(d.label));
        if (builtInOut && typeof ctx.setSinkId === 'function' && builtInOut.deviceId) {
          try {
            await ctx.setSinkId(builtInOut.deviceId);
            speakerLabel = `${builtInOut.label} (L)`;
          } catch (_) {
            speakerLabel = 'Left Speaker';
          }
        }
        if (myEpoch !== this.sessionEpoch) {
          disposeLocalHandles(local);
          return false;
        }

        if (ctx.destination && ctx.destination.maxChannelCount >= 2) {
          try {
            ctx.destination.channelCount = 2;
            ctx.destination.channelCountMode = 'explicit';
            ctx.destination.channelInterpretation = 'speakers';
          } catch (_) {}
        }

        local.micSource = ctx.createMediaStreamSource(local.stream);

        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (panner) {
          panner.pan.value = -1.0;
          panner.connect(ctx.destination);
          local.pannerNode = panner;
        }
        const targetOut = panner || ctx.destination;

        let workletStarted = false;
        let fallbackCore = null;
        if (ctx.audioWorklet && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
          let blobUrl = '';
          try {
            const src = Engine.createWorkletSource();
            const blob = new Blob([src], { type: 'application/javascript' });
            blobUrl = URL.createObjectURL(blob);
            await ctx.audioWorklet.addModule(blobUrl);
            if (myEpoch !== this.sessionEpoch) {
              disposeLocalHandles(local);
              return false;
            }
            const node = new AudioWorkletNode(ctx, 'left-grille-swipe-processor', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [2],
              processorOptions: {
                txEnabled: effectiveTx,
                txGain: this.txGain,
                polarity: this.polarity,
                calibration: this.calibration,
                empiricalModel: this.empiricalModel
              }
            });
            node.port.onmessage = (ev) => this._handleDspEvent(ev.data, false);
            local.micSource.connect(node);
            node.connect(targetOut);
            local.workletNode = node;
            workletStarted = true;
          } catch (_) {
            workletStarted = false;
          } finally {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
          }
        }

        if (!workletStarted) {
          const core = new Engine.AcousticDspCore({
            sampleRate: sr,
            txEnabled: effectiveTx,
            txGain: this.txGain,
            polarity: this.polarity,
            calibration: this.calibration || undefined,
            empiricalModel: this.empiricalModel || undefined
          });
          fallbackCore = core;
          const sp = ctx.createScriptProcessor(512, 1, 2);
          sp.onaudioprocess = (audioEv) => {
            const outL = audioEv.outputBuffer.getChannelData(0);
            const outR =
              audioEv.outputBuffer.numberOfChannels > 1 ? audioEv.outputBuffer.getChannelData(1) : null;
            core.fillTxBlock(outL, outR);
            const inCh = audioEv.inputBuffer.getChannelData(0);
            const events = core.processSamples(inCh);
            for (let i = 0; i < events.length; i++) {
              this._handleDspEvent(events[i], false);
            }
          };
          local.micSource.connect(sp);
          sp.connect(targetOut);
          local.scriptNode = sp;
        }

        // Commit local handles atomically to controller instance
        this.stream = local.stream;
        this.audioCtx = local.audioCtx;
        this.micSource = local.micSource;
        this.pannerNode = local.pannerNode;
        this.workletNode = local.workletNode;
        this.scriptNode = local.scriptNode;
        this.fallbackCore = fallbackCore;
        this.activeMicLabel = micLabel;
        this.activeSpeakerLabel = speakerLabel;
        this.sampleRate = sr;
        this.trackSettings = trackSettings || {};
        if (sr < 40000) {
          this.txEnabled = false;
        }

        // Unplugged / revoked mic ends the track: stop and report instead of showing LIVE on silence.
        local.stream.getAudioTracks().forEach((t) => {
          if (t && typeof t.addEventListener === 'function') {
            t.addEventListener(
              'ended',
              () => {
                if (myEpoch !== this.sessionEpoch) return;
                this.stop({ immediate: true, silent: true });
                this._emitState('error', {
                  error: 'Microphone disconnected — re-arm, or drag rail / use Sim ↑↓.'
                });
              },
              { once: true }
            );
          }
        });

        this._emitState('listening', { error: '' });
        if (this.hiddenMuted || (typeof document !== 'undefined' && document.hidden)) {
          this.setHiddenMuted(true);
        }
        return true;
      } catch (err) {
        const aborted = myEpoch !== this.sessionEpoch;
        disposeLocalHandles(local);
        if (aborted) return false;
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
      } catch (err) {
        // Only retry relaxed constraints on OverconstrainedError / TypeError — never double-prompt on NotAllowedError!
        const name = err && err.name;
        if (name !== 'OverconstrainedError' && name !== 'TypeError') {
          throw err;
        }
        const fallback = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        };
        if (exactDeviceId) fallback.deviceId = { ideal: exactDeviceId };
        return await navigator.mediaDevices.getUserMedia({ audio: fallback, video: false });
      }
    }

    _persistCalibration() {
      if (!this.calibration && !this.empiricalModel && this.polarity === 1) {
        saveStoredCalibration(null);
        return;
      }
      saveStoredCalibration({
        version: 2,
        polarity: this.polarity,
        calibration: this.calibration,
        empiricalModel: this.empiricalModel,
        calSummary: this.calSummary
      });
    }

    _settlePendingRecResolvers(reason) {
      if (!this._pendingRecResolvers.size) return;
      const entries = Array.from(this._pendingRecResolvers.values());
      this._pendingRecResolvers.clear();
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].timer) clearTimeout(entries[i].timer);
        entries[i].resolve({
          ok: false,
          reason: reason || 'cancelled',
          frameCount: 0,
          activeFrameCount: 0,
          peakSnrDb: 0,
          eventRecord: null
        });
      }
    }

    _handleDspEvent(msg, fromSim) {
      if (!msg) return;
      if (msg.type === 'recEventResult') {
        const entry = this._pendingRecResolvers.get(msg.reqId);
        if (entry) {
          this._pendingRecResolvers.delete(msg.reqId);
          if (entry.timer) clearTimeout(entry.timer);
          entry.resolve(msg.result || null);
        }
        return;
      }
      if (msg.type === 'calibrationResult') {
        if (msg.result && msg.result.ok) {
          this.polarity = msg.result.polarity;
          this.calibration = msg.result.calibration;
          this._persistCalibration();
          this._emitState(this.state);
        }
        this.onCalibrationResult(msg.result);
        return;
      }
      // Suppress live mic room-noise packets while a simulated swipe playback is actively running
      if (!fromSim && this.simTimer !== null) {
        return;
      }
      this.onTelemetry(msg);
      if (msg.type === 'swipe' && msg.swipe) {
        this.onSwipe(msg.swipe);
      }
    }

    setSonarEnabled(enabled) {
      if (enabled && this.state === 'listening' && this.sampleRate < 40000) {
        this.txEnabled = false;
        this._emitState(this.state);
        return false;
      }
      this.txEnabled = Boolean(enabled);
      const activeTx = this.txEnabled && !this.hiddenMuted;
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'setTx', enabled: activeTx, gain: this.txGain });
      }
      if (this.fallbackCore) {
        this.fallbackCore.setTxEnabled(activeTx, this.txGain);
      }
      this._emitState(this.state);
      return this.txEnabled;
    }

    setHiddenMuted(hidden) {
      this.hiddenMuted = Boolean(hidden);
      // Hidden tab: suspend capture + DSP entirely; on return resume only what this suspended.
      const ctx = this.audioCtx;
      if (this.hiddenMuted) {
        if (ctx && ctx.state === 'running' && typeof ctx.suspend === 'function') {
          this._ctxSuspendedByVisibility = ctx;
          try {
            ctx.suspend().catch(() => {});
          } catch (_) {}
        }
      } else {
        const suspended = this._ctxSuspendedByVisibility;
        this._ctxSuspendedByVisibility = null;
        if (suspended && suspended === ctx && typeof ctx.resume === 'function') {
          try {
            ctx.resume().catch(() => {});
          } catch (_) {}
        }
      }
      const activeTx = this.txEnabled && !this.hiddenMuted && this.sampleRate >= 40000;
      if (this.workletNode) {
        this.workletNode.port.postMessage({
          type: 'setTx',
          enabled: activeTx,
          gain: activeTx ? this.txGain : 0
        });
      }
      if (this.fallbackCore) {
        this.fallbackCore.setTxEnabled(activeTx, activeTx ? this.txGain : 0);
      }
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
      this._persistCalibration();
      this._emitState(this.state);
    }

    getCalibrationProtocol() {
      return Engine.CALIBRATION_PROTOCOL;
    }

    async probeCollector() {
      const res = await fetchWithTimeout(
        `${this.collectorUrl}/health`,
        { method: 'GET', headers: { Accept: 'application/json' } },
        1200
      );
      if (!res || !res.ok) {
        this.collectorOnline = false;
        return false;
      }
      try {
        const data = await res.json();
        this.collectorOnline = Boolean(data && data.ok !== false);
      } catch (_) {
        this.collectorOnline = true;
      }
      return this.collectorOnline;
    }

    async _postToCollector(payload) {
      const res = await fetchWithTimeout(
        `${this.collectorUrl}/record`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        },
        3000
      );
      const ok = Boolean(res && res.ok);
      if (ok) this.collectorOnline = true;
      return ok;
    }

    beginCalibrationRecord(stepMeta) {
      this._activeRecStepMeta =
        stepMeta && typeof stepMeta === 'object' ? Object.assign({}, stepMeta) : null;
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'beginRec', stepMeta: this._activeRecStepMeta });
      } else if (this.fallbackCore) {
        this.fallbackCore.beginRecordEvent(this._activeRecStepMeta);
      }
    }

    async completeCalibrationRecord() {
      let res = null;
      if (this.workletNode) {
        const reqId = ++this._recReqId;
        res = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this._pendingRecResolvers.has(reqId)) {
              this._pendingRecResolvers.delete(reqId);
              resolve({
                ok: false,
                reason: 'timeout',
                frameCount: 0,
                activeFrameCount: 0,
                peakSnrDb: 0,
                eventRecord: null
              });
            }
          }, 2500);
          this._pendingRecResolvers.set(reqId, { resolve, timer });
          try {
            this.workletNode.port.postMessage({ type: 'endRec', reqId });
          } catch (_) {
            this._pendingRecResolvers.delete(reqId);
            clearTimeout(timer);
            resolve({
              ok: false,
              reason: 'post_failed',
              frameCount: 0,
              activeFrameCount: 0,
              peakSnrDb: 0,
              eventRecord: null
            });
          }
        });
      } else if (this.fallbackCore) {
        res = this.fallbackCore.endRecordEvent();
      } else {
        return {
          ok: false,
          reason: 'not_listening',
          frameCount: 0,
          activeFrameCount: 0,
          peakSnrDb: 0,
          eventRecord: null,
          collectorSaved: false
        };
      }

      this._activeRecStepMeta = null;
      const ok = Boolean(res && res.ok);
      const eventRecord = res && res.eventRecord ? res.eventRecord : null;
      let collectorSaved = false;

      if (ok && eventRecord) {
        const existingIdx = this.recordedEvents.findIndex(
          (e) => e && e.stepId === eventRecord.stepId
        );
        if (existingIdx >= 0) {
          this.recordedEvents[existingIdx] = eventRecord;
        } else {
          this.recordedEvents.push(eventRecord);
        }

        collectorSaved = await this._postToCollector({
          type: 'event',
          sessionId: this.calSessionId,
          trackSettings: this.trackSettings,
          sampleRate: this.sampleRate,
          event: eventRecord
        });
      }

      return {
        ok,
        reason: res ? res.reason : 'empty_recording',
        frameCount: (res && res.frameCount) || 0,
        activeFrameCount: (res && res.activeFrameCount) || 0,
        peakSnrDb: (res && res.peakSnrDb) || 0,
        eventRecord,
        collectorSaved
      };
    }

    async fitRecordedCalibration() {
      const fitResult = Engine.fitEmpiricalCalibration(this.recordedEvents);
      if (!fitResult || !fitResult.ok || !fitResult.model) {
        return {
          ok: false,
          reason: (fitResult && fitResult.reason) || 'fit_failed',
          eventCount: this.recordedEvents.length,
          swipeCount: (fitResult && fitResult.swipeCount) || 0,
          zoneCount: (fitResult && fitResult.zoneCount) || 0,
          looAccuracyPct: 0,
          inSampleAccuracyPct: 0,
          looFolds: 0,
          inSampleOnly: true,
          dPrime: 0,
          model: null,
          collectorSaved: false
        };
      }

      this.empiricalModel = fitResult.model;
      if (fitResult.model.polarity === 1 || fitResult.model.polarity === -1) {
        this.polarity = fitResult.model.polarity;
      }
      if (fitResult.model.legacyCalibration) {
        this.calibration = sanitizeCalibrationObj(fitResult.model.legacyCalibration);
      }
      this.calSummary = {
        eventCount: fitResult.eventCount,
        swipeCount: fitResult.swipeCount,
        zoneCount: fitResult.zoneCount,
        looAccuracyPct: fitResult.looAccuracyPct,
        inSampleAccuracyPct: fitResult.inSampleAccuracyPct,
        looFolds: fitResult.looFolds,
        inSampleOnly: Boolean(fitResult.inSampleOnly),
        dPrime: fitResult.dPrime
      };

      if (this.workletNode) {
        this.workletNode.port.postMessage({
          type: 'setEmpiricalModel',
          model: this.empiricalModel,
          syncPolarity: true
        });
      }
      if (this.fallbackCore) {
        this.fallbackCore.setEmpiricalModel(this.empiricalModel, { syncPolarity: true });
      }

      this._persistCalibration();
      this._emitState(this.state);

      const collectorSaved = await this._postToCollector({
        type: 'fit',
        sessionId: this.calSessionId,
        trackSettings: this.trackSettings,
        sampleRate: this.sampleRate,
        events: this.recordedEvents,
        fitResult
      });

      return {
        ok: true,
        eventCount: fitResult.eventCount,
        swipeCount: fitResult.swipeCount,
        zoneCount: fitResult.zoneCount,
        looAccuracyPct: fitResult.looAccuracyPct,
        inSampleAccuracyPct: fitResult.inSampleAccuracyPct,
        looFolds: fitResult.looFolds,
        inSampleOnly: Boolean(fitResult.inSampleOnly),
        dPrime: fitResult.dPrime,
        model: fitResult.model,
        collectorSaved
      };
    }

    clearRecordedCalibration() {
      this.recordedEvents = [];
      this.calSessionId = makeCalSessionId();
      this._activeRecStepMeta = null;
      this._settlePendingRecResolvers('cleared');
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'cancelRec' });
      } else if (this.fallbackCore) {
        this.fallbackCore.cancelRecordEvent();
      }
    }

    exportCalibrationBundle() {
      return JSON.stringify(
        {
          version: 2,
          exportedAt: new Date().toISOString(),
          sessionId: this.calSessionId,
          sampleRate: this.sampleRate,
          micLabel: this.activeMicLabel,
          speakerLabel: this.activeSpeakerLabel,
          trackSettings: this.trackSettings,
          polarity: this.polarity,
          calibration: this.calibration,
          empiricalModel: this.empiricalModel,
          calSummary: this.calSummary,
          events: this.recordedEvents
        },
        null,
        2
      );
    }

    startCalibrationStep(step) {
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'startCalStep', step });
      } else if (this.fallbackCore) {
        this.fallbackCore.startCalibrationStep(step);
      }
    }

    cancelCalibrationStep() {
      this._activeRecStepMeta = null;
      this._settlePendingRecResolvers('cancelled');
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'cancelCalStep' });
      } else if (this.fallbackCore) {
        this.fallbackCore.cancelCalibrationStep();
      }
    }

    finishCalibrationStep() {
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'finishCalStep' });
      } else if (this.fallbackCore) {
        const res = this.fallbackCore.finishCalibrationStep();
        this._handleDspEvent({ type: 'calibrationResult', result: res }, false);
      }
    }

    resetCalibration() {
      this.polarity = 1;
      this.calibration = null;
      this.empiricalModel = null;
      this.calSummary = null;
      this.recordedEvents = [];
      this.calSessionId = makeCalSessionId();
      this._activeRecStepMeta = null;
      this._settlePendingRecResolvers('reset');
      saveStoredCalibration(null);
      const defaults = {
        polarity: 1,
        specBottomDb: -8.2,
        specTopDb: 3.8,
        snrBottomDb: 7.5,
        snrTopDb: 29.0
      };
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'resetCalibration' });
        this.workletNode.port.postMessage({ type: 'setCalibration', calibration: defaults });
        this.workletNode.port.postMessage({ type: 'setEmpiricalModel', model: null });
      }
      if (this.fallbackCore) {
        this.fallbackCore.resetCalibration();
      }
      this._emitState(this.state);
    }

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
        this._handleDspEvent(playback[idx++], true);
      }, stepMs);
      return events.find((e) => e.type === 'swipe')?.swipe || null;
    }

    async stop(opts = {}) {
      this.sessionEpoch++;
      this._startPromise = null;
      this._activeRecStepMeta = null;
      this._settlePendingRecResolvers('stopped');
      if (this.simTimer) {
        clearInterval(this.simTimer);
        this.simTimer = null;
      }

      // Synchronously detach instance handles so rapid stop()->start() never races across the 24ms fade
      const detached = {
        workletNode: this.workletNode,
        scriptNode: this.scriptNode,
        pannerNode: this.pannerNode,
        micSource: this.micSource,
        stream: this.stream,
        audioCtx: this.audioCtx,
        fallbackCore: this.fallbackCore
      };
      this.workletNode = null;
      this.scriptNode = null;
      this.pannerNode = null;
      this.micSource = null;
      this.stream = null;
      this.audioCtx = null;
      this.fallbackCore = null;
      this.hiddenMuted = false;
      this._ctxSuspendedByVisibility = null;

      if (!opts.silent) {
        this._emitState('idle', { error: '' });
      }

      if (detached.workletNode) {
        try {
          detached.workletNode.port.onmessage = null;
          detached.workletNode.port.postMessage({ type: 'setTx', enabled: false, gain: 0 });
        } catch (_) {}
      }
      if (detached.fallbackCore) {
        detached.fallbackCore.setTxEnabled(false, 0);
      }

      if (detached.audioCtx && detached.audioCtx.state === 'running' && !opts.immediate) {
        await new Promise((r) => setTimeout(r, 24));
      }

      disposeLocalHandles(detached);
    }
  }

  return {
    LeftGrilleSensorController
  };
});
