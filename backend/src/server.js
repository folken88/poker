/**
 * Folken Poker — game server.
 * v0.3 — full hand engine.
 */

const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const path = require('path');

const db = require('./persistence/db');
const { registerLobbyHandlers } = require('./sockets/lobby');
const { registerTableHandlers } = require('./sockets/table');
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

io.on('connection', (socket) => {
  registerLobbyHandlers(io, socket, { tables });
  registerTableHandlers(io, socket, { tables });
  socket.on('disconnect', () => {
    const pid = socket.data.player?.player_id;
    if (!pid) return;
    for (const t of tables.values()) t.handleDisconnect(pid, io);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[poker] v3 listening on :${PORT}  defaultStack=${db.DEFAULT_STACK}  roster=${db.ROSTER.length}`);
});

function shutdown(sig) {
  console.log(`[poker] received ${sig}, shutting down`);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
