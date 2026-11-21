/**
 * Spatial Hand & Gesture Kinematics Engine (`cells/hand-gesture/kinematics.js`)
 * SPDX-License-Identifier: MIT-0
 *
 * Pure clean-room zero-GC kinematics core shared across browser UI and `node --test`:
 * - Coupled 2D One-Euro Filter (`OneEuroFilter2D`, Casiez et al. CHI 2012)
 * - Nearest-palm 2-slot identity lock + aspect-isotropic palm-span gate
 * - Chiral-invariant 3D `worldLandmarks` palm-facing normal + keyboard exclusion (`y < 0.86`)
 * - 200ms steady open-palm arming dwell + 4-frame (~145ms) dropout coasting
 * - Rigid metacarpal cursor anchor (`0.50*L5 + 0.30*L9 + 0.20*L0`) eliminating index-tip pinch dip
 * - Switchable Absolute ROI (`[0.22, 0.78]`) & Relative Fist-Clutch cursor mapping with ballistics
 * - Schmitt-trigger scale-invariant pinch (`<0.28` / `>0.40`), `0.08x` pre-pinch brake & `14px` click-lock
 * - Branch-free unwrapped wrist rotation (`fused`, `knuckle`, `lever`) + 2-hand zoom/steer
 * - Two-finger Peace `V-Scroll` posture detector with `0.94` momentum inertia
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.HandGestureKinematics = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const LM = Object.freeze({
    WRIST: 0, THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
    INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
    MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
    RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
    PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
  });

  const HAND_BONES = new Uint8Array([
    0, 1, 1, 2, 2, 3, 3, 4,
    0, 5, 5, 6, 6, 7, 7, 8,
    0, 9, 9, 10, 10, 11, 11, 12,
    0, 13, 13, 14, 14, 15, 15, 16,
    0, 17, 17, 18, 18, 19, 19, 20,
    5, 9, 9, 13, 13, 17,
  ]);

  const HAND_STATE = Object.freeze({ IDLE: 0, ARMING: 1, ARMED: 2, COASTING: 3 });
  const PINCH_MODE = Object.freeze({ NONE: 0, CLICK_LOCK: 1, DRAG: 2, TWO_HAND: 3 });
  const ROTATION_SOURCE = Object.freeze({ FUSED: 'fused', KNUCKLE_BAR: 'knuckle', WRIST_LEVER: 'lever' });
  const MAPPING_MODE = Object.freeze({ ABSOLUTE_ROI: 'roi', RELATIVE_CLUTCH: 'clutch' });

  const DEFAULT_CONFIG = Object.freeze({
    minPalmSpan: 0.055,
    minPalmFacingCos: 0.22,
    keyboardExclusionY: 0.86,
    armDwellSec: 0.200,
    maxArmAnchorSpeed: 1.25,
    coastMaxFrames: 4,
    coastMaxSec: 0.145,
    slotLockRadius: 0.30,
    invertChirality: false,
    mappingMode: MAPPING_MODE.ABSOLUTE_ROI,
    roiMinX: 0.22,
    roiMaxX: 0.78,
    roiMinY: 0.22,
    roiMaxY: 0.78,
    clutchMinGain: 0.95,
    clutchMaxGain: 2.90,
    minCutoff: 1.15,
    beta: 0.85,
    dCutoff: 1.8,
    pinchEngage: 0.28,
    pinchRelease: 0.40,
    prePinchZone: 0.50,
    prePinchClosingVel: -0.35,
    prePinchDamping: 0.08,
    clickBreakoutPx: 14,
    clickMaxDurationSec: 0.280,
    rotationSource: ROTATION_SOURCE.FUSED,
    twistDeadzoneDeg: 3.5,
    twistGain: 2.0,
    vScrollDecay: 0.94,
    vScrollGain: 1050,
    vScrollDeadzone: 0.0016,
  });

  const RAD_TO_DEG = 180 / Math.PI;
  const DEG_TO_RAD = Math.PI / 180;
  const TWO_PI = Math.PI * 2;

  function clamp(v, lo, hi) {
    if (typeof v !== 'number' || Number.isNaN(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function unwrapAngleDelta(theta, prevTheta) {
    const d = theta - prevTheta;
    if (!Number.isFinite(d)) return 0;
    return Math.atan2(Math.sin(d), Math.cos(d));
  }

  function oneEuroAlpha(cutoffHz, dtSec) {
    const c = cutoffHz > 1e-4 ? cutoffHz : 1e-4;
    const tau = 1 / (TWO_PI * c);
    return 1 / (1 + tau / dtSec);
  }

  /** Coupled 2D 1-Euro Filter using isotropic vector speed hypot(edx, edy). Zero GC. */
  class OneEuroFilter2D {
    constructor() {
      this.initialized = false;
      this.lastTimeSec = 0;
      this.rawX = 0;
      this.rawY = 0;
      this.x = 0;
      this.y = 0;
      this.edx = 0;
      this.edy = 0;
      this.speed = 0;
      this.cutoffHz = DEFAULT_CONFIG.minCutoff;
    }

    reset() {
      this.initialized = false;
      this.edx = 0;
      this.edy = 0;
      this.speed = 0;
    }

    filter(rx, ry, timestampSec, minCutoff, beta, dCutoff) {
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(timestampSec)) {
        return;
      }
      if (!this.initialized) {
        this.initialized = true;
        this.lastTimeSec = timestampSec;
        this.rawX = rx;
        this.rawY = ry;
        this.x = rx;
        this.y = ry;
        this.edx = 0;
        this.edy = 0;
        this.speed = 0;
        this.cutoffHz = minCutoff;
        return;
      }
      let dt = timestampSec - this.lastTimeSec;
      if (dt <= 1e-5) dt = 1 / 120;
      else if (dt > 0.25) dt = 0.25;
      this.lastTimeSec = timestampSec;

      const aDeriv = oneEuroAlpha(dCutoff, dt);
      this.edx += aDeriv * (((rx - this.rawX) / dt) - this.edx);
      this.edy += aDeriv * (((ry - this.rawY) / dt) - this.edy);
      this.speed = Math.hypot(this.edx, this.edy);

      const cutoff = minCutoff + beta * this.speed;
      this.cutoffHz = cutoff;
      const aPos = oneEuroAlpha(cutoff, dt);
      this.rawX = rx;
      this.rawY = ry;
      this.x += aPos * (rx - this.x);
      this.y += aPos * (ry - this.y);
    }
  }

  /** Pre-allocated 60fps oscilloscope ring buffer + dB jitter attenuation metric. */
  class ScopeRingBuffer {
    constructor(capacity = 240) {
      this.capacity = capacity;
      this.rawX = new Float32Array(capacity);
      this.rawY = new Float32Array(capacity);
      this.smoothX = new Float32Array(capacity);
      this.smoothY = new Float32Array(capacity);
      this.speed = new Float32Array(capacity);
      this.pinch = new Float32Array(capacity);
      this.damped = new Uint8Array(capacity);
      this.head = 0;
      this.count = 0;
      this.attenuationDb = 0;
    }

    push(rx, ry, sx, sy, spd, pinchRatio, isDamped) {
      if (!Number.isFinite(rx) || !Number.isFinite(sx)) return;
      const idx = this.head;
      const cap = this.capacity;
      this.rawX[idx] = rx;
      this.rawY[idx] = ry;
      this.smoothX[idx] = sx;
      this.smoothY[idx] = sy;
      this.speed[idx] = Number.isFinite(spd) ? spd : 0;
      this.pinch[idx] = Number.isFinite(pinchRatio) ? pinchRatio : 1;
      this.damped[idx] = isDamped ? 1 : 0;
      this.head = (idx + 1) % cap;
      if (this.count < cap) this.count++;

      const win = this.count < 48 ? this.count : 48;
      if (win >= 4) {
        let rSq = 0;
        let sSq = 0;
        for (let i = 2; i < win; i++) {
          const i0 = (this.head - 1 - i + cap * 2) % cap;
          const i1 = (i0 + 1) % cap;
          const i2 = (i0 + 2) % cap;
          const rddx = this.rawX[i2] - 2 * this.rawX[i1] + this.rawX[i0];
          const rddy = this.rawY[i2] - 2 * this.rawY[i1] + this.rawY[i0];
          const sddx = this.smoothX[i2] - 2 * this.smoothX[i1] + this.smoothX[i0];
          const sddy = this.smoothY[i2] - 2 * this.smoothY[i1] + this.smoothY[i0];
          rSq += rddx * rddx + rddy * rddy;
          sSq += sddx * sddx + sddy * sddy;
        }
        const rRms = Math.sqrt(rSq / (win - 2));
        const sRms = Math.sqrt(sSq / (win - 2));
        this.attenuationDb = (rRms > 1e-6 && sRms > 1e-7) ? 20 * Math.log10(sRms / rRms) : 0;
      }
    }

    clear() {
      this.head = 0;
      this.count = 0;
      this.attenuationDb = 0;
    }
  }

  /**
   * Chiral-invariant 3D palm-facing normal check using `worldLandmarks` cross(L5-L0, L17-L0).
   * On unmirrored MediaPipe video, physical Right palm facing camera has nz < 0 & label 'Left' (sign -1 -> +1),
   * and physical Left palm facing camera has nz > 0 & label 'Right' (sign +1 -> +1).
   */
  function computePalmFacingCosFlat(worldFlat, isLeftLabel, invertChirality) {
    const i5 = LM.INDEX_MCP * 3;
    const i17 = LM.PINKY_MCP * 3;
    const v1x = worldFlat[i5] - worldFlat[0];
    const v1y = worldFlat[i5 + 1] - worldFlat[1];
    const v1z = worldFlat[i5 + 2] - worldFlat[2];
    const v2x = worldFlat[i17] - worldFlat[0];
    const v2y = worldFlat[i17 + 1] - worldFlat[1];
    const v2z = worldFlat[i17 + 2] - worldFlat[2];
    const nx = v1y * v2z - v1z * v2y;
    const ny = v1z * v2x - v1x * v2z;
    const nz = v1x * v2y - v1y * v2x;
    const len = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(len) || len < 1e-8) return 0;
    let sign = isLeftLabel ? -1 : 1;
    if (invertChirality) sign = -sign;
    return sign * (nz / len);
  }

  function isFiniteFlat63(flat63) {
    if (!flat63 || flat63.length < 63) return false;
    for (let i = 0; i < 63; i++) {
      if (!Number.isFinite(flat63[i])) return false;
    }
    return true;
  }

  function copyLandmarksToFlat(landmarksObjArr, outFlat63) {
    if (!landmarksObjArr || landmarksObjArr.length < 21) return false;
    for (let i = 0; i < 21; i++) {
      const pt = landmarksObjArr[i];
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
      const b = i * 3;
      outFlat63[b] = pt.x;
      outFlat63[b + 1] = pt.y;
      outFlat63[b + 2] = Number.isFinite(pt.z) ? pt.z : 0;
    }
    return true;
  }

  function computePalmSpanFlat(normFlat, aspect) {
    const i5 = LM.INDEX_MCP * 3;
    const i9 = LM.MIDDLE_MCP * 3;
    const i17 = LM.PINKY_MCP * 3;
    const w = Math.hypot((normFlat[i5] - normFlat[i17]) * aspect, normFlat[i5 + 1] - normFlat[i17 + 1]);
    const l09 = Math.hypot((normFlat[0] - normFlat[i9]) * aspect, normFlat[1] - normFlat[i9 + 1]);
    const l05 = Math.hypot((normFlat[0] - normFlat[i5]) * aspect, normFlat[1] - normFlat[i5 + 1]);
    return Math.max(l09, l05, 1.12 * w, 1e-5);
  }

  /** Closed-fist & curling-into-fist detectors (distinguishes whole-hand fist closure from thumb-index pinch). */
  function detectClosedFistFlat(normFlat, sPalm, aspect) {
    if (sPalm < 1e-5) return false;
    const l0x = normFlat[0];
    const l0y = normFlat[1];
    const dWrist = (idx) => Math.hypot((normFlat[idx * 3] - l0x) * aspect, normFlat[idx * 3 + 1] - l0y) / sPalm;
    return (
      dWrist(LM.INDEX_TIP) < 1.22 &&
      dWrist(LM.MIDDLE_TIP) < 1.22 &&
      dWrist(LM.RING_TIP) < 1.20 &&
      dWrist(LM.PINKY_TIP) < 1.20
    );
  }

  function detectFistClosingFlat(normFlat, sPalm, aspect) {
    if (sPalm < 1e-5) return false;
    const l0x = normFlat[0];
    const l0y = normFlat[1];
    const dWrist = (idx) => Math.hypot((normFlat[idx * 3] - l0x) * aspect, normFlat[idx * 3 + 1] - l0y) / sPalm;
    return (
      dWrist(LM.MIDDLE_TIP) < 1.42 &&
      dWrist(LM.RING_TIP) < 1.38 &&
      dWrist(LM.PINKY_TIP) < 1.35
    );
  }

  /** Two-Finger V-Scroll: Index + Middle extended, Ring + Pinky curled, unpinched. */
  function detectVScrollPostureFlat(normFlat, sPalm, aspect, pinchRatio) {
    if (sPalm < 1e-5 || pinchRatio < 0.42) return false;
    const l0x = normFlat[0];
    const l0y = normFlat[1];
    const dWrist = (idx) => Math.hypot((normFlat[idx * 3] - l0x) * aspect, normFlat[idx * 3 + 1] - l0y) / sPalm;

    const idxTip = dWrist(LM.INDEX_TIP);
    const idxPip = dWrist(LM.INDEX_PIP);
    const midTip = dWrist(LM.MIDDLE_TIP);
    const midPip = dWrist(LM.MIDDLE_PIP);
    const rngTip = dWrist(LM.RING_TIP);
    const rngPip = dWrist(LM.RING_PIP);
    const pkyTip = dWrist(LM.PINKY_TIP);
    const pkyPip = dWrist(LM.PINKY_PIP);

    if (!(idxTip > 1.38 && idxTip > idxPip * 1.10 && midTip > 1.38 && midTip > midPip * 1.10)) return false;
    if (!((rngTip < rngPip * 1.04 || rngTip < 1.26) && (pkyTip < pkyPip * 1.04 || pkyTip < 1.22))) return false;

    const a = LM.INDEX_TIP * 3;
    const b = LM.MIDDLE_TIP * 3;
    return Math.hypot((normFlat[a] - normFlat[b]) * aspect, normFlat[a + 1] - normFlat[b + 1]) / sPalm > 0.12;
  }

  class HandSlot {
    constructor(slotIndex) {
      this.slotIndex = slotIndex;
      this.normLm = new Float64Array(63);
      this.worldLm = new Float64Array(63);
      this.euroFilter = new OneEuroFilter2D();
      this.reset();
      this.palmX = 0.5;
      this.palmY = 0.5;
      this.palmSpan = 0;
      this.palmFacingCos = 0;
      this.anchorCamX = 0.5;
      this.anchorCamY = 0.5;
      this.indexTipCamX = 0.5;
      this.indexTipCamY = 0.5;
      this.rawU = 0.5;
      this.rawV = 0.5;
      this.cursorU = 0.5;
      this.cursorV = 0.5;
      this.screenX = 0;
      this.screenY = 0;
      this.interactiveX = 0;
      this.interactiveY = 0;
    }

    reset() {
      this.isLeftLabel = true;
      this.visible = false;
      this.state = HAND_STATE.IDLE;
      this.armProgress = 0;
      this.coastFrames = 0;
      this.lastSeenSec = 0;
      this.gateSpanOk = false;
      this.gateFacingOk = false;
      this.gateKeyboardOk = false;
      this.gateOpenOk = false;
      this.hadValidGates = false;
      this.clutchReleased = false;
      this.prevFilterU = 0.5;
      this.prevFilterV = 0.5;
      this.velocityDamped = false;
      this.pinchRatio = 1.0;
      this.prevPinchRatio = 1.0;
      this.pinchVel = 0;
      this.pinched = false;
      this.pinchMode = PINCH_MODE.NONE;
      this.pinchStartSec = 0;
      this.lockOriginX = 0;
      this.lockOriginY = 0;
      this.breakoutOffsetX = 0;
      this.breakoutOffsetY = 0;
      this.pinchSlipPx = 0;
      this.lastClickDwellMs = 0;
      this.lastClickSlipPx = 0;
      this.knuckleRad = 0;
      this.leverRad = 0;
      this.angleInitialized = false;
      this.unwrappedRad = 0;
      this.twistAnchorRad = 0;
      this.twistBrokenOut = false;
      this.twistBreakoutSign = 0;
      this.twistTotalDeg = 0;
      this.twistDeltaDeg = 0;
      this.vScrollActive = false;
      this.vPrevMidY = 0;
      this.vWasActive = false;
      this.euroFilter.reset();
    }
  }

  class CandidateScratch {
    constructor() {
      this.normLm = new Float64Array(63);
      this.worldLm = new Float64Array(63);
      this.isLeftLabel = true;
      this.palmX = 0.5;
      this.palmY = 0.5;
      this.palmSpan = 0;
      this.assigned = false;
    }
  }

  class KinematicEngine {
    constructor(customConfig) {
      this.config = Object.assign({}, DEFAULT_CONFIG, customConfig || {});
      this.slots = [new HandSlot(0), new HandSlot(1)];
      this.candidates = [
        new CandidateScratch(),
        new CandidateScratch(),
        new CandidateScratch(),
        new CandidateScratch(),
      ];
      this.scope = new ScopeRingBuffer(240);
      this.events = {
        justArmed: false,
        justDisarmed: false,
        pinchStart: false,
        pinchDragStart: false,
        pinchRelease: false,
        clickFired: false,
        clickX: 0,
        clickY: 0,
        clickDwellMs: 0,
        clickSlipPx: 0,
        dragDeltaX: 0,
        dragDeltaY: 0,
        twoHandActive: false,
        twoHandJustStarted: false,
        twoHandJustEnded: false,
        twoHandScaleRatio: 1.0,
        twoHandDeltaDeg: 0,
        twoHandTotalDeg: 0,
        twoHandMidX: 0,
        twoHandMidY: 0,
        scrollVelocityPx: 0,
        scrollDeltaPx: 0,
      };
      this._twoHandWasActive = false;
      this._twoHandInitSpan = 100;
      this._twoHandPrevAngle = 0;
      this._twoHandTotalDeg = 0;
      this._scrollVelPx = 0;
      this._lastStepSec = 0;
      this._prevInteractiveX = 0;
      this._prevInteractiveY = 0;
    }

    resetAll() {
      this.slots[0].reset();
      this.slots[1].reset();
      this.scope.clear();
      this._twoHandWasActive = false;
      this._scrollVelPx = 0;
      this._clearFrameEvents();
    }

    _clearFrameEvents() {
      const e = this.events;
      e.justArmed = false;
      e.justDisarmed = false;
      e.pinchStart = false;
      e.pinchDragStart = false;
      e.pinchRelease = false;
      e.clickFired = false;
      e.dragDeltaX = 0;
      e.dragDeltaY = 0;
      e.twoHandJustStarted = false;
      e.twoHandJustEnded = false;
      e.twoHandDeltaDeg = 0;
      e.scrollDeltaPx = 0;
    }

    setFlatCandidate(idx, normFlat63, worldFlat63, isLeftLabel, aspect) {
      if (idx < 0 || idx >= 4) return false;
      if (!isFiniteFlat63(normFlat63) || !isFiniteFlat63(worldFlat63)) return false;
      const c = this.candidates[idx];
      c.normLm.set(normFlat63);
      c.worldLm.set(worldFlat63);
      c.isLeftLabel = Boolean(isLeftLabel);
      c.palmX = (normFlat63[0] + normFlat63[15] + normFlat63[27] + normFlat63[51]) * 0.25;
      c.palmY = (normFlat63[1] + normFlat63[16] + normFlat63[28] + normFlat63[52]) * 0.25;
      c.palmSpan = computePalmSpanFlat(normFlat63, aspect);
      c.assigned = false;
      return true;
    }

    ingestMediaPipeResult(mpResult, aspect) {
      if (!mpResult || !mpResult.landmarks) return 0;
      const rawLen = Math.min(mpResult.landmarks.length, 4);
      let validCount = 0;
      for (let i = 0; i < rawLen; i++) {
        const c = this.candidates[validCount];
        if (!copyLandmarksToFlat(mpResult.landmarks[i], c.normLm)) continue;
        if (mpResult.worldLandmarks && mpResult.worldLandmarks[i]) {
          if (!copyLandmarksToFlat(mpResult.worldLandmarks[i], c.worldLm)) {
            c.worldLm.set(c.normLm);
          }
        } else {
          c.worldLm.set(c.normLm);
        }
        const cat =
          mpResult.handedness &&
          mpResult.handedness[i] &&
          mpResult.handedness[i][0] &&
          mpResult.handedness[i][0].categoryName;
        c.isLeftLabel = cat !== 'Right';
        c.palmX = (c.normLm[0] + c.normLm[15] + c.normLm[27] + c.normLm[51]) * 0.25;
        c.palmY = (c.normLm[1] + c.normLm[16] + c.normLm[28] + c.normLm[52]) * 0.25;
        c.palmSpan = computePalmSpanFlat(c.normLm, aspect);
        c.assigned = false;
        validCount++;
      }
      return validCount;
    }

    step(candidateCount, hasNewSample, nowSec, viewportW, viewportH, camAspect) {
      const aspect = Number.isFinite(camAspect) && camAspect > 0 ? camAspect : 4 / 3;
      const vw = Math.max(1, Number.isFinite(viewportW) ? viewportW : 1280);
      const vh = Math.max(1, Number.isFinite(viewportH) ? viewportH : 800);

      this._clearFrameEvents();
      let dt = this._lastStepSec > 0 ? nowSec - this._lastStepSec : 1 / 60;
      if (!Number.isFinite(dt) || dt <= 1e-5) dt = 1 / 120;
      else if (dt > 0.25) dt = 0.25;
      this._lastStepSec = nowSec;

      if (hasNewSample) {
        let i0 = this._matchSlotCandidate(this.slots[0], candidateCount, aspect);
        if (i0 >= 0) this.candidates[i0].assigned = true;
        let i1 = this._matchSlotCandidate(this.slots[1], candidateCount, aspect);
        if (i1 >= 0) this.candidates[i1].assigned = true;
        if (i0 < 0) {
          i0 = this._pickLargestUnassigned(candidateCount);
          if (i0 >= 0) this.candidates[i0].assigned = true;
        }
        if (i1 < 0) {
          i1 = this._pickLargestUnassigned(candidateCount);
          if (i1 >= 0) this.candidates[i1].assigned = true;
        }

        this._updateSlotFromSample(this.slots[0], i0 >= 0 ? this.candidates[i0] : null, nowSec, dt, vw, vh, aspect, true);
        this._updateSlotFromSample(this.slots[1], i1 >= 0 ? this.candidates[i1] : null, nowSec, dt, vw, vh, aspect, false);
      }

      const s0 = this.slots[0];
      const s1 = this.slots[1];
      const twoHandReady =
        (s0.state === HAND_STATE.ARMED || s0.state === HAND_STATE.COASTING) &&
        (s1.state === HAND_STATE.ARMED || s1.state === HAND_STATE.COASTING) &&
        s0.pinched &&
        s1.pinched;

      if (twoHandReady) {
        const dx = s1.screenX - s0.screenX;
        const dy = s1.screenY - s0.screenY;
        const span = Math.max(32, Math.hypot(dx, dy));
        const angle = Math.atan2(dy, dx);
        this.events.twoHandActive = true;
        this.events.twoHandMidX = 0.5 * (s0.screenX + s1.screenX);
        this.events.twoHandMidY = 0.5 * (s0.screenY + s1.screenY);
        s0.pinchMode = PINCH_MODE.TWO_HAND;
        s1.pinchMode = PINCH_MODE.TWO_HAND;

        if (!this._twoHandWasActive) {
          this._twoHandWasActive = true;
          this._twoHandInitSpan = span;
          this._twoHandPrevAngle = angle;
          this._twoHandTotalDeg = 0;
          this.events.twoHandJustStarted = true;
          this.events.twoHandScaleRatio = 1.0;
          this.events.twoHandTotalDeg = 0;
        } else {
          const dAngDeg = unwrapAngleDelta(angle, this._twoHandPrevAngle) * RAD_TO_DEG;
          this._twoHandPrevAngle = angle;
          this._twoHandTotalDeg += dAngDeg;
          this.events.twoHandScaleRatio = clamp(span / this._twoHandInitSpan, 0.25, 4.0);
          this.events.twoHandDeltaDeg = dAngDeg;
          this.events.twoHandTotalDeg = this._twoHandTotalDeg;
        }
      } else {
        this.events.twoHandActive = false;
        if (this._twoHandWasActive) {
          this._twoHandWasActive = false;
          this.events.twoHandJustEnded = true;
          if (s0.pinched) {
            s0.pinchMode = PINCH_MODE.DRAG;
            s0.lockOriginX = s0.screenX;
            s0.lockOriginY = s0.screenY;
            s0.breakoutOffsetX = 0;
            s0.breakoutOffsetY = 0;
            s0.interactiveX = s0.screenX;
            s0.interactiveY = s0.screenY;
            s0.twistAnchorRad = s0.unwrappedRad;
            s0.twistBrokenOut = false;
            s0.twistTotalDeg = 0;
            s0.twistDeltaDeg = 0;
            this._prevInteractiveX = s0.interactiveX;
            this._prevInteractiveY = s0.interactiveY;
          }
        }
      }

      this._scrollVelPx *= Math.pow(this.config.vScrollDecay, dt * 60);
      if (Math.abs(this._scrollVelPx) < 0.8) this._scrollVelPx = 0;
      this.events.scrollVelocityPx = this._scrollVelPx;
      this.events.scrollDeltaPx = this._scrollVelPx * dt;
      return this.events;
    }

    _matchSlotCandidate(slot, count, aspect) {
      if (slot.state === HAND_STATE.IDLE && !slot.visible) return -1;
      let bestIdx = -1;
      let bestDist = this.config.slotLockRadius;
      for (let i = 0; i < count; i++) {
        const c = this.candidates[i];
        if (c.assigned) continue;
        const d = Math.hypot((c.palmX - slot.palmX) * aspect, c.palmY - slot.palmY);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return bestIdx;
    }

    _pickLargestUnassigned(count) {
      let bestIdx = -1;
      let bestSpan = -1;
      for (let i = 0; i < count; i++) {
        const c = this.candidates[i];
        if (!c.assigned && c.palmSpan > bestSpan) {
          bestSpan = c.palmSpan;
          bestIdx = i;
        }
      }
      return bestIdx;
    }

    _updateSlotFromSample(slot, cand, nowSec, dt, viewportW, viewportH, aspect, isPrimary) {
      const cfg = this.config;
      if (!cand) {
        if (slot.state === HAND_STATE.ARMED || slot.state === HAND_STATE.COASTING) {
          slot.coastFrames += 1;
          if (slot.coastFrames <= cfg.coastMaxFrames && (nowSec - slot.lastSeenSec) <= cfg.coastMaxSec) {
            slot.state = HAND_STATE.COASTING;
            slot.visible = false;
            slot.twistDeltaDeg = 0;
            return;
          }
          if (isPrimary && slot.pinched) this.events.pinchRelease = true;
          if (isPrimary) this.events.justDisarmed = true;
        }
        slot.reset();
        return;
      }

      slot.normLm.set(cand.normLm);
      slot.worldLm.set(cand.worldLm);
      slot.isLeftLabel = cand.isLeftLabel;
      slot.visible = true;
      slot.palmX = cand.palmX;
      slot.palmY = cand.palmY;
      slot.palmSpan = cand.palmSpan;
      slot.lastSeenSec = nowSec;
      slot.coastFrames = 0;

      slot.palmFacingCos = computePalmFacingCosFlat(slot.worldLm, slot.isLeftLabel, cfg.invertChirality);
      slot.gateSpanOk = slot.palmSpan >= cfg.minPalmSpan;
      slot.gateFacingOk = slot.palmFacingCos >= cfg.minPalmFacingCos;
      slot.gateKeyboardOk = slot.palmY < cfg.keyboardExclusionY;

      const lm = slot.normLm;
      const i4 = LM.THUMB_TIP * 3;
      const i5 = LM.INDEX_MCP * 3;
      const i8 = LM.INDEX_TIP * 3;
      const i9 = LM.MIDDLE_MCP * 3;
      const i17 = LM.PINKY_MCP * 3;

      // Rigid metacarpal anchor: 0.50*L5 + 0.30*L9 + 0.20*L0 (immune to index-tip pinch flexion)
      const anchorCamX = 0.50 * lm[i5] + 0.30 * lm[i9] + 0.20 * lm[0];
      const anchorCamY = 0.50 * lm[i5 + 1] + 0.30 * lm[i9 + 1] + 0.20 * lm[1];
      slot.anchorCamX = anchorCamX;
      slot.anchorCamY = anchorCamY;
      slot.indexTipCamX = lm[i8];
      slot.indexTipCamY = lm[i8 + 1];

      const rawU = clamp(((1.0 - anchorCamX) - cfg.roiMinX) / Math.max(0.1, cfg.roiMaxX - cfg.roiMinX), 0, 1);
      const rawV = clamp((anchorCamY - cfg.roiMinY) / Math.max(0.1, cfg.roiMaxY - cfg.roiMinY), 0, 1);
      slot.rawU = rawU;
      slot.rawV = rawV;

      const allGatesPass = slot.gateSpanOk && slot.gateFacingOk && slot.gateKeyboardOk;
      if (slot.state === HAND_STATE.IDLE && (!allGatesPass || !slot.hadValidGates)) {
        slot.euroFilter.reset();
      }
      slot.hadValidGates = allGatesPass;
      slot.euroFilter.filter(rawU, rawV, nowSec, cfg.minCutoff, cfg.beta, cfg.dCutoff);

      const isClosedFist = detectClosedFistFlat(lm, slot.palmSpan, aspect);
      const isFistClosing = isClosedFist || detectFistClosingFlat(lm, slot.palmSpan, aspect);
      const pinchDist = Math.hypot((lm[i4] - lm[i8]) * aspect, lm[i4 + 1] - lm[i8 + 1], (lm[i4 + 2] - lm[i8 + 2]) * aspect * 0.35);
      const pinchRatio = slot.palmSpan > 1e-5 ? pinchDist / slot.palmSpan : 1.0;
      const rawPinchVel = (pinchRatio - slot.prevPinchRatio) / dt;
      slot.pinchVel = Number.isFinite(rawPinchVel) ? (0.45 * slot.pinchVel + 0.55 * rawPinchVel) : 0;
      slot.prevPinchRatio = pinchRatio;
      slot.pinchRatio = pinchRatio;
      slot.gateOpenOk = pinchRatio > cfg.pinchRelease && !isClosedFist;

      if (slot.state === HAND_STATE.COASTING) {
        if (allGatesPass || slot.pinched) {
          slot.state = HAND_STATE.ARMED;
          slot.prevFilterU = slot.euroFilter.x;
          slot.prevFilterV = slot.euroFilter.y;
        } else {
          if (isPrimary && slot.pinched) this.events.pinchRelease = true;
          if (isPrimary) this.events.justDisarmed = true;
          slot.reset();
          return;
        }
      } else if (slot.state === HAND_STATE.ARMED) {
        const keepAlive = slot.pinched
          ? (slot.palmSpan >= cfg.minPalmSpan * 0.75 && slot.palmFacingCos >= -0.10 && slot.palmY < 0.95)
          : (slot.palmSpan >= cfg.minPalmSpan * 0.85 && slot.palmFacingCos >= 0.14 && slot.palmY < 0.90);
        if (!keepAlive) {
          if (isPrimary && slot.pinched) this.events.pinchRelease = true;
          if (isPrimary) this.events.justDisarmed = true;
          slot.state = HAND_STATE.IDLE;
          slot.armProgress = 0;
          slot.pinched = false;
          slot.pinchMode = PINCH_MODE.NONE;
          slot.vScrollActive = false;
          slot.vWasActive = false;
          return;
        }
      } else {
        if (allGatesPass && slot.gateOpenOk && slot.euroFilter.speed <= cfg.maxArmAnchorSpeed) {
          if (slot.state === HAND_STATE.IDLE) {
            slot.state = HAND_STATE.ARMING;
            if (cfg.mappingMode !== MAPPING_MODE.RELATIVE_CLUTCH) {
              slot.cursorU = slot.euroFilter.x;
              slot.cursorV = slot.euroFilter.y;
            }
            slot.prevFilterU = slot.euroFilter.x;
            slot.prevFilterV = slot.euroFilter.y;
          }
          slot.armProgress = clamp(slot.armProgress + dt / cfg.armDwellSec, 0, 1);
          if (slot.armProgress >= 1) {
            slot.state = HAND_STATE.ARMED;
            if (cfg.mappingMode !== MAPPING_MODE.RELATIVE_CLUTCH) {
              slot.cursorU = slot.euroFilter.x;
              slot.cursorV = slot.euroFilter.y;
            }
            slot.prevFilterU = slot.euroFilter.x;
            slot.prevFilterV = slot.euroFilter.y;
            slot.screenX = slot.cursorU * viewportW;
            slot.screenY = slot.cursorV * viewportH;
            slot.interactiveX = slot.screenX;
            slot.interactiveY = slot.screenY;
            this._prevInteractiveX = slot.interactiveX;
            this._prevInteractiveY = slot.interactiveY;
            slot.angleInitialized = false;
            if (isPrimary) this.events.justArmed = true;
          }
        } else if (!allGatesPass) {
          slot.armProgress = 0;
          slot.state = HAND_STATE.IDLE;
        } else {
          slot.armProgress = Math.max(0, slot.armProgress - dt * 2.5);
          if (slot.armProgress === 0) slot.state = HAND_STATE.IDLE;
        }
      }

      const isPrePinchClosing =
        slot.state === HAND_STATE.ARMED &&
        !slot.pinched &&
        pinchRatio < cfg.prePinchZone &&
        slot.pinchVel < cfg.prePinchClosingVel;
      slot.velocityDamped = isPrePinchClosing;

      const prevScreenX = slot.screenX;
      const prevScreenY = slot.screenY;
      const vPostureNow = slot.state === HAND_STATE.ARMED && detectVScrollPostureFlat(lm, slot.palmSpan, aspect, pinchRatio);
      slot.vScrollActive = vPostureNow;

      const stepGain = vPostureNow ? 0.16 : (isPrePinchClosing ? cfg.prePinchDamping : 1.0);
      const dFilterU = slot.euroFilter.x - slot.prevFilterU;
      const dFilterV = slot.euroFilter.y - slot.prevFilterV;
      slot.prevFilterU = slot.euroFilter.x;
      slot.prevFilterV = slot.euroFilter.y;

      if (cfg.mappingMode === MAPPING_MODE.RELATIVE_CLUTCH) {
        if (isClosedFist && slot.pinched && slot.pinchMode === PINCH_MODE.CLICK_LOCK) {
          slot.pinched = false;
          slot.pinchMode = PINCH_MODE.NONE;
        }
        const fistRelease = !slot.pinched && !vPostureNow && isClosedFist;
        slot.clutchReleased = fistRelease;
        if (!fistRelease && slot.state === HAND_STATE.ARMED) {
          const spd = slot.euroFilter.speed;
          const sig = 1 / (1 + Math.exp(-7.5 * (spd - 0.42)));
          const cdGain = (cfg.clutchMinGain + (cfg.clutchMaxGain - cfg.clutchMinGain) * sig) * stepGain;
          slot.cursorU = clamp(slot.cursorU + dFilterU * cdGain, 0, 1);
          slot.cursorV = clamp(slot.cursorV + dFilterV * cdGain, 0, 1);
        }
      } else {
        slot.clutchReleased = false;
        slot.cursorU += (slot.euroFilter.x - slot.cursorU) * stepGain;
        slot.cursorV += (slot.euroFilter.y - slot.cursorV) * stepGain;
      }

      slot.screenX = slot.cursorU * viewportW;
      slot.screenY = slot.cursorV * viewportH;

      if (isPrimary) {
        this.scope.push(rawU, rawV, slot.cursorU, slot.cursorV, slot.euroFilter.speed, pinchRatio, isPrePinchClosing);
      }
      if (slot.state !== HAND_STATE.ARMED) {
        slot.interactiveX = slot.screenX;
        slot.interactiveY = slot.screenY;
        return;
      }

      // Unwrapped wrist rotation in mirrored screen space (+deg = clockwise twist)
      const kVecX = (lm[i5] - lm[i17]) * aspect;
      const kVecY = lm[i17 + 1] - lm[i5 + 1];
      const lVecX = (lm[0] - 0.5 * (lm[i4] + lm[i8])) * aspect;
      const lVecY = 0.5 * (lm[i4 + 1] + lm[i8 + 1]) - lm[1];

      slot.twistDeltaDeg = 0;
      const kLen = Math.hypot(kVecX, kVecY);
      const lLen = Math.hypot(lVecX, lVecY);
      if (kLen > 0.012 && lLen > 0.012) {
        const kTheta = Math.atan2(kVecY, kVecX);
        const lTheta = Math.atan2(lVecY, lVecX);
        if (!slot.angleInitialized) {
          slot.angleInitialized = true;
          slot.knuckleRad = kTheta;
          slot.leverRad = lTheta;
          slot.unwrappedRad = 0;
          slot.twistAnchorRad = 0;
        } else {
          const dk = unwrapAngleDelta(kTheta, slot.knuckleRad);
          const dl = unwrapAngleDelta(lTheta, slot.leverRad);
          slot.knuckleRad = kTheta;
          slot.leverRad = lTheta;
          let stepRad = dk;
          if (cfg.rotationSource === ROTATION_SOURCE.WRIST_LEVER) stepRad = dl;
          else if (cfg.rotationSource === ROTATION_SOURCE.FUSED) stepRad = 0.72 * dk + 0.28 * dl;
          slot.unwrappedRad += stepRad;
        }
      }

      if (!slot.pinched) {
        if (pinchRatio < cfg.pinchEngage && !vPostureNow && !isFistClosing) {
          slot.pinched = true;
          slot.pinchMode = PINCH_MODE.CLICK_LOCK;
          slot.pinchStartSec = nowSec;
          slot.lockOriginX = prevScreenX || slot.screenX;
          slot.lockOriginY = prevScreenY || slot.screenY;
          slot.breakoutOffsetX = 0;
          slot.breakoutOffsetY = 0;
          slot.pinchSlipPx = 0;
          slot.interactiveX = slot.lockOriginX;
          slot.interactiveY = slot.lockOriginY;
          slot.twistAnchorRad = slot.unwrappedRad;
          slot.twistBrokenOut = false;
          slot.twistBreakoutSign = 0;
          slot.twistTotalDeg = 0;
          slot.twistDeltaDeg = 0;
          if (isPrimary) {
            this._prevInteractiveX = slot.interactiveX;
            this._prevInteractiveY = slot.interactiveY;
            this.events.pinchStart = true;
          }
        } else {
          slot.interactiveX = slot.screenX;
          slot.interactiveY = slot.screenY;
        }
      } else if (pinchRatio > cfg.pinchRelease) {
        const dwellSec = nowSec - slot.pinchStartSec;
        const wasClickLock = slot.pinchMode === PINCH_MODE.CLICK_LOCK;
        slot.pinched = false;
        slot.pinchMode = PINCH_MODE.NONE;
        slot.twistBrokenOut = false;
        slot.twistDeltaDeg = 0;
        if (isPrimary) {
          this.events.pinchRelease = true;
          if (wasClickLock && dwellSec < cfg.clickMaxDurationSec) {
            const dwellMs = Math.round(dwellSec * 1000);
            slot.lastClickDwellMs = dwellMs;
            slot.lastClickSlipPx = 0;
            this.events.clickFired = true;
            this.events.clickX = slot.lockOriginX;
            this.events.clickY = slot.lockOriginY;
            this.events.clickDwellMs = dwellMs;
            this.events.clickSlipPx = slot.pinchSlipPx;
          }
        }
        slot.interactiveX = slot.screenX;
        slot.interactiveY = slot.screenY;
      } else {
        const dxO = slot.screenX - slot.lockOriginX;
        const dyO = slot.screenY - slot.lockOriginY;
        const distO = Math.hypot(dxO, dyO);
        slot.pinchSlipPx = distO;

        if (slot.pinchMode === PINCH_MODE.CLICK_LOCK) {
          if (distO >= cfg.clickBreakoutPx) {
            slot.pinchMode = PINCH_MODE.DRAG;
            slot.breakoutOffsetX = (dxO / distO) * cfg.clickBreakoutPx;
            slot.breakoutOffsetY = (dyO / distO) * cfg.clickBreakoutPx;
            if (isPrimary) this.events.pinchDragStart = true;
          } else {
            slot.interactiveX = slot.lockOriginX;
            slot.interactiveY = slot.lockOriginY;
          }
        }
        if (slot.pinchMode === PINCH_MODE.DRAG) {
          slot.interactiveX = slot.screenX - slot.breakoutOffsetX;
          slot.interactiveY = slot.screenY - slot.breakoutOffsetY;
          if (isPrimary) {
            this.events.dragDeltaX = slot.interactiveX - this._prevInteractiveX;
            this.events.dragDeltaY = slot.interactiveY - this._prevInteractiveY;
          }
        }

        const rawTwistDeg = (slot.unwrappedRad - slot.twistAnchorRad) * RAD_TO_DEG;
        if (!slot.twistBrokenOut && Math.abs(rawTwistDeg) >= cfg.twistDeadzoneDeg) {
          slot.twistBrokenOut = true;
          slot.twistBreakoutSign = rawTwistDeg >= 0 ? 1 : -1;
        }
        if (slot.twistBrokenOut) {
          const newTotalDeg = (rawTwistDeg - slot.twistBreakoutSign * cfg.twistDeadzoneDeg) * cfg.twistGain;
          slot.twistDeltaDeg = newTotalDeg - slot.twistTotalDeg;
          slot.twistTotalDeg = newTotalDeg;
        }
      }

      if (isPrimary) {
        this._prevInteractiveX = slot.interactiveX;
        this._prevInteractiveY = slot.interactiveY;
        const vMidY = 0.5 * (lm[i8 + 1] + lm[LM.MIDDLE_TIP * 3 + 1]);
        if (vPostureNow) {
          if (slot.vWasActive) {
            const dyV = vMidY - slot.vPrevMidY;
            if (Math.abs(dyV) > cfg.vScrollDeadzone) {
              this._scrollVelPx = 0.55 * this._scrollVelPx + 0.45 * ((dyV / dt) * cfg.vScrollGain * 0.42);
            }
          }
          slot.vPrevMidY = vMidY;
          slot.vWasActive = true;
        } else {
          slot.vWasActive = false;
        }
      }
    }
  }

  /** Interactive Synthetic 21-Joint Hand Simulator Rig (Zero-GC, Zero-Camera Fallback + Auto-Tour). */
  class SyntheticHandRig {
    constructor() {
      this.handPresent = true;
      this.mirrorX = 0.50;
      this.camY = 0.50;
      this.palmScale = 0.135;
      this.targetPinch = 0;
      this.pinchAmount = 0;
      this.targetVScroll = 0;
      this.vScrollAmount = 0;
      this.targetFist = 0;
      this.fistAmount = 0;
      this.wristRollDeg = 0;
      this.targetDorsal = 0;
      this.dorsalAmount = 0;
      this.dualHand = false;
      this.dualSpan = 0.28;
      this.dualSteerDeg = 0;
      this.autoOrbit = false;
      this.autoTour = false;
      this.orbitPhase = 0;
      this.tourTimeSec = 0;
      this.noiseSigma = 0.0032;
      this._rngState = 0x9e3779b9;
      this.normBuf0 = new Float64Array(63);
      this.worldBuf0 = new Float64Array(63);
      this.normBuf1 = new Float64Array(63);
      this.worldBuf1 = new Float64Array(63);
    }

    _randNormalApprox() {
      let s = this._rngState;
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        sum += ((s >>> 0) / 4294967296) - 0.5;
      }
      this._rngState = s;
      return sum * 1.633;
    }

    stepAndPopulate(engine, dt, camAspect) {
      const aspect = Number.isFinite(camAspect) && camAspect > 0 ? camAspect : 4 / 3;

      if (this.autoTour) {
        this.tourTimeSec = (this.tourTimeSec + dt) % 12.0;
        const t = this.tourTimeSec;
        this.handPresent = true;
        this.targetDorsal = 0;
        this.targetFist = 0;
        if (t < 3.0) {
          // Phase 1: Figure-8 position sweep + pinch click on Cell 03
          this.dualHand = false;
          this.targetVScroll = 0;
          this.wristRollDeg = 0;
          this.mirrorX = 0.50 + 0.22 * Math.sin(t * 2.1);
          this.camY = 0.42 + 0.14 * Math.cos(t * 2.1);
          this.targetPinch = (t > 1.8 && t < 2.0) ? 1 : 0;
        } else if (t < 6.0) {
          // Phase 2: Hover Cell 04 rotary dial + pinch & clockwise/counter-clockwise wrist twist
          const u = t - 3.0;
          this.dualHand = false;
          this.targetVScroll = 0;
          this.mirrorX = 0.32;
          this.camY = 0.50;
          this.targetPinch = u > 0.35 && u < 2.7 ? 1 : 0;
          this.wristRollDeg = u > 0.45 ? 38 * Math.sin((u - 0.45) * 2.6) : 0;
        } else if (t < 9.0) {
          // Phase 3: Hover Cell 06 vertical fader scrub then Cell 07 V-Scroll flick
          const u = t - 6.0;
          this.dualHand = false;
          this.wristRollDeg = 0;
          if (u < 1.5) {
            this.mirrorX = 0.68;
            this.camY = 0.55 - 0.16 * Math.sin(u * 3.2);
            this.targetPinch = u > 0.2 && u < 1.35 ? 1 : 0;
            this.targetVScroll = 0;
          } else {
            this.mirrorX = 0.32;
            this.camY = 0.64 + 0.10 * Math.sin((u - 1.5) * 5.0);
            this.targetPinch = 0;
            this.targetVScroll = 1;
          }
        } else {
          // Phase 4: Center Cell 05 bimanual 2-hand zoom + steer
          const u = t - 9.0;
          this.mirrorX = 0.50;
          this.camY = 0.50;
          this.targetVScroll = 0;
          this.wristRollDeg = 0;
          this.dualHand = true;
          this.targetPinch = u > 0.35 && u < 2.65 ? 1 : 0;
          this.dualSpan = 0.24 + 0.10 * Math.sin(u * 2.2);
          this.dualSteerDeg = 22 * Math.sin(u * 2.0);
        }
      } else if (this.autoOrbit) {
        this.orbitPhase += dt * 0.92;
        this.mirrorX = 0.50 + 0.19 * Math.sin(this.orbitPhase);
        this.camY = 0.49 + 0.15 * Math.sin(this.orbitPhase * 2.0);
      }

      const a = 1 - Math.exp(-dt * 20);
      this.pinchAmount += (this.targetPinch - this.pinchAmount) * a;
      this.vScrollAmount += (this.targetVScroll - this.vScrollAmount) * a;
      this.fistAmount += (this.targetFist - this.fistAmount) * a;
      this.dorsalAmount += (this.targetDorsal - this.dorsalAmount) * (1 - Math.exp(-dt * 12));

      if (!this.handPresent) return 0;

      // Negate rollRad so +wristRollDeg produces clockwise (+deg) rotation in mirrored display space
      const roll0 = -this.wristRollDeg * DEG_TO_RAD;
      if (!this.dualHand) {
        this._buildHandLandmarks(
          1.0 - this.mirrorX,
          this.camY,
          this.palmScale,
          this.pinchAmount,
          this.vScrollAmount,
          this.fistAmount,
          roll0,
          this.dorsalAmount,
          true,
          aspect,
          this.normBuf0,
          this.worldBuf0
        );
        engine.setFlatCandidate(0, this.normBuf0, this.worldBuf0, true, aspect);
        return 1;
      }

      const sr = this.dualSteerDeg * DEG_TO_RAD;
      const hs = this.dualSpan * 0.5;
      const dxM = Math.cos(sr) * hs;
      const dyM = Math.sin(sr) * hs;
      this._buildHandLandmarks(
        1.0 - clamp(this.mirrorX + dxM, 0.12, 0.90),
        clamp(this.camY + dyM, 0.14, 0.84),
        this.palmScale * 0.92,
        this.pinchAmount,
        0,
        0,
        roll0,
        this.dorsalAmount,
        true,
        aspect,
        this.normBuf0,
        this.worldBuf0
      );
      this._buildHandLandmarks(
        1.0 - clamp(this.mirrorX - dxM, 0.10, 0.88),
        clamp(this.camY - dyM, 0.14, 0.84),
        this.palmScale * 0.92,
        this.pinchAmount,
        0,
        0,
        -roll0,
        this.dorsalAmount,
        false,
        aspect,
        this.normBuf1,
        this.worldBuf1
      );
      engine.setFlatCandidate(0, this.normBuf0, this.worldBuf0, true, aspect);
      engine.setFlatCandidate(1, this.normBuf1, this.worldBuf1, false, aspect);
      return 2;
    }

    _buildHandLandmarks(rawCamX, camY, scale, pinch, vScroll, fist, rollRad, dorsal, isLeftLabel, aspect, outNorm, outWorld) {
      const side = isLeftLabel ? 1 : -1;
      const cosF = Math.cos(dorsal * Math.PI);
      const sinF = Math.sin(dorsal * Math.PI);
      const anchorLX = 0.252 * side;
      const anchorLY = -0.180;
      const p = clamp(pinch, 0, 1);
      const v = clamp(vScroll, 0, 1);
      const f = clamp(fist, 0, 1);
      const pmX = 0.50 * side;
      const pmY = -0.82;
      const cosR = Math.cos(rollRad);
      const sinR = Math.sin(rollRad);
      const invA = 1 / aspect;
      const sig = this.noiseSigma;

      const wJ = (idx, lx, ly, lz) => {
        const cx = lx - anchorLX;
        const cy = ly - anchorLY;
        const fx = cx * cosF + lz * sinF;
        const fz = -cx * sinF + lz * cosF;
        const rx = fx * cosR - cy * sinR;
        const ry = fx * sinR + cy * cosR;
        const nx = sig > 0 ? this._randNormalApprox() * sig : 0;
        const ny = sig > 0 ? this._randNormalApprox() * sig : 0;
        const b = idx * 3;
        outNorm[b] = rawCamX + rx * scale * invA + nx * invA;
        outNorm[b + 1] = camY + ry * scale + ny;
        outNorm[b + 2] = fz * scale;
        outWorld[b] = rx * 0.085 + nx * 0.06;
        outWorld[b + 1] = ry * 0.085 + ny * 0.06;
        outWorld[b + 2] = fz * 0.085;
      };

      wJ(0, 0.0, 0.58, 0.02);
      wJ(5, 0.42 * side, -0.34, 0.0);
      wJ(9, 0.14 * side, -0.42, 0.0);
      wJ(13, -0.14 * side, -0.38, 0.01);
      wJ(17, -0.40 * side, -0.30, 0.02);
      wJ(1, 0.24 * side, 0.34, -0.04);
      wJ(2, 0.46 * side, 0.06, -0.07);
      wJ(3, (0.60 - 0.08 * p - 0.12 * f) * side, -0.26 - 0.24 * p + 0.15 * f, -0.09);
      wJ(4, (0.72 * (1 - p) - 0.18 * f) * side + pmX * p, -0.54 * (1 - p) + pmY * p + 0.28 * f, -0.11);

      const vIdx = 0.14 * v * side;
      wJ(6, 0.45 * side + vIdx * 0.4, -0.74 + 0.08 * p + 0.28 * f, -0.03 - 0.04 * p);
      wJ(7, 0.47 * side + vIdx * 0.75, -1.04 + 0.16 * p + 0.68 * f, -0.05 - 0.05 * p);
      wJ(8, (0.48 * side + vIdx) * (1 - p) + (pmX + 0.05 * side) * p, (-1.32 + 1.05 * f) * (1 - p) + (pmY - 0.04) * p, -0.07 - 0.04 * p);

      const vMid = -0.12 * v * side;
      const mCurl = 0.10 * p + 0.48 * f;
      wJ(10, 0.14 * side + vMid * 0.4, -0.86 + mCurl * 0.6, -0.02);
      wJ(11, 0.14 * side + vMid * 0.75, -1.18 + mCurl * 1.4, -0.04);
      wJ(12, 0.14 * side + vMid, -1.44 + mCurl * 2.3, -0.05);

      const rCurl = Math.max(v, f);
      wJ(14, -0.15 * side, -0.78 + 0.26 * rCurl, -0.02 - 0.06 * rCurl);
      wJ(15, -0.16 * side, -1.06 + 0.68 * rCurl, -0.03 - 0.09 * rCurl);
      wJ(16, -0.16 * side, -1.30 + 1.06 * rCurl, -0.04 - 0.06 * rCurl);

      wJ(18, -0.43 * side, -0.64 + 0.24 * rCurl, -0.01 - 0.06 * rCurl);
      wJ(19, -0.45 * side, -0.88 + 0.60 * rCurl, -0.02 - 0.08 * rCurl);
      wJ(20, -0.46 * side, -1.08 + 0.92 * rCurl, -0.03 - 0.05 * rCurl);
    }
  }

  return {
    LM,
    HAND_BONES,
    HAND_STATE,
    PINCH_MODE,
    ROTATION_SOURCE,
    MAPPING_MODE,
    DEFAULT_CONFIG,
    clamp,
    unwrapAngleDelta,
    oneEuroAlpha,
    OneEuroFilter2D,
    ScopeRingBuffer,
    computePalmFacingCosFlat,
    copyLandmarksToFlat,
    computePalmSpanFlat,
    detectClosedFistFlat,
    detectVScrollPostureFlat,
    KinematicEngine,
    SyntheticHandRig,
  };
});
