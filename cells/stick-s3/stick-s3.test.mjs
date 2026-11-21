import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createStickBridgeServer } from './bridge.mjs';

const require = createRequire(import.meta.url);
const ColorEngine = require('./color-engine.js');
const Transport = require('./transport.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('OKLCH gamut mapping stays strictly inside [0..255] sRGB without clipping jumps', () => {
  for (let h = 0; h < 360; h += 15) {
    for (const L of [0.15, 0.35, 0.58, 0.78, 0.92]) {
      const c = ColorEngine.oklchToSrgbGamutMapped(L, 0.28, h);
      assert.ok(c.r >= 0 && c.r <= 255);
      assert.ok(c.g >= 0 && c.g <= 255);
      assert.ok(c.b >= 0 && c.b <= 255);
      assert.match(c.hex, /^#[0-9A-F]{6}$/);
    }
  }

  // Smooth circular wrap between 359 deg and 1 deg
  const c359 = ColorEngine.mapImuToColor(Math.cos((359 * Math.PI) / 180) * 0.7, Math.sin((359 * Math.PI) / 180) * 0.7, 0.7, 0, 0);
  const c001 = ColorEngine.mapImuToColor(Math.cos((1 * Math.PI) / 180) * 0.7, Math.sin((1 * Math.PI) / 180) * 0.7, 0.7, 0, 0);
  assert.ok(Math.abs(c359.r - c001.r) <= 6);
  assert.ok(Math.abs(c359.g - c001.g) <= 6);
  assert.ok(Math.abs(c359.b - c001.b) <= 6);
});

test('pickAdaptiveTheme guarantees >= 4.5:1 WCAG AA contrast for ink across full RGB cube', () => {
  const steps = [0, 51, 102, 153, 204, 255];
  for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) {
        const theme = ColorEngine.pickAdaptiveTheme(r, g, b);
        assert.ok(
          theme.contrastRatio >= 4.5,
          `Expected >= 4.5 contrast for rgb(${r},${g},${b}), got ${theme.contrastRatio.toFixed(2)}`
        );
      }
    }
  }
});

