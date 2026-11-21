(function (root, factory) {
  'use strict';
  const ColorEngine =
    (root.StickS3Color && root.StickS3Color.ColorEngine) ||
    (typeof require === 'function' ? require('./color-engine.js') : null);
  const api = factory(root, ColorEngine);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const ns = (root.StickS3Color = root.StickS3Color || {});
  ns.Transport = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root, ColorEngine) {
  'use strict';

  const DEFAULT_BRIDGE_ORIGIN = 'http://127.0.0.1:8791';
  const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
  const BLE_NOTIFY_UUID  = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
  const BLE_COMMAND_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a9';
  const BACKOFF_BASE_MS  = 1600;
  const BACKOFF_MAX_MS   = 5000;
  const MAX_RX_LINE_LEN  = 4096;
  // Consecutive bridge WebSocket/SSE attempts before probing stops. Re-armed only by
  // retryBridge() (a user action) or the tab becoming visible again.
  const MAX_BRIDGE_ATTEMPTS = 4;
  // A device counts as connected only while telemetry arrived within this window.
  const HW_FRESH_MS      = 3200;

  function isPageHidden() {
    try {
      const doc = root.document;
      return Boolean(doc && doc.visibilityState === 'hidden');
    } catch (_e) {
      return false;
    }
  }

  function supportsWebSerial() {
    return Boolean(root.navigator && root.navigator.serial && typeof root.navigator.serial.requestPort === 'function');
  }

  function supportsWebBluetooth() {
    return Boolean(root.navigator && root.navigator.bluetooth && typeof root.navigator.bluetooth.requestDevice === 'function');
  }

  function detectCustomLocalOrigin() {
    try {
      const loc = root.location;
      if (!loc || (loc.protocol !== 'http:' && loc.protocol !== 'https:')) return '';
      const host = String(loc.hostname || '').toLowerCase();
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
        return '';
      }
      if (!loc.port || loc.port === '8791') return '';
      return String(loc.origin || '').replace(/\/+$/, '');
    } catch (_e) {
      return '';
    }
  }

  /**
   * Unified multi-transport link for M5StickS3:
   * 1. Zero-click Local USB Bridge (`ws://127.0.0.1:8791/ws` + SSE fallback) — works from `file://` & `http://localhost`
   * 2. Direct Browser Web Serial (`navigator.serial` @ 115200)
   * 3. Wireless Web Bluetooth (`navigator.bluetooth` GATT Notify/Write)
   */
  function createStickLink(opts) {
    const options = opts || {};
    const hasExplicitOrigin = Boolean(options.bridgeOrigin);
    let bridgeOrigin = String(options.bridgeOrigin || DEFAULT_BRIDGE_ORIGIN).replace(/\/+$/, '');
    const customLocalOrigin = hasExplicitOrigin ? '' : detectCustomLocalOrigin();
    const onTelemetry = typeof options.onTelemetry === 'function' ? options.onTelemetry : function () {};
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : function () {};

    let started = false;
    let destroyed = false;
    let connecting = false;
    let activeSource = 'none'; // 'bridge' | 'serial' | 'ble' | 'none'
    let bridgePortName = '';
    let bridgeHasHardware = false;
    let lastHardwarePacketMs = 0;

    // Local Bridge handles
    let ws = null;
    let sse = null;
    let wsRetryTimer = null;
    let wsFailCount = 0;
    let sseFailCount = 0;
    let reconnectAttempt = 0;
    let watchdogTimer = null;
    let probedSameOrigin = false;
    let bridgeAttempts = 0;
    let bridgeProbe = 'probing'; // 'probing' | 'open' | 'paused' (tab hidden) | 'stopped' (budget spent)
    let visibilityHooked = false;

    // Web Serial handles
    let serialPort = null;
    let serialReader = null;
    let serialWriter = null;
    let serialKeepReading = false;
    let serialGen = 0;

    // Web Bluetooth handles
    let bleDevice = null;
    let bleNotifyChar = null;
    let bleCmdChar = null;
    let bleRxBuf = '';
    let bleRxDiscard = false;
    let bleWriteChain = Promise.resolve();

    const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const serialTextDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    const bleTextDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

    function isBridgeOpen() {
      return Boolean((ws && ws.readyState === 1) || (sse && sse.readyState === 1));
    }

    function nextBackoffDelayMs() {
      const delay = Math.min(BACKOFF_MAX_MS, Math.round(BACKOFF_BASE_MS * Math.pow(1.45, reconnectAttempt)));
      reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
      return delay;
    }

    function isHardwareFresh() {
      return lastHardwarePacketMs > 0 && Date.now() - lastHardwarePacketMs < HW_FRESH_MS;
    }

    function emitStatus(detail) {
      if (destroyed) return;
      const hwFresh = isHardwareFresh();
      // Connected means StickS3 telemetry is actually arriving. A bridge that merely has a
      // /dev/cu.usbmodem* port open (bridge_status.serialConnected) or an open Web Serial / BLE
      // link with no packets yet is reported through `source` / `bridgePortOpen`, not `connected`.
      const connected = activeSource !== 'none' && hwFresh;

      onStatus({
        connected: connected,
        source: activeSource,
        bridgeReachable: isBridgeOpen(),
        bridgeHasHardware: hwFresh && activeSource === 'bridge',
        bridgePortOpen: bridgeHasHardware,
        bridgeProbe: activeSource === 'serial' || activeSource === 'ble' ? 'off' : bridgeProbe,
        portName: bridgePortName,
        supportsWebSerial: supportsWebSerial(),
        supportsWebBluetooth: supportsWebBluetooth(),
        detail: detail || ''
      });
    }

    // Runs only while telemetry is fresh; stops itself (and reports) once packets stop.
    function ensureFreshnessWatchdog() {
      if (watchdogTimer || destroyed) return;
      watchdogTimer = setInterval(function () {
        if (destroyed) return;
        if (!isHardwareFresh()) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
          bridgeHasHardware = false;
          emitStatus('Waiting for StickS3 telemetry');
        }
      }, 1500);
      if (watchdogTimer && typeof watchdogTimer.unref === 'function') {
        watchdogTimer.unref();
      }
    }

    function handleIncomingLine(line, sourceTag) {
      if (destroyed || !line) return;

      // Enforce source priority: ignore bridge frames when direct Web Serial or BLE is active,
      // and prevent simultaneous serial + ble cross-talk.
      if (sourceTag === 'bridge' && (activeSource === 'serial' || activeSource === 'ble')) {
        return;
      }
      if (sourceTag === 'serial' && activeSource === 'ble') return;
      if (sourceTag === 'ble' && activeSource === 'serial') return;

      if (line.indexOf('"bridge_status"') !== -1) {
        try {
          const st = JSON.parse(line);
          if (st && st.t === 'bridge_status') {
            bridgeHasHardware = Boolean(st.serialConnected);
            bridgePortName = st.port || '';
            if (activeSource === 'none' || activeSource === 'bridge') {
              activeSource = bridgeHasHardware ? 'bridge' : (isBridgeOpen() ? 'bridge' : 'none');
            }
            emitStatus();
            return;
          }
        } catch (_e) {}
      }

      const pkt = ColorEngine.parseTelemetryLine(line);
      if (!pkt) return;

      lastHardwarePacketMs = Date.now();
      if (sourceTag === 'bridge') {
        bridgeHasHardware = true;
        activeSource = 'bridge';
      } else if (sourceTag === 'serial') {
        activeSource = 'serial';
      } else if (sourceTag === 'ble') {
        activeSource = 'ble';
      }
      ensureFreshnessWatchdog();
      onTelemetry(pkt, sourceTag);
      emitStatus();
    }

    // ---------- 1. Auto Local Bridge (WebSocket + SSE Fallback) ----------

    function closeBridgeSockets() {
      if (wsRetryTimer) {
        clearTimeout(wsRetryTimer);
        wsRetryTimer = null;
      }
      if (ws) {
        try { ws.onopen = null; ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); } catch (_e) {}
        ws = null;
      }
      if (sse) {
        try { sse.onopen = null; sse.onerror = null; sse.onmessage = null; sse.close(); } catch (_e) {}
        sse = null;
      }
    }

    // False (and records why) when another automatic probe must not start now.
    function mayProbeBridge() {
      if (isPageHidden()) {
        bridgeProbe = 'paused';
        return false;
      }
      if (bridgeAttempts >= MAX_BRIDGE_ATTEMPTS) {
        bridgeProbe = 'stopped';
        return false;
      }
      return true;
    }

    function scheduleBridgeReconnect(delayMs, preferSse) {
      if (destroyed || activeSource === 'serial' || activeSource === 'ble') return;
      if (wsRetryTimer) return;
      if (!mayProbeBridge()) {
        emitStatus(bridgeProbe === 'stopped' ? 'No local bridge found' : '');
        return;
      }
      const waitMs = typeof delayMs === 'number' && delayMs > 0 ? delayMs : nextBackoffDelayMs();
      wsRetryTimer = setTimeout(function () {
        wsRetryTimer = null;
        if (destroyed || activeSource === 'serial' || activeSource === 'ble') return;
        if (!mayProbeBridge()) {
          emitStatus();
          return;
        }
        if (preferSse && typeof EventSource === 'function') {
          startSseFallback();
        } else {
          connectBridge();
        }
      }, waitMs);
      if (wsRetryTimer && typeof wsRetryTimer.unref === 'function') {
        wsRetryTimer.unref();
      }
    }

    async function probeSameOriginBridge() {
      if (probedSameOrigin || !customLocalOrigin || typeof fetch !== 'function') return;
      probedSameOrigin = true;
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 900) : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        const res = await fetch(customLocalOrigin + '/api/stick-s3/status', {
          method: 'GET',
          signal: ctrl ? ctrl.signal : undefined
        });
        if (destroyed || !res || !res.ok) return;
        const json = await res.json();
        if (destroyed || !json || json.ok !== true) return;
        if (activeSource === 'serial' || activeSource === 'ble') return;
        if (!isBridgeOpen() && bridgeOrigin !== customLocalOrigin) {
          bridgeOrigin = customLocalOrigin;
          wsFailCount = 0;
          sseFailCount = 0;
          reconnectAttempt = 0;
          closeBridgeSockets();
          connectBridge();
        }
      } catch (_e) {
        // Not a StickS3 bridge (e.g. python3 -m http.server); keep DEFAULT_BRIDGE_ORIGIN (8791)
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function startSseFallback() {
      if (destroyed || activeSource === 'serial' || activeSource === 'ble') return;
      if (typeof EventSource !== 'function') {
        scheduleBridgeReconnect(nextBackoffDelayMs(), false);
        return;
      }
      if (sse || ws) return;
      bridgeAttempts++;
      bridgeProbe = 'probing';
      try {
        const es = new EventSource(bridgeOrigin + '/api/stick-s3/stream');
        sse = es;
        es.onopen = function () {
          if (destroyed || sse !== es) return;
          wsFailCount = 0;
          sseFailCount = 0;
          reconnectAttempt = 0;
          bridgeAttempts = 0;
          bridgeProbe = 'open';
          if (activeSource === 'none') activeSource = 'bridge';
          emitStatus('Local USB bridge SSE ready');
        };
        es.onmessage = function (ev) {
          if (ev && typeof ev.data === 'string') {
            handleIncomingLine(ev.data, 'bridge');
          }
        };
        es.onerror = function () {
          if (sse === es) sse = null;
          try { es.close(); } catch (_e) {}
          bridgeHasHardware = false;
          sseFailCount++;
          if (activeSource === 'bridge') {
            activeSource = 'none';
            lastHardwarePacketMs = 0;
          }
          emitStatus();
          scheduleBridgeReconnect(nextBackoffDelayMs(), false);
        };
      } catch (_err) {
        sse = null;
        sseFailCount++;
        scheduleBridgeReconnect(nextBackoffDelayMs(), false);
      }
    }

    function connectBridge() {
      if (destroyed || activeSource === 'serial' || activeSource === 'ble') return;
      if (ws || sse) return;

      if (typeof WebSocket !== 'function') {
        startSseFallback();
        return;
      }

      const wsUrl = bridgeOrigin.replace(/^http/, 'ws') + '/ws';
      let opened = false;
      bridgeAttempts++;
      bridgeProbe = 'probing';
      try {
        const sock = new WebSocket(wsUrl);
        ws = sock;
        sock.onopen = function () {
          if (destroyed || ws !== sock) return;
          opened = true;
          wsFailCount = 0;
          sseFailCount = 0;
          reconnectAttempt = 0;
          bridgeAttempts = 0;
          bridgeProbe = 'open';
          if (activeSource === 'none') activeSource = 'bridge';
          emitStatus('Local USB bridge connected');
        };
        sock.onmessage = function (ev) {
          if (ev && typeof ev.data === 'string') {
            handleIncomingLine(ev.data, 'bridge');
          }
        };
        sock.onerror = function () {};
        sock.onclose = function () {
          if (ws === sock) ws = null;
          bridgeHasHardware = false;
          if (!opened) wsFailCount++;
          if (activeSource === 'bridge') {
            activeSource = 'none';
            lastHardwarePacketMs = 0;
          }
          emitStatus();
          if (wsFailCount >= 2 && sseFailCount === 0 && typeof EventSource === 'function' && mayProbeBridge()) {
            startSseFallback();
          } else {
            const preferSse = wsFailCount >= 2 && typeof EventSource === 'function' && ( sseFailCount % 2 === 0 );
            scheduleBridgeReconnect(nextBackoffDelayMs(), preferSse);
          }
        };
      } catch (_err) {
        ws = null;
        wsFailCount++;
        scheduleBridgeReconnect(nextBackoffDelayMs(), typeof EventSource === 'function');
      }
    }

    async function postBridgeEndpoint(pathSuffix, payload) {
      if (typeof fetch !== 'function') return false;
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 1200) : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      try {
        const res = await fetch(bridgeOrigin + pathSuffix, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {}),
          signal: ctrl ? ctrl.signal : undefined
        });
        return Boolean(res && res.ok);
      } catch (_e) {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // ---------- 2. Direct Browser Web Serial ----------

    async function disconnectWebSerial(reclaimBridge) {
      serialKeepReading = false;
      serialGen++;
      const reader = serialReader;
      const writer = serialWriter;
      const port = serialPort;
      serialReader = null;
      serialWriter = null;
      serialPort = null;
      const wasSerial = activeSource === 'serial';
      if (wasSerial) {
        activeSource = 'none';
        lastHardwarePacketMs = 0;
      }

      if (reader) {
        try { await reader.cancel(); } catch (_e) {}
        try { reader.releaseLock(); } catch (_e) {}
      }
      if (writer) {
        try { writer.releaseLock(); } catch (_e) {}
      }
      if (port) {
        try { await port.close(); } catch (_e) {}
      }

      if (wasSerial && !destroyed) {
        emitStatus('Web Serial disconnected');
      }
      if (reclaimBridge && !destroyed && activeSource === 'none') {
        await postBridgeEndpoint('/api/stick-s3/claim', {});
        if (!destroyed && activeSource === 'none') {
          connectBridge();
        }
      }
    }

    async function connectWebSerial() {
      if (destroyed) {
        throw new Error('StickS3 transport link has been destroyed.');
      }
      if (!supportsWebSerial()) {
        throw new Error('Web Serial requires Chrome or Edge on localhost / HTTPS (or use the auto USB bridge).');
      }
      if (connecting) {
        throw new Error('Another hardware connection attempt is already in progress.');
      }

      connecting = true;
      try {
        let port = null;
        let portOpened = false;
        let bridgeReleased = false;
        try {
          // Chooser first, while the click's user activation is fresh. Cancelling it (NotFoundError)
          // or a denied request (SecurityError) must leave the bridge and any BLE link untouched.
          port = await root.navigator.serial.requestPort({
            filters: [{ usbVendorId: 0x303a }] // Espressif native USB-Serial/JTAG
          });
          if (destroyed) return;

          if (bleDevice || activeSource === 'ble') {
            await disconnectWebBluetooth(false);
            if (destroyed) return;
          }
          if (serialPort || activeSource === 'serial') {
            await disconnectWebSerial(false);
            if (destroyed) return;
          }

          // Ask the local bridge to release /dev/cu.usbmodem* so port.open() never hits EBUSY
          await postBridgeEndpoint('/api/stick-s3/release', {});
          bridgeReleased = true;
          closeBridgeSockets();
          if (activeSource === 'bridge') activeSource = 'none';
          if (destroyed) return;

          await port.open({ baudRate: 115200 });
          portOpened = true;
          if (destroyed) {
            try { await port.close(); } catch (_e) {}
            return;
          }
        } catch (err) {
          if (port && portOpened) {
            try { await port.close(); } catch (_e) {}
          }
          if (!destroyed && bridgeReleased) {
            await postBridgeEndpoint('/api/stick-s3/claim', {});
          }
          if (!destroyed && activeSource === 'none') {
            connectBridge(); // no-op while the bridge socket is still open (chooser cancelled)
          }
          throw err;
        }

        serialPort = port;
        if (port.writable) {
          try {
            serialWriter = port.writable.getWriter();
          } catch (_e) {
            serialWriter = null;
          }
        }
        lastHardwarePacketMs = 0;
        activeSource = 'serial';
        bridgePortName = 'USB Web Serial';
        emitStatus('Connected via Web Serial');

        const myGen = ++serialGen;
        serialKeepReading = true;
        (async function readLoop() {
          let buf = '';
          let discardLine = false;
          while (serialKeepReading && serialGen === myGen && port.readable) {
            let reader;
            try {
              reader = port.readable.getReader();
            } catch (_e) {
              break;
            }
            serialReader = reader;
            try {
              while (serialKeepReading && serialGen === myGen) {
                const step = await reader.read();
                if (step.done) break;
                if (step.value && serialTextDecoder) {
                  buf += serialTextDecoder.decode(step.value, { stream: true });
                  let idx = buf.indexOf('\n');
                  while (idx !== -1) {
                    const line = buf.slice(0, idx);
                    buf = buf.slice(idx + 1);
                    if (discardLine) {
                      discardLine = false;
                    } else {
                      handleIncomingLine(line, 'serial');
                    }
                    idx = buf.indexOf('\n');
                  }
                  if (buf.length > MAX_RX_LINE_LEN) {
                    buf = '';
                    discardLine = true;
                  }
                }
              }
            } catch (_readErr) {
              break;
            } finally {
              if (serialReader === reader) {
                serialReader = null;
              }
              try { reader.releaseLock(); } catch (_e) {}
            }
          }
          if (!destroyed && serialGen === myGen && activeSource === 'serial') {
            await disconnectWebSerial(true);
          }
        })();
      } finally {
        connecting = false;
      }
    }

    // ---------- 3. Wireless Web Bluetooth (BLE GATT) ----------

    function cleanupBleDevice(dev, notifyChar) {
      if (notifyChar) {
        try { notifyChar.removeEventListener('characteristicvaluechanged', onBleNotification); } catch (_e) {}
      }
      if (dev) {
        try { dev.removeEventListener('gattserverdisconnected', onBleDisconnected); } catch (_e) {}
        if (dev.gatt && dev.gatt.connected) {
          try { dev.gatt.disconnect(); } catch (_e) {}
        }
      }
    }

    function onBleNotification(ev) {
      if (destroyed || activeSource !== 'ble') return;
      const dv = ev && ev.target ? ev.target.value : null;
      if (!dv || !bleTextDecoder) return;
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      bleRxBuf += bleTextDecoder.decode(bytes, { stream: true });

      let nl = bleRxBuf.indexOf('\n');
      if (nl !== -1) {
        while (nl !== -1) {
          const line = bleRxBuf.slice(0, nl);
          bleRxBuf = bleRxBuf.slice(nl + 1);
          if (bleRxDiscard) {
            bleRxDiscard = false;
          } else if (line.trim()) {
            handleIncomingLine(line, 'ble');
          }
          nl = bleRxBuf.indexOf('\n');
        }
      } else if (!bleRxDiscard) {
        // Backward compatibility with single-notification or un-delimited complete JSON frames
        const trimmed = bleRxBuf.trim();
        if (trimmed.length > 2 && trimmed[0] === '{' && trimmed[trimmed.length - 1] === '}') {
          bleRxBuf = '';
          handleIncomingLine(trimmed, 'ble');
        }
      }

      if (bleRxBuf.length > MAX_RX_LINE_LEN) {
        bleRxBuf = '';
        bleRxDiscard = true;
      }
    }

    function onBleDisconnected(ev) {
      if (ev && ev.target && bleDevice && ev.target !== bleDevice) return;
      if (bleNotifyChar) {
        try { bleNotifyChar.removeEventListener('characteristicvaluechanged', onBleNotification); } catch (_e) {}
      }
      bleNotifyChar = null;
      bleCmdChar = null;
      bleRxBuf = '';
      bleRxDiscard = false;
      if (activeSource === 'ble') {
        activeSource = 'none';
        lastHardwarePacketMs = 0;
      }
      if (!destroyed) {
        emitStatus('BLE disconnected');
        if (activeSource === 'none') {
          connectBridge();
        }
      }
    }

    async function disconnectWebBluetooth(reclaimBridge) {
      const shouldReconnectBridge = reclaimBridge !== false;
      const dev = bleDevice;
      const notify = bleNotifyChar;
      bleDevice = null;
      bleNotifyChar = null;
      bleCmdChar = null;
      bleRxBuf = '';
      bleRxDiscard = false;
      const wasBle = activeSource === 'ble';
      if (wasBle) {
        activeSource = 'none';
        lastHardwarePacketMs = 0;
      }
      cleanupBleDevice(dev, notify);
      if (wasBle && !destroyed) {
        emitStatus('BLE disconnected');
      }
      if (shouldReconnectBridge && !destroyed && activeSource === 'none') {
        connectBridge();
      }
    }

    async function connectWebBluetooth() {
      if (destroyed) {
        throw new Error('StickS3 transport link has been destroyed.');
      }
      if (!supportsWebBluetooth()) {
        throw new Error('Web Bluetooth requires Chrome or Edge on localhost / HTTPS.');
      }
      if (connecting) {
        throw new Error('Another hardware connection attempt is already in progress.');
      }

      connecting = true;
      let tempDevice = null;
      let tempNotify = null;
      try {
        const device = await root.navigator.bluetooth.requestDevice({
          filters: [
            { namePrefix: 'StickS3' },
            { services: [BLE_SERVICE_UUID] }
          ],
          optionalServices: [BLE_SERVICE_UUID]
        });
        tempDevice = device;
        if (destroyed) {
          cleanupBleDevice(device, null);
          return;
        }

        if (serialPort || activeSource === 'serial') {
          await disconnectWebSerial(true);
          if (destroyed) {
            cleanupBleDevice(device, null);
            return;
          }
        }
        if (bleDevice || activeSource === 'ble') {
          await disconnectWebBluetooth(false);
          if (destroyed) {
            cleanupBleDevice(device, null);
            return;
          }
        }

        closeBridgeSockets();
        if (activeSource === 'bridge') {
          // Sockets are gone; without this a failed GATT connect below skipped the bridge reconnect.
          activeSource = 'none';
          lastHardwarePacketMs = 0;
        }
        bleRxBuf = '';
        bleRxDiscard = false;

        device.addEventListener('gattserverdisconnected', onBleDisconnected);
        const server = await device.gatt.connect();
        if (destroyed) {
          cleanupBleDevice(device, null);
          return;
        }
        const service = await server.getPrimaryService(BLE_SERVICE_UUID);
        if (destroyed) {
          cleanupBleDevice(device, null);
          return;
        }
        const notifyChar = await service.getCharacteristic(BLE_NOTIFY_UUID);
        tempNotify = notifyChar;
        if (destroyed) {
          cleanupBleDevice(device, notifyChar);
          return;
        }
        const cmdChar = await service.getCharacteristic(BLE_COMMAND_UUID);
        if (destroyed) {
          cleanupBleDevice(device, notifyChar);
          return;
        }

        await notifyChar.startNotifications();
        if (destroyed) {
          cleanupBleDevice(device, notifyChar);
          return;
        }
        notifyChar.addEventListener('characteristicvaluechanged', onBleNotification);

        bleDevice = device;
        bleNotifyChar = notifyChar;
        bleCmdChar = cmdChar;
        lastHardwarePacketMs = 0;
        activeSource = 'ble';
        bridgePortName = device.name || 'StickS3-Color BLE';
        emitStatus('Connected wirelessly via BLE');
      } catch (err) {
        if (tempDevice && tempDevice !== bleDevice) {
          cleanupBleDevice(tempDevice, tempNotify);
        }
        if (!destroyed && activeSource === 'none') {
          connectBridge();
        }
        if (tempDevice && err && err.name === 'NotFoundError') {
          // After a device was picked, NotFoundError means the StickS3 GATT service or a
          // characteristic is missing, not a dismissed chooser; do not let the UI call it "cancelled".
          const wrapped = new Error('StickS3 BLE service not found on ' + (tempDevice.name || 'the chosen device') + ': ' + (err.message || err.name));
          wrapped.name = 'StickS3ServiceError';
          throw wrapped;
        }
        throw err;
      } finally {
        connecting = false;
      }
    }

    // ---------- Outbound Host Commands (Mode / Hold / Tare) ----------

    async function sendCommand(cmdObj) {
      if (destroyed) return false;
      const line = ColorEngine.buildHostCommand(cmdObj);
      if (!line) return false;

      if (activeSource === 'serial' && serialWriter && textEncoder) {
        try {
          await serialWriter.write(textEncoder.encode(line));
          return true;
        } catch (_e) {
          return false;
        }
      }

      if (activeSource === 'ble' && bleCmdChar && textEncoder) {
        const charRef = bleCmdChar;
        const payload = textEncoder.encode(line.trim());
        const writeOp = bleWriteChain.then(async function () {
          if (destroyed || activeSource !== 'ble' || bleCmdChar !== charRef) {
            return false;
          }
          if (typeof charRef.writeValueWithoutResponse === 'function') {
            await charRef.writeValueWithoutResponse(payload);
          } else {
            await charRef.writeValue(payload);
          }
          return true;
        });
        bleWriteChain = writeOp.catch(function () { return false; });
        try {
          return await writeOp;
        } catch (_e) {
          return false;
        }
      }

      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify(cmdObj));
          return true;
        } catch (_e) {}
      }

      // HTTP command fallback only when the bridge is known reachable over SSE; with no bridge
      // every mode/hold click would otherwise POST to 127.0.0.1:8791 and fail.
      if (sse && sse.readyState === 1) {
        return postBridgeEndpoint('/api/stick-s3/cmd', cmdObj);
      }
      return false;
    }

    // User-initiated re-arm of bridge probing (fresh attempt budget). No-op while a probe is
    // already in flight or a direct Web Serial / BLE link owns the device.
    function retryBridge() {
      if (destroyed || activeSource === 'serial' || activeSource === 'ble') return false;
      if (ws || sse) return false;
      if (wsRetryTimer) {
        clearTimeout(wsRetryTimer);
        wsRetryTimer = null;
      }
      bridgeAttempts = 0;
      wsFailCount = 0;
      sseFailCount = 0;
      reconnectAttempt = 0;
      connectBridge();
      return true;
    }

    function onVisibilityChange() {
      if (destroyed || isPageHidden()) return;
      if (bridgeProbe === 'paused' || bridgeProbe === 'stopped') {
        retryBridge();
      }
      probeSameOriginBridge();
    }

    function start() {
      if (destroyed || started) return;
      started = true;
      const doc = root.document;
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibilityChange);
        visibilityHooked = true;
      }
      if (isPageHidden()) {
        // Loaded in a background tab: probe nothing until the tab is shown.
        bridgeProbe = 'paused';
        emitStatus();
        return;
      }
      connectBridge();
      probeSameOriginBridge();
    }

    async function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (visibilityHooked) {
        try { root.document.removeEventListener('visibilitychange', onVisibilityChange); } catch (_e) {}
        visibilityHooked = false;
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      closeBridgeSockets();
      await disconnectWebSerial(false);
      await disconnectWebBluetooth(false);
    }

    return {
      start: start,
      destroy: destroy,
      sendCommand: sendCommand,
      connectWebSerial: connectWebSerial,
      disconnectWebSerial: function () { return disconnectWebSerial(true); },
      connectWebBluetooth: connectWebBluetooth,
      disconnectWebBluetooth: function () { return disconnectWebBluetooth(true); },
      retryBridge: retryBridge,
      handleIncomingLine: handleIncomingLine
    };
  }

  return {
    DEFAULT_BRIDGE_ORIGIN: DEFAULT_BRIDGE_ORIGIN,
    BLE_SERVICE_UUID: BLE_SERVICE_UUID,
    supportsWebSerial: supportsWebSerial,
    supportsWebBluetooth: supportsWebBluetooth,
    createStickLink: createStickLink
  };
});
