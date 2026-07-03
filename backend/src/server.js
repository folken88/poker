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

const { VERSION } = require('./version');   // ONE app semver — see src/version.js (bump per the living-docs mandate)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, defaultStack: db.DEFAULT_STACK });
});
app.get('/api/version', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ version: VERSION });
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
  // `connectedClients` = live browser sockets (humans only — bots are server-
  // side, never sockets). Lets the deploy watcher hold a rebuild until every
  // human has actually disconnected, not just left their seat.
  const connectedClients = (io && io.engine && io.engine.clientsCount) || 0;
  res.json([...tables.values()].map(t => {
    const d = dungeons.get(t.id);
    return {
      id: t.id,
      seated: t.seats.filter(s => !s.isEmpty()).length,
      humans: t.seats.filter(s => !s.isEmpty() && !s.isBot).length,
      handActive: !!t.hand,
      // A run is "active" until it's over — lets the deploy watcher hold a
      // rebuild until BOTH the hand is between deals AND the delve has wrapped.
      dungeonActive: !!(d && d.status && d.status !== 'over'),
      dungeonHumans: d ? d.party.filter(m => !m.isBot && !m.left && !m.dead).length : 0,
      connectedClients,
    };
  }));
});

// Deploy announcement — the PRIME voice warns the table before a reboot ("I'M
// REBOOTING TO APPLY UPDATES, FUCKERS!"). LOCALHOST-ONLY: the deploy watcher
// calls it via `docker compose exec backend curl http://localhost:3000/...`
// just before recreating the container. Synthesizes with 11labs (audio tags
// like [excited] pass through to the v3 model; they're stripped from the
// displayed text) and broadcasts to every table as voiced banter.
const elevenlabs = require('./util/elevenlabs');
const PRIME_VOICE = 'CPrddi89utXexSfHFD7y';   // "Prime" (Tokala's voice) — the announcer
// Dedupe timestamp persisted under data/ (a mounted volume) so it SURVIVES the
// container recreate between a double-fired deploy's two announces — the user
// heard the rebooting line twice when two watchers raced.
const ANNOUNCE_TS_FILE = path.join(__dirname, '..', 'data', '.announce-ts');
app.post('/api/admin/announce', async (req, res) => {
  const ip = String(req.socket.remoteAddress || '');
  if (!/^(::1|::ffff:127\.|127\.)/.test(ip)) return res.status(403).json({ ok: false, error: 'local only' });
  const text = String((req.body && req.body.text) || '').slice(0, 300);
  if (!text) return res.status(400).json({ ok: false, error: 'no text' });
  try {
    const fs = require('fs');
    const last = parseInt(fs.readFileSync(ANNOUNCE_TS_FILE, 'utf8'), 10) || 0;
    if (Date.now() - last < 3 * 60_000) return res.json({ ok: true, voiced: false, deduped: true });   // said it in the last 3 min — once was plenty
  } catch (_) {}
  try { require('fs').writeFileSync(ANNOUNCE_TS_FILE, String(Date.now())); } catch (_) {}
  const voiceId = String((req.body && req.body.voice) || PRIME_VOICE);
  let audio = null;
  if (elevenlabs.ENABLED) {
    // synthesize() resolves to a base64 MP3 string or null (despite its header doc).
    try { audio = (await elevenlabs.synthesize(text, voiceId)) || null; } catch (_) {}
  }
  const shown = text.replace(/\[[^\]]+\]\s*/g, '');   // strip [excited]-style audio tags from the text line
  for (const t of tables.values()) t.chat('banter', `📢 ${shown}`, audio ? { audio, audioMime: 'audio/mpeg' } : undefined);
  res.json({ ok: true, voiced: !!audio });
});

// Hidden dev/reference pages: /monsters, /spells, /classes (not linked in the UI).
try { require('./devpages').registerDevPages(app); } catch (e) { console.warn('[devpages] not loaded:', e.message); }

