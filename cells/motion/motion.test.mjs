import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBridgeServer } from './server.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QR = require('./qr.js');
const Physics = require('./physics.js');
const Transport = require('./transport.js');

// ---------- 1. QR Code Encoder Verification ----------

test('QR encoder generates valid ISO/IEC 18004 matrix structure across Versions 1-10', () => {
  const samples = [
    'https://ex.co/a',
    'https://abc123.ngrok-free.app/cells/motion/phone.html?s=K7M4P2Q9&t=dual',
    'https://eddieberklee.github.io/design-with-gemini/cells/motion/phone.html?s=ABCDEFGH&t=mqtt&extra=1234567890',
    'https://x.io/' + 'a'.repeat(190) // Version 10 (16-bit byte count)
  ];

  for (const text of samples) {
    const qr = QR.encode(text);
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.equal(qr.modules.length, qr.size);
    assert.ok(qr.mask >= 0 && qr.mask <= 7);

    const origins = [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]];
    for (const [tr, tc] of origins) {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const center = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          assert.equal(qr.modules[tr + dr][tc + dc], border || center ? 1 : 0);
        }
      }
    }

    for (let i = 8; i < qr.size - 8; i++) {
      assert.equal(qr.modules[6][i], i % 2 === 0 ? 1 : 0);
      assert.equal(qr.modules[i][6], i % 2 === 0 ? 1 : 0);
    }

    assert.equal(qr.modules[qr.size - 8][8], 1);
    const pathD = QR.buildPathData(qr, 4);
    assert.ok(pathD.length > 50 && pathD.startsWith('M'));
  }
});

test('QR Reed-Solomon remainder produces zero syndrome at all generator roots', () => {
  const data = [0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec];
  const ec = QR._internal.rsComputeRemainder(data, 10);
  assert.equal(ec.length, 10);

  const codeword = data.concat(Array.from(ec));
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];

  for (let rootIdx = 0; rootIdx < 10; rootIdx++) {
    const alpha = exp[rootIdx];
    let evalVal = 0;
    for (const coeff of codeword) {
      evalVal = (evalVal === 0 ? 0 : exp[log[evalVal] + log[alpha]]) ^ coeff;
    }
    assert.equal(evalVal, 0);
  }
});

test('QR format bits match ISO/IEC 18004 EC-M reference vectors', () => {
  const expected = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
  for (let m = 0; m < 8; m++) {
    assert.equal(QR._internal.computeFormatBits(0b00, m), expected[m]);
  }
});

// ---------- 2. Accelerometer Physics & Sensor Fusion Verification ----------

test('MotionProcessor tilt mode grows on real clockwise roll and shrinks on counter-clockwise roll (iOS & W3C)', () => {
  // Real iOS clockwise roll (right edge down -> CMDeviceMotion gravity.x > 0, gravity.z < 0)
  const procIOS = new Physics.MotionProcessor({ mode: 'tilt' });
  procIOS.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: -9.81, ts: 1000, isIOS: true });
  assert.equal(procIOS.scale, 1.0);

  for (let i = 1; i <= 25; i++) {
    procIOS.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 4.9, gy: 0, gz: -8.5, ts: 1000 + i * 20, isIOS: true });
  }
  assert.ok(procIOS.telemetry.roll > 20, `Expected positive roll on iOS clockwise twist, got ${procIOS.telemetry.roll}`);
  assert.ok(procIOS.scale > 1.25, `Expected scale > 1.25 on iOS clockwise tilt, got ${procIOS.scale}`);

  for (let i = 26; i <= 60; i++) {
    procIOS.ingestMotion({ ax: 0, ay: 0, az: 0, gx: -4.9, gy: 0, gz: -8.5, ts: 1000 + i * 20, isIOS: true });
  }
  assert.ok(procIOS.scale < 0.8, `Expected scale < 0.8 on iOS counter-clockwise tilt, got ${procIOS.scale}`);

  // Real W3C/Android clockwise roll (right edge down -> left edge toward sky -> gx < 0, gz > 0)
  const procW3C = new Physics.MotionProcessor({ mode: 'tilt' });
  procW3C.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 9.81, ts: 1000, isIOS: false });
  for (let i = 1; i <= 25; i++) {
    procW3C.ingestMotion({ ax: 0, ay: 0, az: 0, gx: -4.9, gy: 0, gz: 8.5, ts: 1000 + i * 20, isIOS: false });
  }
  assert.ok(procW3C.scale > 1.25, `Expected scale > 1.25 on W3C clockwise tilt, got ${procW3C.scale}`);
});

