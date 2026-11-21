// Node tests for cells/stick-s3/bridge.mjs hardening: DNS-rebinding Host guard, no CORS or
// dotfiles on static responses, EPIPE-safe serial helper, bounded helper respawn.
// Every bridge here listens on an ephemeral port; none spawns python3 or opens a serial port.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createStickBridgeServer } from './bridge.mjs';

function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => {
      s.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let out = '';
    s.setTimeout(3000, () => { s.destroy(); resolve(out); });
    s.on('data', (c) => { out += c.toString('utf8'); if (/\r\n\r\n/.test(out) && !/^HTTP\/1\.1 200/.test(out)) s.end(); });
    s.on('end', () => resolve(out));
    s.on('close', () => resolve(out));
    s.on('error', reject);
  });
}

async function withBridge(opts, fn) {
  const bridge = createStickBridgeServer({ port: 0, enableSerial: false, ...opts });
  const { port } = await bridge.start();
  try {
    return await fn(port, bridge);
  } finally {
    await bridge.close();
  }
}

test('requests whose Host is not loopback are refused (DNS rebinding), HTTP and WebSocket', async () => {
  await withBridge({}, async (port) => {
    const http = await rawRequest(port, [
      'GET /api/stick-s3/status HTTP/1.1',
      `Host: rebind.attacker.example:${port}`,
      'Connection: close'
    ]);
    assert.match(http.split('\r\n')[0], /^HTTP\/1\.1 403/);

    const ws = await rawRequest(port, [
      'GET /ws HTTP/1.1',
      `Host: rebind.attacker.example:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13'
    ]);
    assert.match(ws.split('\r\n')[0], /^HTTP\/1\.1 403/);

    const ok = await fetch(`http://127.0.0.1:${port}/api/stick-s3/status`);
    assert.equal(ok.status, 200);
    const okLocalhost = await rawRequest(port, ['GET /api/stick-s3/status HTTP/1.1', `Host: localhost:${port}`, 'Connection: close']);
    assert.match(okLocalhost.split('\r\n')[0], /^HTTP\/1\.1 200/);
  });
});

test('static files are never CORS-readable cross-origin and dotfiles are not served', async () => {
  await withBridge({}, async (port) => {
    const page = await fetch(`http://127.0.0.1:${port}/index.html`, { headers: { Origin: 'null' } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('access-control-allow-origin'), null,
      'Origin null (any sandboxed iframe) must not be able to read repo files');
    await page.arrayBuffer();

    for (const p of ['/.gitignore', '/.git/HEAD', '/cells/../.gitignore', '/%2Egitignore']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.notEqual(res.status, 200, `${p} must not be served`);
      await res.arrayBuffer();
    }

    // The API keeps working for file:// pages (Origin: null).
    const api = await fetch(`http://127.0.0.1:${port}/api/stick-s3/status`, { headers: { Origin: 'null' } });
    assert.equal(api.status, 200);
    assert.equal(api.headers.get('access-control-allow-origin'), 'null');
  });
});

test('a serial helper that dies does not crash the bridge on the next command, and respawning is bounded', async () => {
  // Fake "python3": closes its stdin (so bridge writes hit EPIPE), lingers briefly, exits.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-fake-py-'));
  const fakePython = path.join(tmpDir, 'python3');
  fs.writeFileSync(fakePython, '#!/bin/sh\nexec 0<&-\nsleep 0.3\n', { mode: 0o755 });
  // Without this the bridge would fall back to the real python3 and open /dev/cu.usbmodem*.
  assert.ok(fs.existsSync(fakePython), `${fakePython} is required so no real serial helper runs`);
  const prevPython = process.env.PYTHON3;
  process.env.PYTHON3 = fakePython;
  const stderrWrite = process.stderr.write;
  const stderrLines = [];
  process.stderr.write = (chunk, ...rest) => { stderrLines.push(String(chunk)); return true; };
  try {
    await withBridge({ enableSerial: true }, async (port, bridge) => {
      // Hammer commands while the helper is starting and exiting (EPIPE on its stdin).
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        bridge.sendSerialCommand({ cmd: 'mode', m: 1 });
        await new Promise((r) => setTimeout(r, 15));
        if (stderrLines.some((l) => l.includes('stopped respawning'))) break;
      }
      const res = await fetch(`http://127.0.0.1:${port}/api/stick-s3/status`);
      assert.equal(res.status, 200, 'bridge still serving after helper deaths');
      await res.json();
      assert.ok(stderrLines.some((l) => l.includes('stopped respawning')),
        'a helper that exits immediately must stop being respawned');
    });
  } finally {
    process.stderr.write = stderrWrite;
    if (prevPython === undefined) delete process.env.PYTHON3;
    else process.env.PYTHON3 = prevPython;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
