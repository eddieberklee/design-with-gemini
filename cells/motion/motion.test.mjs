import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { createBridgeServer } from './server.mjs';

const require = createRequire(import.meta.url);
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

test('SpringDamper converges cleanly to target without oscillation blowup', () => {
  const spring = new Physics.SpringDamper(1.0, 190, 26);
  spring.setTarget(1.75);
  for (let i = 0; i < 180; i++) spring.step(1 / 60);
  assert.ok(Math.abs(spring.value - 1.75) < 0.002);
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