test('Pure pull toward user does not contaminate GravityFilter tilt estimate', () => {
  const proc = new Physics.MotionProcessor({ mode: 'all' });
  let ts = 1000;
  // Hold phone upright (W3C gy = +9.81, gz = 0)
  for (let i = 0; i < 10; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 9.81, gz: 0, ts, isIOS: false });
    ts += 16;
  }
  // Pull toward chest (+az = +5 m/s^2 for 256ms, while gravity stays pure +9.81 Y)
  for (let i = 0; i < 16; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 5.0, gx: 0, gy: 9.81, gz: 5.0, ts, isIOS: false });
    ts += 16;
  }
  assert.ok(Math.abs(proc.telemetry.pitch - 90) < 0.1, `Gravity pitch should stay near 90°, got ${proc.telemetry.pitch}`);
  assert.ok(proc.scale > 1.07, `Pure pull toward chest should enlarge cells, got ${proc.scale}`);
});

test('MotionProcessor lift mode responds to raising phone up (with or without linear acc) and suppresses drift', () => {
  const proc = new Physics.MotionProcessor({ mode: 'lift' });
  let ts = 1000;
  for (let i = 0; i < 10; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 9.81, ts, isIOS: false });
    ts += 16;
  }
  for (let i = 0; i < 15; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 4.0, gx: 0, gy: 0, gz: 13.81, ts, isIOS: false });
    ts += 16;
  }
  const afterLift = proc.scale;
  assert.ok(afterLift > 1.08, `Expected scale growth on upward lift, got ${afterLift}`);

  for (let i = 0; i < 120; i++) {
    const noise = i % 2 === 0 ? 0.18 : -0.18;
    proc.ingestMotion({ ax: noise, ay: -noise, az: noise, gx: noise, gy: -noise, gz: 9.81 + noise, ts, isIOS: false });
    ts += 16;
  }
  assert.ok(Math.abs(proc.scale - afterLift) < 0.15);
  assert.equal(proc.velLift, 0);

  // Also test fallback when event.acceleration is null
  const procNoLin = new Physics.MotionProcessor({ mode: 'lift' });
  let ts2 = 1000;
  for (let i = 0; i < 10; i++) {
    procNoLin.ingestMotion({ ax: null, ay: null, az: null, gx: 0, gy: 0, gz: 9.81, ts: ts2, isIOS: false });
    ts2 += 16;
  }
  for (let i = 0; i < 12; i++) {
    procNoLin.ingestMotion({ ax: null, ay: null, az: null, gx: 0, gy: 0, gz: 13.81, ts: ts2, isIOS: false });
    ts2 += 16;
  }
  assert.ok(procNoLin.scale > 1.04, `Fallback lift without event.acceleration should grow scale, got ${procNoLin.scale}`);
});

test('MotionProcessor clutch mode freezes scale when released and ratchets when held', () => {
  const proc = new Physics.MotionProcessor({ mode: 'tilt', clutchRequired: true });
  proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 9.81, ts: 100, isIOS: false });

  for (let i = 1; i <= 15; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: -5.5, gy: 0, gz: 8.1, ts: 100 + i * 20, isIOS: false });
  }
  assert.equal(proc.scale, 1.0);

  proc.setClutch(true);
  for (let i = 16; i <= 35; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: -8.5, gy: 0, gz: 4.9, ts: 100 + i * 20, isIOS: false });
  }
  assert.ok(proc.scale > 1.15);
  const lockedScale = proc.scale;

  proc.setClutch(false);
  for (let i = 36; i <= 55; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 9.81, ts: 100 + i * 20, isIOS: false });
  }
  assert.equal(proc.scale, lockedScale);
});

test('SpringDamper converges cleanly to target without oscillation blowup and guards NaN inputs', () => {
  const spring = new Physics.SpringDamper(1.0, 190, 26);
  spring.setTarget(1.75);
  for (let i = 0; i < 180; i++) spring.step(1 / 60);
  assert.ok(Math.abs(spring.value - 1.75) < 0.002);

  const nanSpring = new Physics.SpringDamper(NaN, NaN, NaN);
  nanSpring.setTarget(1.4);
  nanSpring.step(1 / 60);
  assert.ok(Number.isFinite(nanSpring.value), `Expected finite SpringDamper value, got ${nanSpring.value}`);

  const nanFilter = new Physics.GravityFilter(NaN);
  const g = nanFilter.update(0, 0, 9.81, NaN);
  assert.ok(Number.isFinite(g.z) && Math.abs(g.z - 1) < 1e-3);

  // Pre-motion calibrate() must defer zero-pose capture until first real accelerometer sample
  const preCalProc = new Physics.MotionProcessor({ mode: 'tilt', sensitivity: NaN });
  preCalProc.calibrate();
  assert.equal(preCalProc.calibrated, false);
  preCalProc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 6.93, gz: 6.93, ts: 1000, isIOS: false });
  assert.ok(Math.abs(preCalProc.zeroPitch - 45) < 0.5, `Expected pre-calibrated zeroPitch ~45°, got ${preCalProc.zeroPitch}`);
  assert.equal(preCalProc.scale, 1.0);
});

