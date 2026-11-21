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
  // Path 1: Same-origin Local WebSocket (/ws) with automatic HTTP POST/SSE fallback (via cells/motion/server.mjs)
  // Path 2: Pure-JS MQTT 3.1.1 over WSS relay (works zero-server from file://, http://localhost, or https://)

  const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8881/mqtt'
  ];

  const TOPIC_PREFIX = 'dwg-motion-v1/';

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
      if (idx >= buf.length) return null; // incomplete
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

  /**
   * Parses 0..N complete MQTT packets from an accumulated Uint8Array buffer.
   * Returns { packets: [...], remainder: Uint8Array }.
   */
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
      const pktEnd = rem.nextOffset + rem.length;
      if (pktEnd > buffer.length) break; // wait for more bytes

      const body = buffer.subarray(rem.nextOffset, pktEnd);
      if (type === 3) {
        // PUBLISH
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
    this.sessionId = opts.sessionId;
    this.role = opts.role; // 'desktop' | 'phone'
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
  }

  MqttRelayTransport.prototype.start = function () {
    this.closed = false;
    this._connect();
  };

  MqttRelayTransport.prototype._connect = function () {
    if (this.closed) return;
    this._clearTimers();
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
        ws.close();
      }
    };

    ws.onmessage = function (ev) {
      if (self.ws !== ws || self.closed) return;
      const chunk = ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new Uint8Array(0);
      if (chunk.length === 0) return;

      self.rxBuf = self.rxBuf.length ? concatBytes([self.rxBuf, chunk]) : chunk;
      const parsed = parseMqttPackets(self.rxBuf);
      self.rxBuf = parsed.remainder;

      for (let i = 0; i < parsed.packets.length; i++) {
        const pkt = parsed.packets[i];
        if (pkt.type === 'connack') {
          if (pkt.returnCode === 0) {
            ws.send(buildSubscribePacket(1, self.subTopic));
          } else {
            ws.close();
          }
        } else if (pkt.type === 'suback') {
          clearTimeout(self.connectTimer);
          self.ready = true;
          self.retryDelay = 800;
          self.onStatus('ready', { transport: 'mqtt', broker: url });
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

    ws.onerror = function () {
      // onclose handles failover cleanly
    };

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

  // ---------- Same-Origin Local WebSocket + HTTP Fallback Transport ----------

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
    this.reconnectTimer = null;
  }

  LocalBridgeTransport.prototype.start = function () {
    this.closed = false;
    if (this.wsUrl) {
      this._connectWs();
    } else if (this.httpBase) {
      this._startHttpFallback();
    }
  };

  LocalBridgeTransport.prototype._connectWs = function () {
    if (this.closed) return;
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
    const openGuard = setTimeout(function () {
      if (!self.ready && self.ws === ws) {
        try { ws.close(); } catch (_e) {}
      }
    }, 3500);

    ws.onopen = function () {
      clearTimeout(openGuard);
      if (self.ws !== ws || self.closed) return;
      self.ready = true;
      self.wsFailures = 0;
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
      clearTimeout(openGuard);
      if (self.ws !== ws) return;
      self.ready = false;
      if (!self.closed) self._onWsFail();
    };
  };

  LocalBridgeTransport.prototype._onWsFail = function () {
    this.wsFailures++;
    // iOS Safari over self-signed LAN certs may reject wss:// while allowing same-origin HTTPS fetch/SSE
    if (this.wsFailures >= 2 && this.httpBase) {
      this._startHttpFallback();
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
    this.useHttpFallback = true;
    this.ready = true;
    this.onStatus('ready', { transport: 'local-http', url: this.httpBase });
    if (typeof root.EventSource === 'function') {
      const url = this.httpBase + '/api/motion/stream?s=' + encodeURIComponent(this.sessionId) + '&role=' + encodeURIComponent(this.role);
      try {
        const es = new root.EventSource(url);
        this.es = es;
        const self = this;
        es.onmessage = function (ev) {
          try { self.onMessage(JSON.parse(ev.data)); } catch (_e) {}
        };
      } catch (_e) {}
    }
  };

  LocalBridgeTransport.prototype.send = function (obj) {
    if (this.useHttpFallback && this.httpBase && typeof root.fetch === 'function') {
      const url = this.httpBase + '/api/motion/send?s=' + encodeURIComponent(this.sessionId) + '&role=' + encodeURIComponent(this.role);
      root.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj),
        keepalive: false
      }).catch(function () {});
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
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (_e) {} this.ws = null; }
    if (this.es) { try { this.es.close(); } catch (_e) {} this.es = null; }
  };

  /**
   * DualLink: Runs MQTT WSS always (or local bridge + MQTT simultaneously when local bridge is available)
   * with sequence deduplication so phone <-> desktop stays connected across Wi-Fi, 5G, ngrok, or LAN!
   */
  function createLink(opts) {
    const mode = opts.mode || 'mqtt'; // 'mqtt' | 'local' | 'dual'
    const links = [];
    const seenSeqs = new Set();

    function handleIncoming(msg) {
      if (msg && msg.t === 'm' && typeof msg.seq === 'number') {
        if (seenSeqs.has(msg.seq)) return;
        seenSeqs.add(msg.seq);
        if (seenSeqs.size > 120) {
          const first = seenSeqs.values().next().value;
          seenSeqs.delete(first);
        }
      }
      if (opts.onMessage) opts.onMessage(msg);
    }

    const statusMap = {};
    function reportStatus(kind, state, meta) {
      statusMap[kind] = { state: state, meta: meta };
      if (opts.onStatus) {
        const active = statusMap.local && statusMap.local.state === 'ready'
          ? { state: 'ready', transport: statusMap.local.meta.transport, meta: statusMap.local.meta }
          : statusMap.mqtt && statusMap.mqtt.state === 'ready'
            ? { state: 'ready', transport: 'mqtt', meta: statusMap.mqtt.meta }
            : { state: state, transport: (meta && meta.transport) || kind, meta: meta };
        opts.onStatus(active.state, active);
      }
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
        // Prefer local low-latency bridge if ready; fall back to MQTT if local isn't ready
        const local = links.find(function (l) { return l.kind === 'local'; });
        if (local && local.inst.ready) {
          return local.inst.send(obj);
        }
        let sent = false;
        links.forEach(function (l) {
          if (l.inst.ready && l.inst.send(obj)) sent = true;
        });
        return sent;
      },
      close: function () {
        links.forEach(function (l) { l.inst.close(); });
      }
    };
  }

  return {
    MQTT_BROKERS: MQTT_BROKERS,
    TOPIC_PREFIX: TOPIC_PREFIX,
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
