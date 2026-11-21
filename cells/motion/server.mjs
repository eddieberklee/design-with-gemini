#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency HTTPS + WebSocket + SSE/POST Local Bridge for Cell #3 (Motion Grid).
 *
 * Serves static web assets from the repository root so desktop (`http://localhost:8443`)
 * and iPhone (`https://...`) connect cleanly under iOS Safari's mandatory Secure Context
 * for DeviceMotionEvent.
 *
 * Usage:
 *   node cells/motion/server.mjs                # Auto-detects ngrok HTTPS tunnel; falls back to self-signed LAN HTTPS
 *   node cells/motion/server.mjs --no-ngrok     # Local HTTP + self-signed LAN HTTPS only
 *   node cells/motion/server.mjs --port 8443    # Custom HTTP port (HTTPS = port + 1)
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SESSION_ID_RE = /^[A-Z0-9]{6,12}$/;
const MAX_POST_BYTES = 8192;
const MAX_WS_PAYLOAD = 8192;
const MAX_WS_RXBUF = 16384;

// Public web asset allowlist (blocks dotfiles, .git/*, .env, GEMINI.md, AGENTS.md, etc.)
const PUBLIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return '127.0.0.1';
}

function generateSelfSignedCert(lanIp) {
  const dir = path.join(os.tmpdir(), 'dwg-motion-tls');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_e) {}
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const san = `IP:${lanIp},IP:127.0.0.1,DNS:localhost`;

  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath,
        '-out', certPath,
        '-days', '7',
        '-subj', '/CN=design-with-gemini-local',
        '-addext', `subjectAltName=${san}`
      ],
      { stdio: 'ignore' }
    );
    try { fs.chmodSync(keyPath, 0o600); } catch (_e) {}
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
  } catch (_err) {
    return null;
  }
}

// ---------- Minimal RFC 6455 WebSocket Frame Codec ----------

function encodeWsFrame(payloadInput, opcode = 0x1) {
  const payload = Buffer.isBuffer(payloadInput)
    ? payloadInput
    : Buffer.from(String(payloadInput), 'utf8');
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

function parseWsFrames(buffer, maxPayload = MAX_WS_PAYLOAD) {
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
      const bigLen = buffer.readBigUInt64BE(pos);
      if (bigLen > BigInt(maxPayload)) {
        return { frames, remainder: Buffer.alloc(0), error: 'frame_too_large' };
      }
      payloadLen = Number(bigLen);
      pos += 8;
    }

    if (payloadLen > maxPayload) {
      return { frames, remainder: Buffer.alloc(0), error: 'frame_too_large' };
    }

    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + payloadLen > buffer.length) break;

    const maskKey = masked ? buffer.subarray(pos, pos + 4) : null;
    pos += maskLen;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = masked ? buffer[pos + i] ^ maskKey[i & 3] : buffer[pos + i];
    }
    frames.push({ opcode, payload });
    offset = pos + payloadLen;
  }
  return { frames, remainder: buffer.subarray(offset), error: null };
}

function safeParseRequestUrl(req) {
  const rawUrl = typeof req.url === 'string' ? req.url : '/';
  const rawHost = typeof req.headers.host === 'string' && /^[A-Za-z0-9.\-:\[\]]+$/.test(req.headers.host)
    ? req.headers.host
    : 'localhost';
  try {
    const parsed = new URL(rawUrl, `http://${rawHost}`);
    const decodedPath = decodeURIComponent(parsed.pathname);
    return { url: parsed, rawUrl, decodedPath };
  } catch (_err) {
    return null;
  }
}

// ---------- Room Relay (Desktop <-> Phone) ----------

