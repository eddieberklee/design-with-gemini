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
MAX_BUF = 4096

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

def write_serial_line(write_fd, payload):
    view = memoryview(payload)
    sent = 0
    tries = 0
    while sent < len(view) and tries < 8:
        try:
            n = os.write(write_fd, view[sent:])
            if n <= 0:
                break
            sent += n
        except BlockingIOError:
            tries += 1
            time.sleep(0.004)

sys.stdout.reconfigure(line_buffering=True)
os.set_blocking(sys.stdin.fileno(), False)
rx_buf = b""
rx_discard = False
stdin_buf = b""
stdin_discard = False

def drain_stdin(write_fd):
    global stdin_buf, stdin_discard
    try:
        chunk = os.read(sys.stdin.fileno(), 1024)
        if not chunk:
            sys.exit(0)
        stdin_buf += chunk
        while b"\\n" in stdin_buf:
            line, stdin_buf = stdin_buf.split(b"\\n", 1)
            if stdin_discard:
                stdin_discard = False
                continue
            if write_fd >= 0 and line.strip():
                write_serial_line(write_fd, line.strip() + b"\\n")
        if len(stdin_buf) > MAX_BUF:
            stdin_buf = b""
            stdin_discard = True
    except BlockingIOError:
        pass

while True:
    if fd < 0:
        try:
            r_idle, _, _ = select.select([sys.stdin.fileno()], [], [], 0.0)
            if sys.stdin.fileno() in r_idle:
                drain_stdin(-1)
        except SystemExit:
            raise
        except Exception:
            pass
        p = find_port()
        if not p:
            try:
                r_wait, _, _ = select.select([sys.stdin.fileno()], [], [], 0.8)
                if sys.stdin.fileno() in r_wait:
                    drain_stdin(-1)
            except SystemExit:
                raise
            except Exception:
                time.sleep(0.8)
            continue
        try:
            fd = open_serial(p)
            current_port = p
            rx_buf = b""
            rx_discard = False
            print('{"t":"bridge_port","connected":true,"port":"' + p + '"}', flush=True)
        except Exception:
            fd = -1
            try:
                r_wait, _, _ = select.select([sys.stdin.fileno()], [], [], 0.8)
                if sys.stdin.fileno() in r_wait:
                    drain_stdin(-1)
            except SystemExit:
                raise
            except Exception:
                time.sleep(0.8)
            continue

    try:
        rlist, _, _ = select.select([fd, sys.stdin.fileno()], [], [], 0.25)
    except Exception:
        rlist = []

    if sys.stdin.fileno() in rlist:
        try:
            drain_stdin(fd)
        except SystemExit:
            raise
        except Exception:
            try:
                os.close(fd)
            except Exception:
                pass
            fd = -1
            print('{"t":"bridge_port","connected":false,"port":"' + current_port + '"}', flush=True)
            current_port = ""
            rx_buf = b""
            rx_discard = False
            continue

    if fd >= 0 and fd in rlist:
        try:
            data = os.read(fd, 2048)
            if not data:
                raise OSError("EOF")
            rx_buf += data
            while b"\\n" in rx_buf:
                raw_line, rx_buf = rx_buf.split(b"\\n", 1)
                if rx_discard:
                    rx_discard = False
                    continue
                txt = raw_line.decode("utf-8", errors="ignore").strip()
                if txt.startswith("{") and txt.endswith("}"):
                    print(txt, flush=True)
            if len(rx_buf) > MAX_BUF:
                rx_buf = b""
                rx_discard = True
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
            rx_discard = False
            time.sleep(0.5)