// ---------- 3. Transport & MQTT Codec Verification ----------

test('Transport rejects wildcard/malformed session IDs and scopes DualLink dedup across reloads', () => {
  assert.equal(Transport.isValidSessionId('K7M4P2Q9'), true);
  assert.equal(Transport.isValidSessionId('#'), false);
  assert.equal(Transport.isValidSessionId('foo/+'), false);
  assert.throws(() => new Transport.MqttRelayTransport({ sessionId: 'bad/#', role: 'phone' }));

  const codec = Transport._codec;
  const bigMsg = JSON.stringify({ t: 'm', seq: 42, pad: 'x'.repeat(240) });
  const p1 = codec.buildPublishPacket('dwg-motion-v1/TEST1234/p2d', bigMsg);
  const p2 = codec.buildPublishPacket('dwg-motion-v1/TEST1234/p2d', '{"t":"act","cmd":"reset"}');

  const combined = new Uint8Array(p1.length + p2.length);
  combined.set(p1, 0);
  combined.set(p2, p1.length);

  const r1 = codec.parseMqttPackets(combined.slice(0, 75));
  assert.equal(r1.packets.length, 0);
  const merged = new Uint8Array(r1.remainder.length + (combined.length - 75));
  merged.set(r1.remainder, 0);
  merged.set(combined.slice(75), r1.remainder.length);

  const r2 = codec.parseMqttPackets(merged);
  assert.equal(r2.packets.length, 2);
  assert.equal(JSON.parse(r2.packets[0].payload).seq, 42);
  assert.equal(JSON.parse(r2.packets[1].payload).cmd, 'reset');
});

// ---------- 4. Hardened Local Bridge Server Security & Relay Verification ----------

function rawHttpGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (c) => { data += c.toString('utf8'); });
    sock.on('end', () => {
      const m = data.match(/^HTTP\/1\.1 (\d+)/);
      resolve({ status: m ? Number(m[1]) : 0, raw: data });
    });
    sock.on('error', reject);
  });
}

test('Hardened bridge server blocks traversal/dotfiles/malformed URIs/oversized POSTs and relays WS', async () => {
  const bridge = createBridgeServer({ port: 0, httpsPort: 0, enableHttps: false });
  const st = await bridge.start();
  try {
    // Malformed URI must return 400 and keep server alive
    const badUri = await rawHttpGet(st.httpPort, '/%E0%A4%A');
    assert.equal(badUri.status, 400);

    // Raw traversal & dotfiles & non-web internals must return 403
    for (const blocked of ['/../GEMINI.md', '/%2e%2e/GEMINI.md', '/.git/HEAD', '/GEMINI.md', '/AGENTS.md']) {
      const r = await rawHttpGet(st.httpPort, blocked);
      assert.equal(r.status, 403, `Expected 403 for ${blocked}, got ${r.status}`);
    }

    // Legitimate web assets work
    const okHtml = await fetch(`http://127.0.0.1:${st.httpPort}/cells/motion/phone.html`);
    assert.equal(okHtml.status, 200);

    // Oversized POST returns 413; invalid session returns 400
    const bigPost = await fetch(`http://127.0.0.1:${st.httpPort}/api/motion/send?s=TEST99AA&role=phone`, {
      method: 'POST',
      body: JSON.stringify({ pad: 'x'.repeat(12000) })
    });
    assert.equal(bigPost.status, 413);

    const badSid = await fetch(`http://127.0.0.1:${st.httpPort}/api/motion/send?s=bad%2F%23&role=phone`, {
      method: 'POST',
      body: '{}'
    });
    assert.equal(badSid.status, 400);

    // Config & WS relay still healthy after adversarial probes
    const cfgRes = await fetch(`http://127.0.0.1:${st.httpPort}/api/motion-config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.ok, true);
    assert.equal(cfg.httpsReady, false);

    const sid = 'TEST99AA';
    const wsDesk = new WebSocket(`ws://127.0.0.1:${st.httpPort}/ws?s=${sid}&role=desktop`);
    const wsPhone = new WebSocket(`ws://127.0.0.1:${st.httpPort}/ws?s=${sid}&role=phone`);
    await Promise.all([
      new Promise((r) => { wsDesk.onopen = r; }),
      new Promise((r) => { wsPhone.onopen = r; })
    ]);

    const received = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS relay timeout')), 3000);
      wsDesk.onmessage = (ev) => {
        clearTimeout(t);
        resolve(JSON.parse(String(ev.data)));
      };
    });

    wsPhone.send(JSON.stringify({ t: 'm', cid: 'ABC123', seq: 7, scale: 1.58 }));
    const msg = await received;
    assert.equal(msg.seq, 7);
    assert.equal(msg.scale, 1.58);

    wsDesk.close();
    wsPhone.close();
  } finally {
    await bridge.close();
  }
});

