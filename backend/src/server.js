/**
 * Folken Poker — game server.
 * v0.3 — full hand engine.
 */

const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const path = require('path');

const db = require('./persistence/db');
const { PRONUNCIATIONS } = require('./util/pronunciations');
const ttsCache = require('./util/ttsCache');
const { registerLobbyHandlers } = require('./sockets/lobby');
const { registerTableHandlers } = require('./sockets/table');
const { registerDungeonHandlers } = require('./sockets/dungeon');
const { Table } = require('./game/Table');

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
app.use(express.json({ limit: '4kb' }));
app.set('trust proxy', true);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: 3, defaultStack: db.DEFAULT_STACK });
});

app.get('/api/roster', (_req, res) => {
  res.json({ players: db.listPlayers(), defaultStack: db.DEFAULT_STACK });
});

// Name-pronunciation overrides — the SAME list the 11labs TTS uses, served
// to the browser so blind-mode Web Speech narration shares one source of
// truth (see util/pronunciations.js). Cached briefly; it changes rarely.
app.get('/api/pronunciations', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(PRONUNCIATIONS);
});

// TTS cache hit-rate — how many 11labs calls we're saving by reusing audio.
app.get('/api/tts-cache', (_req, res) => {
  res.json(ttsCache.getStats());
});

// Lightweight live status per table — used by the deploy watcher to tell
// whether anyone is seated. If nobody is, the watcher can recreate the
// container immediately instead of waiting for a between-hands window.
app.get('/api/tables', (_req, res) => {
  res.json([...tables.values()].map(t => ({
    id: t.id,
    seated: t.seats.filter(s => !s.isEmpty()).length,
    humans: t.seats.filter(s => !s.isEmpty() && !s.isBot).length,
    handActive: !!t.hand,
  })));
});

if (process.env.SERVE_STATIC === '1') {
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
}

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: false },
  pingInterval: 20000,
  pingTimeout:  40000,
});

const tables = new Map();
const defaultTable = new Table({ id: 'main', maxSeats: 9, smallBlind: 25, bigBlind: 50, io });
tables.set(defaultTable.id, defaultTable);

// Active dungeon runs, keyed by leader player_id (one run per leader).
const dungeons = new Map();

io.on('connection', (socket) => {
  registerLobbyHandlers(io, socket, { tables });
  registerTableHandlers(io, socket, { tables });
  registerDungeonHandlers(io, socket, { tables, dungeons });
  socket.on('disconnect', () => {
    const pid = socket.data.player?.player_id;
    if (!pid) return;
    for (const t of tables.values()) t.handleDisconnect(pid, io);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[poker] v3 listening on :${PORT}  defaultStack=${db.DEFAULT_STACK}  roster=${db.ROSTER.length}`);
  // If this deploy carried a feature note (DEPLOY_NOTE env, set on the
  // `docker compose up`), drop a short "what changed" line into the table
  // chat. It lands in the chat log, so whoever is connected or joins after
  // the restart sees it.
  const note = (process.env.DEPLOY_NOTE || '').trim();
  if (note) {
    for (const t of tables.values()) {
      try { t.chat('info', `🔧 Update: ${note.slice(0, 160)}`); } catch (_) {}
    }
    console.log(`[poker] deploy note posted: ${note.slice(0, 160)}`);
  }
});

function shutdown(sig) {
  console.log(`[poker] received ${sig}, shutting down`);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
