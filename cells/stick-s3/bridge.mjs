#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency Local USB Serial <-> WebSocket + SSE + HTTP Bridge for Cell 05 (M5StickS3).
 *
 * Automatically opens `/dev/cu.usbmodem*` (ESP32-S3 USB-Serial/JTAG at 115200 8N1) using a
 * tiny Python 3 stdlib `termios` helper (no npm `serialport` addon required) and fans out
 * 50 Hz accelerometer telemetry to any browser viewing `index.html` over `file://` or `http://localhost`.
 *
 * Usage:
 *   node cells/stick-s3/bridge.mjs
 *   node cells/stick-s3/bridge.mjs --port 8791 --serial /dev/cu.usbmodem1101
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ColorEngine = require('./color-engine.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

// Python 3 stdlib termios bridge: opens macOS/Linux USB CDC port cleanly without toggling RTS/DTR reset
const PY_SERIAL_HELPER = `
import os, sys, glob, time, select, termios

preferred = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "auto" else ""
fd = -1
current_port = ""

def find_port():
    if preferred and os.path.exists(preferred):
        return preferred
    cands = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*"))
    return cands[0] if cands else ""

def open_serial(port_path):
    f = os.open(port_path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(f)
    attrs[0] = 0
    attrs[1] = 0
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    attrs[3] = 0
    attrs[4] = termios.B115200
    attrs[5] = termios.B115200
    termios.tcsetattr(f, termios.TCSANOW, attrs)
    return f

sys.stdout.reconfigure(line_buffering=True)
os.set_blocking(sys.stdin.fileno(), False)
rx_buf = b""
stdin_buf = b""

while True:
    if fd < 0:
        p = find_port()
        if not p:
            time.sleep(0.8)
            continue
        try:
            fd = open_serial(p)
            current_port = p
            print('{"t":"bridge_port","connected":true,"port":"' + p + '"}', flush=True)
        except Exception as e:
            fd = -1
            time.sleep(0.8)
            continue

    try:
        rlist, _, _ = select.select([fd, sys.stdin.fileno()], [], [], 0.25)
    except Exception:
        rlist = []

    if sys.stdin.fileno() in rlist:
        try:
            chunk = os.read(sys.stdin.fileno(), 1024)
            if not chunk:
                break
            stdin_buf += chunk
            while b"\\n" in stdin_buf:
                line, stdin_buf = stdin_buf.split(b"\\n", 1)
                if fd >= 0 and line.strip():
                    os.write(fd, line.strip() + b"\\n")
        except BlockingIOError:
            pass
        except Exception:
            pass

    if fd in rlist:
        try:
            data = os.read(fd, 2048)
            if not data:
                raise OSError("EOF")
            rx_buf += data
            while b"\\n" in rx_buf:
                raw_line, rx_buf = rx_buf.split(b"\\n", 1)
                txt = raw_line.decode("utf-8", errors="ignore").strip()
                if txt.startswith("{") and txt.endswith("}"):
                    print(txt, flush=True)
        except BlockingIOError:
            pass
        except Exception:
            try:
                os.close(fd)
            except Exception:
                pass
            fd = -1
            print('{"t":"bridge_port","connected":false,"port":"' + current_port + '"}', flush=True)
            current_port = ""
            rx_buf = b""
            time.sleep(0.5)
`;

function encodeWsFrame(payloadText, opcode = 0x1) {
  const payload = Buffer.from(payloadText, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let pos = offset + 2;

    if (payloadLen === 126) {
      if (pos + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (payloadLen === 127) {
      if (pos + 8 > buffer.length) break;
      const big = buffer.readBigUInt64BE(pos);
      if (big > 1048576n) {
        return { frames, remainder: Buffer.alloc(0), protocolError: true };
      }
      payloadLen = Number(big);
      pos += 8;
    }

    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + payloadLen > buffer.length) break;

    const payload = Buffer.alloc(payloadLen);
    if (masked) {
      const mask = buffer.subarray(pos, pos + 4);
      pos += 4;
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[pos + i] ^ mask[i & 3];
      }
    } else {
      buffer.copy(payload, 0, pos, pos + payloadLen);
    }

    offset = pos + payloadLen;
    frames.push({ opcode, payload });
  }
  return { frames, remainder: buffer.subarray(offset), protocolError: false };
}

export function createStickBridgeServer(options = {}) {
  const port = options.port !== undefined ? Number(options.port) : 8791;
  const host = options.host || '127.0.0.1';
  const serialTarget = options.serialPort || 'auto';
  const enableSerial = options.enableSerial !== false;

  const wsClients = new Set();
  const sseClients = new Set();

  let pyProc = null;
  let serialReleased = false;
  let serialConnected = false;
  let activeSerialPort = '';
  let lastPacket = null;
  let lastPacketAtMs = 0;
  let stdoutRemainder = '';

  function broadcastJson(obj) {
    const line = JSON.stringify(obj);
    const wsFrame = encodeWsFrame(line, 0x1);
    for (const sock of wsClients) {
      if (!sock.destroyed) {
        try { sock.write(wsFrame); } catch (_e) {}
      }
    }
    const sseChunk = `data: ${line}\n\n`;
    for (const res of sseClients) {
      if (!res.writableEnded) {
        try { res.write(sseChunk); } catch (_e) {}
      }
    }
  }

  function broadcastStatus() {
    broadcastJson({
      t: 'bridge_status',
      serialConnected,
      serialReleased,
      port: activeSerialPort,
      lastPacketAtMs
    });
  }

  function ingestRawSerialLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    try {
      const meta = JSON.parse(trimmed);
      if (meta && meta.t === 'bridge_port') {
        serialConnected = Boolean(meta.connected);
        activeSerialPort = meta.port || '';
        broadcastStatus();
        return;
      }
    } catch (_e) {}

    const parsed = ColorEngine.parseTelemetryLine(trimmed);
    if (!parsed) return;
    serialConnected = true;
    lastPacket = parsed;
    lastPacketAtMs = Date.now();
    broadcastJson({
      t: 's3',
      seq: parsed.seq,
      ax: parsed.ax,
      ay: parsed.ay,
      az: parsed.az,
      tx: parsed.tx,
      ty: parsed.ty,
      gx: parsed.gx,
      gy: parsed.gy,
      gz: parsed.gz,
      r: parsed.roll,
      p: parsed.pitch,
      kin: parsed.kin,
      m: parsed.mode,
      h: parsed.hold ? 1 : 0,
      hex: parsed.color.hex,
      bat: parsed.battery,
      ev: parsed.event
    });
  }

  function sendSerialCommand(cmdObj) {
    const formatted = ColorEngine.buildHostCommand(cmdObj);
    if (!formatted) return false;
    if (pyProc && pyProc.stdin && !pyProc.stdin.destroyed) {
      try {
        pyProc.stdin.write(formatted);
        return true;
      } catch (_e) {
        return false;
      }
    }
    return false;
  }

  function startSerialWorker() {
    if (!enableSerial || serialReleased || pyProc) return;
    const pythonBin = process.env.PYTHON3 || '/opt/homebrew/bin/python3';
    const fallbackBin = fs.existsSync(pythonBin) ? pythonBin : 'python3';

    pyProc = spawn(fallbackBin, ['-u', '-c', PY_SERIAL_HELPER, serialTarget], {
      stdio: ['pipe', 'pipe', 'ignore']
    });

    pyProc.stdout.on('data', (chunk) => {
      stdoutRemainder += chunk.toString('utf8');
      let nl = stdoutRemainder.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutRemainder.slice(0, nl);
        stdoutRemainder = stdoutRemainder.slice(nl + 1);
        ingestRawSerialLine(line);
        nl = stdoutRemainder.indexOf('\n');
      }
    });

    pyProc.on('exit', () => {
      pyProc = null;
      serialConnected = false;
      activeSerialPort = '';
      broadcastStatus();
      if (!serialReleased && !closed) {
        setTimeout(startSerialWorker, 1200).unref();
      }
    });
  }

  function stopSerialWorker() {
    if (pyProc) {
      const p = pyProc;
      pyProc = null;
      try { p.kill('SIGTERM'); } catch (_e) {}
    }
    serialConnected = false;
    activeSerialPort = '';
    broadcastStatus();
  }

  function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  function readJsonBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => {
        if (body.length < 16384) body += c.toString('utf8');
      });
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch (_e) { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
  }

  const server = http.createServer(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (pathname === '/api/stick-s3/status' && req.method === 'GET') {
      const fresh = lastPacketAtMs > 0 && Date.now() - lastPacketAtMs < 3500;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        serialConnected: serialConnected && fresh,
        portOpen: serialConnected,
        serialReleased,
        port: activeSerialPort,
        clients: wsClients.size + sseClients.size,
        lastPacketAtMs,
        lastPacket
      }));
      return;
    }

    if (pathname === '/api/stick-s3/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({
        t: 'bridge_status',
        serialConnected,
        serialReleased,
        port: activeSerialPort,
        lastPacketAtMs
      })}\n\n`);
      if (lastPacket && Date.now() - lastPacketAtMs < 3500) {
        res.write(`data: ${JSON.stringify({
          t: 's3',
          seq: lastPacket.seq,
          ax: lastPacket.ax,
          ay: lastPacket.ay,
          az: lastPacket.az,
          tx: lastPacket.tx,
          ty: lastPacket.ty,
          r: lastPacket.roll,
          p: lastPacket.pitch,
          kin: lastPacket.kin,
          m: lastPacket.mode,
          h: lastPacket.hold ? 1 : 0,
          hex: lastPacket.color.hex,
          bat: lastPacket.battery,
          ev: ''
        })}\n\n`);
      }
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname === '/api/stick-s3/cmd' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const sent = sendSerialCommand(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, sent }));
      return;
    }

    if (pathname === '/api/stick-s3/ingest' && req.method === 'POST') {
      // Used by automated integration tests or external relays
      const body = await readJsonBody(req);
      ingestRawSerialLine(JSON.stringify(body));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/api/stick-s3/release' && req.method === 'POST') {
      serialReleased = true;
      stopSerialWorker();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, released: true }));
      return;
    }

    if (pathname === '/api/stick-s3/claim' && req.method === 'POST') {
      serialReleased = false;
      startSerialWorker();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, released: false }));
      return;
    }

    // Serve repository static files cleanly when opened via http://127.0.0.1:8791/
    const rel = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.resolve(REPO_ROOT, '.' + decodeURIComponent(rel));
    if (!resolved.startsWith(REPO_ROOT + path.sep) && resolved !== path.join(REPO_ROOT, 'index.html')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        fs.createReadStream(resolved).pipe(res);
        return;
      }
    } catch (_e) {}

    res.writeHead(404);
    res.end('Not found');
  });

  server.on('upgrade', (req, socket) => {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    if (urlObj.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    wsClients.add(socket);
    socket.write(encodeWsFrame(JSON.stringify({
      t: 'bridge_status',
      serialConnected,
      serialReleased,
      port: activeSerialPort,
      lastPacketAtMs
    })));

    let rxBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      const parsed = parseWsFrames(rxBuf);
      if (parsed.protocolError) {
        socket.destroy();
        return;
      }
      rxBuf = parsed.remainder;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeWsFrame('', 0x8));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeWsFrame(frame.payload.toString('utf8'), 0xA));
          continue;
        }
        if (frame.opcode === 0x1) {
          try {
            const cmd = JSON.parse(frame.payload.toString('utf8'));
            sendSerialCommand(cmd);
          } catch (_e) {}
        }
      }
    });

    const cleanup = () => wsClients.delete(socket);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  let closed = false;

  async function start() {
    startSerialWorker();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const addr = server.address();
    return {
      port: typeof addr === 'object' && addr ? addr.port : port,
      host
    };
  }

  async function close() {
    closed = true;
    stopSerialWorker();
    for (const s of wsClients) {
      try { s.destroy(); } catch (_e) {}
    }
    wsClients.clear();
    for (const r of sseClients) {
      try { r.end(); } catch (_e) {}
    }
    sseClients.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    server,
    start,
    close,
    ingestRawSerialLine,
    sendSerialCommand
  };
}

// Run as CLI daemon if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  let cliPort = 8791;
  let cliSerial = 'auto';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--port' && process.argv[i + 1]) {
      cliPort = Number(process.argv[++i]) || 8791;
    } else if (process.argv[i] === '--serial' && process.argv[i + 1]) {
      cliSerial = process.argv[++i];
    }
  }

  const bridge = createStickBridgeServer({ port: cliPort, serialPort: cliSerial });
  bridge.start().then(({ host, port }) => {
    process.stdout.write(
      `[stick-s3-bridge] listening on http://${host}:${port} (WS ws://${host}:${port}/ws, SSE /api/stick-s3/stream)\n`
    );
  }).catch((err) => {
    process.stderr.write(`[stick-s3-bridge] failed to start: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });

  const shutdown = () => {
    bridge.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
