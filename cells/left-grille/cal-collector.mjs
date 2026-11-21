#!/usr/bin/env node
/**
 * Local Disk Telemetry Collector (`cells/left-grille/cal-collector.mjs`)
 *
 * Zero-npm-dependency Node ESM HTTP server (`127.0.0.1:8792`) that persists Cell 01's
 * 14-step empirical left-grille acoustic calibration telemetry and fitted model parameters
 * directly to `.worktrees/cal-data/` (which is gitignored so captured sessions never
 * dirty `git status`).
 *
 * Endpoints (all with `Access-Control-Allow-Origin: *`):
 *   - `GET /health`  -> `{ ok: true, savedSessions, latestPath: '.worktrees/cal-data/latest-session.json' }`
 *   - `POST /record` -> Appends event/fit telemetry to `.worktrees/cal-data/events.jsonl` and
 *                       updates `.worktrees/cal-data/session-<sid>.json` + `latest-session.json`
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../.worktrees/cal-data');

export function sanitizeSessionId(rawSid) {
  if (typeof rawSid !== 'string' || !rawSid.trim()) return 'default';
  const cleaned = rawSid.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'default';
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
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function mergeEventByStepId(eventsList, incomingEvent) {
  const list = Array.isArray(eventsList) ? eventsList.slice() : [];
  if (!incomingEvent || typeof incomingEvent !== 'object') return list;
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
  const silent = Boolean(opts.silent);

  fs.mkdirSync(dataDir, { recursive: true });

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };

  function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify(payload));
  }

  const server = http.createServer((req, res) => {
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
      sendJson(res, 400, { ok: false, error: 'Malformed request URL' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      fs.mkdirSync(dataDir, { recursive: true });
      sendJson(res, 200, {
        ok: true,
        savedSessions: countSavedSessions(dataDir),
        latestPath: '.worktrees/cal-data/latest-session.json'
      });
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
      let totalBytes = 0;
      let aborted = false;
      const chunks = [];

      req.on('data', (chunk) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          aborted = true;
          sendJson(res, 413, { ok: false, error: 'Payload exceeds 15 MB limit' });
          req.destroy();
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
        if (aborted || res.writableEnded) return;
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
              payload.trackSettings && typeof payload.trackSettings === 'object'
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
            Object.keys(payload.trackSettings).length > 0
          ) {
            existing.trackSettings = payload.trackSettings;
          }
          existing.updatedAt = nowIso;

          const recordType =
            payload.type || (payload.fitResult ? 'fit' : payload.event ? 'event' : 'bundle');

          if (recordType === 'event' && payload.event && typeof payload.event === 'object') {
            const jsonlLine = JSON.stringify({
              type: 'event',
              receivedAt: nowIso,
              sessionId: sid,
              sampleRate: existing.sampleRate,
              trackSettings: existing.trackSettings,
              event: payload.event
            });
            fs.appendFileSync(jsonlPath, `${jsonlLine}\n`, 'utf8');

            existing.events = mergeEventByStepId(existing.events, payload.event);
            const serialized = JSON.stringify(existing, null, 2);
            fs.writeFileSync(sessionPath, serialized, 'utf8');
            fs.writeFileSync(latestPath, serialized, 'utf8');

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

          if (recordType === 'fit' || payload.fitResult) {
            if (Array.isArray(payload.events) && payload.events.length > 0) {
              let merged = existing.events;
              for (const ev of payload.events) {
                merged = mergeEventByStepId(merged, ev);
              }
              existing.events = merged;
            }
            existing.fitResult = payload.fitResult || null;

            const jsonlLine = JSON.stringify({
              type: 'fit',
              receivedAt: nowIso,
              sessionId: sid,
              eventCount: existing.events.length,
              fitResult: existing.fitResult
            });
            fs.appendFileSync(jsonlPath, `${jsonlLine}\n`, 'utf8');

            const serialized = JSON.stringify(existing, null, 2);
            fs.writeFileSync(sessionPath, serialized, 'utf8');
            fs.writeFileSync(latestPath, serialized, 'utf8');

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

          // Generic fallback bundle save
          if (Array.isArray(payload.events)) {
            for (const ev of payload.events) {
              existing.events = mergeEventByStepId(existing.events, ev);
            }
          }
          const jsonlLine = JSON.stringify({
            type: recordType,
            receivedAt: nowIso,
            sessionId: sid,
            payload
          });
          fs.appendFileSync(jsonlPath, `${jsonlLine}\n`, 'utf8');
          const serialized = JSON.stringify(existing, null, 2);
          fs.writeFileSync(sessionPath, serialized, 'utf8');
          fs.writeFileSync(latestPath, serialized, 'utf8');

          sendJson(res, 200, {
            ok: true,
            type: recordType,
            sessionId: sid,
            eventCount: existing.events.length,
            latestPath: '.worktrees/cal-data/latest-session.json'
          });
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
