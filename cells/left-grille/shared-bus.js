/**
 * Shared 48 kHz Full-Duplex Acoustic Bus & Secondary Grid Slot Registry
 * (`cells/left-grille/shared-bus.js`)
 *
 * Powers Secondary Grid Cells 02–07 inside `#left-grille-secondary-grid` via
 * a single raw unprocessed hardware microphone stream + stereo ultrasonic TX
 * multiplexer (`window.LeftGrilleLab`):
 *
 * - `LeftGrilleLab.registerCell(slotNumber, spec)`:
 *   Registers `{ id, title, mount(cellEl, bus) }` for secondary slots `2..9`
 *   (specifically `2..7` for sibling sensors). Preserves and drains any
 *   pre-registered `LeftGrilleLab._pending` queue (`[slotNumber, spec]`),
 *   mounting immediately if `#lg-sec-cell-${slotNumber}` is already in the DOM
 *   or deferring until `ui.js` attaches the secondary grid.
 *
 * - `LeftGrilleLab.bus` (`SharedAcousticBus`):
 *   - Single raw `getUserMedia` stream (`echoCancellation: false`,
 *     `noiseSuppression: false`, `autoGainControl: false`, `48 kHz` ideal),
 *     auto-upgrading to `/macbook|built-in|internal/i` mic + `setSinkId`
 *     speakers, with `sessionEpoch` abort isolation and single-prompt
 *     `NotAllowedError` handling.
 *   - `subscribeAudio(fn)` -> `unsubscribe()`: delivers sanitized 512-sample
 *     `Float32Array` blocks (`~93.75 Hz` at `48 kHz`) with
 *     `{ samples, sampleRate, timeSec, txMode }`.
 *   - `registerTxGenerator(modeId, genFn)` + `setTxMode(modeId)` / `getTxMode()`:
 *     true-stereo (`leftOut`, `rightOut`) synthesis with click-free `15 ms`
 *     raised-cosine ramp-in, ramp-out, and mode-to-mode crossfading. Strictly
 *     forces digital silence whenever `sampleRate < 40000` or `document.hidden`.
 *   - `requestArm(preferredTxMode)` -> `Promise<boolean>`
 *   - `stopAll()` -> `Promise<void>`: synchronous handle detach, `15 ms` TX
 *     fade-out, mic track teardown, `AudioContext.close()`, `state = 'idle'`,
 *     and `CustomEvent('lg-secondary-close')` dispatch on `window`.
 *   - `onStateChange(fn)` -> `unsubscribe()`: immediately emits current
 *     `{ state, sampleRate, txMode, micLabel, error }` snapshot.
 */