function rawWsUpgrade(port, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const hdrLines = [
        `GET ${rawPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13'
      ];
      for (const [k, v] of Object.entries(headers)) {
        hdrLines.push(`${k}: ${v}`);
      }
      sock.write(hdrLines.join('\r\n') + '\r\n\r\n');
    });
    const chunks = [];
    let closed = false;
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => {
      closed = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      const m = raw.match(/^HTTP\/1\.1 (\d+)/);
      resolve({ status: m ? Number(m[1]) : 0, raw, closed });
    });
    sock.on('error', (err) => {
      if (chunks.length > 0) {
        const raw = Buffer.concat(chunks).toString('utf8');
        const m = raw.match(/^HTTP\/1\.1 (\d+)/);
        resolve({ status: m ? Number(m[1]) : 0, raw, closed: true });
      } else {
        reject(err);
      }
    });
  });
}

test('Bridge handleUpgrade rejects disallowed Origin (CSWSH 403), rejects unmasked client frames, and cleans up TLS temp dir', async () => {
  const beforeDirs = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dwg-motion-tls-')));
  const bridge = createBridgeServer({ port: 0, httpsPort: 0, enableHttps: true });
  const st = await bridge.start();
  try {
    const afterDirs = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dwg-motion-tls-') && !beforeDirs.has(n));
    assert.equal(afterDirs.length, 0, `Expected ephemeral TLS temp dir cleanup, found: ${afterDirs.join(', ')}`);

    // Disallowed cross-site Origin must be rejected with 403 Forbidden + destroyed socket
    const evilUpgrade = await rawWsUpgrade(st.httpPort, '/ws?s=ABCD1234&role=desktop', {
      Origin: 'https://evil.example'
    });
    assert.equal(evilUpgrade.status, 403);
    assert.equal(evilUpgrade.closed, true);

    // Allowed localhost Origin upgrades cleanly (101), then unmasked client frame is rejected with 1002 close
    const unmaskedResult = await new Promise((resolve, reject) => {
      const sock = net.connect(st.httpPort, '127.0.0.1', () => {
        sock.write(
          'GET /ws?s=ABCD1234&role=desktop HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${st.httpPort}\r\n` +
          `Origin: http://localhost:${st.httpPort}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });
      let upgraded = false;
      const rx = [];
      sock.on('data', (chunk) => {
        rx.push(chunk);
        const all = Buffer.concat(rx);
        if (!upgraded && all.toString('utf8').includes('101 Switching Protocols')) {
          upgraded = true;
          // Send an unmasked text frame ("hi" -> [0x81, 0x02, 0x68, 0x69])
          sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
        }
      });
      sock.on('close', () => resolve({ upgraded, rx: Buffer.concat(rx) }));
      sock.on('error', reject);
    });
    assert.equal(unmaskedResult.upgraded, true);

    // Keep an SSE stream + WS open and verify bridge.close() resolves promptly without hanging
    const sseAbort = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${st.httpPort}/api/motion/stream?s=ABCD1234&role=desktop`, {
      signal: sseAbort.signal
    });
    assert.equal(sseRes.status, 200);
    const liveWs = new WebSocket(`ws://127.0.0.1:${st.httpPort}/ws?s=ABCD1234&role=phone`);
    await new Promise((r) => { liveWs.onopen = r; });

    const closeStart = Date.now();
    await bridge.close();
    assert.ok(Date.now() - closeStart < 1500, 'bridge.close() should terminate active SSE and WS connections promptly');
    sseAbort.abort();
  } finally {
    await bridge.close();
  }
});

