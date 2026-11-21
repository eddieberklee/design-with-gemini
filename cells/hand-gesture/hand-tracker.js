/**
 * MediaPipe Tasks Vision 1.2.3 Runtime Loader & Input Orchestrator (`cells/hand-gesture/hand-tracker.js`)
 * SPDX-License-Identifier: MIT-0
 *
 * Supports dual `file://` and `http://localhost` loading via UMD global (`HandGestureTracker`),
 * lazy dynamic `import()` of `@mediapipe/tasks-vision@1.2.3` (`Apache-2.0`) only when Webcam mode
 * is requested, `sessionEpoch` race protection against rapid mode toggles / navigation, and
 * `video.currentTime` frame gating so 30/60fps video never wastes GPU budget on 120Hz displays.
 */
(function (root) {
  'use strict';

  const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3';
  const VISION_BUNDLE_URL = VISION_CDN + '/vision_bundle.mjs';
  const VISION_WASM_URL = VISION_CDN + '/wasm';
  const HAND_MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  const TRACKER_MODE = Object.freeze({
    IDLE: 'idle',
    SYNTH: 'synth',
    TOUR: 'tour',
    WEBCAM: 'webcam',
    POINTER: 'pointer',
  });

  const CAMERA_STATUS = Object.freeze({
    OFF: 'off',
    LOADING_MODEL: 'loading-model',
    REQUESTING_CAM: 'requesting-camera',
    STREAMING: 'streaming',
    ERROR: 'error',
  });

  class HandTrackerController {
    constructor(engine, synthRig, videoEl) {
      this.engine = engine;
      this.synthRig = synthRig;
      this.videoEl = videoEl;
      this.mode = TRACKER_MODE.IDLE;
      this.cameraStatus = CAMERA_STATUS.OFF;
      this.cameraError = '';
      this.delegateUsed = 'NONE';
      this._sessionEpoch = 0;
      this._handLandmarker = null;
      this._mediaStream = null;
      this._loadingPromise = null;
      this._lastVideoTime = -1;
      this._lastDetectMs = 0;
      this._lastFrameSec = 0;
      this._listeners = [];
      this.stats = {
        fps: 60,
        frameMs: 16.7,
        detectMs: 0,
        camWidth: 640,
        camHeight: 480,
        camAspect: 4 / 3,
        detectedHands: 0,
      };
    }

    onStatusChange(cb) {
      if (typeof cb === 'function') this._listeners.push(cb);
    }

    _emitStatus() {
      for (let i = 0; i < this._listeners.length; i++) {
        this._listeners[i](this.mode, this.cameraStatus, this.cameraError, this.delegateUsed);
      }
    }

    setVideoElement(videoEl) {
      if (this.videoEl === videoEl) return;
      const stream = this._mediaStream;
      if (this.videoEl && this.videoEl.srcObject) {
        this.videoEl.srcObject = null;
      }
      this.videoEl = videoEl;
      if (videoEl && stream) {
        videoEl.srcObject = stream;
        videoEl.playsInline = true;
        videoEl.muted = true;
        videoEl.play().catch(function () {});
      }
    }

    async setMode(nextMode) {
      if (
        nextMode === this.mode &&
        (nextMode !== TRACKER_MODE.WEBCAM || this.cameraStatus === CAMERA_STATUS.STREAMING)
      ) {
        return true;
      }
      if (nextMode === TRACKER_MODE.WEBCAM) {
        return this.enableWebcam();
      }
      this._sessionEpoch += 1;
      this.stopWebcamStream();
      this.mode = nextMode;
      this.cameraStatus = CAMERA_STATUS.OFF;
      this.cameraError = '';
      this.synthRig.autoTour = nextMode === TRACKER_MODE.TOUR;
      if (nextMode === TRACKER_MODE.SYNTH) {
        this.synthRig.handPresent = true;
      }
      this.engine.resetAll();
      this._emitStatus();
      return true;
    }

    async _ensureLandmarkerLoaded() {
      if (this._handLandmarker) return this._handLandmarker;
      if (this._loadingPromise) return this._loadingPromise;

      this.cameraStatus = CAMERA_STATUS.LOADING_MODEL;
      this.cameraError = '';
      this._emitStatus();

      this._loadingPromise = (async () => {
        const mod = await import(VISION_BUNDLE_URL);
        const vision = await mod.FilesetResolver.forVisionTasks(VISION_WASM_URL);
        const makeOptions = (delegate) => ({
          baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.55,
          minHandPresenceConfidence: 0.55,
          minTrackingConfidence: 0.50,
        });

        try {
          this._handLandmarker = await mod.HandLandmarker.createFromOptions(vision, makeOptions('GPU'));
          this.delegateUsed = 'GPU';
        } catch (_gpuErr) {
          this._handLandmarker = await mod.HandLandmarker.createFromOptions(vision, makeOptions('CPU'));
          this.delegateUsed = 'CPU';
        }
        return this._handLandmarker;
      })();

      try {
        return await this._loadingPromise;
      } catch (err) {
        this._loadingPromise = null;
        throw err;
      }
    }

    async enableWebcam(fallbackMode) {
      const fb = fallbackMode || TRACKER_MODE.SYNTH;
      const myEpoch = ++this._sessionEpoch;

      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        this.cameraStatus = CAMERA_STATUS.ERROR;
        this.cameraError =
          'Webcam API unavailable (serve over http://localhost or HTTPS). Switched to Synthetic Rig.';
        this.mode = fb;
        this.synthRig.autoTour = fb === TRACKER_MODE.TOUR;
        this.synthRig.handPresent = true;
        this._emitStatus();
        return false;
      }

      try {
        this.cameraStatus = CAMERA_STATUS.REQUESTING_CAM;
        this.cameraError = '';
        this._emitStatus();

        const results = await Promise.all([
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: 'user',
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 60, min: 24 },
            },
          }),
          this._ensureLandmarkerLoaded(),
        ]);

        const stream = results[0];
        if (myEpoch !== this._sessionEpoch) {
          stream.getTracks().forEach(function (t) {
            t.stop();
          });
          return false;
        }

        this.stopWebcamStream();
        this._mediaStream = stream;
        if (this.videoEl) {
          this.videoEl.srcObject = stream;
          this.videoEl.playsInline = true;
          this.videoEl.muted = true;
          await this.videoEl.play();
        }
        if (myEpoch !== this._sessionEpoch) {
          this.stopWebcamStream();
          return false;
        }

        const vw = (this.videoEl && this.videoEl.videoWidth) || 640;
        const vh = (this.videoEl && this.videoEl.videoHeight) || 480;
        this.stats.camWidth = vw;
        this.stats.camHeight = vh;
        this.stats.camAspect = vw / vh;
        this._lastVideoTime = -1;
        this.synthRig.autoTour = false;
        this.engine.resetAll();
        this.mode = TRACKER_MODE.WEBCAM;
        this.cameraStatus = CAMERA_STATUS.STREAMING;
        this.cameraError = '';
        this._emitStatus();
        return true;
      } catch (err) {
        if (myEpoch !== this._sessionEpoch) return false;
        this.stopWebcamStream();
        const name = err && err.name ? err.name : '';
        this.cameraError =
          name === 'NotAllowedError' || name === 'PermissionDeniedError'
            ? 'Camera permission declined — Synthetic Hand Rig active.'
            : name === 'NotFoundError' || name === 'DevicesNotFoundError'
              ? 'No webcam found — Synthetic Hand Rig active.'
              : 'Webcam / MediaPipe load failed (' +
                (err && err.message ? err.message : 'offline or blocked') +
                ') — Synthetic Hand Rig active.';
        this.cameraStatus = CAMERA_STATUS.ERROR;
        this.mode = fb;
        this.synthRig.autoTour = fb === TRACKER_MODE.TOUR;
        this.synthRig.handPresent = true;
        this._emitStatus();
        return false;
      }
    }

    stopWebcamStream() {
      if (this._mediaStream) {
        this._mediaStream.getTracks().forEach(function (t) {
          t.stop();
        });
        this._mediaStream = null;
      }
      if (this.videoEl && this.videoEl.srcObject) {
        this.videoEl.srcObject = null;
      }
    }

    tick(nowMs, viewportW, viewportH) {
      const nowSec = nowMs * 0.001;
      let dt = this._lastFrameSec > 0 ? nowSec - this._lastFrameSec : 1 / 60;
      if (!Number.isFinite(dt) || dt <= 1e-5) dt = 1 / 120;
      else if (dt > 0.25) dt = 0.25;
      this._lastFrameSec = nowSec;

      this.stats.fps = this.stats.fps * 0.9 + (1 / dt) * 0.1;
      this.stats.frameMs = this.stats.frameMs * 0.9 + dt * 1000 * 0.1;

      if (this.mode === TRACKER_MODE.POINTER || this.mode === TRACKER_MODE.IDLE) {
        this.stats.detectedHands = 0;
        this.stats.detectMs = 0;
        return this.engine.step(0, false, nowSec, viewportW, viewportH, 4 / 3);
      }

      if (this.mode === TRACKER_MODE.SYNTH || this.mode === TRACKER_MODE.TOUR) {
        this.stats.camWidth = 640;
        this.stats.camHeight = 480;
        this.stats.camAspect = 4 / 3;
        this.stats.detectMs = 0.04;
        const count = this.synthRig.stepAndPopulate(this.engine, dt, 4 / 3);
        this.stats.detectedHands = count;
        return this.engine.step(count, true, nowSec, viewportW, viewportH, 4 / 3);
      }

      const vid = this.videoEl;
      if (
        this.cameraStatus === CAMERA_STATUS.STREAMING &&
        this._handLandmarker &&
        vid &&
        vid.readyState >= 2
      ) {
        const vw = vid.videoWidth || 640;
        const vh = vid.videoHeight || 480;
        const aspect = vw / vh;
        this.stats.camWidth = vw;
        this.stats.camHeight = vh;
        this.stats.camAspect = aspect;

        if (vid.currentTime !== this._lastVideoTime) {
          this._lastVideoTime = vid.currentTime;
          const detectTs = Math.max(this._lastDetectMs + 1, Math.floor(nowMs));
          this._lastDetectMs = detectTs;
          const t0 = performance.now();
          const mpResult = this._handLandmarker.detectForVideo(vid, detectTs);
          this.stats.detectMs = this.stats.detectMs * 0.85 + (performance.now() - t0) * 0.15;
          const count = this.engine.ingestMediaPipeResult(mpResult, aspect);
          this.stats.detectedHands = count;
          return this.engine.step(count, true, nowSec, viewportW, viewportH, aspect);
        }
        return this.engine.step(this.stats.detectedHands, false, nowSec, viewportW, viewportH, aspect);
      }

      return this.engine.step(0, false, nowSec, viewportW, viewportH, 4 / 3);
    }
  }

  root.HandGestureTracker = {
    TRACKER_MODE,
    CAMERA_STATUS,
    HandTrackerController,
  };
})(typeof window !== 'undefined' ? window : globalThis);