`;

const ALLOWED_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function isAllowedOrigin(originHeader) {
  if (originHeader === undefined || originHeader === '') return true;
  if (originHeader === 'null') return true;
  return ALLOWED_ORIGIN_RE.test(String(originHeader));
}

function encodeWsRawFrame(payloadBuf, opcode = 0x1) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(String(payloadBuf), 'utf8');
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

function encodeWsFrame(payloadText, opcode = 0x1) {
  return encodeWsRawFrame(Buffer.from(payloadText, 'utf8'), opcode);
}

function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let pos = offset + 2;

    if (opcode >= 0x8 && (!fin || payloadLen > 125)) {
      return { frames, remainder: Buffer.alloc(0), protocolError: true };
    }

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
    frames.push({ fin, opcode, payload });
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
  let workerRestartTimer = null;
  let serialReleased = false;
  let serialConnected = false;
  let activeSerialPort = '';
  let lastPacket = null;
  let lastPacketAtMs = 0;
  let stdoutRemainder = '';
  let closed = false;

  function broadcastJson(obj) {
    const line = JSON.stringify(obj);
    const wsFrame = encodeWsFrame(line, 0x1);
    for (const sock of wsClients) {
      if (!sock.destroyed && sock.writableLength < 65536) {
        try { sock.write(wsFrame); } catch (_e) {}
      }
    }
    const sseChunk = `data: ${line}\n\n`;
    for (const res of sseClients) {
      if (!res.writableEnded && !res.destroyed && res.writableLength < 65536) {
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

  function ingestTelemetryLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return false;
    const parsed = ColorEngine.parseTelemetryLine(trimmed);
    if (!parsed) return false;
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
    return true;
  }

  function ingestRawSerialLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    try {
      const meta = JSON.parse(trimmed);
      if (meta && meta.t === 'bridge_port') {
        serialConnected = Boolean(meta.connected);
        activeSerialPort = typeof meta.port === 'string' ? meta.port : '';
        broadcastStatus();
        return;
      }
    } catch (_e) {}

    ingestTelemetryLine(trimmed);
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
    if (!enableSerial || serialReleased || closed || pyProc) return;
    if (workerRestartTimer) {
      clearTimeout(workerRestartTimer);
      workerRestartTimer = null;
    }
    stdoutRemainder = '';
    const pythonBin = process.env.PYTHON3 || '/opt/homebrew/bin/python3';
    const fallbackBin = fs.existsSync(pythonBin) ? pythonBin : 'python3';

    const proc = spawn(fallbackBin, ['-u', '-c', PY_SERIAL_HELPER, serialTarget], {
      stdio: ['pipe', 'pipe', 'ignore']
    });
    pyProc = proc;

    proc.stdout.on('data', (chunk) => {
      if (pyProc !== proc) return;
      stdoutRemainder += chunk.toString('utf8');
      if (stdoutRemainder.length > 65536) {
        stdoutRemainder = '';
      }
      let nl = stdoutRemainder.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutRemainder.slice(0, nl);
        stdoutRemainder = stdoutRemainder.slice(nl + 1);
        ingestRawSerialLine(line);
        nl = stdoutRemainder.indexOf('\n');
      }
    });

    proc.on('error', () => {
      if (pyProc !== proc) return;
      pyProc = null;
      stdoutRemainder = '';
      serialConnected = false;
      activeSerialPort = '';
      broadcastStatus();
    });

    proc.on('exit', () => {
      if (pyProc !== proc) return;
      pyProc = null;
      stdoutRemainder = '';
      serialConnected = false;
      activeSerialPort = '';
      broadcastStatus();
      if (!serialReleased && !closed) {
        workerRestartTimer = setTimeout(() => {
          workerRestartTimer = null;
          startSerialWorker();
        }, 1200);
        workerRestartTimer.unref();
      }
    });
  }

  async function stopSerialWorker() {
    if (workerRestartTimer) {
      clearTimeout(workerRestartTimer);
      workerRestartTimer = null;
    }
    stdoutRemainder = '';
    const proc = pyProc;
    pyProc = null;
    serialConnected = false;
    activeSerialPort = '';
    broadcastStatus();

    if (!proc) return;
    if (proc.exitCode !== null || proc.signalCode !== null) return;

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      proc.once('exit', done);
      proc.once('error', done);
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_e) {}
        setTimeout(done, 50).unref();
      }, 400);
      killTimer.unref();
      try {
        proc.kill('SIGTERM');
      } catch (_e) {
        done();
      }
    });
  }

  function setCors(req, res) {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    } else if (!origin) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }

  function readJsonBody(req, maxBytes = 16384) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let tooLarge = false;

      req.on('data', (chunk) => {
        if (tooLarge) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        total += buf.length;
        if (total > maxBytes) {
          tooLarge = true;
          const err = new Error('Payload Too Large');
          err.statusCode = 413;
          reject(err);
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => {
        if (tooLarge) return;
        if (total === 0) {
          resolve({});
          return;
        }
        try {
          const raw = Buffer.concat(chunks, total).toString('utf8');
          const parsed = JSON.parse(raw);
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch (_e) {
          const err = new Error('Invalid JSON');
          err.statusCode = 400;
          reject(err);
        }
      });
      req.on('error', (err) => {
        if (!tooLarge) reject(err);
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedOrigin(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      setCors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      let urlObj;
      try {
        urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      } catch (_urlErr) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
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
            gx: lastPacket.gx,
            gy: lastPacket.gy,
            gz: lastPacket.gz,
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
        // External HTTP callers may only ingest validated telemetry packets, never bridge_port metadata
        const body = await readJsonBody(req);
        const accepted = ingestTelemetryLine(JSON.stringify(body));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, accepted }));
        return;
      }

      if (pathname === '/api/stick-s3/release' && req.method === 'POST') {
        serialReleased = true;
        await stopSerialWorker();
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
      let decodedRel;
      try {
        decodedRel = decodeURIComponent(rel);
      } catch (_uriErr) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      if (decodedRel.indexOf('\0') !== -1) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

      const resolved = path.resolve(REPO_ROOT, '.' + decodedRel);
      if (!resolved.startsWith(REPO_ROOT + path.sep) && resolved !== path.join(REPO_ROOT, 'index.html')) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
          const ext = path.extname(resolved).toLowerCase();
          const stream = fs.createReadStream(resolved);
          stream.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Internal Server Error');
            } else {
              res.destroy();
            }
          });
          res.on('close', () => stream.destroy());
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          stream.pipe(res);
          return;
        }
      } catch (_e) {}

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      const code = err && typeof err.statusCode === 'number' ? err.statusCode : 500;
      if (code === 413) {
        req.resume();
      }
      if (!res.headersSent) {
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          ...(code === 413 ? { Connection: 'close' } : {})
        });
        res.end(JSON.stringify({
          ok: false,
          error: code === 413 ? 'Payload Too Large' : (code === 400 ? 'Bad Request' : 'Internal Server Error')
        }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    if (!isAllowedOrigin(req.headers.origin)) {
      try {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      } catch (_e) {}
      socket.destroy();
      return;
    }

    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (_urlErr) {
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      } catch (_e) {}
      socket.destroy();
      return;
    }

    if (urlObj.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || typeof key !== 'string') {
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
    let fragOpcode = 0;
    let fragChunks = [];
    let fragLen = 0;

    function processDataMessage(opcode, payloadBuf) {
      if (opcode === 0x1) {
        try {
          const cmd = JSON.parse(payloadBuf.toString('utf8'));
          sendSerialCommand(cmd);
        } catch (_e) {}
      }
    }

    function onSocketChunk(chunk) {
      if (!chunk || chunk.length === 0 || socket.destroyed) return;
      rxBuf = rxBuf.length > 0 ? Buffer.concat([rxBuf, chunk]) : Buffer.from(chunk);
      if (rxBuf.length > 1048576) {
        socket.destroy();
        return;
      }
      const parsed = parseWsFrames(rxBuf);
      if (parsed.protocolError) {
        socket.destroy();
        return;
      }
      rxBuf = parsed.remainder;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeWsRawFrame(Buffer.alloc(0), 0x8));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeWsRawFrame(frame.payload, 0xA));
          continue;
        }
        if (frame.opcode === 0xA) {
          continue;
        }
        if (frame.opcode === 0x0) {
          if (!fragOpcode) {
            socket.destroy();
            return;
          }
          fragLen += frame.payload.length;
          if (fragLen > 65536) {
            socket.destroy();
            return;
          }
          fragChunks.push(frame.payload);
          if (frame.fin) {
            const fullPayload = Buffer.concat(fragChunks, fragLen);
            const doneOp = fragOpcode;
            fragOpcode = 0;
            fragChunks = [];
            fragLen = 0;
            processDataMessage(doneOp, fullPayload);
          }
          continue;
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          if (fragOpcode) {
            socket.destroy();
            return;
          }
          if (frame.fin) {
            processDataMessage(frame.opcode, frame.payload);
          } else {
            fragOpcode = frame.opcode;
            fragChunks = [frame.payload];
            fragLen = frame.payload.length;
          }
        }
      }
    }

    socket.on('data', onSocketChunk);

    const cleanup = () => wsClients.delete(socket);
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    if (head && head.length > 0) {
      onSocketChunk(head);
    }
  });

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
    await stopSerialWorker();
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