test('Transport cleans up openGuard timer and handles malformed MQTT frames & subscribe errors', () => {
  let pendingTimers = 0;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  // Test LocalBridgeTransport openGuard cleanup on close()
  let wsClosed = false;
  function FakeSlowWs() {}
  FakeSlowWs.prototype.close = function () { wsClosed = true; };

  const localTx = new Transport.LocalBridgeTransport({
    sessionId: 'ABCD1234',
    role: 'desktop',
    wsUrl: 'ws://127.0.0.1:9999/ws'
  });
  const prevWs = globalThis.WebSocket;
  globalThis.WebSocket = FakeSlowWs;
  globalThis.setTimeout = (fn, ms) => {
    pendingTimers++;
    return realSetTimeout(fn, ms);
  };
  globalThis.clearTimeout = (id) => {
    if (id) pendingTimers--;
    return realClearTimeout(id);
  };
  try {
    localTx.start();
    assert.equal(pendingTimers, 1);
    localTx.close();
    assert.equal(pendingTimers, 0, 'LocalBridgeTransport.close() must clear openGuard timer');
    assert.equal(wsClosed, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.WebSocket = prevWs;
  }

  // Test MqttRelayTransport closes WS on malformed remaining length and on subscribe send error
  let activeMockWs = null;
  let throwOnSub = false;
  function FakeMqttWs() {
    this.readyState = 1;
    this.closed = false;
    activeMockWs = this;
  }
  FakeMqttWs.prototype.send = function (pkt) {
    if (throwOnSub && pkt[0] === 0x82) {
      throw new Error('WS closed before subscribe');
    }
  };
  FakeMqttWs.prototype.close = function () {
    this.closed = true;
  };

  globalThis.WebSocket = FakeMqttWs;
  try {
    const mqtt1 = new Transport.MqttRelayTransport({
      sessionId: 'ABCD1234',
      role: 'desktop',
      brokers: ['wss://example.invalid/mqtt']
    });
    mqtt1.start();
    // Malformed MQTT remaining length (5 continuation bytes)
    activeMockWs.onmessage({ data: new Uint8Array([0x30, 0x80, 0x80, 0x80, 0x80, 0x01]).buffer });
    assert.equal(activeMockWs.closed, true, 'MqttRelayTransport must close WS on parsed.error');
    mqtt1.close();

    throwOnSub = true;
    const mqtt2 = new Transport.MqttRelayTransport({
      sessionId: 'ABCD1234',
      role: 'desktop',
      brokers: ['wss://example.invalid/mqtt']
    });
    mqtt2.start();
    // CONNACK returnCode = 0 -> triggers subscribe -> throws -> caught cleanly & closes WS
    assert.doesNotThrow(() => {
      activeMockWs.onmessage({ data: new Uint8Array([0x20, 0x02, 0x00, 0x00]).buffer });
    });
    assert.equal(activeMockWs.closed, true, 'MqttRelayTransport must catch subscribe send error and close WS');
    mqtt2.close();
  } finally {
    globalThis.WebSocket = prevWs;
  }
});

// ---------- 5. Retry ceilings, aggregate link status, cell-width truth ----------

function withFakeTimers(fn) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const timers = new Map();
  let nextId = 1;
  globalThis.setTimeout = (cb, ms) => { const id = nextId++; timers.set(id, { cb, ms, kind: 't' }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.setInterval = (cb, ms) => { const id = nextId++; timers.set(id, { cb, ms, kind: 'i' }); return id; };
  globalThis.clearInterval = (id) => { timers.delete(id); };
  const clock = {
    timers,
    pending: () => timers.size,
    // Fire the oldest pending one-shot timer (reconnect / connect guard)
    fireNext() {
      for (const [id, t] of timers) {
        if (t.kind === 't') { timers.delete(id); t.cb(); return true; }
      }
      return false;
    }
  };
  try {
    return fn(clock);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

test('scaleToCellWidth reports the measured 1.00x width at phone sizes (no 180px floor)', () => {
  // 390px viewport: 358px grid, 2 columns, gap 4 -> 177px tiles
  assert.equal(Physics.scaleToCellWidth(1.0, 177, 358), 177);
  assert.equal(Physics.scaleToCellWidth(1.0, 150, 358), 150);
  assert.equal(Physics.scaleToCellWidth(0.34, 177, 358), Physics.MIN_CELL_W);
  assert.equal(Physics.scaleToCellWidth(2.15, 488, 1472), Physics.MAX_CELL_W);
  assert.equal(Physics.scaleToCellWidth(1.0, NaN, NaN), 420);
});

test('MqttRelayTransport stops at its retry ceiling with a terminal failed status and start() re-arms', () => {
  const prevWs = globalThis.WebSocket;
  const sockets = [];
  function DeadWs(url) { this.url = url; this.readyState = 0; sockets.push(this); }
  DeadWs.prototype.send = function () {};
  DeadWs.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  };
  globalThis.WebSocket = DeadWs;
  try {
    withFakeTimers((clock) => {
      const statuses = [];
      const mqtt = new Transport.MqttRelayTransport({
        sessionId: 'ABCD1234',
        role: 'desktop',
        maxAttempts: 4,
        onStatus: (st) => statuses.push(st)
      });
      mqtt.start();
      // Each attempt: the broker never answers -> connect guard fires -> close -> reconnect timer
      for (let i = 0; i < 20 && clock.fireNext(); i++) { /* drain */ }
      assert.equal(statuses[statuses.length - 1], 'failed');
      assert.equal(statuses.filter((s) => s === 'failed').length, 1);
      assert.equal(sockets.length, 4, 'exactly maxAttempts sockets, then stop');
      assert.equal(clock.pending(), 0, 'no reconnect or ping timer may survive the ceiling');
      // Broker failover still rotates across the list
      assert.deepEqual(sockets.slice(0, 3).map((w) => w.url), Transport.MQTT_BROKERS);

      mqtt.start();
      assert.equal(sockets.length, 5, 'start() re-arms after failed');
      assert.equal(statuses[statuses.length - 1], 'connecting');
      mqtt.close();
      assert.equal(clock.pending(), 0);
    });
  } finally {
    globalThis.WebSocket = prevWs;
  }
});

test('LocalBridgeTransport caps WS reconnects and closes a failing EventSource fallback', () => {
  const prevWs = globalThis.WebSocket;
  const prevEs = globalThis.EventSource;
  const sockets = [];
  function DeadWs() { this.readyState = 0; sockets.push(this); }
  DeadWs.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  };
  const sources = [];
  function FakeEs(url) { this.url = url; this.readyState = 0; this.closed = false; sources.push(this); }
  FakeEs.prototype.close = function () { this.closed = true; this.readyState = 2; };
  globalThis.WebSocket = DeadWs;
  globalThis.EventSource = FakeEs;
  try {
    withFakeTimers((clock) => {
      // (a) No HTTP fallback: WS retries stop at the ceiling
      const st1 = [];
      const wsOnly = new Transport.LocalBridgeTransport({
        sessionId: 'ABCD1234', role: 'desktop', wsUrl: 'ws://127.0.0.1:1/ws', maxWsAttempts: 3,
        onStatus: (st) => st1.push(st)
      });
      wsOnly.start();
      for (let i = 0; i < 20 && clock.fireNext(); i++) { /* drain */ }
      assert.equal(st1[st1.length - 1], 'failed');
      assert.equal(sockets.length, 3);
      assert.equal(clock.pending(), 0);

      // (b) WS fails twice -> SSE fallback; repeated EventSource errors close it (no endless auto-retry)
      const st2 = [];
      const withHttp = new Transport.LocalBridgeTransport({
        sessionId: 'ABCD1234', role: 'desktop', wsUrl: 'ws://127.0.0.1:1/ws', httpBase: 'http://127.0.0.1:1',
        onStatus: (st) => st2.push(st)
      });
      withHttp.start();
      for (let i = 0; i < 20 && clock.fireNext(); i++) { /* drain */ }
      assert.equal(sources.length, 1);
      const es = sources[0];
      es.onerror();
      es.onerror();
      assert.equal(es.closed, false);
      assert.equal(st2[st2.length - 1], 'reconnecting');
      es.onerror();
      assert.equal(es.closed, true, 'EventSource must be closed at the error ceiling');
      assert.equal(st2[st2.length - 1], 'failed');
      assert.equal(clock.pending(), 0);
      withHttp.close();
    });
  } finally {
    globalThis.WebSocket = prevWs;
    globalThis.EventSource = prevEs;
  }
});

test('createLink reports failed only when every sub-link has failed', () => {
  const prevWs = globalThis.WebSocket;
  const sockets = [];
  function PendingWs(url) { this.url = url; this.readyState = 0; sockets.push(this); }
  PendingWs.prototype.send = function () {};
  PendingWs.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  };
  globalThis.WebSocket = PendingWs;
  try {
    withFakeTimers((clock) => {
      const seen = [];
      const link = Transport.createLink({
        mode: 'dual', sessionId: 'ABCD1234', role: 'desktop', wsUrl: 'ws://127.0.0.1:1/ws', httpBase: '',
        onStatus: (st, info) => seen.push(st + ':' + info.transport)
      });
      link.start();
      const fireWhere = (pred) => {
        for (const [id, t] of clock.timers) {
          if (t.kind === 't' && pred(t)) { clock.timers.delete(id); t.cb(); return true; }
        }
        return false;
      };
      // Kill the local bridge until it hits its ceiling; local reconnect timers are 1000ms.
      for (let i = 0; i < 10; i++) {
        sockets.filter((w) => w.url.startsWith('ws://') && w.readyState !== 3).forEach((w) => w.close());
        if (!fireWhere((t) => t.ms === 1000)) break;
      }
      assert.equal(sockets.filter((w) => w.url.startsWith('ws://')).length, 4);
      assert.ok(!seen.includes('failed:local-ws'), 'local failure alone must not fail the link: ' + seen.join(','));
      assert.equal(seen[seen.length - 1], 'connecting:mqtt');
      assert.equal(link.subStatus('local'), 'failed', 'sub-link status stays observable for relink decisions');

      // Now exhaust MQTT as well -> the whole link reports failed exactly once
      for (let i = 0; i < 20; i++) {
        sockets.filter((w) => w.url.startsWith('wss://') && w.readyState !== 3).forEach((w) => w.close());
        if (!fireWhere((t) => t.ms !== 1000)) break;
      }
      assert.equal(seen[seen.length - 1], 'failed:mqtt');
      assert.equal(seen.filter((x) => x.startsWith('failed')).length, 1);
      assert.equal(clock.pending(), 0);
      link.close();
    });
  } finally {
    globalThis.WebSocket = prevWs;
  }
});

function makeUiHarness(location) {
  const uiSource = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

  function makeNode(tag) {
    const listeners = {};
    return {
      tagName: String(tag).toUpperCase(),
      className: '',
      id: '',
      title: '',
      value: '',
      textContent: '',
      hidden: false,
      open: false,
      isConnected: true,
      dataset: {},
      style: {
        setProperty(k, v) { this[k] = v; },
        removeProperty(k) { delete this[k]; }
      },
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, f) {
          const on = f === undefined ? !this._set.has(c) : Boolean(f);
          if (on) this._set.add(c); else this._set.delete(c);
        },
        contains(c) { return this._set.has(c); }
      },
      children: [],
      parentNode: null,
      get firstChild() { return this.children[0] || null; },
      appendChild(child) {
        if (child && typeof child === 'object') {
          if (child.parentNode) child.parentNode.removeChild(child);
          child.parentNode = this;
        }
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) {
          this.children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      setAttribute(k, v) { this[k] = String(v); },
      removeAttribute(k) { delete this[k]; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this, k); },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      dispatchEvent(ev) {
        (listeners[ev.type] || []).slice().forEach((fn) => fn(ev));
      },
      showModal() { this.open = true; },
      close() {
        this.open = false;
        this.dispatchEvent({ type: 'close' });
      },
      focus() { doc.activeElement = this; },
      closest(sel) { return sel === '.grid' ? gridEl : null; }
    };
  }

  const body = makeNode('body');
  const gridEl = makeNode('main');
  gridEl.className = 'grid';
  const cellEl = makeNode('section');
  gridEl.appendChild(cellEl);
  body.appendChild(gridEl);

  const docListeners = {};
  const doc = {
    readyState: 'loading',
    visibilityState: 'visible',
    body,
    documentElement: { clientWidth: 1280 },
    activeElement: body,
    createElement: (t) => makeNode(t),
    createElementNS: (_ns, t) => makeNode(t),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt) }),
    getElementById: () => null,
    querySelector: (sel) => (sel === '.grid' || sel === 'main.grid' ? gridEl : null),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => {
      if (docListeners[t]) docListeners[t] = docListeners[t].filter((f) => f !== fn);
    }
  };
  const links = { opened: 0, closed: 0, last: null };

  let activeIntervals = 0;
  const winListeners = {};
  const win = {
    MotionGrid: {
      QR,
      Physics,
      Transport: {
        ...Transport,
        createLink: (opts) => {
          links.opened++;
          const l = { opts, open: true, start() {}, send() { return true; }, close() { if (this.open) { this.open = false; links.closed++; } } };
          links.last = l;
          return l;
        }
      }
    },
    document: doc,
    navigator: { clipboard: null },
    location,
    innerWidth: 1280,
    performance: { now: () => 1000 },
    getComputedStyle: () => ({ paddingLeft: '24px', paddingRight: '24px' }),
    matchMedia: () => ({ matches: true }),
    fetch: () => Promise.reject(new Error('offline')),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setInterval: () => { activeIntervals++; return activeIntervals + 100; },
    clearInterval: (id) => { if (id) activeIntervals--; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => {
      if (winListeners[t]) winListeners[t] = winListeners[t].filter((f) => f !== fn);
    }
  };
  Object.defineProperty(win, 'sessionStorage', {
    get() { throw new Error('SecurityError: sessionStorage blocked'); }
  });
  Object.defineProperty(win, 'localStorage', {
    get() { throw new Error('SecurityError: localStorage blocked'); }
  });
  win.window = win;
  win.globalThis = win;

  vm.runInNewContext(uiSource, win);

  return {
    win, doc, body, gridEl, cellEl, links, winListeners, docListeners,
    intervals: () => activeIntervals,
    setVisibility(v) {
      doc.visibilityState = v;
      (docListeners.visibilitychange || []).slice().forEach((fn) => fn({ type: 'visibilitychange' }));
    }
  };
}

