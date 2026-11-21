#!/usr/bin/env node
/**
 * Optional Local Hardware IOHIDManager Lid Angle Bridge (`cells/left-grille/lid-bridge.mjs`)
 *
 * Zero-npm-dependency Node HTTP + SSE server (`127.0.0.1:8791`) serving Apple's built-in
 * MacBook `LidAngleSensor` (`VendorID = 0x05AC`, `ProductID = 0x8104`,
 * `UsagePage = 0x0020`, `Usage = 0x008A`) via a tiny cached `/tmp` Swift IOKit helper.
 *
 * Endpoints (all with `Access-Control-Allow-Origin: *`):
 *   - `GET /angle`  -> JSON snapshot `{ available, angleDeg, raw, source, reason?, timestampMs }`
 *   - `GET /events` -> Server-Sent Events stream (`event: angle\ndata: <json>\n\n`)
 *   - `GET /health` -> `{ ok: true, available, clients }`
 *
 * Usage:
 *   node cells/left-grille/lid-bridge.mjs
 *   LID_BRIDGE_PORT=8791 node cells/left-grille/lid-bridge.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8791;

const SWIFT_LID_HELPER_SRC = `import Foundation
import IOKit
import IOKit.hid

setbuf(stdout, nil)

func emit(_ json: String) {
  print(json)
  fflush(stdout)
}

func emitUnavailable(_ reason: String) {
  let safe = reason
    .replacingOccurrences(of: "\\\\", with: "\\\\\\\\")
    .replacingOccurrences(of: "\\"", with: "\\\\\\"")
  emit("{\\"available\\":false,\\"angleDeg\\":null,\\"source\\":\\"iohid\\",\\"reason\\":\\"\\(safe)\\"}")
}

let onceMode = CommandLine.arguments.contains("--once")
let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))

let matching: [String: Any] = [
  kIOHIDVendorIDKey as String: 0x05AC,
  kIOHIDProductIDKey as String: 0x8104,
  kIOHIDPrimaryUsagePageKey as String: 0x0020,
  kIOHIDPrimaryUsageKey as String: 0x008A
]
IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)

let mgrOpen = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
if mgrOpen != kIOReturnSuccess {
  emitUnavailable("IOHIDManagerOpen failed (status \\(mgrOpen))")
  exit(0)
}

guard let deviceSet = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice>, !deviceSet.isEmpty else {
  IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
  emitUnavailable("Apple LidAngleSensor (0x05AC:0x8104) not present on this Mac")
  exit(0)
}

var activeDevice: IOHIDDevice? = nil
var lastErr: IOReturn = kIOReturnError

func readLidAngle(_ dev: IOHIDDevice) -> (Int, Double)? {
  var report = [UInt8](repeating: 0, count: 8)
  var length: CFIndex = report.count
  let kr = IOHIDDeviceGetReport(dev, kIOHIDReportTypeFeature, CFIndex(1), &report, &length)
  if kr != kIOReturnSuccess || length < 3 {
    lastErr = kr
    return nil
  }
  let raw = Int(report[1]) | (Int(report[2]) << 8)
  let deg: Double = raw <= 360 ? Double(raw) : Double(raw) / 100.0
  guard deg >= 0.0 && deg <= 360.0 else { return nil }
  return (raw, deg)
}

for dev in deviceSet {
  let kr = IOHIDDeviceOpen(dev, IOOptionBits(kIOHIDOptionsTypeNone))
  if kr == kIOReturnSuccess {
    if readLidAngle(dev) != nil {
      activeDevice = dev
      break
    }
    IOHIDDeviceClose(dev, IOOptionBits(kIOHIDOptionsTypeNone))
  } else {
    lastErr = kr
  }
}

guard let sensor = activeDevice else {
  IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
  emitUnavailable("LidAngleSensor HID report restricted or unreadable (status \\(lastErr))")
  exit(0)
}

while true {
  if let (raw, deg) = readLidAngle(sensor) {
    let rounded = (deg * 10.0).rounded() / 10.0
    emit("{\\"available\\":true,\\"angleDeg\\":\\(rounded),\\"raw\\":\\(raw),\\"source\\":\\"iohid\\"}")
  } else {
    emitUnavailable("LidAngleSensor read interrupted (status \\(lastErr))")
    break
  }
  if onceMode { break }
  usleep(33_333)
}

IOHIDDeviceClose(sensor, IOOptionBits(kIOHIDOptionsTypeNone))
IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
`;

export function parseHelperLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== 'object') return null;
    if (obj.available && Number.isFinite(obj.angleDeg)) {
      return {
        available: true,
        angleDeg: Math.round(obj.angleDeg * 10) / 10,
        raw: Number.isFinite(obj.raw) ? obj.raw : Math.round(obj.angleDeg),
        source: 'iohid',
        device: 'Apple LidAngleSensor (0x05AC:0x8104)',
        timestampMs: Date.now()
      };
    }
    return {
      available: false,
      angleDeg: null,
      source: 'iohid',
      reason: typeof obj.reason === 'string' ? obj.reason : 'LidAngleSensor unavailable',
      timestampMs: Date.now()
    };
  } catch (_) {
    return null;
  }
}

export function ensureSwiftHelperBinary() {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: `macOS IOKit required (detected ${process.platform})` };
  }

  const hash = crypto.createHash('sha256').update(SWIFT_LID_HELPER_SRC).digest('hex').slice(0, 12);
  const tmpDir = os.tmpdir();
  const srcPath = path.join(tmpDir, `dwg-lid-angle-hid-${hash}.swift`);
  const binPath = path.join(tmpDir, `dwg-lid-angle-hid-${hash}`);

  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return { ok: true, binPath };
  } catch (_) {
    // Compile once into /tmp cache
  }

  try {
    fs.writeFileSync(srcPath, SWIFT_LID_HELPER_SRC, { encoding: 'utf8', mode: 0o600 });
    execFileSync(
      'swiftc',
      ['-O', '-framework', 'IOKit', '-framework', 'Foundation', srcPath, '-o', binPath],
      { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { ok: true, binPath };
  } catch (err) {
    const msg =
      err && err.code === 'ENOENT'
        ? 'swiftc not found (install Xcode Command Line Tools)'
        : (err && err.message) || 'Failed to compile Swift IOKit helper';
    return { ok: false, reason: msg };
  }
}

export function createBridgeServer(opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const port = Number.isFinite(opts.port) ? opts.port : DEFAULT_PORT;

  let latestSnapshot = {
    available: false,
    angleDeg: null,
    source: 'iohid',
    reason: 'Initializing IOHIDManager bridge…',
    timestampMs: Date.now()
  };

  const sseClients = new Set();
  let helperProc = null;
  let helperStdoutBuf = '';
  let lastBroadcastMs = 0;

  function broadcast(snapshot, force = false) {
    const changed =
      snapshot.available !== latestSnapshot.available ||
      snapshot.angleDeg !== latestSnapshot.angleDeg ||
      snapshot.reason !== latestSnapshot.reason;
    latestSnapshot = snapshot;
    const now = Date.now();
    if (!force && !changed && now - lastBroadcastMs < 500) {
      return;
    }
    lastBroadcastMs = now;
    const payload = `event: angle\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch (_) {
        sseClients.delete(res);
      }
    }
  }

  function startHelper() {
    if (opts.disableHardware) {
      broadcast({
        available: false,
        angleDeg: null,
        source: 'iohid',
        reason: 'Hardware probe disabled',
        timestampMs: Date.now()
      });
      return;
    }

    const compiled = ensureSwiftHelperBinary();
    if (!compiled.ok) {
      broadcast({
        available: false,
        angleDeg: null,
        source: 'iohid',
        reason: compiled.reason,
        timestampMs: Date.now()
      });
      return;
    }

    helperProc = spawn(compiled.binPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (helperProc.stderr) helperProc.stderr.resume();
    helperProc.stdout.setEncoding('utf8');
    helperProc.stdout.on('data', (chunk) => {
      helperStdoutBuf += chunk;
      let nl = helperStdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = helperStdoutBuf.slice(0, nl);
        helperStdoutBuf = helperStdoutBuf.slice(nl + 1);
        const parsed = parseHelperLine(line);
        if (parsed) broadcast(parsed);
        nl = helperStdoutBuf.indexOf('\n');
      }
    });

    helperProc.on('exit', (code) => {
      helperProc = null;
      if (latestSnapshot.available) {
        broadcast({
          available: false,
          angleDeg: null,
          source: 'iohid',
          reason: `HID reader exited (${code ?? 'signal'})`,
          timestampMs: Date.now()
        });
      }
    });

    helperProc.on('error', (err) => {
      helperProc = null;
      broadcast({
        available: false,
        angleDeg: null,
        source: 'iohid',
        reason: (err && err.message) || 'Failed to spawn Swift HID helper',
        timestampMs: Date.now()
      });
    });
  }

  const keepaliveTimer = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(': keepalive\n\n');
      } catch (_) {
        sseClients.delete(res);
      }
    }
  }, 10_000);
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();

  const server = http.createServer((req, res) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    let url;
    try {
      const addr = server.address();
      const activePort = addr && typeof addr === 'object' ? addr.port : port;
      url = new URL(req.url || '/', `http://${host}:${activePort}`);
    } catch (_) {
      res.writeHead(400, {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(JSON.stringify({ error: 'Malformed request URL' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/angle') {
      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(JSON.stringify(latestSnapshot));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(
        JSON.stringify({
          ok: true,
          available: Boolean(latestSnapshot.available),
          clients: sseClients.size
        })
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive'
      });
      res.write(`event: angle\ndata: ${JSON.stringify(latestSnapshot)}\n\n`);
      sseClients.add(res);
      const cleanup = () => sseClients.delete(res);
      req.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    res.writeHead(404, {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify({ error: 'Not found', endpoints: ['/angle', '/events', '/health'] }));
  });

  function closeAll() {
    clearInterval(keepaliveTimer);
    for (const res of sseClients) {
      try {
        res.end();
      } catch (_) {}
    }
    sseClients.clear();
    if (helperProc) {
      try {
        helperProc.kill('SIGTERM');
      } catch (_) {}
      helperProc = null;
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return {
    server,
    start() {
      startHelper();
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          const boundPort = addr && typeof addr === 'object' ? addr.port : port;
          resolve({ host, port: boundPort });
        });
      });
    },
    getSnapshot: () => latestSnapshot,
    close: closeAll
  };
}

// CLI entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.LID_BRIDGE_PORT || DEFAULT_PORT);
  const bridge = createBridgeServer({ host: DEFAULT_HOST, port });
  bridge
    .start()
    .then(({ host, port: boundPort }) => {
      process.stdout.write(
        `[lid-bridge] listening on http://${host}:${boundPort} (/angle, /events, /health)\n`
      );
    })
    .catch((err) => {
      process.stderr.write(`[lid-bridge] failed to bind ${DEFAULT_HOST}:${port}: ${err.message}\n`);
      process.exit(1);
    });

  const shutdown = () => {
    bridge.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