// Recent sounds emitted to clients + a play-count tally, for diagnosing an
// overplayed sound. { last: [{ts,source,sound,label}], tally: [{sound,count}] }.
app.get('/api/sounds', (req, res) => {
  const n = Math.min(60, Math.max(1, parseInt(req.query.n, 10) || 15));
  res.json(require('./persistence/logger').recentSounds(n));
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

// Let each table tell whether a human from it is currently off in its dungeon, so
// it keeps its bots while that player adventures — and clears them only when the
// table is truly empty (no seated humans AND no dungeon humans). See
// Table._humanStillNeedsTable.
for (const t of tables.values()) {
  t._dungeonHasHumans = () => {
    const d = dungeons.get(t.id);
    return !!(d && d.party && d.party.some(m => !m.isBot && !m.left && !m.dead));
  };
}

io.on('connection', (socket) => {
  registerLobbyHandlers(io, socket, { tables });
  registerTableHandlers(io, socket, { tables, dungeons });
  registerDungeonHandlers(io, socket, { tables, dungeons });
  socket.on('disconnect', () => {
    const pid = socket.data.player?.player_id;
    if (!pid) return;
    for (const t of tables.values()) t.handleDisconnect(pid, io);
  });
});

// ── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
// docker stop / compose recreate sends SIGTERM (node is PID 1 — exec-form CMD).
// Before the process dies, every ACTIVE dungeon run pays out its pool to the
// whole party via _groupExtract (even shares, downed included — better-sqlite3
// is synchronous, so the chips land before exit). A deploy can therefore NEVER
// eat unbanked gold again, no matter what the gate raced against.
// (Lesson 2026-06-12: a recreate vaporized a depth-10 run's 14,548 gp pool.)
function bankLiveDungeonRuns(why) {
  try {
    for (const d of dungeons.values()) {
      try {
        if (d && d.status && d.status !== 'over') {
          console.log(`[${why}] banking live dungeon run — pool ${d.runGold || 0}g, depth ${d.depth || 0}`);
          d._groupExtract();
        }
      } catch (e) { console.error(`[${why}] dungeon payout:`, e.message); }
    }
  } catch (e) { console.error(`[${why}]`, e.message); }
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { bankLiveDungeonRuns('shutdown'); process.exit(0); });
}
// CRASH BACKSTOP — a hard crash (uncaught exception / rejected promise) is NOT a
// signal, so the SIGTERM payout above never runs: the process just dies and
// docker auto-restarts, vaporizing every in-memory run. (Lost a depth-15 run +
// 12,893 gp on 2026-06-13 when a loot-roll timer threw on a null lootRoll.)
// Bank every live run's pool to the party FIRST — better-sqlite3 is synchronous,
// so the chips land before we exit — then crash for real so docker restarts us.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  bankLiveDungeonRuns('crash');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
  bankLiveDungeonRuns('crash');
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[poker] v${VERSION} listening on :${PORT}  defaultStack=${db.DEFAULT_STACK}  roster=${db.ROSTER.length}`);
  // Meyanda, the family Discord herald — a silent no-op unless data/.meyanda.env
  // enables her (so the testbed stays dark and her failures stay her own).
  try { require('./discord/meyanda').start(); } catch (e) { console.error('[meyanda]', e.message); }
  // If this deploy carried a feature note (DEPLOY_NOTE env, set on the
  // `docker compose up`), drop a short "what changed" line into the table
  // chat. It lands in the chat log, so whoever is connected or joins after
  // the restart sees it.
  const note = (process.env.DEPLOY_NOTE || '').trim();
  if (note) {
    // Post the COMPLETE notes — split into readable lines (on newlines or " | ")
    // so a multi-point update isn't cut off. First line is headed "🔧 Update:",
    // the rest are bulleted. Each line is capped only as a sanity bound.
    const lines = note.split(/\s*\n\s*|\s*\|\s*/).map(s => s.trim()).filter(Boolean);
    for (const t of tables.values()) {
      lines.forEach((ln, i) => {
        try { t.chat('info', `${i === 0 ? '🔧 Update:' : '   •'} ${ln.slice(0, 300)}`); } catch (_) {}
      });
    }
    console.log(`[poker] deploy note posted (${lines.length} line${lines.length === 1 ? '' : 's'})`);
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