export function createBridgeServer(options = {}) {
  const httpPort = Number(options.port ?? 8443);
  const httpsPort = Number(options.httpsPort ?? httpPort + 1);
  const rootDir = fs.realpathSync(options.rootDir || REPO_ROOT);
  const lanIp = options.lanIp || getLanIp();

  const state = {
    httpPort,
    httpsPort,
    lanIp,
    publicHttpsOrigin: '',
    lanHttpsOrigin: '',
    tunnelSource: 'none',
    tunnelPending: Boolean(options.tunnelPending)
  };

  const rooms = new Map();

  function getRoom(sid) {
    let room = rooms.get(sid);
    if (!room) {
      room = { desktop: new Set(), phone: new Set() };
      rooms.set(sid, room);
    }
    return room;
  }

  function relayMessage(sid, fromRole, rawJson) {
    const room = rooms.get(sid);
    if (!room) return;
    const targetRole = fromRole === 'phone' ? 'desktop' : 'phone';
    const targets = room[targetRole];
    for (const client of targets) {
      try {
        client.send(rawJson);
      } catch (_e) {
        targets.delete(client);
      }
    }
  }

  function resolvePhoneBaseUrl() {
    if (state.publicHttpsOrigin) {
      return state.publicHttpsOrigin + '/cells/motion/phone.html';
    }
    if (state.lanHttpsOrigin) {
      return state.lanHttpsOrigin + '/cells/motion/phone.html';
    }
    return '';
  }

  function isAllowedOrigin(origin) {
    if (!origin || origin === 'null') return true; // file:// or direct same-origin request
    if (origin === state.publicHttpsOrigin || origin === state.lanHttpsOrigin) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
    }
  }

  function handleRequest(req, res) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedReq = safeParseRequestUrl(req);
    if (!parsedReq) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    const { url: reqUrl, rawUrl, decodedPath } = parsedReq;

    if (decodedPath === '/api/motion-config') {
      const isTls = Boolean(req.socket && req.socket.encrypted);
      const reqHost = typeof req.headers.host === 'string' && /^[A-Za-z0-9.\-:\[\]]+$/.test(req.headers.host)
        ? req.headers.host
        : `127.0.0.1:${state.httpPort}`;
      const httpProto = isTls ? 'https' : 'http';
      const wsProto = isTls ? 'wss' : 'ws';
      const phoneBaseUrl = resolvePhoneBaseUrl();

      const payload = {
        ok: true,
        phoneBaseUrl,
        httpsReady: Boolean(phoneBaseUrl),
        tunnelSource: state.tunnelSource,
        tunnelPending: state.tunnelPending,
        transport: 'dual',
        desktopHttpBase: `${httpProto}://${reqHost}`,
        desktopWsUrl: `${wsProto}://${reqHost}/ws`
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (decodedPath === '/api/motion/send' && req.method === 'POST') {
      const sid = (reqUrl.searchParams.get('s') || '').trim().toUpperCase();
      const role = reqUrl.searchParams.get('role') === 'phone' ? 'phone' : 'desktop';
      if (!SESSION_ID_RE.test(sid)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid session"}');
        return;
      }
      const chunks = [];
      let totalBytes = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_POST_BYTES) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end('{"error":"payload too large"}');
          return;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          JSON.parse(body);
        } catch (_e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"invalid json"}');
          return;
        }
        relayMessage(sid, role, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }

    if (decodedPath === '/api/motion/stream' && req.method === 'GET') {
      const sid = (reqUrl.searchParams.get('s') || '').trim().toUpperCase();
      const role = reqUrl.searchParams.get('role') === 'phone' ? 'phone' : 'desktop';
      if (!SESSION_ID_RE.test(sid)) {
        res.writeHead(400);
        res.end('Invalid session');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      const room = getRoom(sid);
      const client = {
        send: (txt) => {
          res.write(`data: ${txt.replace(/\r?\n/g, '')}\n\n`);
        }
      };
      room[role].add(client);
      req.on('close', () => {
        room[role].delete(client);
        if (room.desktop.size === 0 && room.phone.size === 0) rooms.delete(sid);
      });
      return;
    }

    // Reject raw traversal attempts (`..` or `%2e%2e`) before URL normalization hides them
    const rawPathOnly = rawUrl.split('?')[0].split('#')[0];
    if (/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/i.test(rawPathOnly) || decodedPath.includes('\0')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    // Reject dotfiles and dot-directories (.git, .env, .DS_Store, etc.)
    const segments = decodedPath.split('/').filter(Boolean);
    if (segments.some((seg) => seg.startsWith('.') || seg === '..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const rel = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
    const ext = path.extname(rel).toLowerCase();
    const mime = PUBLIC_MIME_TYPES[ext];
    if (!mime) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const candidate = path.resolve(rootDir, rel);
    if (!candidate.startsWith(rootDir + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    fs.realpath(candidate, (rpErr, realPath) => {
      if (rpErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      if (!realPath.startsWith(rootDir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      fs.stat(realPath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(realPath).pipe(res);
      });
    });
  }

  function handleUpgrade(req, socket) {
    const parsedReq = safeParseRequestUrl(req);
    if (!parsedReq || parsedReq.decodedPath !== '/ws') {
      socket.destroy();
      return;
    }
    const sid = (parsedReq.url.searchParams.get('s') || '').trim().toUpperCase();
    const role = parsedReq.url.searchParams.get('role') === 'phone' ? 'phone' : 'desktop';
    const key = req.headers['sec-websocket-key'];
    if (!SESSION_ID_RE.test(sid) || !key) {
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

    const room = getRoom(sid);
    const client = {
      send: (txt) => {
        if (!socket.destroyed) socket.write(encodeWsFrame(txt, 0x1));
      }
    };
    room[role].add(client);

    let rxBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (rxBuf.length + chunk.length > MAX_WS_RXBUF) {
        socket.end(encodeWsFrame(Buffer.from([0x03, 0xf1]), 0x8)); // 1009 Message Too Big
        socket.destroy();
        return;
      }
      rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : chunk;
      const parsed = parseWsFrames(rxBuf, MAX_WS_PAYLOAD);
      if (parsed.error) {
        socket.end(encodeWsFrame(Buffer.from([0x03, 0xf1]), 0x8));
        socket.destroy();
        return;
      }
      rxBuf = Buffer.from(parsed.remainder);
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x1) {
          relayMessage(sid, role, frame.payload.toString('utf8'));
        } else if (frame.opcode === 0x8) {
          socket.end();
        } else if (frame.opcode === 0x9) {
          socket.write(encodeWsFrame(frame.payload, 0xA)); // Preserve binary ping payload verbatim
        }
      }
    });

    const cleanup = () => {
      room[role].delete(client);
      if (room.desktop.size === 0 && room.phone.size === 0) rooms.delete(sid);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  const httpServer = http.createServer(handleRequest);
  httpServer.on('upgrade', handleUpgrade);

  let httpsServer = null;
  if (options.enableHttps !== false) {
    const tls = generateSelfSignedCert(lanIp);
    if (tls) {
      httpsServer = https.createServer(tls, handleRequest);
      httpsServer.on('upgrade', handleUpgrade);
    }
  }

  return {
    state,
    httpServer,
    httpsServer,
    start: async () => {
      await new Promise((resolve) => httpServer.listen(httpPort, '0.0.0.0', resolve));
      state.httpPort = httpServer.address().port;
      if (httpsServer) {
        await new Promise((resolve) => httpsServer.listen(httpsPort, '0.0.0.0', resolve));
        state.httpsPort = httpsServer.address().port;
        state.lanHttpsOrigin = `https://${state.lanIp}:${state.httpsPort}`;
        state.tunnelSource = 'lan-self-signed';
      }
      return state;
    },
    close: async () => {
      await new Promise((r) => httpServer.close(() => r()));
      if (httpsServer) await new Promise((r) => httpsServer.close(() => r()));
    }
  };
}

async function queryNgrokUrl(targetPort) {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels');
    if (!res.ok) return '';
    const data = await res.json();
    const portSuffix = `:${targetPort}`;
    const tunnel = (data.tunnels || []).find((t) => {
      if (typeof t.public_url !== 'string' || !t.public_url.startsWith('https://')) return false;
      const addr = String(t.config && t.config.addr || '');
      return addr === String(targetPort) || addr.endsWith(portSuffix);
    });
    return tunnel ? tunnel.public_url.replace(/\/+$/, '') : '';
  } catch (_e) {
    return '';
  }
}

async function startNgrokTunnel(port) {
  const existing = await queryNgrokUrl(port);
  if (existing) return { url: existing, child: null };

  const child = spawn('ngrok', ['http', String(port), '--log=stdout'], {
    stdio: ['ignore', 'ignore', 'ignore']
  });
  child.on('error', () => {});

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const url = await queryNgrokUrl(port);
    if (url) return { url, child };
  }
  try { child.kill(); } catch (_e) {}
  return { url: '', child: null };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  const noNgrok = args.includes('--no-ngrok');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) || 8443 : 8443;

  const bridge = createBridgeServer({ port, tunnelPending: !noNgrok });
  let ngrokChild = null;

  (async () => {
    const st = await bridge.start();
    if (!noNgrok) {
      const ng = await startNgrokTunnel(st.httpPort);
      if (ng.url) {
        st.publicHttpsOrigin = ng.url;
        st.tunnelSource = 'ngrok';
        ngrokChild = ng.child;
      }
      st.tunnelPending = false;
    }

    console.log('');
    console.log('  Motion Grid Bridge running');
    console.log(`  Desktop Grid : http://localhost:${st.httpPort}`);
    if (st.publicHttpsOrigin) {
      console.log(`  iPhone HTTPS : ${st.publicHttpsOrigin}/cells/motion/phone.html  (trusted ngrok tunnel)`);
    } else if (st.lanHttpsOrigin) {
      console.log(`  iPhone HTTPS : ${st.lanHttpsOrigin}/cells/motion/phone.html  (self-signed LAN TLS)`);
    }
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  })();

  const shutdown = () => {
    if (ngrokChild) { try { ngrokChild.kill(); } catch (_e) {} }
    bridge.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