const HTTPS_ORIGIN = { protocol: 'https:', hostname: 'example.com', origin: 'https://example.com', pathname: '/' };

test('mountMotionCell survives throwing storage getters and unmounts cleanly without leaking DOM or timers', () => {
  const h = makeUiHarness(HTTPS_ORIGIN);
  const unmount1 = h.win.MotionGrid.UI.mountMotionCell(h.cellEl);
  assert.equal(typeof unmount1, 'function');
  // Idle tile: relay link open (scannable HTTPS QR exists) but no periodic timers until a phone pairs
  assert.equal(h.intervals(), 0);
  assert.equal(h.links.opened, 1);
  // body has [gridEl, hud, dialog]
  assert.equal(h.body.children.length, 3);

  // A phone message starts the 1Hz liveness + 220ms feedback timers
  h.links.last.opts.onMessage({ t: 'hello', v: 1 });
  assert.equal(h.intervals(), 2);

  // Mounting a second time without manual unmount must auto-clean prior HUD, dialog, link and intervals
  const unmount2 = h.win.MotionGrid.UI.mountMotionCell(h.cellEl);
  assert.equal(h.intervals(), 0);
  assert.equal(h.links.opened, 2);
  assert.equal(h.links.closed, 1);
  assert.equal(h.body.children.length, 3);
  h.links.last.opts.onMessage({ t: 'hello', v: 1 });
  assert.equal(h.intervals(), 2);

  // Explicit unmount removes HUD, dialog, intervals, link, and window/document listeners
  unmount2();
  assert.equal(h.intervals(), 0);
  assert.equal(h.links.closed, 2);
  assert.equal(h.body.children.length, 1);
  assert.equal((h.winListeners.keydown || []).length, 0);
  assert.equal((h.winListeners.resize || []).length, 0);
  assert.equal((h.winListeners.beforeunload || []).length, 0);
  assert.equal((h.docListeners.visibilitychange || []).length, 0);
});