test('Firmware C++ color_math.h and Browser JS color-engine.js match within <= 1 LSB across all 4 modes', () => {
  const headerPath = path.join(__dirname, 'firmware', 'src', 'color_math.h');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-color-parity-'));
  const cppFile = path.join(tmpDir, 'parity.cpp');
  const binFile = path.join(tmpDir, 'parity');

  const cppSrc = `
#include <stdio.h>
#include "${headerPath.replace(/\\/g, '\\\\')}"
using namespace sticks3_color;
int main() {
  const float vecs[][4] = {
    {0.0f, 0.0f, 1.0f, 0.0f},
    {0.65f, -0.25f, 0.72f, 0.12f},
    {-0.80f, 0.45f, -0.35f, 0.55f},
    {0.15f, 0.88f, 0.10f, 0.90f},
    {-0.42f, -0.71f, -0.85f, 0.05f}
  };
  for (int m = 0; m < 4; ++m) {
    for (int i = 0; i < 5; ++i) {
      RgbColor c = mapImuToColor(vecs[i][0], vecs[i][1], vecs[i][2], vecs[i][3], (uint8_t)m);
      printf("%d,%d,%u,%u,%u\\n", m, i, c.r, c.g, c.b);
    }
  }
  return 0;
}
`;

  try {
    fs.writeFileSync(cppFile, cppSrc, 'utf8');
    execFileSync('clang++', ['-std=c++17', '-O2', cppFile, '-o', binFile], { stdio: 'pipe' });
    const out = execFileSync(binFile, [], { encoding: 'utf8' }).trim().split('\n');

    const vecs = [
      [0.0, 0.0, 1.0, 0.0],
      [0.65, -0.25, 0.72, 0.12],
      [-0.80, 0.45, -0.35, 0.55],
      [0.15, 0.88, 0.10, 0.90],
      [-0.42, -0.71, -0.85, 0.05]
    ];

    assert.equal(out.length, 20);
    for (const line of out) {
      const [m, idx, cr, cg, cb] = line.split(',').map(Number);
      const [tx, ty, az, kin] = vecs[idx];
      const jsCol = ColorEngine.mapImuToColor(tx, ty, az, kin, m);
      assert.ok(Math.abs(jsCol.r - cr) <= 1, `mode ${m} vec ${idx} R: js=${jsCol.r} cpp=${cr}`);
      assert.ok(Math.abs(jsCol.g - cg) <= 1, `mode ${m} vec ${idx} G: js=${jsCol.g} cpp=${cg}`);
      assert.ok(Math.abs(jsCol.b - cb) <= 1, `mode ${m} vec ${idx} B: js=${jsCol.b} cpp=${cb}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseTelemetryLine and buildHostCommand handle live packets, hold hex override, and malformed input', () => {
  assert.equal(ColorEngine.parseTelemetryLine('not json'), null);
  assert.equal(ColorEngine.parseTelemetryLine('{"t":"other"}'), null);

  const pkt = ColorEngine.parseTelemetryLine(
    '{"t":"s3","seq":77,"ax":0.5,"ay":-0.25,"az":0.83,"tx":0.5,"ty":-0.25,"r":28.1,"p":-15.2,"kin":0.2,"m":2,"h":1,"hex":"#D94F1E","bat":88,"ev":"swatch"}'
  );
  assert.ok(pkt);
  assert.equal(pkt.seq, 77);
  assert.equal(pkt.mode, 2);
  assert.equal(pkt.hold, true);
  assert.equal(pkt.color.hex, '#D94F1E');
  assert.equal(pkt.battery, 88);
  assert.equal(pkt.event, 'swatch');

  assert.equal(ColorEngine.buildHostCommand({ cmd: 'mode', m: 3 }), '{"cmd":"mode","m":3}\n');
  assert.equal(ColorEngine.buildHostCommand({ cmd: 'hold', h: true }), '{"cmd":"hold","h":1}\n');
  assert.equal(ColorEngine.buildHostCommand({ cmd: 'tare' }), '{"cmd":"tare"}\n');
});

test('Local Bridge Server fans out StickS3 telemetry over WebSocket and HTTP status cleanly', async () => {
  const bridge = createStickBridgeServer({ port: 0, enableSerial: false });
  const { port } = await bridge.start();

  try {
    // Connect raw RFC 6455 WebSocket client
    const wsMessages = [];
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.createConnection({ host: '127.0.0.1', port });

    await new Promise((resolve, reject) => {
      let upgraded = false;
      let buf = Buffer.alloc(0);
      client.on('error', reject);
      client.on('connect', () => {
        client.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      client.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx !== -1) {
            upgraded = true;
            buf = buf.subarray(idx + 4);
            // Ingest a simulated StickS3 telemetry packet
            bridge.ingestRawSerialLine(
              '{"t":"s3","seq":12,"ax":0.42,"ay":0.31,"az":0.85,"tx":0.42,"ty":0.31,"kin":0.1,"m":0,"h":0,"hex":"#4499CC","bat":95,"ev":""}'
            );
          }
        }
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            offset = 4;
          }
          if (buf.length < offset + len) break;
          const msg = JSON.parse(buf.subarray(offset, offset + len).toString('utf8'));
          wsMessages.push(msg);
          buf = buf.subarray(offset + len);
          if (msg.t === 's3' && msg.seq === 12) {
            resolve();
          }
        }
      });
    });

    client.destroy();
    const s3Msg = wsMessages.find((m) => m.t === 's3');
    assert.ok(s3Msg);
    assert.equal(s3Msg.seq, 12);
    assert.equal(s3Msg.bat, 95);

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/stick-s3/status`);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.serialConnected, true);
    assert.equal(statusJson.lastPacket.seq, 12);
  } finally {
    await bridge.close();
  }
});

test('Transport createStickLink routes incoming lines and deduplicates source priority', () => {
  const received = [];
  const link = Transport.createStickLink({
    onTelemetry: (pkt, src) => received.push({ pkt, src })
  });
  link.handleIncomingLine(
    '{"t":"s3","seq":5,"ax":-0.5,"ay":0.2,"az":0.84,"tx":-0.5,"ty":0.2,"m":1,"h":0,"hex":"#33AA77","bat":72,"ev":""}',
    'serial'
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].pkt.seq, 5);
  assert.equal(received[0].src, 'serial');
});
