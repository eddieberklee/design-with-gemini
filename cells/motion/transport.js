(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const ns = (root.MotionGrid = root.MotionGrid || {});
  ns.Transport = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  // Zero-dependency dual-path real-time link for Desktop <-> iPhone Motion Control.
  // Path 1: Same-origin Local WebSocket (/ws) with liveness-checked HTTP POST/SSE fallback
  // Path 2: Pure-JS MQTT 3.1.1 over WSS relay (works zero-server from file://, http://localhost, or https://)

  const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8881/mqtt'
  ];

  const TOPIC_PREFIX = 'dwg-motion-v1/';
  const SESSION_ID_RE = /^[A-Z0-9]{6,12}$/;
  const MAX_MQTT_RXBUF = 65536;
  // Retry ceilings (resident-cost rule: every reconnect loop settles in a terminal 'failed' state)
  const MQTT_MAX_ATTEMPTS = 6;        // 2 full rounds of the 3-broker failover list
  const LOCAL_WS_MAX_ATTEMPTS = 4;    // local /ws reconnects when no HTTP fallback exists
  const LOCAL_HTTP_MAX_ERRORS = 3;    // consecutive EventSource errors before the SSE fallback gives up

  function isValidSessionId(sid) {
    return typeof sid === 'string' && SESSION_ID_RE.test(sid);
  }

  function generateSessionId(len) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const count = len || 8;
    const bytes = new Uint8Array(count);
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      root.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < count; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (let i = 0; i < count; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  // ---------- Minimal MQTT 3.1.1 Binary Codec ----------

  const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

  function utf8Encode(str) {
    if (textEncoder) return textEncoder.encode(String(str));
    const s = String(str);
    const out = [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    if (textDecoder) return textDecoder.decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function concatBytes(chunks) {
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  function encodeMqttString(str) {
    const b = utf8Encode(str);
    const hdr = new Uint8Array([b.length >>> 8, b.length & 0xff]);
    return concatBytes([hdr, b]);
  }

  function encodeRemainingLength(len) {
    const out = [];
    let x = len;
    do {
      let digit = x % 128;
      x = Math.floor(x / 128);
      if (x > 0) digit |= 128;
      out.push(digit);
    } while (x > 0);
    return new Uint8Array(out);
  }

  function decodeRemainingLength(buf, offset) {
    let mult = 1;
    let value = 0;
    let idx = offset;
    for (let i = 0; i < 4; i++) {
      if (idx >= buf.length) return null;
      const byte = buf[idx++];
      value += (byte & 127) * mult;
      if ((byte & 128) === 0) {
        return { length: value, nextOffset: idx };
      }
      mult *= 128;
    }
    return { error: 'malformed_remaining_length' };
  }

  function buildConnectPacket(clientId, keepAliveSec) {
    const ka = keepAliveSec || 25;
    const varHdr = concatBytes([
      encodeMqttString('MQTT'),
      new Uint8Array([0x04, 0x02, (ka >>> 8) & 0xff, ka & 0xff])
    ]);
    const payload = encodeMqttString(clientId);
    const body = concatBytes([varHdr, payload]);
    return concatBytes([new Uint8Array([0x10]), encodeRemainingLength(body.length), body]);
  }

  function buildSubscribePacket(packetId, topic) {
    const body = concatBytes([
      new Uint8Array([(packetId >>> 8) & 0xff, packetId & 0xff]),
      encodeMqttString(topic),
      new Uint8Array([0x00])
    ]);
    return concatBytes([new Uint8Array([0x82]), encodeRemainingLength(body.length), body]);
  }

  function buildPublishPacket(topic, message) {
    const body = concatBytes([encodeMqttString(topic), utf8Encode(message)]);
    return concatBytes([new Uint8Array([0x30]), encodeRemainingLength(body.length), body]);
  }

  function buildPingReqPacket() {
    return new Uint8Array([0xc0, 0x00]);
  }

  function buildDisconnectPacket() {
    return new Uint8Array([0xe0, 0x00]);
  }

  function parseMqttPackets(buffer) {
    const packets = [];
    let offset = 0;
    while (offset < buffer.length) {
      if (offset + 2 > buffer.length) break;
      const header = buffer[offset];
      const type = header >>> 4;
      const flags = header & 0x0f;
      const rem = decodeRemainingLength(buffer, offset + 1);
      if (!rem) break;
      if (rem.error) {
        return { packets: packets, remainder: new Uint8Array(0), error: rem.error };
      }
      if (rem.length > MAX_MQTT_RXBUF) {
        return { packets: packets, remainder: new Uint8Array(0), error: 'packet_too_large' };
      }
      const pktEnd = rem.nextOffset + rem.length;
      if (pktEnd > buffer.length) break;

      const body = buffer.subarray(rem.nextOffset, pktEnd);
      if (type === 3) {
        if (body.length >= 2) {
          const tLen = (body[0] << 8) | body[1];
          const qos = (flags >>> 1) & 0x03;
          const payloadStart = 2 + tLen + (qos > 0 ? 2 : 0);
          if (payloadStart <= body.length) {
            const topic = utf8Decode(body.subarray(2, 2 + tLen));
            const payload = utf8Decode(body.subarray(payloadStart));
            packets.push({ type: 'publish', topic: topic, payload: payload });
          }
        }
      } else if (type === 2) {
        packets.push({ type: 'connack', returnCode: body.length >= 2 ? body[1] : 0 });
      } else if (type === 9) {
        packets.push({ type: 'suback' });
      } else if (type === 13) {
        packets.push({ type: 'pingresp' });
      }
      offset = pktEnd;
    }
    return {
      packets: packets,
      remainder: offset < buffer.length ? buffer.slice(offset) : new Uint8Array(0)
    };
  }

  // ---------- MQTT WSS Transport ----------

  function MqttRelayTransport(opts) {
    if (!isValidSessionId(opts.sessionId)) {
      throw new Error('Invalid sessionId for MQTT transport');
    }
    this.sessionId = opts.sessionId;
    this.role = opts.role;
    this.brokers = opts.brokers || MQTT_BROKERS;
    this.onMessage = opts.onMessage || function () {};
    this.onStatus = opts.onStatus || function () {};

    this.pubTopic = TOPIC_PREFIX + this.sessionId + '/' + (this.role === 'phone' ? 'p2d' : 'd2p');
    this.subTopic = TOPIC_PREFIX + this.sessionId + '/' + (this.role === 'phone' ? 'd2p' : 'p2d');

    this.brokerIdx = 0;
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.rxBuf = new Uint8Array(0);
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.retryDelay = 800;
    // Retry ceiling: consecutive connection attempts that never reach SUBACK before giving up
    // with a terminal 'failed' status. Reset on every successful subscribe and on start().
    this.maxAttempts = Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : MQTT_MAX_ATTEMPTS;
    this.failedAttempts = 0;
  }

  MqttRelayTransport.prototype.start = function () {
    this.closed = false;
    this.failedAttempts = 0;
    this.retryDelay = 800;
    this._connect();
  };

  MqttRelayTransport.prototype._connect = function () {
    if (this.closed) return;
    this._clearTimers();
    if (this.ws) {
      const prev = this.ws;
      this.ws = null;
      try { prev.close(); } catch (_e) {}
    }
    const url = this.brokers[this.brokerIdx % this.brokers.length];
    this.onStatus('connecting', { transport: 'mqtt', broker: url });

    let ws;
    try {
      ws = new root.WebSocket(url, ['mqtt']);
      ws.binaryType = 'arraybuffer';
    } catch (err) {
      this._scheduleReconnect(String(err && err.message || err));
      return;
    }
    this.ws = ws;
    this.rxBuf = new Uint8Array(0);
    this.ready = false;

    const self = this;
    this.connectTimer = setTimeout(function () {
      if (!self.ready && self.ws === ws) {
        try { ws.close(); } catch (_e) {}
      }
    }, 5500);

    ws.onopen = function () {
      if (self.ws !== ws || self.closed) return;
      const cid = 'dwg_' + self.role[0] + '_' + generateSessionId(8);
      try {
        ws.send(buildConnectPacket(cid, 25));
      } catch (_e) {
        try { ws.close(); } catch (_e2) {}
      }
    };

    ws.onmessage = function (ev) {
      if (self.ws !== ws || self.closed) return;
      const chunk = ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : ArrayBuffer.isView(ev.data)
          ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
          : new Uint8Array(0);
      if (chunk.length === 0) return;

      if (self.rxBuf.length + chunk.length > MAX_MQTT_RXBUF) {
        self.rxBuf = new Uint8Array(0);
        try { ws.close(); } catch (_e) {}
        return;
      }

      self.rxBuf = self.rxBuf.length ? concatBytes([self.rxBuf, chunk]) : chunk;
      const parsed = parseMqttPackets(self.rxBuf);
      if (parsed.error) {
        self.rxBuf = new Uint8Array(0);
        try { ws.close(); } catch (_e) {}
        return;
      }
      self.rxBuf = parsed.remainder;

      for (let i = 0; i < parsed.packets.length; i++) {
        const pkt = parsed.packets[i];
        if (pkt.type === 'connack') {
          if (pkt.returnCode === 0) {
            try {
              ws.send(buildSubscribePacket(1, self.subTopic));
            } catch (_e) {
              try { ws.close(); } catch (_e2) {}
              return;
            }
          } else {
            try { ws.close(); } catch (_e) {}
            return;
          }
        } else if (pkt.type === 'suback') {
          clearTimeout(self.connectTimer);
          self.connectTimer = null;
          self.ready = true;
          self.retryDelay = 800;
          self.failedAttempts = 0;
          self.onStatus('ready', { transport: 'mqtt', broker: url });
          if (self.pingTimer) clearInterval(self.pingTimer);
          self.pingTimer = setInterval(function () {
            if (self.ws === ws && ws.readyState === 1) {
              try { ws.send(buildPingReqPacket()); } catch (_e) {}
            }
          }, 18000);
        } else if (pkt.type === 'publish') {
          try {
            const msg = JSON.parse(pkt.payload);
            self.onMessage(msg);
          } catch (_e) {}
        }
      }
    };

    ws.onerror = function () {};

    ws.onclose = function () {
      if (self.ws !== ws) return;
      const wasReady = self.ready;
      self.ready = false;
      self._clearTimers();
      if (!self.closed) {
        if (!wasReady) self.brokerIdx = (self.brokerIdx + 1) % self.brokers.length;
        self._scheduleReconnect('disconnected');
      }
    };
  };

  MqttRelayTransport.prototype._scheduleReconnect = function (reason) {
    if (this.closed) return;
    const self = this;
    this.failedAttempts++;
    if (this.failedAttempts >= this.maxAttempts) {
      this._clearTimers();
      this.onStatus('failed', { transport: 'mqtt', reason: reason, attempts: this.failedAttempts });
      return;
    }
    this.onStatus('reconnecting', { transport: 'mqtt', reason: reason });
    this.reconnectTimer = setTimeout(function () {
      self._connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(5000, Math.round(this.retryDelay * 1.5));
  };

  MqttRelayTransport.prototype._clearTimers = function () {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
  };

  MqttRelayTransport.prototype.send = function (obj) {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(buildPublishPacket(this.pubTopic, JSON.stringify(obj)));
      return true;
    } catch (_e) {
      return false;
    }
  };

  MqttRelayTransport.prototype.close = function () {
    this.closed = true;
    this.ready = false;
    this._clearTimers();
    if (this.ws) {
      try {
        if (this.ws.readyState === 1) this.ws.send(buildDisconnectPacket());
        this.ws.close();
      } catch (_e) {}
      this.ws = null;
    }
  };

  // ---------- Same-Origin Local WebSocket + Liveness-Checked HTTP Fallback ----------

  function LocalBridgeTransport(opts) {
    this.sessionId = opts.sessionId;
    this.role = opts.role;
    this.wsUrl = opts.wsUrl;
    this.httpBase = opts.httpBase || '';
    this.onMessage = opts.onMessage || function () {};
    this.onStatus = opts.onStatus || function () {};

    this.ws = null;
    this.es = null;
    this.ready = false;
    this.closed = false;
    this.useHttpFallback = false;
    this.wsFailures = 0;
    this.httpFailures = 0;
    this.openGuard = null;
    this.reconnectTimer = null;
    this.maxWsAttempts = Number.isFinite(opts.maxWsAttempts) && opts.maxWsAttempts > 0 ? opts.maxWsAttempts : LOCAL_WS_MAX_ATTEMPTS;
    this.maxHttpErrors = Number.isFinite(opts.maxHttpErrors) && opts.maxHttpErrors > 0 ? opts.maxHttpErrors : LOCAL_HTTP_MAX_ERRORS;
  }

  LocalBridgeTransport.prototype.start = function () {
    this.closed = false;
    this.wsFailures = 0;
    this.httpFailures = 0;
    this.useHttpFallback = false;
    if (this.wsUrl) {
      this._connectWs();
    } else if (this.httpBase) {
      this._startHttpFallback();
    }
  };

  LocalBridgeTransport.prototype._connectWs = function () {
    if (this.closed) return;
    this.reconnectTimer = null;
    if (this.openGuard) { clearTimeout(this.openGuard); this.openGuard = null; }
    this.onStatus('connecting', { transport: 'local-ws', url: this.wsUrl });
    let ws;
    try {
      ws = new root.WebSocket(this.wsUrl);
    } catch (_e) {
      this._onWsFail();
      return;
    }
    this.ws = ws;
    const self = this;
    const guard = setTimeout(function () {
      if (self.openGuard === guard) self.openGuard = null;
      if (!self.ready && self.ws === ws) {
        try { ws.close(); } catch (_e) {}
      }
    }, 3500);
    this.openGuard = guard;

    ws.onopen = function () {
      if (self.openGuard === guard) { clearTimeout(guard); self.openGuard = null; }
      if (self.ws !== ws || self.closed) return;
      self.ready = true;
      self.wsFailures = 0;
      self.httpFailures = 0;
      self.useHttpFallback = false;
      self.onStatus('ready', { transport: 'local-ws', url: self.wsUrl });
    };

    ws.onmessage = function (ev) {
      if (self.ws !== ws || self.closed) return;
      try {
        const msg = JSON.parse(String(ev.data));
        self.onMessage(msg);
      } catch (_e) {}
    };

    ws.onerror = function () {};

    ws.onclose = function () {
      if (self.openGuard === guard) { clearTimeout(guard); self.openGuard = null; }
      if (self.ws !== ws) return;
      self.ready = false;
      if (!self.closed) self._onWsFail();
    };
  };

  LocalBridgeTransport.prototype._onWsFail = function () {
    if (this.closed) return;
    this.wsFailures++;
    if (this.wsFailures >= 2 && this.httpBase) {
      this._startHttpFallback();
      return;
    }
    if (this.wsFailures >= this.maxWsAttempts) {
      this.ready = false;
      this.onStatus('failed', { transport: 'local-ws', attempts: this.wsFailures });
      return;
    }
    const self = this;
    this.onStatus('reconnecting', { transport: 'local-ws' });
    this.reconnectTimer = setTimeout(function () {
      self._connectWs();
    }, 1000);
  };

  LocalBridgeTransport.prototype._startHttpFallback = function () {
    if (this.closed || !this.httpBase) return;
    if (this.es) {
      try { this.es.close(); } catch (_e) {}
      this.es = null;
    }
    this.useHttpFallback = true;
    this.ready = false;
    this.httpFailures = 0;
    const self = this;

    // Only mark local HTTP fallback ready once EventSource confirms live reachability
    // so an unreachable local bridge never starves healthy MQTT WSS in DualLink.
    if (typeof root.EventSource === 'function') {
      const url = this.httpBase + '/api/motion/stream?s=' + encodeURIComponent(this.sessionId) + '&role=' + encodeURIComponent(this.role);
      try {
        const es = new root.EventSource(url);
        this.es = es;
        es.onopen = function () {
          if (self.es !== es || self.closed) return;
          self.ready = true;
          self.httpFailures = 0;
          self.onStatus('ready', { transport: 'local-http', url: self.httpBase });
        };
        es.onmessage = function (ev) {
          if (self.es !== es || self.closed) return;
          try { self.onMessage(JSON.parse(ev.data)); } catch (_e) {}
        };
        es.onerror = function () {
          if (self.es !== es || self.closed) return;
          self.ready = false;
          self.httpFailures++;
          // EventSource reconnects on its own forever; cap it. readyState 2 = CLOSED (browser gave up).
          if (es.readyState === 2 || self.httpFailures >= self.maxHttpErrors) {
            self.es = null;
            try { es.close(); } catch (_e) {}
            self.onStatus('failed', { transport: 'local-http', attempts: self.httpFailures });
            return;
          }
          self.onStatus('reconnecting', { transport: 'local-http' });
        };
      } catch (_e) {
        this.ready = false;
        this.onStatus('failed', { transport: 'local-http' });
      }
    } else {
      this.ready = false;
      this.onStatus('failed', { transport: 'local-http', reason: 'no EventSource' });
    }
  };

  LocalBridgeTransport.prototype.send = function (obj) {
    if (this.useHttpFallback && this.ready && this.httpBase && typeof root.fetch === 'function') {
      const self = this;
      const url = this.httpBase + '/api/motion/send?s=' + encodeURIComponent(this.sessionId) + '&role=' + encodeURIComponent(this.role);
      root.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': '1'
        },
        body: JSON.stringify(obj),
        keepalive: false
      })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
          self.httpFailures = 0;
        })
        .catch(function () {
          self.httpFailures++;
          if (self.httpFailures >= 3) {
            self.ready = false;
            self.onStatus('reconnecting', { transport: 'local-http' });
          }
        });
      return true;
    }
    if (!this.ready || !this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (_e) {
      return false;
    }
  };

  LocalBridgeTransport.prototype.close = function () {
    this.closed = true;
    this.ready = false;
    if (this.openGuard) { clearTimeout(this.openGuard); this.openGuard = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (_e) {} this.ws = null; }
    if (this.es) { try { this.es.close(); } catch (_e) {} this.es = null; }
  };

  /**
   * DualLink: Runs MQTT WSS always (or local bridge + MQTT simultaneously when local bridge is available)
   * with per-sender sequence deduplication so phone reloads and Wi-Fi -> 5G handoffs never drop packets.
   */
  function createLink(opts) {
    const mode = opts.mode || 'mqtt';
    const links = [];
    const seenSeqs = new Set();

    function handleIncoming(msg) {
      if (msg && msg.t === 'hello') {
        seenSeqs.clear();
      } else if (msg && msg.t === 'm' && typeof msg.seq === 'number') {
        const key = (typeof msg.cid === 'string' ? msg.cid : '') + ':' + msg.seq;
        if (seenSeqs.has(key)) return;
        seenSeqs.add(key);
        if (seenSeqs.size > 160) {
          const first = seenSeqs.values().next().value;
          seenSeqs.delete(first);
        }
      }
      if (opts.onMessage) opts.onMessage(msg);
    }

    const statusMap = {};
    function reportStatus(kind, state, meta) {
      statusMap[kind] = { state: state, meta: meta };
      if (!opts.onStatus) return;
      let active;
      if (statusMap.local && statusMap.local.state === 'ready') {
        active = { state: 'ready', transport: statusMap.local.meta.transport, meta: statusMap.local.meta };
      } else if (statusMap.mqtt && statusMap.mqtt.state === 'ready') {
        active = { state: 'ready', transport: 'mqtt', meta: statusMap.mqtt.meta };
      } else {
        // 'failed' is terminal for the whole link only when every sub-link has given up;
        // a dead local bridge must not report offline while MQTT is still connecting.
        const alive = links.filter(function (l) {
          return !statusMap[l.kind] || statusMap[l.kind].state !== 'failed';
        });
        if (alive.length === 0) {
          active = { state: 'failed', transport: (meta && meta.transport) || kind, meta: meta };
        } else if (state === 'failed') {
          const other = statusMap[alive[0].kind];
          active = other
            ? { state: other.state, transport: (other.meta && other.meta.transport) || alive[0].kind, meta: other.meta }
            : { state: 'connecting', transport: alive[0].kind, meta: null };
        } else {
          active = { state: state, transport: (meta && meta.transport) || kind, meta: meta };
        }
      }
      opts.onStatus(active.state, active);
    }

    if ((mode === 'local' || mode === 'dual') && (opts.wsUrl || opts.httpBase)) {
      const local = new LocalBridgeTransport({
        sessionId: opts.sessionId,
        role: opts.role,
        wsUrl: opts.wsUrl,
        httpBase: opts.httpBase,
        onMessage: handleIncoming,
        onStatus: function (st, meta) { reportStatus('local', st, meta); }
      });
      links.push({ kind: 'local', inst: local });
    }

    if (mode === 'mqtt' || mode === 'dual') {
      const mqtt = new MqttRelayTransport({
        sessionId: opts.sessionId,
        role: opts.role,
        brokers: opts.brokers,
        onMessage: handleIncoming,
        onStatus: function (st, meta) { reportStatus('mqtt', st, meta); }
      });
      links.push({ kind: 'mqtt', inst: mqtt });
    }

    return {
      start: function () {
        links.forEach(function (l) { l.inst.start(); });
      },
      send: function (obj) {
        const local = links.find(function (l) { return l.kind === 'local'; });
        if (local && local.inst.ready && local.inst.send(obj)) {
          return true;
        }
        let sent = false;
        links.forEach(function (l) {
          if (l.kind !== 'local' && l.inst.ready && l.inst.send(obj)) sent = true;
        });
        return sent;
      },
      close: function () {
        links.forEach(function (l) { l.inst.close(); });
      },
      // Last status of one sub-link ('local' | 'mqtt'), e.g. to relink after a bridge restart
      // while the aggregate still reads 'ready' on MQTT.
      subStatus: function (kind) {
        return statusMap[kind] ? statusMap[kind].state : '';
      }
    };
  }

  return {
    MQTT_BROKERS: MQTT_BROKERS,
    TOPIC_PREFIX: TOPIC_PREFIX,
    SESSION_ID_RE: SESSION_ID_RE,
    isValidSessionId: isValidSessionId,
    generateSessionId: generateSessionId,
    MqttRelayTransport: MqttRelayTransport,
    LocalBridgeTransport: LocalBridgeTransport,
    createLink: createLink,
    _codec: {
      encodeRemainingLength: encodeRemainingLength,
      decodeRemainingLength: decodeRemainingLength,
      buildConnectPacket: buildConnectPacket,
      buildSubscribePacket: buildSubscribePacket,
      buildPublishPacket: buildPublishPacket,
      buildPingReqPacket: buildPingReqPacket,
      parseMqttPackets: parseMqttPackets
    }
  };
});
