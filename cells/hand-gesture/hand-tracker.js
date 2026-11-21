/**
 * MediaPipe Tasks Vision 1.2.3 Runtime Loader & Input Orchestrator (`cells/hand-gesture/hand-tracker.js`)
 * SPDX-License-Identifier: MIT-0
 *
 * Supports dual `file://` and `http://localhost` loading via UMD global (`HandGestureTracker`)
 * and CommonJS (`module.exports` for `node --test`), lazy dynamic `import()` of
 * `@mediapipe/tasks-vision@1.2.3` (`Apache-2.0`) only when Webcam mode is requested,
 * `_sessionEpoch` + `teardown()` race/leak protection against rapid mode toggles, navigation,
 * tab-hide, and `pagehide`, and `video.currentTime` frame gating so 30/60fps video never wastes
 * GPU budget on 120Hz displays.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.HandGestureTracker = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
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

  function stopStreamTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    const tracks = stream.getTracks();
    for (let i = 0; i < tracks.length; i++) {
      try {
        tracks[i].stop();
      } catch (_) {}
    }
  }

  function clipText(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  class HandTrackerController {
    constructor(engine, synthRig, videoEl, opts) {
      const options = opts || {};
      this.engine = engine;
      this.synthRig = synthRig;
      this.videoEl = videoEl || null;
      this.mode = TRACKER_MODE.IDLE;
      this.cameraStatus = CAMERA_STATUS.OFF;
      this.cameraError = '';
      this.delegateUsed = 'NONE';
      this._sessionEpoch = 0;
      this._handLandmarker = null;
      this._mediaStream = null;
      this._pendingStream = null;
      this._detachStreamListeners = null;
      this._loadingPromise = null;
      this._pendingWebcamPromise = null;
      this._pendingFallbackMode = TRACKER_MODE.SYNTH;
      this._activeFallbackMode = TRACKER_MODE.SYNTH;
      this._mediaDevicesOverride = options.mediaDevices !== undefined ? options.mediaDevices : undefined;
      this._loadVisionOverride = typeof options.loadVision === 'function' ? options.loadVision : null;
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

    get isWebcamStarting() {
      return (
        Boolean(this._pendingWebcamPromise) ||
        this.cameraStatus === CAMERA_STATUS.REQUESTING_CAM ||
        this.cameraStatus === CAMERA_STATUS.LOADING_MODEL
      );
    }

    get sessionEpoch() {
      return this._sessionEpoch;
    }

    get lastVideoTime() {
      return this._lastVideoTime;
    }

    onStatusChange(cb) {
      if (typeof cb === 'function') this._listeners.push(cb);
    }

    notifyStatus() {
      this._emitStatus();
    }

    setFallbackMode(fallbackMode) {
      if (fallbackMode) {
        this._pendingFallbackMode = fallbackMode;
        this._activeFallbackMode = fallbackMode;
      }
    }

    _emitStatus() {
      for (let i = 0; i < this._listeners.length; i++) {
        this._listeners[i](this.mode, this.cameraStatus, this.cameraError, this.delegateUsed);
      }
    }

    /** Forget frame timestamps so the first tick after a pause uses a nominal dt (see KinematicEngine.resetClock). */
    resetClock() {
      this._lastFrameSec = 0;
      if (this.engine && typeof this.engine.resetClock === 'function') this.engine.resetClock();
    }

    /** True while a webcam session is being requested or is live. */
    isCameraActive() {
      return (
        this.mode === TRACKER_MODE.WEBCAM ||
        Boolean(this._pendingWebcamPromise) ||
        this.cameraStatus === CAMERA_STATUS.REQUESTING_CAM ||
        this.cameraStatus === CAMERA_STATUS.LOADING_MODEL
      );
    }

    _getMediaDevices() {
      if (this._mediaDevicesOverride !== undefined) {
        return this._mediaDevicesOverride;
      }
      return typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    }

    _fallbackSuffix(fb) {
      return fb === TRACKER_MODE.IDLE
        ? ' Press Sim for a simulated hand.'
        : ' Synthetic Hand Rig active.';
    }

    _enterFallback(fb, message) {
      const target = fb || TRACKER_MODE.SYNTH;
      this.cameraStatus = CAMERA_STATUS.ERROR;
      this.cameraError = message + this._fallbackSuffix(target);
      this.mode = target;
      if (this.synthRig) {
        this.synthRig.autoTour = target === TRACKER_MODE.TOUR;
        if (target === TRACKER_MODE.SYNTH || target === TRACKER_MODE.TOUR) {
          this.synthRig.handPresent = true;
        }
      }
      this._lastFrameSec = 0;
      if (this.engine) {
        this.engine.resetAll();
      }
      this._emitStatus();
    }

    setVideoElement(videoEl) {
      const prevEl = this.videoEl;
      const stream = this._mediaStream;
      if (prevEl !== videoEl) {
        if (prevEl) {
          if (prevEl.srcObject) prevEl.srcObject = null;
          if (prevEl.classList && typeof prevEl.classList.remove === 'function') {
            prevEl.classList.remove('is-live');
          }
        }
        this.videoEl = videoEl || null;
      }
      this._lastVideoTime = -1;
      if (this.videoEl && stream) {
        if (this.videoEl.srcObject !== stream) {
          this.videoEl.srcObject = stream;
        }
        this.videoEl.playsInline = true;
        this.videoEl.muted = true;
        if (typeof this.videoEl.play === 'function') {
          Promise.resolve(this.videoEl.play()).catch(function () {});
        }
      }
      this._emitStatus();
    }

    async setMode(nextMode) {
      if (nextMode === TRACKER_MODE.WEBCAM) {
        if (this.mode === TRACKER_MODE.WEBCAM && this.cameraStatus === CAMERA_STATUS.STREAMING) {
          return true;
        }
        return this.enableWebcam();
      }
      // A pending camera request runs while `mode` still holds the previous mode, so "same mode"
      // is not a no-op then: it must fall through to cancel the request and stop a parked stream.
      if (
        nextMode === this.mode &&
        !this.isWebcamStarting &&
        this.cameraStatus === CAMERA_STATUS.OFF
      ) {
        return true;
      }
      this._sessionEpoch += 1;
      this._pendingWebcamPromise = null;
      this.stopWebcamStream();
      this.mode = nextMode;
      this.cameraStatus = CAMERA_STATUS.OFF;
      this.cameraError = '';
      this._lastFrameSec = 0;
      if (this.synthRig) {
        this.synthRig.autoTour = nextMode === TRACKER_MODE.TOUR;
        if (nextMode === TRACKER_MODE.SYNTH) {
          this.synthRig.handPresent = true;
        }
      }
      if (this.engine) {
        this.engine.resetAll();
      }
      this._emitStatus();
      return true;
    }

    teardown() {
      this._sessionEpoch += 1;
      this._pendingWebcamPromise = null;
      this.stopWebcamStream();
      this.mode = TRACKER_MODE.IDLE;
      this.cameraStatus = CAMERA_STATUS.OFF;
      this.cameraError = '';
      this._lastFrameSec = 0;
      if (this.synthRig) {
        this.synthRig.autoTour = false;
      }
      if (this.engine) {
        this.engine.resetAll();
      }
      this._emitStatus();
    }

    async _ensureLandmarkerLoaded() {
      if (this._handLandmarker) return this._handLandmarker;
      if (this._loadingPromise) return this._loadingPromise;

      this._loadingPromise = (async () => {
        if (this._loadVisionOverride) {
          const res = await this._loadVisionOverride();
          if (res && typeof res.detectForVideo === 'function') {
            this._handLandmarker = res;
            this.delegateUsed = res.delegateUsed || 'MOCK';
            return this._handLandmarker;
          }
        }
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

    enableWebcam(fallbackMode) {
      const fb = fallbackMode || TRACKER_MODE.SYNTH;
      this._pendingFallbackMode = fb;

      if (this._pendingWebcamPromise) {
        return this._pendingWebcamPromise;
      }
      if (this.mode === TRACKER_MODE.WEBCAM && this.cameraStatus === CAMERA_STATUS.STREAMING && this._mediaStream) {
        this._activeFallbackMode = fb;
        return Promise.resolve(true);
      }

      const myEpoch = ++this._sessionEpoch;
      const mediaDevices = this._getMediaDevices();

      if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
        this.stopWebcamStream();
        this._enterFallback(fb, 'Webcam API unavailable (serve over http://localhost or HTTPS).');
        return Promise.resolve(false);
      }

      let acquiredStream = null;
      let attemptDead = false;
      let attemptSettled = false;
      let attemptPromise = null;
      const clearPendingAttempt = () => {
        attemptSettled = true;
        if (this._pendingWebcamPromise === attemptPromise) {
          this._pendingWebcamPromise = null;
        }
      };

      attemptPromise = (async () => {
        try {
          this.cameraStatus = CAMERA_STATUS.REQUESTING_CAM;
          this.cameraError = '';
          this._emitStatus();
          if (myEpoch !== this._sessionEpoch) {
            attemptDead = true;
            clearPendingAttempt();
            return false;
          }

          // Start model download in parallel, while guarding getUserMedia so any rejection or stale
          // epoch stops tracks immediately without ever leaking an active camera LED.
          const modelPromise = this._ensureLandmarkerLoaded();
          modelPromise.catch(function () {});

          const gumPromise = Promise.resolve(
            mediaDevices.getUserMedia({
              audio: false,
              video: {
                facingMode: 'user',
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 60, min: 24 },
              },
            })
          ).then((s) => {
            if (attemptDead || myEpoch !== this._sessionEpoch) {
              stopStreamTracks(s);
              return null;
            }
            acquiredStream = s;
            return s;
          });
          gumPromise.catch(function () {});

          // Race model/permission failure fast while parking granted stream in `_pendingStream`
          const results = await Promise.all([
            gumPromise.then((stream) => {
              if (!stream || attemptDead || myEpoch !== this._sessionEpoch) {
                stopStreamTracks(stream);
                return null;
              }
              this.stopWebcamStream();
              this._pendingStream = stream;
              if (!this._handLandmarker && myEpoch === this._sessionEpoch) {
                this.cameraStatus = CAMERA_STATUS.LOADING_MODEL;
                this._emitStatus();
              }
              return stream;
            }),
            modelPromise,
          ]);

          const stream = results[0];
          if (myEpoch !== this._sessionEpoch || !stream) {
            attemptDead = true;
            clearPendingAttempt();
            stopStreamTracks(acquiredStream || stream);
            if (this._pendingStream === stream) this._pendingStream = null;
            acquiredStream = null;
            return false;
          }
          this._pendingStream = null;

          this._mediaStream = stream;
          this._activeFallbackMode = this._pendingFallbackMode || fb;
          this._attachTrackEndedGuards(stream, myEpoch);

          const startEl = this.videoEl;
          if (startEl) {
            startEl.srcObject = stream;
            startEl.playsInline = true;
            startEl.muted = true;
            if (typeof startEl.play === 'function') {
              try {
                await startEl.play();
              } catch (playErr) {
                const handedOff =
                  myEpoch === this._sessionEpoch &&
                  this._mediaStream === stream &&
                  this.videoEl !== startEl;
                if (!handedOff) {
                  throw playErr;
                }
                if (this.videoEl && typeof this.videoEl.play === 'function') {
                  await Promise.resolve(this.videoEl.play()).catch(function () {});
                }
              }
            }
          }
          if (myEpoch !== this._sessionEpoch || this._mediaStream !== stream) {
            attemptDead = true;
            clearPendingAttempt();
            stopStreamTracks(stream);
            if (this._mediaStream === stream) {
              this.stopWebcamStream();
            } else if (startEl && startEl.srcObject === stream) {
              startEl.srcObject = null;
            }
            acquiredStream = null;
            return false;
          }
          acquiredStream = null;

          const vw = (this.videoEl && this.videoEl.videoWidth) || 640;
          const vh = (this.videoEl && this.videoEl.videoHeight) || 480;
          this.stats.camWidth = vw;
          this.stats.camHeight = vh;
          this.stats.camAspect = vw / vh;
          this._lastVideoTime = -1;
          if (this.synthRig) {
            this.synthRig.autoTour = false;
          }
          if (this.engine) {
            this.engine.resetAll();
          }
          this.mode = TRACKER_MODE.WEBCAM;
          this.cameraStatus = CAMERA_STATUS.STREAMING;
          this.cameraError = '';
          clearPendingAttempt();
          this._emitStatus();
          return true;
        } catch (err) {
          attemptDead = true;
          clearPendingAttempt();
          if (acquiredStream) {
            stopStreamTracks(acquiredStream);
            if (this._pendingStream === acquiredStream) {
              this._pendingStream = null;
            }
            if (this._mediaStream === acquiredStream) {
              this._mediaStream = null;
            }
            acquiredStream = null;
          }
          if (myEpoch !== this._sessionEpoch) return false;
          this.stopWebcamStream();
          const targetFb = this._pendingFallbackMode || fb;
          const name = err && err.name ? err.name : '';
          const message =
            name === 'NotAllowedError' || name === 'PermissionDeniedError'
              ? 'Camera permission declined.'
              : name === 'NotFoundError' || name === 'DevicesNotFoundError'
                ? 'No webcam found.'
                : 'Webcam / MediaPipe load failed (' +
                  clipText(String(err && err.message ? err.message : 'offline or blocked'), 160) +
                  ').';
          this._enterFallback(targetFb, message);
          return false;
        } finally {
          clearPendingAttempt();
        }
      })();

      if (!attemptSettled && myEpoch === this._sessionEpoch) {
        this._pendingWebcamPromise = attemptPromise;
      }
      return attemptPromise;
    }

    _attachTrackEndedGuards(stream, epoch) {
      if (!stream || typeof stream.getTracks !== 'function') return;
      const tracks = stream.getTracks();
      const cleanups = [];
      const onEnded = () => {
        if (this._mediaStream !== stream || epoch !== this._sessionEpoch) return;
        const fb = this._activeFallbackMode || TRACKER_MODE.SYNTH;
        this.stopWebcamStream();
        this._enterFallback(fb, 'Camera stream disconnected.');
      };
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t && typeof t.addEventListener === 'function') {
          t.addEventListener('ended', onEnded);
          cleanups.push(function () {
            try {
              t.removeEventListener('ended', onEnded);
            } catch (_) {}
          });
        }
      }
      this._detachStreamListeners = function () {
        for (let i = 0; i < cleanups.length; i++) cleanups[i]();
      };
    }

    stopWebcamStream() {
      if (this._detachStreamListeners) {
        this._detachStreamListeners();
        this._detachStreamListeners = null;
      }
      if (this._pendingStream) {
        stopStreamTracks(this._pendingStream);
        this._pendingStream = null;
      }
      if (this._mediaStream) {
        stopStreamTracks(this._mediaStream);
        this._mediaStream = null;
      }
      if (this.videoEl) {
        if (this.videoEl.srcObject) {
          this.videoEl.srcObject = null;
        }
        if (this.videoEl.classList && typeof this.videoEl.classList.remove === 'function') {
          this.videoEl.classList.remove('is-live');
        }
      }
    }

    tick(nowMs, viewportW, viewportH) {
      const safeMs = Number.isFinite(nowMs) ? nowMs : this._lastFrameSec * 1000 + 16.67;
      const nowSec = safeMs * 0.001;
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
        vid.readyState >= 2 &&
        vid.videoWidth > 0 &&
        vid.videoHeight > 0
      ) {
        const vw = vid.videoWidth;
        const vh = vid.videoHeight;
        const aspect = vw / vh;
        this.stats.camWidth = vw;
        this.stats.camHeight = vh;
        this.stats.camAspect = aspect;

        if (vid.currentTime !== this._lastVideoTime) {
          this._lastVideoTime = vid.currentTime;
          const detectTs = Math.max(this._lastDetectMs + 1, Math.floor(safeMs));
          this._lastDetectMs = detectTs;
          const t0 = typeof performance !== 'undefined' ? performance.now() : safeMs;
          try {
            const mpResult = this._handLandmarker.detectForVideo(vid, detectTs);
            const t1 = typeof performance !== 'undefined' ? performance.now() : safeMs;
            this.stats.detectMs = this.stats.detectMs * 0.85 + (t1 - t0) * 0.15;
            const count = this.engine.ingestMediaPipeResult(mpResult, aspect);
            this.stats.detectedHands = count;
            return this.engine.step(count, true, nowSec, viewportW, viewportH, aspect);
          } catch (_detectErr) {
            this.stats.detectedHands = 0;
            return this.engine.step(0, true, nowSec, viewportW, viewportH, aspect);
          }
        }
        return this.engine.step(this.stats.detectedHands, false, nowSec, viewportW, viewportH, aspect);
      }

      return this.engine.step(0, false, nowSec, viewportW, viewportH, 4 / 3);
    }
  }

  return {
    TRACKER_MODE,
    CAMERA_STATUS,
    HandTrackerController,
  };
});
