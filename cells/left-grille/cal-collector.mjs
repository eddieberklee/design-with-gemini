#!/usr/bin/env node
/**
 * Local Disk Telemetry Collector (`cells/left-grille/cal-collector.mjs`)
 *
 * Zero-npm-dependency Node ESM HTTP server (`127.0.0.1:8792`) that persists Cell 05 / Slot 01's
 * 14-step empirical left-grille acoustic calibration telemetry and fitted model parameters
 * directly to `.worktrees/cal-data/` (which is gitignored so captured sessions never
 * dirty `git status`).
 *
 * Access & security policy (`isAllowedHost`, `isAllowedOrigin`):
 *   - Every request must carry a loopback `Host` header (`127.0.0.1`, `localhost`, or `[::1]`
 *     with optional `:port`) to block DNS rebinding (`403` otherwise).
 *   - Requests with an `Origin` header must match a loopback origin
 *     (`^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$`) (`403` otherwise, including
 *     `Origin: null` from sandboxed iframes; allowed origins echoed via `Access-Control-Allow-Origin` + `Vary: Origin`).
 *   - `POST /record` requires `Content-Type: application/json*` (`415` otherwise) and strictly
 *     validates `payload.type === 'event'` or `payload.type === 'fit'` (`400` otherwise).
 *
 * Endpoints:
 *   - `GET /health`  -> `{ ok: true, savedSessions, latestPath: '.worktrees/cal-data/latest-session.json' }`
 *   - `POST /record` -> Appends bounded (`<= 25 MB`) event/fit telemetry to `.worktrees/cal-data/events.jsonl`
 *                       and atomically updates `.worktrees/cal-data/session-<sid>.json` (pruned to `<= 32`
 *                       sessions) + `.worktrees/cal-data/latest-session.json`
 *   - `GET /latest`  -> Returns `.worktrees/cal-data/latest-session.json` if present
 *
 * Usage:
 *   node cells/left-grille/cal-collector.mjs
 *   CAL_COLLECTOR_PORT=8792 node cells/left-grille/cal-collector.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8792;
export const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAX_SAVED_SESSIONS = 32;
export const MAX_JSONL_BYTES = 25 * 1024 * 1024; // 25 MB

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../.worktrees/cal-data');

export function sanitizeSessionId(rawSid) {
  if (typeof rawSid !== 'string' || !rawSid.trim()) return 'default';
  const cleaned = rawSid.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'default';
}

export function isAllowedHost(hostHeader) {
  const m = /^(\[[^\]]+\]|[^:[\]]+)(?::\d{1,5})?$/.exec(String(hostHeader || '').trim());
  return Boolean(m && LOOPBACK_HOST_RE.test(m[1]));
}

export function isAllowedOrigin(origin) {
  if (origin === undefined) return true;
  const trimmed = String(origin).trim();
  return LOOPBACK_ORIGIN_RE.test(trimmed);
}

function countSavedSessions(dataDir) {
  try {
    const entries = fs.readdirSync(dataDir);
    return entries.filter((name) => name.startsWith('session-') && name.endsWith('.json')).length;
  } catch (_) {
    return 0;
  }
}

function readJsonFileSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

let atomicTmpSeq = 0;
function writeFileAtomicSync(targetPath, content) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${++atomicTmpSeq}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    throw err;
  }
}

function pruneSavedSessions(dataDir, maxSessions = MAX_SAVED_SESSIONS) {
  try {
    const cap = Number.isFinite(maxSessions) && maxSessions > 0 ? Math.floor(maxSessions) : MAX_SAVED_SESSIONS;
    const entries = fs
      .readdirSync(dataDir)
      .filter((name) => name.startsWith('session-') && name.endsWith('.json'));
    if (entries.length <= cap) return;
    const withStats = entries
      .map((name) => {
        const fullPath = path.join(dataDir, name);
        try {
          const st = fs.statSync(fullPath);
          return { fullPath, mtimeMs: st.mtimeMs || 0, name };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    const toRemove = withStats.length - cap;
    for (let i = 0; i < toRemove; i++) {
      try {
        fs.unlinkSync(withStats[i].fullPath);
      } catch (_) {}
    }
  } catch (_) {}
}

function appendJsonlBoundedSync(jsonlPath, lineStr, maxBytes = MAX_JSONL_BYTES) {
  const entry = `${lineStr}\n`;
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_JSONL_BYTES;
  try {
    if (fs.existsSync(jsonlPath)) {
      const st = fs.statSync(jsonlPath);
      const entryBytes = Buffer.byteLength(entry, 'utf8');
      if (st.size + entryBytes > cap) {
        const keepBytes = Math.max(0, Math.floor(cap * 0.5) - entryBytes);
        if (keepBytes > 0 && st.size > keepBytes) {
          const fd = fs.openSync(jsonlPath, 'r');
          let tailBuf;
          try {
            tailBuf = Buffer.allocUnsafe(keepBytes);
            fs.readSync(fd, tailBuf, 0, keepBytes, st.size - keepBytes);
          } finally {
            fs.closeSync(fd);
          }
          const nlIdx = tailBuf.indexOf(0x0a);
          const cleanTail = nlIdx >= 0 ? tailBuf.subarray(nlIdx + 1) : tailBuf;
          writeFileAtomicSync(jsonlPath, cleanTail.toString('utf8') + entry);
          return;
        }
        writeFileAtomicSync(jsonlPath, entry);
        return;
      }
    }
  } catch (_) {}
  fs.appendFileSync(jsonlPath, entry, 'utf8');
}

function mergeEventByStepId(eventsList, incomingEvent) {
  const list = Array.isArray(eventsList) ? eventsList.slice() : [];
  if (!incomingEvent || typeof incomingEvent !== 'object' || Array.isArray(incomingEvent)) {
    return list;
  }
  const key = incomingEvent.stepId || incomingEvent.id || null;
  if (key) {
    const existingIdx = list.findIndex(
      (item) => item && (item.stepId === key || item.id === key)
    );
    if (existingIdx >= 0) {
      list[existingIdx] = incomingEvent;
      return list;
    }
  }
  list.push(incomingEvent);
  return list;
}

export function createCollectorServer(opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const port = Number.isFinite(opts.port) ? opts.port : DEFAULT_PORT;
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : DEFAULT_DATA_DIR;
  const maxSavedSessions = Number.isFinite(opts.maxSavedSessions)
    ? opts.maxSavedSessions
    : MAX_SAVED_SESSIONS;
  const maxJsonlBytes = Number.isFinite(opts.maxJsonlBytes)
    ? opts.maxJsonlBytes
    : MAX_JSONL_BYTES;
  const silent = Boolean(opts.silent);

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {}

  const server = http.createServer((req, res) => {
    res.on('error', () => {});

    const origin = req.headers.origin;
    const baseSecurityHeaders = {
      'Cache-Control': 'no-store',
      Vary: 'Origin'
    };

    if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(origin)) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          res.writeHead(403, {
            ...baseSecurityHeaders,
            'Content-Type': 'application/json; charset=utf-8'
          });
          res.end(JSON.stringify({ ok: false, error: 'Forbidden origin or host' }));
        } catch (_) {}
      }
      return;
    }

    const corsHeaders = {
      ...baseSecurityHeaders,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (origin !== undefined) {
      corsHeaders['Access-Control-Allow-Origin'] = String(origin).trim();
    }

    function sendJson(targetRes, statusCode, payload, extraHeaders = {}) {
      if (targetRes.headersSent || targetRes.writableEnded || targetRes.destroyed) return;
      try {
        targetRes.writeHead(statusCode, {
          ...corsHeaders,
          ...extraHeaders,
          'Content-Type': 'application/json; charset=utf-8'
        });
        targetRes.end(JSON.stringify(payload));
      } catch (_) {}
    }

    if (req.method === 'OPTIONS') {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          res.writeHead(204, corsHeaders);
          res.end();
        } catch (_) {}
      }
      return;
    }

    let url;
    try {
      const addr = server.address();
      const activePort = addr && typeof addr === 'object' ? addr.port : port;
      url = new URL(req.url || '/', `http://${host}:${activePort}`);
    } catch (_) {
      sendJson(res, 400, { ok: false, error: 'Malformed request URL' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        sendJson(res, 200, {
          ok: true,
          savedSessions: countSavedSessions(dataDir),
          latestPath: '.worktrees/cal-data/latest-session.json'
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: (err && err.message) || 'Collector storage directory unavailable'
        });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/latest') {
      const latestFile = path.join(dataDir, 'latest-session.json');
      const data = readJsonFileSafe(latestFile);
      if (!data) {
        sendJson(res, 404, { ok: false, error: 'No recorded calibration session yet' });
        return;
      }
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/record') {
      const contentType = String(req.headers['content-type'] || '').trim();
      if (!/^application\/json\b/i.test(contentType)) {
        sendJson(res, 415, {
          ok: false,
          error: 'Unsupported Media Type: Content-Type must be application/json'
        });
        return;
      }

      let totalBytes = 0;
      let aborted = false;
      const chunks = [];

      req.on('data', (chunk) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          aborted = true;
          chunks.length = 0;
          try {
            req.resume();
          } catch (_) {}
          res.once('finish', () => {
            setTimeout(() => {
              try {
                req.destroy();
              } catch (_) {}
            }, 20);
          });
          sendJson(
            res,
            413,
            { ok: false, error: 'Payload exceeds 15 MB limit' },
            { Connection: 'close' }
          );
          return;
        }
        chunks.push(chunk);
      });

      req.on('error', () => {
        if (!aborted && !res.writableEnded) {
          sendJson(res, 400, { ok: false, error: 'Request stream error' });
        }
      });

      req.on('end', () => {
        if (aborted || res.writableEnded || res.headersSent || res.destroyed) return;
        let payload;
        try {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          payload = JSON.parse(rawBody);
        } catch (_) {
          sendJson(res, 400, { ok: false, error: 'Invalid JSON payload' });
          return;
        }

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          sendJson(res, 400, { ok: false, error: 'Expected JSON object payload' });
          return;
        }

        const isValidEventPayload =
          payload.type === 'event' &&
          payload.event &&
          typeof payload.event === 'object' &&
          !Array.isArray(payload.event) &&
          typeof payload.event.stepId === 'string' &&
          payload.event.stepId.trim().length > 0;

        const isValidFitPayload =
          payload.type === 'fit' &&
          ((payload.fitResult &&
            typeof payload.fitResult === 'object' &&
            !Array.isArray(payload.fitResult)) ||
            (payload.empiricalModel &&
              typeof payload.empiricalModel === 'object' &&
              !Array.isArray(payload.empiricalModel)));

        if (!isValidEventPayload && !isValidFitPayload) {
          sendJson(res, 400, {
            ok: false,
            error:
              'Invalid calibration record schema: expected type="event" with event.stepId or type="fit" with fitResult/empiricalModel'
          });
          return;
        }

        try {
          fs.mkdirSync(dataDir, { recursive: true });
          const nowIso = new Date().toISOString();
          const sid = sanitizeSessionId(payload.sessionId);
          const sessionPath = path.join(dataDir, `session-${sid}.json`);
          const latestPath = path.join(dataDir, 'latest-session.json');
          const jsonlPath = path.join(dataDir, 'events.jsonl');

          const existing = readJsonFileSafe(sessionPath) || {
            sessionId: sid,
            createdAt: nowIso,
            updatedAt: nowIso,
            sampleRate: Number.isFinite(payload.sampleRate) ? payload.sampleRate : 48000,
            trackSettings:
              payload.trackSettings &&
              typeof payload.trackSettings === 'object' &&
              !Array.isArray(payload.trackSettings)
                ? payload.trackSettings
                : {},
            events: [],
            fitResult: null
          };

          if (Number.isFinite(payload.sampleRate)) {
            existing.sampleRate = payload.sampleRate;
          }
          if (
            payload.trackSettings &&
            typeof payload.trackSettings === 'object' &&
            !Array.isArray(payload.trackSettings) &&
            Object.keys(payload.trackSettings).length > 0
          ) {
            existing.trackSettings = payload.trackSettings;
          }
          existing.updatedAt = nowIso;

          if (isValidEventPayload) {
            const jsonlLine = JSON.stringify({
              type: 'event',
              receivedAt: nowIso,
              sessionId: sid,
              sampleRate: existing.sampleRate,
              trackSettings: existing.trackSettings,
              event: payload.event
            });
            appendJsonlBoundedSync(jsonlPath, jsonlLine, maxJsonlBytes);

            existing.events = mergeEventByStepId(existing.events, payload.event);
            const serialized = JSON.stringify(existing, null, 2);
            writeFileAtomicSync(sessionPath, serialized);
            writeFileAtomicSync(latestPath, serialized);
            pruneSavedSessions(dataDir, maxSavedSessions);

            if (!silent) {
              const stepId = payload.event.stepId || payload.event.id || 'step';
              const frames = Array.isArray(payload.event.frames)
                ? payload.event.frames.length
                : payload.event.frameCount || 0;
              const active = payload.event.activeFrameCount ?? frames;
              process.stdout.write(
                `[cal-collector] event ${stepId} (${active}/${frames} active frames) -> .worktrees/cal-data/latest-session.json\n`
              );
            }

            sendJson(res, 200, {
              ok: true,
              type: 'event',
              sessionId: sid,
              eventCount: existing.events.length,
              latestPath: '.worktrees/cal-data/latest-session.json'
            });
            return;
          }

          if (isValidFitPayload) {
            if (Array.isArray(payload.events) && payload.events.length > 0) {
              let merged = existing.events;
              for (const ev of payload.events) {
                merged = mergeEventByStepId(merged, ev);
              }
              existing.events = merged;
            }
            existing.fitResult = payload.fitResult || payload.empiricalModel || null;

            const jsonlLine = JSON.stringify({
              type: 'fit',
              receivedAt: nowIso,
              sessionId: sid,
              eventCount: existing.events.length,
              fitResult: existing.fitResult
            });
            appendJsonlBoundedSync(jsonlPath, jsonlLine, maxJsonlBytes);

            const serialized = JSON.stringify(existing, null, 2);
            writeFileAtomicSync(sessionPath, serialized);
            writeFileAtomicSync(latestPath, serialized);
            pruneSavedSessions(dataDir, maxSavedSessions);

            const loo = existing.fitResult?.looAccuracyPct ?? 'n/a';
            const dp = existing.fitResult?.dPrime ?? 'n/a';
            if (!silent) {
              process.stdout.write(
                `[cal-collector] fit saved (sid=${sid}, events=${existing.events.length}, LOO=${loo}%, d'=${dp}) -> .worktrees/cal-data/latest-session.json\n`
              );
            }

            sendJson(res, 200, {
              ok: true,
              type: 'fit',
              sessionId: sid,
              eventCount: existing.events.length,
              looAccuracyPct: existing.fitResult?.looAccuracyPct ?? null,
              dPrime: existing.fitResult?.dPrime ?? null,
              latestPath: '.worktrees/cal-data/latest-session.json'
            });
            return;
          }
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            error: (err && err.message) || 'Failed to persist calibration record'
          });
        }
      });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: 'Not found',
      endpoints: ['/health', '/record', '/latest']
    });
  });

  server.on('clientError', (_err, socket) => {
    try {
      if (socket && socket.writable && !socket.destroyed) {
        socket.end(
          'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n{"ok":false,"error":"Bad request"}'
        );
      } else if (socket && !socket.destroyed) {
        socket.destroy();
      }
    } catch (_) {}
  });

  function closeAll() {
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return {
    server,
    dataDir,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          server.on('error', () => {});
          const addr = server.address();
          const boundPort = addr && typeof addr === 'object' ? addr.port : port;
          resolve({ host, port: boundPort, dataDir });
        });
      });
    },
    close: closeAll
  };
}

// CLI entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CAL_COLLECTOR_PORT || DEFAULT_PORT);
  const collector = createCollectorServer({ host: DEFAULT_HOST, port });
  collector
    .start()
    .then(({ host, port: boundPort }) => {
      process.stdout.write(
        `[cal-collector] listening on http://${host}:${boundPort} (/health, /record, /latest) -> .worktrees/cal-data/latest-session.json\n`
      );
    })
    .catch((err) => {
      process.stderr.write(
        `[cal-collector] failed to bind ${DEFAULT_HOST}:${port}: ${err.message}\n`
      );
      process.exit(1);
    });

  const shutdown = () => {
    collector.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