test('mountMotionCell drops link and phone timers while hidden and reopens only what it suspended', () => {
  const h = makeUiHarness(HTTPS_ORIGIN);
  const unmount = h.win.MotionGrid.UI.mountMotionCell(h.cellEl);
  const first = h.links.last;
  first.opts.onMessage({ t: 'hello', v: 1 });
  assert.equal(h.intervals(), 2);

  h.setVisibility('hidden');
  assert.equal(h.intervals(), 0, 'hidden tab must stop liveness/feedback intervals');
  assert.equal(first.open, false, 'hidden tab must close the relay link');
  assert.equal(h.links.opened, 1);

  h.setVisibility('visible');
  assert.equal(h.links.opened, 2, 'visible again reopens the link it suspended');
  assert.equal(h.intervals(), 0, 'phone timers restart only when the phone talks again');

  // A link that reached the transport retry ceiling is not reopened by visibility churn
  const second = h.links.last;
  second.opts.onStatus('failed', { transport: 'mqtt' });
  h.setVisibility('hidden');
  h.setVisibility('visible');
  assert.equal(h.links.opened, 2, 'failed link stays down until the user retries');

  unmount();
  assert.equal(h.intervals(), 0);
});

test('mountMotionCell opens no relay link when no scannable QR URL exists (file:// setup state)', () => {
  const h = makeUiHarness({ protocol: 'file:', hostname: '', origin: 'null', pathname: '/x/index.html' });
  const unmount = h.win.MotionGrid.UI.mountMotionCell(h.cellEl);
  assert.equal(h.links.opened, 0, 'no public broker connection while the tile can only show SETUP');
  assert.equal(h.intervals(), 0);
  unmount();
});
