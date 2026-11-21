import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createBridgeServer } from './server.mjs';

const require = createRequire(import.meta.url);
const QR = require('./qr.js');
const Physics = require('./physics.js');
const Transport = require('./transport.js');

// ---------- 1. QR Code Encoder Verification ----------

test('QR encoder generates valid ISO/IEC 18004 matrix structure across Versions 1-8', () => {
  const samples = [
    'https://ex.co/a',
    'https://abc123.ngrok-free.app/cells/motion/phone.html?s=K7M4P2Q9&t=dual',
    'https://eddieberklee.github.io/design-with-gemini/cells/motion/phone.html?s=ABCDEFGH&t=mqtt&extra=1234567890'
  ];

  for (const text of samples) {
    const qr = QR.encode(text);
    assert.equal(qr.size, qr.version * 4 + 17);
    assert.equal(qr.modules.length, qr.size);
    assert.ok(qr.mask >= 0 && qr.mask <= 7);

    // Check all three 7x7 finder patterns (solid dark outer border + 3x3 dark core)
    const origins = [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]];
    for (const [tr, tc] of origins) {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const center = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          assert.equal(qr.modules[tr + dr][tc + dc], border || center ? 1 : 0,
            `Finder mismatch at (${tr + dr},${tc + dc})`);
        }
      }
    }

    // Check timing patterns along row 6 and col 6
    for (let i = 8; i < qr.size - 8; i++) {
      assert.equal(qr.modules[6][i], i % 2 === 0 ? 1 : 0);
      assert.equal(qr.modules[i][6], i % 2 === 0 ? 1 : 0);
    }

    // Check fixed dark module
    assert.equal(qr.modules[qr.size - 8][8], 1);

    // Check SVG path data builds cleanly
    const pathD = QR.buildPathData(qr, 4);
    assert.ok(pathD.length > 50 && pathD.startsWith('M'));
  }
});

test('QR Reed-Solomon remainder produces zero syndrome at all generator roots', () => {
  const data = [0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec];
  const ec = QR._internal.rsComputeRemainder(data, 10);
  assert.equal(ec.length, 10);

  // Evaluate codeword polynomial over GF(256) at alpha^0 .. alpha^9
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
    assert.equal(evalVal, 0, `RS syndrome non-zero at root ${rootIdx}`);
  }
});

test('QR format bits match ISO/IEC 18004 EC-M reference vectors', () => {
  // EC-M (00), masks 0..7 known standard 15-bit format strings
  const expected = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
  for (let m = 0; m < 8; m++) {
    assert.equal(QR._internal.computeFormatBits(0b00, m), expected[m]);
  }
});

// ---------- 2. Accelerometer Physics & Sensor Fusion Verification ----------

test('MotionProcessor tilt mode grows cells on clockwise roll and shrinks on counter-clockwise roll', () => {
  const proc = new Physics.MotionProcessor({ mode: 'tilt' });

  // Neutral flat hold (iOS convention: flat face-up reports gz = -9.81)
  proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: -9.81, ts: 1000, isIOS: true });
  assert.equal(proc.scale, 1.0);

  // Tilt clockwise ~30 deg (W3C gx > 0 -> iOS gx < 0)
  for (let i = 1; i <= 25; i++) {
    proc.ingestMotion({
      ax: 0, ay: 0, az: 0,
      gx: -4.9, gy: 0, gz: -8.5,
      ts: 1000 + i * 20,
      isIOS: true
    });
  }
  assert.ok(proc.scale > 1.25, `Expected scale > 1.25 on clockwise tilt, got ${proc.scale}`);

  // Tilt counter-clockwise ~30 deg
  for (let i = 26; i <= 60; i++) {
    proc.ingestMotion({
      ax: 0, ay: 0, az: 0,
      gx: 4.9, gy: 0, gz: -8.5,
      ts: 1000 + i * 20,
      isIOS: true
    });
  }
  assert.ok(proc.scale < 0.8, `Expected scale < 0.8 on counter-clockwise tilt, got ${proc.scale}`);
});

