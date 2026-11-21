#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency HTTPS + WebSocket + SSE/POST Local Bridge for Cell #2 (Motion Grid).
 *
 * Serves the repository root so desktop (`http://localhost:8443`) and iPhone (`https://...`)
 * connect cleanly with iOS Safari's mandatory Secure Context for DeviceMotionEvent.
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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
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
  fs.mkdirSync(dir, { recursive: true });
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
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
  } catch (_err) {
    return null;
  }
}

// ---------- Minimal RFC 6455 WebSocket Frame Codec ----------

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
      payloadLen = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
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
  return { frames, remainder: buffer.subarray(offset) };
}

// ---------- Room Relay (Desktop <-> Phone) ----------

export function createBridgeServer(options = {}) {
  const httpPort = Number(options.port ?? 8443);
  const httpsPort = Number(options.httpsPort ?? httpPort + 1);
  const rootDir = options.rootDir || REPO_ROOT;
  const lanIp = options.lanIp || getLanIp();

  const state = {
    httpPort,
    httpsPort,
    lanIp,
    publicHttpsOrigin: '',
    lanHttpsOrigin: '',
    tunnelSource: 'none'
  };

  // Map<sessionId, { desktop: Set<client>, phone: Set<client> }>
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
    return `http://${state.lanIp}:${state.httpPort}/cells/motion/phone.html`;
  }

  function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  }

  function handleRequest(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname === '/api/motion-config') {
      const payload = {
        ok: true,
        phoneBaseUrl: resolvePhoneBaseUrl(),
        httpsReady: Boolean(state.publicHttpsOrigin || state.lanHttpsOrigin),
        tunnelSource: state.tunnelSource,
        transport: 'dual',
        desktopHttpBase: `http://127.0.0.1:${state.httpPort}`,
        desktopWsUrl: `ws://127.0.0.1:${state.httpPort}/ws`
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (pathname === '/api/motion/send' && req.method === 'POST') {
      const sid = (reqUrl.searchParams.get('s') || '').trim().toUpperCase();
      const role = reqUrl.searchParams.get('role') === 'phone' ? 'phone' : 'desktop';
      if (!sid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"missing session"}');
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        if (body.length < 16384) body += chunk.toString('utf8');
      });
      req.on('end', () => {
        relayMessage(sid, role, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }

    if (pathname === '/api/motion/stream' && req.method === 'GET') {
      const sid = (reqUrl.searchParams.get('s') || '').trim().toUpperCase();
      const role = reqUrl.searchParams.get('role') === 'phone' ? 'phone' : 'desktop';
      if (!sid) {
        res.writeHead(400);
        res.end('Missing session');
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

    // Static file server strictly confined to REPO_ROOT
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const fullPath = path.resolve(rootDir, rel);
    if (!fullPath.startsWith(rootDir + path.sep) && fullPath !== rootDir) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(fullPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(fullPath).pipe(res);
    });
  }

  function handleUpgrade(req, socket) {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (reqUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const sid = (reqUrl.searchParams.get('s') || '').trim().toUpperCase();
    const role = reqUrl.searchParams.get('role') === 'phone' ? 'phone' : 'desktop';
    const key = req.headers['sec-websocket-key'];
    if (!sid || !key) {
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
      rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : chunk;
      const parsed = parseWsFrames(rxBuf);
      rxBuf = Buffer.from(parsed.remainder);
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x1) {
          relayMessage(sid, role, frame.payload.toString('utf8'));
        } else if (frame.opcode === 0x8) {
          socket.end();
        } else if (frame.opcode === 0x9) {
          socket.write(encodeWsFrame(frame.payload.toString('utf8'), 0xA));
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

async function queryNgrokUrl() {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels');
    if (!res.ok) return '';
    const data = await res.json();
    const tunnel = (data.tunnels || []).find((t) => typeof t.public_url === 'string' && t.public_url.startsWith('https://'));
    return tunnel ? tunnel.public_url.replace(/\/+$/, '') : '';
  } catch (_e) {
    return '';
  }
}

async function startNgrokTunnel(port) {
  // Reuse an existing ngrok tunnel if one is already pointed at this port
  const existing = await queryNgrokUrl();
  if (existing) return { url: existing, child: null };

  const child = spawn('ngrok', ['http', String(port), '--log=stdout'], {
    stdio: ['ignore', 'ignore', 'ignore']
  });
  child.on('error', () => {});

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const url = await queryNgrokUrl();
    if (url) return { url, child };
  }
  try { child.kill(); } catch (_e) {}
  return { url: '', child: null };
}

// CLI entry point
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  const noNgrok = args.includes('--no-ngrok');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) || 8443 : 8443;

  const bridge = createBridgeServer({ port });
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
