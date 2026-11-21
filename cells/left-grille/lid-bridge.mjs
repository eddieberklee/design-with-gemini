#!/usr/bin/env node
/**
 * Optional Local Hardware IOHIDManager Lid Angle Bridge (`cells/left-grille/lid-bridge.mjs`)
 *
 * Zero-npm-dependency Node HTTP + SSE server (`127.0.0.1:8793`) serving Apple's built-in
 * MacBook `LidAngleSensor` (`VendorID = 0x05AC`, `ProductID = 0x8104`,
 * `UsagePage = 0x0020`, `Usage = 0x008A`) via a tiny cached `/tmp` Swift IOKit helper.
 *
 * Endpoints:
 *   - `GET /angle`  -> JSON snapshot `{ available, angleDeg, raw, source, reason?, timestampMs }`
 *   - `GET /events` -> Server-Sent Events stream (`event: angle\ndata: <json>\n\n`)
 *   - `GET /health` -> `{ ok: true, available, clients }`
 *
 * Access policy (`isAllowedHost`, `isAllowedOrigin`): the `Host` header must name a loopback
 * host (blocks DNS rebinding), and a request that carries `Origin` must come from a loopback
 * http(s) page or `Origin: null` (the `file://` page). Any other origin gets `403` and no CORS
 * header, so a random website cannot read the hinge angle. `Origin: null` is also what a
 * sandboxed iframe on any site sends; that is the accepted cost of supporting `file://`.
 *
 * Usage:
 *   node cells/left-grille/lid-bridge.mjs
 *   LID_BRIDGE_PORT=8793 node cells/left-grille/lid-bridge.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8793;
export const MAX_SSE_CLIENTS = 8;
const MAX_SSE_BUFFERED_BYTES = 64 * 1024;
const MAX_HELPER_LINE_BYTES = 16 * 1024;
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])$/i;

/** `Host` header must name a loopback host (optionally with a port); anything else is DNS rebinding. */
export function isAllowedHost(hostHeader) {
  const m = /^(\[[^\]]+\]|[^:[\]]+)(?::\d{1,5})?$/.exec(String(hostHeader || '').trim());
  return Boolean(m && LOOPBACK_HOST_RE.test(m[1]));
}

/** `undefined` (no Origin header) is allowed; `'null'` is the file:// page; else loopback http(s) only. */
export function isAllowedOrigin(origin) {
  if (origin === undefined) return true;
  if (origin === 'null') return true;
  try {
    const u = new URL(String(origin));
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOST_RE.test(u.hostname);
  } catch (_) {
    return false;
  }
}

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
      writeOrDrop(res, payload);
    }
  }

  // A client that stops reading must not grow the server's write buffer without bound.
  function writeOrDrop(res, chunk) {
    if (res.writableLength > MAX_SSE_BUFFERED_BYTES) {
      sseClients.delete(res);
      try {
        res.destroy();
      } catch (_) {}
      return;
    }
    try {
      res.write(chunk);
    } catch (_) {
      sseClients.delete(res);
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
      if (helperStdoutBuf.length > MAX_HELPER_LINE_BYTES && helperStdoutBuf.indexOf('\n') === -1) {
        helperStdoutBuf = '';
        return;
      }
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
      writeOrDrop(res, ': keepalive\n\n');
    }
  }, 10_000);
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(origin)) {
      res.writeHead(403, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        Vary: 'Origin'
      });
      res.end(JSON.stringify({ error: 'Forbidden origin or host' }));
      return;
    }

    const corsHeaders = {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
      Vary: 'Origin'
    };
    if (origin !== undefined) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
    }

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
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503, {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8'
        });
        res.end(JSON.stringify({ error: 'Too many event-stream clients' }));
        return;
      }
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
      // Spawn the HID helper only once the port is ours, so a failed bind (port in use)
      // never leaves a helper process behind.
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          const boundPort = addr && typeof addr === 'object' ? addr.port : port;
          startHelper();
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
  const envPort = Number(process.env.LID_BRIDGE_PORT);
  const port = Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : DEFAULT_PORT;
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