test('MotionProcessor lift mode responds to raising phone up and suppresses idle MEMS drift', () => {
  const proc = new Physics.MotionProcessor({ mode: 'lift' });
  let ts = 1000;

  // Settle flat on table
  for (let i = 0; i < 10; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 9.81, ts, isIOS: false });
    ts += 16;
  }

  // Upward lift impulse (+4 m/s^2 along world-up for 240ms)
  for (let i = 0; i < 15; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 4.0, gx: 0, gy: 0, gz: 9.81, ts, isIOS: false });
    ts += 16;
  }
  const afterLift = proc.scale;
  assert.ok(afterLift > 1.08, `Expected scale growth on upward lift, got ${afterLift}`);

  // Hold still with sub-deadzone MEMS noise (+/-0.2 m/s^2) for 2 seconds -> must not drift!
  for (let i = 0; i < 120; i++) {
    const noise = (i % 2 === 0 ? 0.18 : -0.18);
    proc.ingestMotion({ ax: noise, ay: -noise, az: noise, gx: 0, gy: 0, gz: 9.81, ts, isIOS: false });
    ts += 16;
  }
  assert.ok(Math.abs(proc.scale - afterLift) < 0.15, 'ZUPT should damp velocity quickly without drift');
  assert.equal(proc.velLift, 0, 'Velocity should zero out when stationary');
});

test('MotionProcessor clutch mode freezes scale when released and ratchets when held', () => {
  const proc = new Physics.MotionProcessor({ mode: 'tilt', clutchRequired: true });
  proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 9.81, ts: 100, isIOS: false });

  // Move without holding clutch -> scale must stay 1.0
  for (let i = 1; i <= 15; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 5.5, gy: 0, gz: 8.1, ts: 100 + i * 20, isIOS: false });
  }
  assert.equal(proc.scale, 1.0);

  // Engage clutch and tilt further -> scale moves
  proc.setClutch(true);
  for (let i = 16; i <= 35; i++) {
    proc.ingestMotion({ ax: 0, ay: 0, az: 0, gx: 8.5, gy: 0, gz: 4.9, ts: 100 + i * 20, isIOS: false });
  }
  assert.ok(proc.scale > 1.15);
  const lockedScale = proc.scale;

  // Release clutch and return flat -> scale remains locked
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
  assert.ok(Math.abs(spring.value - 1.75) < 0.002, `Expected convergence to 1.75, got ${spring.value}`);
});

// ---------- 3. MQTT 3.1.1 Codec & Fragmentation Verification ----------

test('MQTT 3.1.1 codec handles multi-byte remaining length and coalesced/fragmented frames', () => {
  const codec = Transport._codec;
  const bigMsg = JSON.stringify({ t: 'm', seq: 42, pad: 'x'.repeat(240) });
  const p1 = codec.buildPublishPacket('dwg-motion-v1/TEST1234/p2d', bigMsg);
  const p2 = codec.buildPublishPacket('dwg-motion-v1/TEST1234/p2d', '{"t":"act","cmd":"reset"}');

  // Concatenate and split mid-packet to test stream reassembly
  const combined = new Uint8Array(p1.length + p2.length);
  combined.set(p1, 0);
  combined.set(p2, p1.length);

  const partA = combined.slice(0, 75);
  const partB = combined.slice(75);

  const r1 = codec.parseMqttPackets(partA);
  assert.equal(r1.packets.length, 0);
  assert.equal(r1.remainder.length, 75);

  const merged = new Uint8Array(r1.remainder.length + partB.length);
  merged.set(r1.remainder, 0);
  merged.set(partB, r1.remainder.length);

  const r2 = codec.parseMqttPackets(merged);
  assert.equal(r2.packets.length, 2);
  assert.equal(r2.remainder.length, 0);
  assert.equal(JSON.parse(r2.packets[0].payload).seq, 42);
  assert.equal(JSON.parse(r2.packets[1].payload).cmd, 'reset');
});

// ---------- 4. Local Bridge Server End-to-End Relay Verification ----------

test('Local bridge server serves motion-config and relays phone <-> desktop WebSocket frames', async () => {
  const bridge = createBridgeServer({ port: 0, httpsPort: 0, enableHttps: false });
  const st = await bridge.start();
  try {
    const cfgRes = await fetch(`http://127.0.0.1:${st.httpPort}/api/motion-config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.ok, true);
    assert.ok(cfg.phoneBaseUrl.endsWith('/cells/motion/phone.html'));

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

    wsPhone.send(JSON.stringify({ t: 'm', seq: 7, scale: 1.58 }));
    const msg = await received;
    assert.equal(msg.seq, 7);
    assert.equal(msg.scale, 1.58);

    wsDesk.close();
    wsPhone.close();
  } finally {
    await bridge.close();
  }
});