(function (root, factory) {
  const exportsObj = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = exportsObj;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function sharedBusFactory(root) {
  'use strict';

  const BLOCK_SIZE = 512;
  const RAMP_DURATION_SEC = 0.015;
  const MIN_SONAR_SAMPLE_RATE = 40000;
  const BUILTIN_RE = /(macbook|built-in|internal)/i;

  function clampSample(v) {
    if (!Number.isFinite(v)) return 0;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  }

  function isDocumentHidden(explicitHidden, targetRoot) {
    if (explicitHidden) return true;
    const doc =
      (targetRoot && targetRoot.document) ||
      (typeof document !== 'undefined' ? document : null);
    return Boolean(doc && doc.hidden);
  }

  function disposeAudioHandles(handles) {
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
    if (handles.micSource) {
      try {
        handles.micSource.disconnect();
      } catch (_) {}
    }
    if (handles.stream) {
      try {
        handles.stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch (_) {}
        });
      } catch (_) {}
    }
    if (handles.audioCtx) {
      try {
        const p = handles.audioCtx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }
  }

  function createBusWorkletSource() {
    return `
      class SharedAcousticBusProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.rxBuf = new Float32Array(${BLOCK_SIZE});
          this.rxFill = 0;
          this.txQueue = [];
          this.curTx = null;
          this.curTxIdx = 0;
          this.port.onmessage = (ev) => {
            const d = ev && ev.data;
            if (d && d.type === 'txBlock' && d.left && d.right) {
              if (this.txQueue.length < 12) {
                this.txQueue.push({ left: d.left, right: d.right });
              }
            } else if (d && d.type === 'flushTx') {
              this.txQueue.length = 0;
              this.curTx = null;
              this.curTxIdx = 0;
            }
          };
        }
        process(inputs, outputs) {
          const out = outputs[0];
          const outL = out && out[0];
          const outR = out && out[1];
          const len = outL ? outL.length : 128;

          for (let i = 0; i < len; i++) {
            if (!this.curTx || this.curTxIdx >= this.curTx.left.length) {
              this.curTx = this.txQueue.length > 0 ? this.txQueue.shift() : null;
              this.curTxIdx = 0;
            }
            if (this.curTx) {
              if (outL) outL[i] = this.curTx.left[this.curTxIdx];
              if (outR) outR[i] = this.curTx.right[this.curTxIdx];
              this.curTxIdx++;
            } else {
              if (outL) outL[i] = 0;
              if (outR) outR[i] = 0;
            }
          }

          const inp = inputs[0];
          const inCh = inp && inp[0];
          for (let i = 0; i < len; i++) {
            const s = inCh ? inCh[i] : 0;
            this.rxBuf[this.rxFill++] = Number.isFinite(s) ? s : 0;
            if (this.rxFill >= ${BLOCK_SIZE}) {
              const copy = new Float32Array(this.rxBuf);
              this.port.postMessage({ type: 'rxBlock', samples: copy }, [copy.buffer]);
              this.rxFill = 0;
            }
          }
          return true;
        }
      }
      registerProcessor('lg-shared-acoustic-bus-processor', SharedAcousticBusProcessor);
    `;
  }

  class SharedAcousticBus {
    constructor(options = {}) {
      this._root = options.root || root || {};
      this._state = 'idle'; // 'idle' | 'requesting' | 'listening' | 'error'
      this._sampleRate = 48000;
      this._txMode = 'off';
      this._micLabel = '';
      this._speakerLabel = 'Stereo Speakers';
      this._error = '';
      this._hiddenMuted = false;

      this._sessionEpoch = 0;
      this._armPromise = null;

      this._audioSubscribers = new Set();
      this._stateListeners = new Set();
      this._beforeArmHooks = new Set();
      this._txGenerators = new Map();

      // TX envelope / crossfade state (15 ms raised-cosine ramp, multi-overlap safe)
      this._txSampleOffset = 0;
      this._activeTxMode = 'off';
      this._activeTxPhase = 0; // 0..1 raised-cosine ramp progress
      this._fadingModes = new Map(); // modeId -> phase (1..0)
      this._scratchL = new Float32Array(BLOCK_SIZE);
      this._scratchR = new Float32Array(BLOCK_SIZE);
      this._fadeScratchL = new Float32Array(BLOCK_SIZE);
      this._fadeScratchR = new Float32Array(BLOCK_SIZE);

      // RX 512-sample framing state
      this._rxSampleOffset = 0;
      this._rxStage = new Float32Array(BLOCK_SIZE);
      this._rxStageFill = 0;

      // Active Web Audio handles
      this.stream = null;
      this.audioCtx = null;
      this.micSource = null;
      this.scriptNode = null;
      this.workletNode = null;
      this._workletPushTx = null;

      const doc =
        (this._root && this._root.document) ||
        (typeof document !== 'undefined' ? document : null);
      if (doc && typeof doc.addEventListener === 'function') {
        this._onVisibilityChange = () => {
          this.setHiddenMuted(Boolean(doc.hidden));
        };
        doc.addEventListener('visibilitychange', this._onVisibilityChange);
      }
    }

    get state() {
      return this._state;
    }

    get sampleRate() {
      return this._sampleRate;
    }

    get txMode() {
      return this._txMode;
    }

    get micLabel() {
      return this._micLabel;
    }

    get speakerLabel() {
      return this._speakerLabel;
    }

    get error() {
      return this._error;
    }

    getSnapshot() {
      return {
        state: this._state,
        sampleRate: this._sampleRate,
        txMode: this._txMode,
        micLabel: this._micLabel,
        speakerLabel: this._speakerLabel,
        canUseSonar: this._sampleRate >= MIN_SONAR_SAMPLE_RATE,
        error: this._error
      };
    }

    _emitState(nextState, extra = {}) {
      if (nextState) this._state = nextState;
      if (extra.error !== undefined) this._error = extra.error;
      if (extra.sampleRate !== undefined) this._sampleRate = extra.sampleRate;
      if (extra.micLabel !== undefined) this._micLabel = extra.micLabel;
      if (extra.speakerLabel !== undefined) this._speakerLabel = extra.speakerLabel;

      const snap = this.getSnapshot();
      const listeners = Array.from(this._stateListeners);
      for (let i = 0; i < listeners.length; i++) {
        try {
          listeners[i](snap);
        } catch (_) {}
      }
    }

    onStateChange(fn) {
      if (typeof fn !== 'function') return function () {};
      this._stateListeners.add(fn);
      try {
        fn(this.getSnapshot());
      } catch (_) {}
      return () => {
        this._stateListeners.delete(fn);
      };
    }

    setBeforeArmHook(fn) {
      if (typeof fn !== 'function') return function () {};
      this._beforeArmHooks.add(fn);
      return () => {
        this._beforeArmHooks.delete(fn);
      };
    }

    subscribeAudio(fn) {
      if (typeof fn !== 'function') return function () {};
      this._audioSubscribers.add(fn);
      return () => {
        this._audioSubscribers.delete(fn);
      };
    }

    registerTxGenerator(modeId, genFn) {
      const key = typeof modeId === 'string' ? modeId.trim() : '';
      if (!key || key === 'off' || typeof genFn !== 'function') {
        return function () {};
      }
      const hadActive = this._txGenerators.has(key);
      this._txGenerators.set(key, genFn);
      if (this._txMode === key && !hadActive) {
        this._activeTxMode = key;
        this._activeTxPhase = 0;
      }
      return () => {
        if (this._txGenerators.get(key) === genFn) {
          this._txGenerators.delete(key);
          if (this._txMode === key) {
            this.setTxMode('off');
          }
        }
      };
    }

    hasTxGenerator(modeId) {
      return this._txGenerators.has(String(modeId || ''));
    }

    getTxMode() {
      return this._txMode;
    }

    setTxMode(modeId) {
      const next = modeId ? String(modeId).trim() : 'off';
      const normalized = next || 'off';
      if (normalized === this._txMode) {
        return this._txMode;
      }

      // Smoothly crossfade from currently sounding mode(s) into next mode over 15 ms
      if (this._activeTxMode !== 'off' && this._activeTxPhase > 0) {
        const prevExisting = this._fadingModes.get(this._activeTxMode) || 0;
        this._fadingModes.set(this._activeTxMode, Math.max(prevExisting, this._activeTxPhase));
      }
      if (normalized !== 'off' && this._fadingModes.has(normalized)) {
        // Re-entering a mode mid-fade resumes smoothly from its instantaneous phase
        this._activeTxPhase = this._fadingModes.get(normalized);
        this._fadingModes.delete(normalized);
      } else {
        this._activeTxPhase = 0;
      }
      this._txMode = normalized;
      this._activeTxMode = normalized;

      this._emitState(this._state);
      return this._txMode;
    }

    setHiddenMuted(hidden) {
      const next = Boolean(hidden);
      if (next && this.workletNode && this.workletNode.port) {
        try {
          this.workletNode.port.postMessage({ type: 'flushTx' });
        } catch (_) {}
      }
      if (this._hiddenMuted === next) return;
      this._hiddenMuted = next;
      if (next) {
        this._activeTxPhase = 0;
        this._fadingModes.clear();
      } else if (
        this._state === 'listening' &&
        typeof this._workletPushTx === 'function' &&
        !isDocumentHidden(false, this._root)
      ) {
        this._workletPushTx();
        this._workletPushTx();
      }
    }

    _resetTxStateToOff() {
      this._txMode = 'off';
      this._activeTxMode = 'off';
      this._activeTxPhase = 0;
      this._fadingModes.clear();
    }

    /**
     * Captures a self-contained stereo 15 ms raised-cosine ramp-out buffer in
     * exact `BLOCK_SIZE` chunks without advancing live `_txSampleOffset` or
     * retaining any reference to live bus state during `stopAll()`.
     */
    _snapshotFadeTail(sampleRate) {
      const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : this._sampleRate;
      if (sr < MIN_SONAR_SAMPLE_RATE || isDocumentHidden(this._hiddenMuted, this._root)) {
        return null;
      }

      const fadingEntries = new Map();
      for (const [fMode, ph] of this._fadingModes.entries()) {
        if (ph > 0 && this._txGenerators.has(fMode)) {
          fadingEntries.set(fMode, ph);
        }
      }
      if (
        this._activeTxMode !== 'off' &&
        this._activeTxPhase > 0 &&
        this._txGenerators.has(this._activeTxMode)
      ) {
        const prev = fadingEntries.get(this._activeTxMode) || 0;
        fadingEntries.set(this._activeTxMode, Math.max(prev, this._activeTxPhase));
      }
      if (fadingEntries.size === 0) {
        return null;
      }

      const rampSamples = Math.max(1, Math.round(RAMP_DURATION_SEC * sr));
      const rampStep = 1 / rampSamples;
      const totalSamples = Math.ceil(rampSamples / BLOCK_SIZE) * BLOCK_SIZE;
      const snapL = new Float32Array(totalSamples);
      const snapR = new Float32Array(totalSamples);
      const tmpL = new Float32Array(BLOCK_SIZE);
      const tmpR = new Float32Array(BLOCK_SIZE);
      const baseOffset = this._txSampleOffset;

      for (const [fMode, startPhase] of fadingEntries.entries()) {
        const fn = this._txGenerators.get(fMode);
        if (!fn || startPhase <= 0) continue;
        let ph = startPhase;
        for (let blockOffset = 0; blockOffset < totalSamples && ph > 0; blockOffset += BLOCK_SIZE) {
          tmpL.fill(0);
          tmpR.fill(0);
          try {
            fn(tmpL, tmpR, sr, baseOffset + blockOffset);
          } catch (_) {
            break;
          }
          for (let i = 0; i < BLOCK_SIZE; i++) {
            ph = Math.max(0, ph - rampStep);
            if (ph <= 0) break;
            const gOut = 0.5 - 0.5 * Math.cos(Math.PI * ph);
            snapL[blockOffset + i] += clampSample(tmpL[i]) * gOut;
            snapR[blockOffset + i] += clampSample(tmpR[i]) * gOut;
          }
        }
      }

      for (let i = 0; i < totalSamples; i++) {
        snapL[i] = clampSample(snapL[i]);
        snapR[i] = clampSample(snapR[i]);
      }
      return { left: snapL, right: snapR };
    }

    _ensureScratchCapacity(len) {
      if (this._scratchL.length < len) {
        this._scratchL = new Float32Array(len);
        this._scratchR = new Float32Array(len);
        this._fadeScratchL = new Float32Array(len);
        this._fadeScratchR = new Float32Array(len);
      }
    }

    /**
     * Fills stereo output buffers (`leftOut`, `rightOut`) with smooth 15 ms
     * raised-cosine ramp-in/ramp-out across TX mode transitions.
     * Strictly outputs digital zero if `sampleRate < 40000` or `document.hidden`.
     */
    _renderTxBlock(leftOut, rightOut, sampleRate) {
      const len = leftOut ? leftOut.length : rightOut ? rightOut.length : 0;
      if (len <= 0) return;

      const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : this._sampleRate;
      const startOffset = this._txSampleOffset;
      this._txSampleOffset += len;

      if (leftOut) leftOut.fill(0);
      if (rightOut) rightOut.fill(0);

      // Mandatory safety gate: force strict silence on < 40 kHz (Bluetooth HFP) or hidden tab
      if (sr < MIN_SONAR_SAMPLE_RATE || isDocumentHidden(this._hiddenMuted, this._root)) {
        this._activeTxPhase = 0;
        this._fadingModes.clear();
        return;
      }

      this._ensureScratchCapacity(len);
      const rampStep = 1 / Math.max(1, Math.round(RAMP_DURATION_SEC * sr));

      // Accumulate any outgoing fading generators
      if (this._fadingModes.size > 0) {
        const subFadeL = this._fadeScratchL.subarray(0, len);
        const subFadeR = this._fadeScratchR.subarray(0, len);
        for (const [fMode, startPhase] of Array.from(this._fadingModes.entries())) {
          const fn = this._txGenerators.get(fMode);
          if (!fn || startPhase <= 0) {
            this._fadingModes.delete(fMode);
            continue;
          }
          subFadeL.fill(0);
          subFadeR.fill(0);
          try {
            fn(subFadeL, subFadeR, sr, startOffset);
          } catch (_) {
            this._fadingModes.delete(fMode);
            continue;
          }
          let ph = startPhase;
          for (let i = 0; i < len; i++) {
            ph = Math.max(0, ph - rampStep);
            if (ph <= 0) break;
            const gOut = 0.5 - 0.5 * Math.cos(Math.PI * ph);
            if (leftOut) leftOut[i] += clampSample(subFadeL[i]) * gOut;
            if (rightOut) rightOut[i] += clampSample(subFadeR[i]) * gOut;
          }
          if (ph <= 0) {
            this._fadingModes.delete(fMode);
          } else {
            this._fadingModes.set(fMode, ph);
          }
        }
      }

      // Accumulate active TX generator
      const activeFn =
        this._activeTxMode !== 'off' ? this._txGenerators.get(this._activeTxMode) : null;
      if (activeFn) {
        const subActiveL = this._scratchL.subarray(0, len);
        const subActiveR = this._scratchR.subarray(0, len);
        subActiveL.fill(0);
        subActiveR.fill(0);
        let ok = true;
        try {
          activeFn(subActiveL, subActiveR, sr, startOffset);
        } catch (_) {
          ok = false;
        }
        if (ok) {
          let ph = this._activeTxPhase;
          for (let i = 0; i < len; i++) {
            if (ph < 1) ph = Math.min(1, ph + rampStep);
            const gIn = ph >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * ph);
            if (leftOut) leftOut[i] += clampSample(subActiveL[i]) * gIn;
            if (rightOut) rightOut[i] += clampSample(subActiveR[i]) * gIn;
          }
          this._activeTxPhase = ph;
        }
      }

      // Final clamp on combined output channels
      if (leftOut) {
        for (let i = 0; i < len; i++) leftOut[i] = clampSample(leftOut[i]);
      }
      if (rightOut) {
        for (let i = 0; i < len; i++) rightOut[i] = clampSample(rightOut[i]);
      }
    }

    _emit512Block(clean512, sr) {
      const blockStartSample = this._rxSampleOffset;
      this._rxSampleOffset += BLOCK_SIZE;
      const subscribers = Array.from(this._audioSubscribers);
      if (subscribers.length === 0) return;

      const timeSec = blockStartSample / sr;
      const txMode = this._txMode;

      for (let i = 0; i < subscribers.length; i++) {
        // Provide an isolated 512-sample Float32Array per subscriber when >1 subscriber is
        // listening so in-place windowing or ring-buffer retention never corrupts siblings.
        const samples =
          i === subscribers.length - 1 ? clean512 : new Float32Array(clean512);
        try {
          subscribers[i]({
            samples,
            sampleRate: sr,
            timeSec,
            txMode
          });
        } catch (_) {}
      }
    }

    /**
     * Accepts arbitrary-length raw input chunks and frames them into exact
     * 512-sample sanitized `Float32Array` blocks for `subscribeAudio` listeners.
     */
    _deliverAudioSamples(inputChunk, sampleRate) {
      if (!inputChunk || !inputChunk.length) return;
      const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : this._sampleRate;

      // Fast path when chunk is already 512 samples and staging buffer is empty
      if (this._rxStageFill === 0 && inputChunk.length === BLOCK_SIZE) {
        const block = new Float32Array(BLOCK_SIZE);
        for (let i = 0; i < BLOCK_SIZE; i++) {
          const v = inputChunk[i];
          block[i] = Number.isFinite(v) ? v : 0;
        }
        this._emit512Block(block, sr);
        return;
      }

      let offset = 0;
      while (offset < inputChunk.length) {
        const space = BLOCK_SIZE - this._rxStageFill;
        const count = Math.min(space, inputChunk.length - offset);
        for (let i = 0; i < count; i++) {
          const v = inputChunk[offset + i];
          this._rxStage[this._rxStageFill + i] = Number.isFinite(v) ? v : 0;
        }
        this._rxStageFill += count;
        offset += count;

        if (this._rxStageFill === BLOCK_SIZE) {
          const block = new Float32Array(this._rxStage);
          this._rxStageFill = 0;
          this._emit512Block(block, sr);
        }
      }
    }

    /**
     * Deterministic helper for headless tests or synthetic frame drivers:
     * renders one stereo TX block and dispatches the paired RX samples.
     */
    processDuplexFrame(rxSamples, leftOut, rightOut, sampleRate) {
      const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : this._sampleRate;
      this._renderTxBlock(leftOut, rightOut, sr);
      if (rxSamples) {
        this._deliverAudioSamples(rxSamples, sr);
      }
    }

    requestArm(preferredTxMode, options = {}) {
      const hasPref =
        preferredTxMode !== undefined &&
        preferredTxMode !== null &&
        String(preferredTxMode).trim() !== '';

      if (this._state === 'listening') {
        if (hasPref) {
          this.setTxMode(String(preferredTxMode));
        }
        return Promise.resolve(true);
      }

      if (hasPref) {
        const mode = String(preferredTxMode).trim();
        this._txMode = mode;
        this._activeTxMode = mode;
        this._activeTxPhase = 0;
      }

      if (this._state === 'requesting' && this._armPromise) {
        if (hasPref) {
          this._emitState('requesting');
        }
        return this._armPromise;
      }

      const p = this._runArm(options).finally(() => {
        if (this._armPromise === p) {
          this._armPromise = null;
        }
      });
      this._armPromise = p;
      return p;
    }

    async _requestRawMic(nav, exactDeviceId) {
      const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 }
      };
      if (exactDeviceId) {
        audioConstraints.deviceId = { exact: exactDeviceId };
      }

      try {
        return await nav.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      } catch (err) {
        // Retry relaxed constraints ONLY on OverconstrainedError / TypeError — NEVER double-prompt on NotAllowedError!
        const name = err && err.name;
        if (name !== 'OverconstrainedError' && name !== 'TypeError') {
          throw err;
        }
        const fallback = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        };
        if (exactDeviceId) {
          fallback.deviceId = { ideal: exactDeviceId };
        }
        return await nav.mediaDevices.getUserMedia({ audio: fallback, video: false });
      }
    }

    async _runArm(options = {}) {
      const myEpoch = ++this._sessionEpoch;
      this._emitState('requesting', { error: '' });

      // Allow UI coordinator to stop Cell 1's standalone controller before opening hardware mic
      const hooks = Array.from(this._beforeArmHooks);
      for (let i = 0; i < hooks.length; i++) {
        try {
          await hooks[i]();
        } catch (_) {}
        if (myEpoch !== this._sessionEpoch) {
          return false;
        }
      }

      const nav =
        (this._root && this._root.navigator) ||
        (typeof navigator !== 'undefined' ? navigator : null);
      const loc =
        (this._root && this._root.location) ||
        (typeof location !== 'undefined' ? location : null);

      if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
        this._resetTxStateToOff();
        const isFile = Boolean(loc && loc.protocol === 'file:');
        this._emitState('error', {
          error: isFile
            ? 'Mic blocked on file:// — serve over localhost or use cell Sim controls.'
            : 'Microphone API unavailable in this browser.'
        });
        return false;
      }

      const local = {
        stream: null,
        audioCtx: null,
        micSource: null,
        scriptNode: null,
        workletNode: null,
        workletPushTx: null
      };

      try {
        local.stream = await this._requestRawMic(nav, options.deviceId || null);
        if (myEpoch !== this._sessionEpoch) {
          disposeAudioHandles(local);
          return false;
        }

        const devices =
          typeof nav.mediaDevices.enumerateDevices === 'function'
            ? await nav.mediaDevices.enumerateDevices().catch(() => [])
            : [];
        if (myEpoch !== this._sessionEpoch) {
          disposeAudioHandles(local);
          return false;
        }

        const audioInputs = devices.filter((d) => d && d.kind === 'audioinput');
        const audioOutputs = devices.filter((d) => d && d.kind === 'audiooutput');

        // Auto-prefer built-in MacBook microphone array when default input is an external/Bluetooth mic
        if (!options.deviceId && audioInputs.length > 1) {
          const tracks = local.stream.getAudioTracks ? local.stream.getAudioTracks() : [];
          const currentLabel = (tracks[0] && tracks[0].label) || '';
          const builtInMic = audioInputs.find((d) => d.deviceId && BUILTIN_RE.test(d.label || ''));
          if (builtInMic && !BUILTIN_RE.test(currentLabel)) {
            try {
              const upgradedStream = await this._requestRawMic(nav, builtInMic.deviceId);
              if (myEpoch !== this._sessionEpoch) {
                disposeAudioHandles({ stream: upgradedStream });
                disposeAudioHandles(local);
                return false;
              }
              disposeAudioHandles({ stream: local.stream });
              local.stream = upgradedStream;
            } catch (_) {}
          }
        }

        const activeTracks = local.stream.getAudioTracks ? local.stream.getAudioTracks() : [];
        const micLabel = (activeTracks[0] && activeTracks[0].label) || 'Built-in Mic Array';

        const AudioCtx =
          (this._root && (this._root.AudioContext || this._root.webkitAudioContext)) ||
          (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
          globalThis.AudioContext ||
          globalThis.webkitAudioContext;

        if (typeof AudioCtx !== 'function') {
          disposeAudioHandles(local);
          this._resetTxStateToOff();
          this._emitState('error', { error: 'Web Audio API unavailable in this environment.' });
          return false;
        }

        const ctx = new AudioCtx({
          latencyHint: 'interactive',
          sampleRate: 48000
        });
        local.audioCtx = ctx;
        const sr = Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 48000;

        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          await ctx.resume();
        }
        if (myEpoch !== this._sessionEpoch) {
          disposeAudioHandles(local);
          return false;
        }

        // Auto-prefer built-in MacBook stereo speakers via setSinkId when supported
        let speakerLabel = 'Stereo Speakers';
        const builtInOut = audioOutputs.find((d) => d.deviceId && BUILTIN_RE.test(d.label || ''));
        if (builtInOut && typeof ctx.setSinkId === 'function') {
          try {
            await ctx.setSinkId(builtInOut.deviceId);
            speakerLabel = builtInOut.label || 'Built-in Speakers';
          } catch (_) {}
        }
        if (myEpoch !== this._sessionEpoch) {
          disposeAudioHandles(local);
          return false;
        }

        if (ctx.destination && ctx.destination.maxChannelCount >= 2) {
          try {
            ctx.destination.channelCount = 2;
            ctx.destination.channelCountMode = 'explicit';
            ctx.destination.channelInterpretation = 'speakers';
          } catch (_) {}
        }

        this._rxSampleOffset = 0;
        this._rxStageFill = 0;
        this._txSampleOffset = 0;
        this._activeTxMode = this._txMode;
        this._activeTxPhase = 0;
        this._fadingModes.clear();

        local.micSource = ctx.createMediaStreamSource(local.stream);

        const useWorkletOnly =
          Boolean(options.preferWorklet) || typeof ctx.createScriptProcessor !== 'function';
        let connected = false;

        if (
          useWorkletOnly &&
          ctx.audioWorklet &&
          typeof ctx.audioWorklet.addModule === 'function' &&
          typeof Blob !== 'undefined' &&
          typeof URL !== 'undefined'
        ) {
          let blobUrl = '';
          try {
            const blob = new Blob([createBusWorkletSource()], {
              type: 'application/javascript'
            });
            blobUrl = URL.createObjectURL(blob);
            await ctx.audioWorklet.addModule(blobUrl);
            if (myEpoch !== this._sessionEpoch) {
              disposeAudioHandles(local);
              return false;
            }
            const WorkletNodeCls =
              (this._root && this._root.AudioWorkletNode) ||
              (typeof AudioWorkletNode === 'function' ? AudioWorkletNode : null);
            if (WorkletNodeCls) {
              const node = new WorkletNodeCls(ctx, 'lg-shared-acoustic-bus-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2]
              });
              const pushTxBlockToWorklet = () => {
                if (myEpoch !== this._sessionEpoch) return;
                if (isDocumentHidden(this._hiddenMuted, this._root)) {
                  this._activeTxPhase = 0;
                  this._fadingModes.clear();
                  try {
                    node.port.postMessage({ type: 'flushTx' });
                  } catch (_) {}
                  return;
                }
                const left = new Float32Array(BLOCK_SIZE);
                const right = new Float32Array(BLOCK_SIZE);
                this._renderTxBlock(left, right, sr);
                node.port.postMessage(
                  { type: 'txBlock', left, right },
                  [left.buffer, right.buffer]
                );
              };
              for (let q = 0; q < 3; q++) pushTxBlockToWorklet();
              node.port.onmessage = (ev) => {
                if (myEpoch !== this._sessionEpoch) return;
                const d = ev && ev.data;
                if (d && d.type === 'rxBlock' && d.samples) {
                  pushTxBlockToWorklet();
                  this._deliverAudioSamples(d.samples, sr);
                }
              };
              local.micSource.connect(node);
              node.connect(ctx.destination);
              local.workletNode = node;
              local.workletPushTx = pushTxBlockToWorklet;
              connected = true;
            }
          } catch (_) {
            connected = false;
          } finally {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
          }
        }

        if (!connected && typeof ctx.createScriptProcessor === 'function') {
          const sp = ctx.createScriptProcessor(BLOCK_SIZE, 1, 2);
          sp.onaudioprocess = (audioEv) => {
            if (myEpoch !== this._sessionEpoch) return;
            const outBuf = audioEv.outputBuffer;
            const outL = outBuf ? outBuf.getChannelData(0) : null;
            const outR =
              outBuf && outBuf.numberOfChannels > 1 ? outBuf.getChannelData(1) : null;
            this._renderTxBlock(outL, outR, sr);

            const inBuf = audioEv.inputBuffer;
            const inCh = inBuf ? inBuf.getChannelData(0) : null;
            if (inCh) {
              this._deliverAudioSamples(inCh, sr);
            }
          };
          local.micSource.connect(sp);
          sp.connect(ctx.destination);
          local.scriptNode = sp;
          connected = true;
        }

        if (!connected) {
          disposeAudioHandles(local);
          this._resetTxStateToOff();
          this._emitState('error', { error: 'Audio processor initialization failed.' });
          return false;
        }

        // Commit session atomically
        this.stream = local.stream;
        this.audioCtx = local.audioCtx;
        this.micSource = local.micSource;
        this.scriptNode = local.scriptNode;
        this.workletNode = local.workletNode;
        this._workletPushTx = local.workletPushTx;

        this._emitState('listening', {
          error: '',
          sampleRate: sr,
          micLabel,
          speakerLabel
        });
        return true;
      } catch (err) {
        const aborted = myEpoch !== this._sessionEpoch;
        disposeAudioHandles(local);
        if (aborted) return false;
        this._resetTxStateToOff();
        const msg =
          err && err.name === 'NotAllowedError'
            ? 'Mic permission denied — allow microphone access or use Sim controls.'
            : (err && err.message) || 'Shared acoustic bus failed to start.';
        this._emitState('error', { error: msg });
        return false;
      }
    }

    async stopAll(options = {}) {
      this._sessionEpoch++;
      this._armPromise = null;

      // Synchronously detach active handles so rapid stopAll() -> requestArm() never races
      const detached = {
        workletNode: this.workletNode,
        scriptNode: this.scriptNode,
        micSource: this.micSource,
        stream: this.stream,
        audioCtx: this.audioCtx
      };
      this.workletNode = null;
      this.scriptNode = null;
      this.micSource = null;
      this.stream = null;
      this.audioCtx = null;
      this._workletPushTx = null;

      const canFadeScriptNode = Boolean(
        !options.immediate &&
          detached.scriptNode &&
          detached.audioCtx &&
          detached.audioCtx.state === 'running'
      );
      const fadeSr =
        (detached.audioCtx && detached.audioCtx.sampleRate) || this._sampleRate || 48000;
      const fadeSnapshot = canFadeScriptNode ? this._snapshotFadeTail(fadeSr) : null;

      this._resetTxStateToOff();
      this._rxStageFill = 0;

      this._emitState('idle', { error: '' });

      // Dispatch global secondary-grid lifecycle close event (prefer instance root first)
      if (options.dispatchClose !== false) {
        const win =
          (this._root && typeof this._root.dispatchEvent === 'function' ? this._root : null) ||
          (this._root &&
          this._root.window &&
          typeof this._root.window.dispatchEvent === 'function'
            ? this._root.window
            : null) ||
          (typeof window !== 'undefined' && window && typeof window.dispatchEvent === 'function'
            ? window
            : null);
        if (win && typeof win.dispatchEvent === 'function') {
          try {
            const CustomEvt =
              (win && win.CustomEvent) ||
              (typeof CustomEvent === 'function' ? CustomEvent : null);
            const Evt =
              CustomEvt ||
              (win && win.Event) ||
              (typeof Event === 'function' ? Event : null);
            const ev = Evt ? new Evt('lg-secondary-close') : { type: 'lg-secondary-close' };
            win.dispatchEvent(ev);
          } catch (_) {}
        }
      }

      if (detached.workletNode) {
        try {
          detached.workletNode.port.onmessage = null;
          detached.workletNode.port.postMessage({ type: 'flushTx' });
        } catch (_) {}
      }

      // Allow a 20 ms ramp-down window from pre-snapshotted samples when active ultrasonic TX
      // was running on ScriptProcessor — never touches live `this` state or new TX generators!
      if (fadeSnapshot && detached.scriptNode) {
        let readPos = 0;
        const snapL = fadeSnapshot.left;
        const snapR = fadeSnapshot.right;
        detached.scriptNode.onaudioprocess = (audioEv) => {
          const outBuf = audioEv.outputBuffer;
          const outL = outBuf ? outBuf.getChannelData(0) : null;
          const outR =
            outBuf && outBuf.numberOfChannels > 1 ? outBuf.getChannelData(1) : null;
          const len = outL ? outL.length : outR ? outR.length : 0;
          if (outL) outL.fill(0);
          if (outR) outR.fill(0);
          if (
            len <= 0 ||
            readPos >= snapL.length ||
            isDocumentHidden(this._hiddenMuted, this._root)
          ) {
            readPos = snapL.length;
            return;
          }
          const copyLen = Math.min(len, snapL.length - readPos);
          if (outL) {
            for (let i = 0; i < copyLen; i++) outL[i] = snapL[readPos + i];
          }
          if (outR) {
            for (let i = 0; i < copyLen; i++) outR[i] = snapR[readPos + i];
          }
          readPos += copyLen;
        };
        await new Promise((r) => setTimeout(r, 20));
      }

      disposeAudioHandles(detached);
    }
  }

  /**
   * Initializes or augments `targetRoot.LeftGrilleLab` in place while preserving
   * and draining any pre-registered `_pending` slot queue (`[slotNumber, spec]`).
   */
  function createLeftGrilleLab(targetRoot, options = {}) {
    const host = targetRoot || {};
    const lab =
      options.fresh || !host.LeftGrilleLab || typeof host.LeftGrilleLab !== 'object'
        ? { _pending: [] }
        : host.LeftGrilleLab;

    const priorPending = Array.isArray(lab._pending) ? lab._pending.slice() : [];
    lab._pending = [];

    const bus =
      lab.bus instanceof SharedAcousticBus
        ? lab.bus
        : new SharedAcousticBus({ root: host });

    const registry = new Map();     // slotNumber (2..9) -> spec
    const slotElements = new Map(); // slotNumber (2..9) -> HTMLElement
    const mountedCells = new Map(); // slotNumber (2..9) -> { spec, el }

    function resolveSlotElement(slotNumber) {
      if (slotElements.has(slotNumber)) {
        return slotElements.get(slotNumber);
      }
      const doc =
        (host && host.document) ||
        (typeof document !== 'undefined' ? document : null);
      if (doc && typeof doc.getElementById === 'function') {
        const found = doc.getElementById(`lg-sec-cell-${slotNumber}`);
        if (found) {
          slotElements.set(slotNumber, found);
          return found;
        }
      }
      return null;
    }

    function tryMountSlot(slotNumber) {
      const spec = registry.get(slotNumber);
      if (!spec || typeof spec.mount !== 'function') return false;
      const cellEl = resolveSlotElement(slotNumber);
      if (!cellEl) return false;

      const prev = mountedCells.get(slotNumber);
      if (prev && prev.spec === spec && prev.el === cellEl) {
        return true;
      }

      if (spec.title && typeof cellEl.setAttribute === 'function') {
        if (!cellEl.getAttribute || !cellEl.getAttribute('aria-label')) {
          cellEl.setAttribute('aria-label', String(spec.title));
        }
      }
      if (spec.id && cellEl.dataset) {
        cellEl.dataset.cellId = String(spec.id);
      }

      mountedCells.set(slotNumber, { spec, el: cellEl });
      try {
        spec.mount(cellEl, bus);
      } catch (err) {
        spec._mountError = err;
      }
      return true;
    }

    function drainPendingQueue() {
      if (!Array.isArray(lab._pending) || lab._pending.length === 0) return;
      const queued = lab._pending.splice(0, lab._pending.length);
      for (let i = 0; i < queued.length; i++) {
        const entry = queued[i];
        if (Array.isArray(entry) && entry.length >= 2) {
          registerCell(entry[0], entry[1]);
        } else if (entry && typeof entry === 'object') {
          registerCell(
            entry.slotNumber !== undefined ? entry.slotNumber : entry.slot,
            entry.spec || entry
          );
        }
      }
    }

    function registerCell(slotNumber, spec) {
      const slot = Number(slotNumber);
      if (!Number.isInteger(slot) || slot < 2 || slot > 9) {
        return false;
      }
      if (!spec || typeof spec !== 'object' || typeof spec.mount !== 'function') {
        return false;
      }
      registry.set(slot, spec);
      tryMountSlot(slot);
      return true;
    }

    function attachSecondarySlots(elementsBySlot) {
      if (elementsBySlot && typeof elementsBySlot === 'object') {
        Object.keys(elementsBySlot).forEach((k) => {
          const slot = Number(k);
          const el = elementsBySlot[k];
          if (Number.isInteger(slot) && slot >= 2 && slot <= 9 && el) {
            slotElements.set(slot, el);
          }
        });
      }
      drainPendingQueue();
      for (const slot of registry.keys()) {
        tryMountSlot(slot);
      }
    }

    function getRegisteredCell(slotNumber) {
      return registry.get(Number(slotNumber)) || null;
    }

    lab.bus = bus;
    lab.registerCell = registerCell;
    lab.attachSecondarySlots = attachSecondarySlots;
    lab.drainPending = drainPendingQueue;
    lab.getRegisteredCell = getRegisteredCell;
    lab.SharedAcousticBus = SharedAcousticBus;
    lab.BLOCK_SIZE = BLOCK_SIZE;

    // Preserve pre-attached slot elements if ui.js ran before shared-bus.js
    if (lab._slotElements && typeof lab._slotElements === 'object') {
      attachSecondarySlots(lab._slotElements);
    }

    // Drain any items pre-queued on `_pending` prior to shared-bus initialization
    for (let i = 0; i < priorPending.length; i++) {
      const item = priorPending[i];
      if (Array.isArray(item) && item.length >= 2) {
        registerCell(item[0], item[1]);
      } else if (item && typeof item === 'object') {
        registerCell(
          item.slotNumber !== undefined ? item.slotNumber : item.slot,
          item.spec || item
        );
      }
    }

    if (typeof lab._onReady === 'function') {
      const cb = lab._onReady;
      lab._onReady = null;
      try {
        cb(lab);
      } catch (_) {}
    }

    if (!options.fresh && host && typeof host === 'object') {
      host.LeftGrilleLab = lab;
    }

    return lab;
  }

  const defaultLab = root ? createLeftGrilleLab(root) : null;

  return {
    BLOCK_SIZE,
    RAMP_DURATION_SEC,
    MIN_SONAR_SAMPLE_RATE,
    SharedAcousticBus,
    createLeftGrilleLab,
    LeftGrilleLab: defaultLab
  };
});
