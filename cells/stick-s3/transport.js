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

  function supportsWebSerial() {
    return Boolean(root.navigator && root.navigator.serial && typeof root.navigator.serial.requestPort === 'function');
  }

  function supportsWebBluetooth() {
    return Boolean(root.navigator && root.navigator.bluetooth && typeof root.navigator.bluetooth.requestDevice === 'function');
  }

  /**
   * Unified multi-transport link for M5StickS3:
   * 1. Zero-click Local USB Bridge (`ws://127.0.0.1:8791/ws` + SSE fallback) — works from `file://` & `http://localhost`
   * 2. Direct Browser Web Serial (`navigator.serial` @ 115200)
   * 3. Wireless Web Bluetooth (`navigator.bluetooth` GATT Notify/Write)
   */
  function createStickLink(opts) {
    const options = opts || {};
    const bridgeOrigin = String(options.bridgeOrigin || DEFAULT_BRIDGE_ORIGIN).replace(/\/+$/, '');
    const onTelemetry = typeof options.onTelemetry === 'function' ? options.onTelemetry : function () {};
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : function () {};

    let destroyed = false;
    let activeSource = 'none'; // 'bridge' | 'serial' | 'ble' | 'none'
    let bridgePortName = '';
    let bridgeHasHardware = false;
    let lastHardwarePacketMs = 0;

    // Local Bridge handles
    let ws = null;
    let sse = null;
    let wsRetryTimer = null;
    let wsFailCount = 0;
    let watchdogTimer = null;

    // Web Serial handles
    let serialPort = null;
    let serialReader = null;
    let serialWriter = null;
    let serialKeepReading = false;

    // Web Bluetooth handles
    let bleDevice = null;
    let bleNotifyChar = null;
    let bleCmdChar = null;

    const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

    function emitStatus(detail) {
      if (destroyed) return;
      const hwFresh = lastHardwarePacketMs > 0 && Date.now() - lastHardwarePacketMs < 3200;
      const connected =
        activeSource === 'serial' ||
        activeSource === 'ble' ||
        (activeSource === 'bridge' && (bridgeHasHardware || hwFresh));

      onStatus({
        connected: connected,
        source: activeSource,
        bridgeReachable: Boolean(ws || sse),
        bridgeHasHardware: bridgeHasHardware || hwFresh,
        portName: bridgePortName,
        supportsWebSerial: supportsWebSerial(),
        supportsWebBluetooth: supportsWebBluetooth(),
        detail: detail || ''
      });
    }

    function handleIncomingLine(line, sourceTag) {
      if (destroyed || !line) return;

      // Ignore bridge frames when user explicitly connected direct Web Serial or BLE
      if (sourceTag === 'bridge' && (activeSource === 'serial' || activeSource === 'ble')) {
        return;
      }

      if (line.indexOf('"bridge_status"') !== -1) {
        try {
          const st = JSON.parse(line);
          if (st && st.t === 'bridge_status') {
            bridgeHasHardware = Boolean(st.serialConnected);
            bridgePortName = st.port || '';
            if (activeSource === 'none' || activeSource === 'bridge') {
              activeSource = bridgeHasHardware ? 'bridge' : (ws || sse ? 'bridge' : 'none');
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
      }
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
        try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); } catch (_e) {}
        ws = null;
      }
      if (sse) {
        try { sse.onerror = null; sse.onmessage = null; sse.close(); } catch (_e) {}
        sse = null;
      }
    }

    function scheduleBridgeReconnect(delayMs) {
      if (destroyed || activeSource === 'serial' || activeSource === 'ble') return;
      if (wsRetryTimer) return;
      wsRetryTimer = setTimeout(function () {
        wsRetryTimer = null;
        connectBridge();
      }, delayMs || 1800);
    }

    function startSseFallback() {
      if (destroyed || typeof EventSource !== 'function' || sse) return;
      try {
        const es = new EventSource(bridgeOrigin + '/api/stick-s3/stream');
        sse = es;
        es.onopen = function () {
          if (activeSource === 'none') activeSource = 'bridge';
          emitStatus('Local USB bridge SSE ready');
        };
        es.onmessage = function (ev) {
          if (ev && typeof ev.data === 'string') {
            handleIncomingLine(ev.data, 'bridge');
          }
        };
        es.onerror = function () {
          try { es.close(); } catch (_e) {}
          sse = null;
          bridgeHasHardware = false;
          emitStatus();
          scheduleBridgeReconnect(2200);
        };
      } catch (_err) {
        scheduleBridgeReconnect(2500);
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
      try {
        const sock = new WebSocket(wsUrl);
        ws = sock;
        sock.onopen = function () {
          opened = true;
          wsFailCount = 0;
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
          emitStatus();
          if (wsFailCount >= 2 && typeof EventSource === 'function') {
            startSseFallback();
          } else {
            scheduleBridgeReconnect(1600);
          }
        };
      } catch (_err) {
        ws = null;
        startSseFallback();
      }
    }

    async function postBridgeEndpoint(pathSuffix, payload) {
      if (typeof fetch !== 'function') return false;
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 1200) : null;
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
      if (serialReader) {
        try { await serialReader.cancel(); } catch (_e) {}
        try { serialReader.releaseLock(); } catch (_e) {}
        serialReader = null;
      }
      if (serialWriter) {
        try { serialWriter.releaseLock(); } catch (_e) {}
        serialWriter = null;
      }
      if (serialPort) {
        try { await serialPort.close(); } catch (_e) {}
        serialPort = null;
      }
      if (activeSource === 'serial') {
        activeSource = 'none';
      }
      emitStatus('Web Serial disconnected');
      if (reclaimBridge && !destroyed) {
        await postBridgeEndpoint('/api/stick-s3/claim', {});
        connectBridge();
      }
    }

    async function connectWebSerial() {
      if (!supportsWebSerial()) {
        throw new Error('Web Serial requires Chrome or Edge on localhost / HTTPS (or use the auto USB bridge).');
      }
      // Ask local bridge to release /dev/cu.usbmodem* first so browser serial never hits EBUSY
      await postBridgeEndpoint('/api/stick-s3/release', {});
      closeBridgeSockets();

      let port;
      try {
        port = await root.navigator.serial.requestPort({
          filters: [{ usbVendorId: 0x303a }] // Espressif native USB-Serial/JTAG
        });
      } catch (err) {
        await postBridgeEndpoint('/api/stick-s3/claim', {});
        connectBridge();
        throw err;
      }

      await port.open({ baudRate: 115200 });
      serialPort = port;
      if (port.writable) {
        serialWriter = port.writable.getWriter();
      }
      activeSource = 'serial';
      bridgePortName = 'USB Web Serial';
      emitStatus('Connected via Web Serial');

      serialKeepReading = true;
      (async function readLoop() {
        let buf = '';
        while (serialKeepReading && port.readable) {
          serialReader = port.readable.getReader();
          try {
            while (serialKeepReading) {
              const step = await serialReader.read();
              if (step.done) break;
              if (step.value && textDecoder) {
                buf += textDecoder.decode(step.value, { stream: true });
                let idx = buf.indexOf('\n');
                while (idx !== -1) {
                  const line = buf.slice(0, idx);
                  buf = buf.slice(idx + 1);
                  handleIncomingLine(line, 'serial');
                  idx = buf.indexOf('\n');
                }
              }
            }
          } catch (_readErr) {
            break;
          } finally {
            if (serialReader) {
              try { serialReader.releaseLock(); } catch (_e) {}
              serialReader = null;
            }
          }
        }
        if (activeSource === 'serial') {
          await disconnectWebSerial(true);
        }
      })();
    }

    // ---------- 3. Wireless Web Bluetooth (BLE GATT) ----------

    function onBleDisconnected() {
      bleNotifyChar = null;
      bleCmdChar = null;
      if (activeSource === 'ble') {
        activeSource = 'none';
      }
      emitStatus('BLE disconnected');
      if (!destroyed) {
        connectBridge();
      }
    }

    async function disconnectWebBluetooth() {
      if (bleDevice) {
        try { bleDevice.removeEventListener('gattserverdisconnected', onBleDisconnected); } catch (_e) {}
        if (bleDevice.gatt && bleDevice.gatt.connected) {
          try { bleDevice.gatt.disconnect(); } catch (_e) {}
        }
      }
      bleDevice = null;
      bleNotifyChar = null;
      bleCmdChar = null;
      if (activeSource === 'ble') {
        activeSource = 'none';
      }
      emitStatus('BLE disconnected');
      if (!destroyed) {
        connectBridge();
      }
    }

    async function connectWebBluetooth() {
      if (!supportsWebBluetooth()) {
        throw new Error('Web Bluetooth requires Chrome or Edge on localhost / HTTPS.');
      }
      const device = await root.navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'StickS3' },
          { services: [BLE_SERVICE_UUID] }
        ],
        optionalServices: [BLE_SERVICE_UUID]
      });

      device.addEventListener('gattserverdisconnected', onBleDisconnected);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE_SERVICE_UUID);
      const notifyChar = await service.getCharacteristic(BLE_NOTIFY_UUID);
      const cmdChar = await service.getCharacteristic(BLE_COMMAND_UUID);

      await notifyChar.startNotifications();
      notifyChar.addEventListener('characteristicvaluechanged', function (ev) {
        const dv = ev && ev.target ? ev.target.value : null;
        if (!dv || !textDecoder) return;
        const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        handleIncomingLine(textDecoder.decode(bytes), 'ble');
      });

      bleDevice = device;
      bleNotifyChar = notifyChar;
      bleCmdChar = cmdChar;
      activeSource = 'ble';
      bridgePortName = device.name || 'StickS3-Color BLE';
      closeBridgeSockets();
      emitStatus('Connected wirelessly via BLE');
    }

    // ---------- Outbound Host Commands (Mode / Hold / Tare) ----------

    async function sendCommand(cmdObj) {
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
        try {
          const payload = textEncoder.encode(line.trim());
          if (typeof bleCmdChar.writeValueWithoutResponse === 'function') {
            await bleCmdChar.writeValueWithoutResponse(payload);
          } else {
            await bleCmdChar.writeValue(payload);
          }
          return true;
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

      return postBridgeEndpoint('/api/stick-s3/cmd', cmdObj);
    }

    function start() {
      if (destroyed) return;
      connectBridge();
      watchdogTimer = setInterval(function () {
        if (activeSource === 'bridge' && bridgeHasHardware && Date.now() - lastHardwarePacketMs > 3400) {
          bridgeHasHardware = false;
          emitStatus('Waiting for StickS3 USB telemetry');
        }
      }, 1500);
    }

    async function destroy() {
      destroyed = true;
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      closeBridgeSockets();
      await disconnectWebSerial(false);
      await disconnectWebBluetooth();
    }

    return {
      start: start,
      destroy: destroy,
      sendCommand: sendCommand,
      connectWebSerial: connectWebSerial,
      disconnectWebSerial: function () { return disconnectWebSerial(true); },
      connectWebBluetooth: connectWebBluetooth,
      disconnectWebBluetooth: disconnectWebBluetooth,
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
