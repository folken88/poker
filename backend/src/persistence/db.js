/**
 * SQLite wrapper + roster seeding.
 *
 * Identity model (v0.2 prototype):
 *  - A fixed roster of 14 players is seeded on boot.
 *  - Each socket connection picks a player from the roster.
 *  - Chip totals are persistent per player_id (lowercased name).
 *  - No auth — anyone clicking "Fred" is Fred for that browser tab.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { CLASSES, castingAbilityFor } = require('../pf1data/classes');
const loadouts = require('../pf1data/loadouts');     // default spell loadouts (Phase B)
const { levelFromXp } = require('../pf1data/xp');     // per-class level from XP (default scales with level)
const { STAPLE_BY_KEY, WEAPON_LOOKUP, DEFAULT_WEAPON } = require('../pf1data/staples');
const abilityProfiles = require('../pf1data/characterProfiles');
const { validateBuild } = require('../pf1data/abilityScores');
const RACES = require('../pf1data/races');
const { BUILDS } = require('../pf1data/characterBuilds');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH  = process.env.DB_PATH  || path.join(DATA_DIR, 'poker.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Schema
const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schemaSql);

// Idempotent column additions (SQLite doesn't support IF NOT EXISTS on ALTER).
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}
ensureColumn('players', 'is_bot',     'INTEGER NOT NULL DEFAULT 0');
ensureColumn('players', 'bot_mode',   'TEXT');
// Bot intelligence: 'low' | 'average' | 'high'. Adds noise to the
// strength estimate inside Bot.decide() — low-int bots mis-read hands
// more often, high-int bots are nearly always right. Independent of
// bot_mode (risk appetite).
ensureColumn('players', 'bot_intelligence', "TEXT NOT NULL DEFAULT 'average'");
// Long-term "tab" — every time a human hits Re-buy we add DEFAULT_STACK to
// this debt. They can pay it down later from their stack via `lobby:payDebt`.
// Bots do NOT accrue debt — their auto-rebuys are free (they're the house).
ensureColumn('players', 'rebuy_debt', 'INTEGER NOT NULL DEFAULT 0');
// Turns-in-debt clock for Abadar's compound interest (see tickDebtTurn). Counts
// the turns a player takes — poker actions AND dungeon combat turns — while they
// owe; every DEBT_INTEREST_TURNS the tab compounds. Resets when the debt clears.
ensureColumn('players', 'debt_turns', 'INTEGER NOT NULL DEFAULT 0');
// JSON object mapping sword tier (string '1'..'5') to count, e.g.
// '{"1":2,"2":1}' = two +1 longswords and one +2. LEGACY — superseded by
// the `gear` column below. Left in place so older rows don't break.
ensureColumn('players', 'swords',     "TEXT NOT NULL DEFAULT '{}'");
// JSON object: { weapon: 5, armor: null, shield: 3, ring: null, cloak: 4 }.
// (Amulet slot removed 2026-05; see migrateRemoveAmulet below.)
// One slot per gear type, value = enhancement tier (1–5) or null/absent.
// Players keep one item per slot. Goal: +5 in all five = LOOT LORD.
ensureColumn('players', 'gear',       "TEXT NOT NULL DEFAULT '{}'");
// Pronoun set per player: 'he' | 'she' | 'they'. Humans default to
// 'they' until they pick from the dropdown. Bots are pinned via
// BOT_ROSTER entries below and re-synced on every boot.
ensureColumn('players', 'gender',     "TEXT NOT NULL DEFAULT 'they'");
// PF1e class (drives BAB / saves / abilities) and chosen base weapon (the +N
// enhancement in the gear 'weapon' slot rides on this weapon). Humans default to
// a Fighter with a masterwork Dagger and change both in the name-click menu;
// bots are pinned from BOT_CLASSES below and re-synced each boot.
ensureColumn('players', 'class',      "TEXT NOT NULL DEFAULT 'fighter'");
ensureColumn('players', 'weapon',     "TEXT NOT NULL DEFAULT 'dagger'");
// PF1e dungeon EXPERIENCE — now the SOLE source of a hero's level (see
// pf1data/xp.js, medium track), replacing the old gear-derived level. Adding this
// column with DEFAULT 0 IS the one-time reset off the item-leveled system: every
// existing player (and bot) starts fresh at level 1 / 0 XP. Gear still affects
// to-hit / damage / AC, but no longer grants levels.
ensureColumn('players', 'experience', 'INTEGER NOT NULL DEFAULT 0');
// PERMANENT Loot Lord crown — set once when a player first assembles a full +5
// set, and NEVER cleared (it is deliberately left out of every reset, so the crown
// shows over their token forever, through full wipes and Loot-Lord resets alike).
ensureColumn('players', 'crowned', 'INTEGER NOT NULL DEFAULT 0');
// PER-CLASS experience — XP is tracked separately for each PF1 class a player has
// played: switching class shows THAT class's level (start at 1 if new), switching
// back restores the prior class's XP. JSON map { <class>: xp }. Gear is unaffected.
ensureColumn('players', 'class_xp', "TEXT NOT NULL DEFAULT '{}'");
// PF1 ABILITY SCORES — a per-class map { <class>: {str,dex,con,int,wis,cha} } of
// the character's BASE 25-point array (pre-race, pre-ASI), MIRRORING class_xp:
// each class a player tries gets its own build (a wizard is INT, a barbarian is
// STR). Seeded lazily from the character's class + chosen weapon via
// pf1data/characterProfiles (finesse/ranged ⇒ DEX). Editable per-class later.
ensureColumn('players', 'ability_scores', "TEXT NOT NULL DEFAULT '{}'");
// PF1 RACE — one per character (NOT per class). Drives racial ability mods,
// vision, and save bonuses (see pf1data/races.js). Default 'human'; pinned per
// character from pf1data/characterBuilds.js (BUILDS) and re-synced at boot.
ensureColumn('players', 'race', "TEXT NOT NULL DEFAULT 'none'");
// PF1 SPELL LOADOUTS — per-class, mirroring class_xp/ability_scores (see
// SPELL-LOADOUTS-DESIGN.md). PREPARED casters (cleric/druid/wizard/paladin/ranger/
// antipaladin) store which spells are readied into each slot LEVEL:
//   prepared_spells = { <class>: { <slotLevel>: [spellKey, …] } }
// SPONTANEOUS casters (sorcerer/bard/oracle/inquisitor) store their spells KNOWN:
//   known_spells    = { <class>: [spellKey, …] }
// Empty {} = "use the class default loadout" (built lazily on first access). The
// runtime (Phase C) reads these to decide what a character may cast.
ensureColumn('players', 'prepared_spells', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('players', 'known_spells', "TEXT NOT NULL DEFAULT '{}'");
// DOMAINS (Phase A, 2026-07-03) — per-class map like prepared_spells:
//   domains = { "cleric": ["healing","war"], "inquisitor": ["liberation"] }
// Cleric picks 2 (powers + domain spells), inquisitor 1 (power only). See
// pf1data/domains.js + DOMAINS-DESIGN.md; changes land between rooms.
ensureColumn('players', 'domains', "TEXT NOT NULL DEFAULT '{}'");
// The chosen ability for a FLEX race's floating +2 (human/half-elf/half-orc),
// e.g. 'str'. Empty = auto (highest base stat). Pinned from characterBuilds.
ensureColumn('players', 'race_flex', "TEXT NOT NULL DEFAULT ''");
// One-time backfill: fold any legacy single `experience` into the per-class map.
try {
  const _bf = db.prepare("SELECT player_id, class, experience FROM players WHERE experience > 0 AND (class_xp IS NULL OR class_xp = '{}')").all();
  const _bfUp = db.prepare('UPDATE players SET class_xp = ? WHERE player_id = ?');
  for (const r of _bf) _bfUp.run(JSON.stringify({ [r.class || 'fighter']: r.experience }), r.player_id);
} catch (_) {}

// One-time fix-up (2026-06-02 PNG→WebP asset conversion): avatar_id stores the
// token's served PATH, and the old .png token files were converted to .webp and
// deleted — so any stored avatar ending in .png now 404s. Rewrite the trailing
// .png to .webp (every converted png has a same-named webp). Idempotent: once no
// avatar_id ends in .png, this is a no-op.
try {
  db.prepare("UPDATE players SET avatar_id = substr(avatar_id, 1, length(avatar_id) - 4) || '.webp' WHERE avatar_id LIKE '%.png'").run();
} catch (_) { /* non-fatal: a broken avatar just shows the fallback glyph */ }

// One-time cleanup (2026-06-20): retire the joke human seeds Boobs / Butt / Farts
// (Tobias). Removed from ROSTER below so they never re-seed; this drops any
// existing rows. is_bot=0 guard so a same-named bot could never be hit.
try {
  db.prepare("DELETE FROM players WHERE is_bot = 0 AND player_id IN ('boobs', 'butt', 'farts')").run();
} catch (_) { /* non-fatal */ }

// Champions Board — one row per Loot Lord. Logged when someone hits +5
// in every slot. The reset-to-default that follows wipes everyone's
// chips/gear but this table records the historical winners forever.
db.exec(`
  CREATE TABLE IF NOT EXISTS champions (
    id INTEGER PRIMARY KEY,
    player_id TEXT NOT NULL,
    nickname  TEXT NOT NULL,
    avatar_id TEXT,
    won_at    INTEGER NOT NULL,
    hands_to_win INTEGER,
    final_chips  INTEGER
  );
`);

// ---- Reserved human roster ----
// EVERY entry here is a RESERVED HUMAN identity — saved for real
// people the user plays with. The "+ Bot" button (lobby:addBot) never
// picks from this list; the AI driver (_maybeDriveBot in Table.js)
// only acts on seats where seat.isBot === true, which itself comes
// from player.is_bot = 1. Reserved humans always seed with is_bot = 0,
// so AI cannot drive or supersede them. Their chips, gear, and rebuy
// debt persist across sessions for whoever sits down as them.
// User explicitly named these as reserved: Tobis, Timmy (Timmay),
// Sydness, BRION, Zachariah, Harry, Banana, Fred, LEEESA — the rest
// (Chrees, Lowgan, Farts, Butt, Boobs, Cram) follow the same policy
// since they all live in this ROSTER as is_bot=0 humans.
const ROSTER = [
  { name: 'Tobis',     avatar: 'dragon'  },
  { name: 'Fred',      avatar: 'fox'     },
  { name: 'Timmay',    avatar: 'robot'   },
  { name: 'LEEESA',    avatar: 'wizard'  },
  { name: 'Banana',    avatar: 'frog'    },
  { name: 'Sydness',   avatar: 'owl'     },
  { name: 'BRION',     avatar: 'knight'  },
  { name: 'Chrees',    avatar: 'bear'    },
  { name: 'Lowgan',    avatar: 'wolf'    },
  { name: 'Zachariah', avatar: 'lion'    },
  { name: 'Harry',     avatar: 'raccoon' },
  { name: 'Cram',      avatar: 'bear'    },
  { name: 'Daemon',    avatar: 'wolf'    },
  { name: 'Kip',       avatar: 'fox'     },
  { name: 'Mandore',   avatar: 'knight'  },
  { name: 'Gramm',     avatar: 'lion'    },
  { name: 'Rique',     avatar: 'raccoon' },
  { name: 'Ash',       avatar: 'lion'    },
  { name: 'Kayla',     avatar: 'owl'     },
  { name: 'Serra',     avatar: 'frog'    },
  { name: 'Lid',       avatar: 'cat'     },
  { name: 'Josh',      avatar: 'wolf'    },
  { name: 'Mylez',     avatar: 'raccoon' },
  { name: 'Pinkey',    avatar: 'fox'     },
  { name: 'Punkers',   avatar: 'bear'    },
  { name: 'LeJeanBec', avatar: 'frog'    },
  { name: 'Octo',      avatar: 'frog'    },
];

// AI players — pre-seeded, available via "Add bot" button. Humans can
// also pick them from the roster to "supersede" the AI for a session.
// Personality = baseMode (cautious / standard / risky). Avatar paths
// point at /tokens/ files imported by scripts/import-token-gallery.js.
// `intelligence`: 'low' | 'average' | 'high' — affects how much noise
// is added to the bot's hand-strength estimate in Bot.decide(). High =
// nearly always right; low = frequently misreads. Independent from
// baseMode (risk appetite).
const BOT_ROSTER = [
  // Original 6 bots
  { name: 'Dinvaya',              avatar: '/tokens/dinvaya.webp',              baseMode: 'cautious', intelligence: 'high', gender: 'she'    },
  { name: 'Vaughan',              avatar: '/tokens/vaughan.webp',              baseMode: 'risky',    intelligence: 'high', gender: 'he'    }, // user: high intel + high risk
  { name: 'Storgrim Thunderbeard', nickname: 'Storgrim', avatar: '/tokens/storgrim-thunderbeard.webp', baseMode: 'cautious', intelligence: 'average', gender: 'he' }, // user: avg intel + cautious
  { name: 'Kate Blackwood',        nickname: 'Kate',     avatar: '/tokens/kate-blackwood.webp',        baseMode: 'cautious', intelligence: 'high', gender: 'she'    }, // user: high intel + low risk
  { name: 'Kovira',               avatar: '/tokens/kovira.webp',               baseMode: 'risky',    intelligence: 'high', gender: 'she'    },
  { name: 'Elfrip',               avatar: '/tokens/elfrip.webp',               baseMode: 'standard', intelligence: 'low', gender: 'he'     }, // user: goblin cleric, low intel + normal risk

  // Round 2 additions
  { name: 'Taelys',               avatar: '/tokens/taelys-of-starfall.webp',     baseMode: 'risky',    intelligence: 'low', gender: 'she'     }, // user: low intel + high risk
  { name: 'Lirienne',             avatar: '/tokens/lirienne-voss.webp',          baseMode: 'standard', intelligence: 'average', gender: 'she' }, // user: avg intel + normal risk
  { name: 'Kelda',                avatar: '/tokens/kelda-ironglim.webp',         baseMode: 'cautious', intelligence: 'high', gender: 'they'    }, // user: cautious + high intel
  { name: 'Mr. Brow',             avatar: '/tokens/augustus-teabrow.webp',       baseMode: 'risky',    intelligence: 'high', gender: 'he'    }, // user: highly intelligent + risky
  { name: 'Nomkath',              avatar: '/tokens/nomkath.webp',                baseMode: 'standard', intelligence: 'average', gender: 'he' }, // catfolk_male rogue/scout in Numeria; user: avg intel + avg risk
  { name: 'Ulfred',               avatar: '/tokens/ulfred-stronginthearm.webp',  baseMode: 'standard', intelligence: 'average', gender: 'he' },
  { name: 'Kai Ginn',             avatar: '/tokens/kai-ginn-2.webp',             baseMode: 'standard', intelligence: 'average', gender: 'he' }, // user: avg intel + avg risk; new detective-slayer art
  { name: 'Ser Toche',            avatar: '/tokens/ser-toche.webp',              baseMode: 'standard', intelligence: 'average', gender: 'she' }, // tengu rogue — silent but deadly (elven curved blade, DEX 2H)
  { name: 'El Guapo',             avatar: '/tokens/el-guapo.webp',               baseMode: 'risky',    intelligence: 'high',    gender: 'he' },  // swashbuckler — brilliant gambler, fearless, funloving
  { name: 'Gabriel',              avatar: '/tokens/gabriel.png',                 baseMode: 'cautious', intelligence: 'average', gender: 'he' },  // paladin — courageous, friendly, wise; careful with cards
  { name: 'Crisp',                avatar: '/tokens/crisp.webp',                  baseMode: 'risky',    intelligence: 'low', gender: 'they'     }, // velociraptor — pure instinct, no thinking
  { name: 'Tamsin',               avatar: '/tokens/tamsin.webp',                 baseMode: 'cautious', intelligence: 'high', gender: 'she'    },
  { name: 'Toni',                 avatar: '/tokens/antoinette-borden.webp',      baseMode: 'risky',    intelligence: 'average', gender: 'she' },
  { name: 'Agu',                  avatar: '/tokens/aguclandos-lem.webp',         baseMode: 'cautious', intelligence: 'high', gender: 'she'    }, // Aguclandos "Queen of Skanktown" Lem — flipped to she/her per user direction

  // Round 3 additions
  { name: 'Fera',                 avatar: '/tokens/fera.webp',                   baseMode: 'cautious', intelligence: 'high', gender: 'she'    }, // user: high intel + low risk
  { name: 'Gaspar',               avatar: '/tokens/gaspar.webp',                 baseMode: 'standard', intelligence: 'average', gender: 'he' }, // user: avg intel + normal risk
  { name: 'Daramid',              avatar: '/tokens/daramid.webp',                baseMode: 'cautious', intelligence: 'high', gender: 'she'    }, // user: high intel + cautious
  { name: 'Farrah',               avatar: '/tokens/farrah.webp',                 baseMode: 'standard', intelligence: 'low', gender: 'she'     },
  { name: 'Concetta',             avatar: '/tokens/concetta.webp',               baseMode: 'risky',    intelligence: 'high', gender: 'she'    }, // user: highly intelligent + risky
  { name: 'Rissa',                avatar: '/tokens/rissa.webp',                  baseMode: 'risky',    intelligence: 'average', gender: 'she' }, // user: avg intel + risky
  { name: 'Conchobar',            avatar: '/tokens/conchobar.webp',              baseMode: 'risky',    intelligence: 'low', gender: 'he'     }, // bard, pure vibes

  // Round 4 additions — user-specified with explicit intel + risk:
  { name: 'Tokala',               avatar: '/tokens/tokala.webp',                 baseMode: 'risky',    intelligence: 'low', gender: 'he'     }, // user: high risk + low intel
  { name: 'Casandalee',           avatar: '/tokens/casandalee.webp',             baseMode: 'cautious', intelligence: 'high', gender: 'she'    }, // user: low risk + high intel
  { name: 'Meyanda',              avatar: '/tokens/meyanda.webp',                baseMode: 'standard', intelligence: 'high', gender: 'she'    }, // user: avg risk + high intel

  // Round 5 additions:
  { name: 'Rhyarca',              avatar: '/tokens/rhyarca-jillyr.webp',         baseMode: 'standard', intelligence: 'average', gender: 'she' }, // user: normal risk + normal intel; Oracle of Besmara (drow art)

  // Round 6 additions — Carrion Crown villains + Caliphas NPCs + Chef:
  { name: 'Adimarus',             avatar: '/tokens/adimarus.webp',               baseMode: 'risky',    intelligence: 'high', gender: 'he'    }, // Shudderwood werewolf antipaladin of Jezelda; user: high intel + high risk
  { name: 'Estovion',             avatar: '/tokens/estovion.webp',               baseMode: 'cautious', intelligence: 'high', gender: 'he'    }, // Master of Ascanor Lodge; user: high intel + cautious
  { name: 'Auren Vrood',          avatar: '/tokens/auren-vrood.webp',            baseMode: 'standard', intelligence: 'high', gender: 'he'    }, // Whispering Way necromancer; user: high intel + normal risk
  { name: 'Tar Baphon',           avatar: '/tokens/tar-baphon.webp',             baseMode: 'standard', intelligence: 'high', gender: 'he'    }, // The Whispering Tyrant; user: high intel + normal risk
  { name: 'Farrus Richton',       avatar: '/tokens/farrus-richton.webp',         baseMode: 'risky',    intelligence: 'average', gender: 'he' }, // The Butcher of Courtaud (Farrah's grandpa ghost); user: avg intel + high risk
  { name: 'Vesorianna',           avatar: '/tokens/vesorianna.webp',             baseMode: 'standard', intelligence: 'average', gender: 'she' }, // Harrowstone warden's-wife ghost; user: avg intel + avg risk
  { name: 'Lou Candlebean',       avatar: '/tokens/lou-candlebean.webp',         baseMode: 'standard', intelligence: 'low', gender: 'she'     }, // Caliphas gnome cavalier mercenary; user: low intel + avg risk
  { name: 'Elodie',               avatar: '/tokens/elodie.webp',                 baseMode: 'standard', intelligence: 'average', gender: 'she' }, // Caliphas gnome bard / estoc-swashbuckler; user: avg intel + avg risk
  { name: 'Chef',                 avatar: '/tokens/chef.webp',                   baseMode: 'risky',    intelligence: 'high', gender: 'he'    }, // Gordon-Ramsay-but-won't-admit-it; high-intensity host (user: not specified, picking risky/high)
  // Vorkstag — skinwalker serial killer. avatar field is his TRUE
  // face (skinless butcher art). At seating-time Table.seatBot detects
  // playerId === 'vorkstag' and overlays a random tablemate's avatar
  // onto the seat (Seat.avatarOverride + Seat.impersonatedNick) — so
  // the displayed face AND 11labs voice shift every time he sits.
  // True face only shows when no one else is at the table.
  { name: 'Vorkstag',             avatar: '/tokens/vorkstag.webp',               baseMode: 'cautious', intelligence: 'high', gender: 'he'    }, // user: very intelligent + cautious

  // Round 7 additions — characters with user-specified 11labs voices:
  { name: 'Dismas',               avatar: '/tokens/dismas-aevrett.webp',         baseMode: 'risky',    intelligence: 'average', gender: 'he' }, // CC Holy Gun Paladin 11, CP-USS / Daramid Knights; user: normal intel + high risk
  { name: 'Holden',               nickname: 'Texas Holden', avatar: '/tokens/texas-holden.webp', baseMode: 'risky', intelligence: 'low', gender: 'he' }, // displayed as "Texas Holden" (poker pun, his own name is the joke he never caught onto); player_id stays 'holden'
  { name: 'Sirona',               avatar: '/tokens/sirona.webp',                 baseMode: 'standard', intelligence: 'average', gender: 'she' }, // Paladin of Sarenrae · soldierly; best friends w/ Elfrip; friendly to CP-USS
  { name: 'Duristan Silvio',      nickname: 'Duristan', avatar: '/tokens/duristan-silvio.webp',        baseMode: 'risky',    intelligence: 'low', gender: 'he'     }, // Ustalavian nobleman buffoon — displayed as "Duristan", persistence key stays
  { name: 'Bujon, Storm of Cheliax', nickname: 'Bujon', avatar: '/tokens/bujon-storm-of-cheliax.webp', baseMode: 'risky',    intelligence: 'low', gender: 'he'     }, // Iku-Turso eel-form storm-sorcerer, Kill-Steal helm
  { name: 'Rodney Smith',         nickname: 'Danger', avatar: '/tokens/rodney-danger-smith.webp', baseMode: 'cautious', intelligence: 'average', gender: 'he' }, // Rodney "Danger" Smith — CP-USS ranger/archer from Courtaud, killed Auren Vrood at Feldgrau; works under Daramid; redneck; "Nick" voice
  { name: 'Olbryn',               avatar: '/tokens/olbryn.webp',                 baseMode: 'risky',    intelligence: 'high', gender: 'he'     }, // Josh's Drow storm-sorcerer (Iron Gods) — Staff of Lightning (+2 CL to electricity); wild-magic, selfish-but-loyal
  { name: 'Binch',                avatar: '/tokens/binch.webp',                  baseMode: 'standard', intelligence: 'average', gender: 'she' }, // Cleric of Besmara — Trickery + Liberation; older woman
  { name: 'Celeb',                avatar: '/tokens/celeb.webp',                  baseMode: 'standard', intelligence: 'high', gender: 'he'     }, // Cleric of NETHYS — arcane-dabbling, wears no armor
];

const DEFAULT_STACK = parseInt(process.env.DEFAULT_STACK || '5000', 10);

// ============================================================
// PF1e GEAR ECONOMY
// ============================================================
// Five magic-item slots, each upgradeable from +1 to +5. Goal of the game:
// own a full +5 set across every slot. First player to do so is declared
// the LOOT LORD, wins, and gets logged on the Champions Board.
//
// PF1e standard prices = base item + masterwork + enhancement(bonus² × multiplier).
// Multipliers: weapon/ring ×2000, armor/shield/cloak ×1000.
// (5-slot game — amulet slot was removed to save space on seat cards.)
const GEAR_SLOTS = [
  { key: 'weapon', label: 'Weapon',  short: 'Weapon',  mw: 315,  multiplier: 2000 },   // +N rides on the player's chosen weapon
  { key: 'armor',  label: 'Armor',   short: 'Armor',   mw: 1650, multiplier: 1000 },   // +N rides on the class's worn armor
  { key: 'shield', label: 'Shield',  short: 'Shield',  mw: 170,  multiplier: 1000 },
  { key: 'cloak',  label: 'Cloak of Resistance', short: 'Cloak',   mw: 0,    multiplier: 1000 },
  { key: 'ring',   label: 'Ring of Protection',  short: 'Ring',    mw: 0,    multiplier: 2000 },
];
const GEAR_SLOT_KEYS = GEAR_SLOTS.map(s => s.key);
const GEAR_BY_KEY = Object.fromEntries(GEAR_SLOTS.map(s => [s.key, s]));

/** Price (gp) for the given slot at the given enhancement tier (1–5). */
function gearPrice(slotKey, tier) {
  const s = GEAR_BY_KEY[slotKey];
  if (!s || tier < 1 || tier > 5) return 0;
  return s.mw + tier * tier * s.multiplier;
}

/** All tier prices for one slot, useful for the bank UI. */
function gearPriceTable(slotKey) {
  return [1, 2, 3, 4, 5].map(t => ({ tier: t, price: gearPrice(slotKey, t) }));
}

/** Half of the current item's market price, rounded down. PF1e standard
 *  resale rate. Returns 0 if the slot is empty. */
function gearHockValue(slotKey, currentTier) {
  if (!currentTier) return 0;
  return Math.floor(gearPrice(slotKey, currentTier) / 2);
}

/** Total market value of everything in this gear object. */
function gearTotalValue(gear) {
  let total = 0;
  for (const k of GEAR_SLOT_KEYS) {
    const t = gear?.[k] || 0;
    if (t) total += gearPrice(k, t);
  }
  return total;
}

/** True iff every slot holds a +5 item. */
function gearIsLootLord(gear) {
  return GEAR_SLOT_KEYS.every(k => gear?.[k] === 5);
}

const stmts = {
  getPlayer:    db.prepare('SELECT * FROM players WHERE player_id = ?'),
  listPlayers:  db.prepare('SELECT * FROM players ORDER BY nickname COLLATE NOCASE'),
  listHumans:   db.prepare('SELECT * FROM players WHERE is_bot = 0 ORDER BY nickname COLLATE NOCASE'),
  listBots:     db.prepare('SELECT * FROM players WHERE is_bot = 1 ORDER BY nickname COLLATE NOCASE'),
  seedPlayer:   db.prepare(`
    INSERT OR IGNORE INTO players
      (player_id, nickname, avatar_id, chips, created_at, last_seen_at, is_bot, bot_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  touchPlayer:  db.prepare('UPDATE players SET last_seen_at = ? WHERE player_id = ?'),
  updateChips:  db.prepare('UPDATE players SET chips = ?, last_seen_at = ? WHERE player_id = ?'),
  addDebt:      db.prepare('UPDATE players SET rebuy_debt = rebuy_debt + ? WHERE player_id = ?'),
  payDebt:      db.prepare('UPDATE players SET chips = chips - ?, rebuy_debt = rebuy_debt - ? WHERE player_id = ?'),
  recordWin:    db.prepare('UPDATE players SET total_won = total_won + ?, hands_played = hands_played + 1 WHERE player_id = ?'),
  recordLoss:   db.prepare('UPDATE players SET total_lost = total_lost + ?, hands_played = hands_played + 1 WHERE player_id = ?'),
  insertHand:   db.prepare(`
    INSERT INTO hand_history (table_id, played_at, board, players_json, winners_json)
    VALUES (?, ?, ?, ?, ?)
  `),
  recentHands:  db.prepare('SELECT * FROM hand_history WHERE table_id = ? ORDER BY played_at DESC LIMIT ?'),
};

// One-shot migration: any player with non-empty `swords` (legacy sword
// inventory from the old auto-invest system) gets the full market value
// refunded to chips and their swords cleared. Runs once per boot — if
// no legacy data remains, this is a no-op.
function migrateLegacySwords() {
  const legacy = db.prepare("SELECT player_id, chips, swords FROM players WHERE swords != '{}' AND swords IS NOT NULL").all();
  if (legacy.length === 0) return;
  let totalRefund = 0;
  const tx = db.transaction(() => {
    for (const row of legacy) {
      let inv = {};
      try { inv = JSON.parse(row.swords) || {}; } catch { continue; }
      let refund = 0;
      for (const tierStr of Object.keys(inv)) {
        const tier = Number(tierStr);
        const count = Number(inv[tierStr]) || 0;
        const price = ALL_SWORD_PRICES_LEGACY[tier] || 0;
        refund += price * count;
      }
      if (refund <= 0) continue;
      totalRefund += refund;
      db.prepare('UPDATE players SET chips = chips + ?, swords = \'{}\' WHERE player_id = ?')
        .run(refund, row.player_id);
    }
  });
  tx();
  console.log(`[poker] migrated legacy swords: refunded ${totalRefund.toLocaleString()} gp across ${legacy.length} player(s); swords cleared`);
}
// Same numbers as the old ALL_SWORD_PRICES table — kept here so the
// migration above doesn't depend on the rest of the new gear system.
const ALL_SWORD_PRICES_LEGACY = { 1: 2315, 2: 8315, 3: 18315, 4: 32315, 5: 50315 };
migrateLegacySwords();

// One-shot migration: amulet slot was removed (5-slot game now). Any
// player carrying a +N amulet gets the FULL market price refunded
// (not the usual 50% hock value — this is a forced removal, not a
// player choice), and the amulet field is stripped from their gear.
// Idempotent: re-running finds nothing matching the LIKE filter.
const AMULET_PRICE = (tier) => 0 + tier * tier * 2000;  // mw=0, mult=2000
function migrateRemoveAmulet() {
  const rows = db.prepare("SELECT player_id, chips, gear FROM players WHERE gear LIKE '%amulet%'").all();
  if (rows.length === 0) return;
  let totalRefund = 0, affected = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      let gear = {};
      try { gear = JSON.parse(row.gear) || {}; } catch { continue; }
      if (!('amulet' in gear)) continue;
      const tier = Number(gear.amulet) || 0;
      const refund = tier > 0 ? AMULET_PRICE(tier) : 0;
      delete gear.amulet;
      db.prepare('UPDATE players SET chips = chips + ?, gear = ? WHERE player_id = ?')
        .run(refund, JSON.stringify(gear), row.player_id);
      totalRefund += refund;
      affected++;
    }
  });
  tx();
  console.log(`[poker] migrated: removed amulet slot, refunded ${totalRefund.toLocaleString()} gp across ${affected} player(s)`);
}
migrateRemoveAmulet();

// (Removed 2026-05-27: the migrateClearRebuyDebt() boot pass that used to
// zero out rebuy_debt on every restart. Debt tracking is back — owed to
// the First Bank of Abadar — so we let the column accumulate across boots
// like every other persisted state. The Loot Lord reset still clears
// everyone's debt to 0 (see Table.js _doFullReset), which is the only
// legitimate way to wipe it now.)

// PF1e class per AI character (drives BAB / saves / abilities). User-specified
// where known; the rest inferred from Carrion Crown / Iron Gods / etc. lore;
// anything unlisted defaults to Fighter. Re-synced from here every boot.
const BOT_CLASSES = {
  'Sirona': 'paladin', 'Gaspar': 'inquisitor', 'Tar Baphon': 'wizard', 'Bujon, Storm of Cheliax': 'sorcerer',
  'Kelda': 'rogue', 'Kate Blackwood': 'magus', 'Toni': 'magus', 'Adimarus': 'antipaladin',
  'Rhyarca': 'oracle', 'Conchobar': 'bard', 'Nomkath': 'rogue', 'Lou Candlebean': 'fighter',
  'Elodie': 'bard', 'Dismas': 'paladin', 'Vorkstag': 'rogue', 'Estovion': 'wizard',
  'Auren Vrood': 'wizard', 'Casandalee': 'oracle', 'Meyanda': 'cleric', 'Daramid': 'wizard',
  'Kovira': 'wizard', 'Tokala': 'barbarian', 'Mr. Brow': 'investigator', 'Tamsin': 'bard',
  'Concetta': 'swashbuckler', 'Farrah': 'sorcerer', 'Fera': 'rogue',
  'Elfrip': 'oracle', 'Rodney Smith': 'ranger', 'Olbryn': 'sorcerer', 'Binch': 'cleric', 'Celeb': 'cleric',   // Elfrip is a Flame-mystery oracle (fire blaster); Rodney "Danger" Smith is an archer; Olbryn is a Drow storm-sorcerer (lightning)
  'Vesorianna': 'oracle', 'Farrus Richton': 'barbarian', 'Dinvaya': 'cleric', 'Storgrim Thunderbeard': 'fighter',
  'Agu': 'inquisitor', 'Chef': 'rogue', 'Crisp': 'rogue', 'Kai Ginn': 'ranger', 'Lirienne': 'ranger',   // Crisp = deinonychus: no real class, but rogue is closest (pounce + sneak); keeps his 'bite' natural multi-attack (3 attacks, no iteratives) via BOT_WEAPONS + _attackOffsets
  'Rissa': 'druid', 'Taelys': 'gunslinger', 'Ulfred': 'cleric', 'Vaughan': 'magus', 'Duristan Silvio': 'gunslinger',   // Taelys + Duristan: PF1 gunslingers (rifles)
  'Holden': 'swashbuckler',
  'Ser Toche': 'rogue', 'El Guapo': 'swashbuckler', 'Gabriel': 'paladin',
};
// Sensible default base weapon per class so AI aren't all daggers in the dungeon.
const CLASS_WEAPON = {
  fighter:'longsword', paladin:'longsword', antipaladin:'scimitar', cavalier:'longsword',
  samurai:'katana', bloodrager:'greatsword', slayer:'longsword', warpriest:'warhammer',
  barbarian:'greataxe', ranger:'longsword', rogue:'dagger', ninja:'shortsword',   // rogues dual-wield daggers/kukris
  monk:'unarmed', brawler:'unarmed', bard:'rapier', skald:'longsword', swashbuckler:'rapier',
  magus:'longsword', cleric:'warhammer', inquisitor:'longsword', druid:'shillelagh',
  oracle:'scimitar', shaman:'quarterstaff', wizard:'quarterstaff', sorcerer:'quarterstaff',
  witch:'quarterstaff', arcanist:'quarterstaff', psychic:'dagger', alchemist:'dagger',
  investigator:'shortsword', gunslinger:'longsword', summoner:'longspear', hunter:'longspear',
  kineticist:'quarterstaff', medium:'longsword', mesmerist:'rapier', occultist:'longsword',
  spiritualist:'dagger', vigilante:'shortsword',
};
const weaponForClass = (cls) => CLASS_WEAPON[cls] || 'dagger';
// Named NPC signature weapons (override the class default). Dismas's holy
// dragon-rifle Rovadra, Gaspar's bastard sword Curator, Elodie's rapier.
const BOT_WEAPONS = {
  'Dismas': 'rovadra', 'Gaspar': 'curator', 'Elodie': 'rapier', 'Rodney Smith': 'longbow',
  'Vesorianna': 'ghosttouch', 'Farrus Richton': 'twoaxes', 'Dinvaya': 'warhammer', 'Storgrim Thunderbeard': 'battleaxe',
  'Agu': 'rapier', 'Chef': 'battleaxe', 'Crisp': 'bite', 'Kai Ginn': 'bastardsblade', 'Lirienne': 'repeatingcrossbow', 'Binch': 'scimitar', 'Celeb': 'quarterstaff',
  'Rissa': 'claws', 'Taelys': 'dvl', 'Ulfred': 'voidshard', 'Vaughan': 'radiance', 'Duristan Silvio': 'lapua',
  'Holden': 'rapier', 'Rhyarca': 'rapier', 'Concetta': 'rapier', 'Kovira': 'unarmed',   // Kovira (wizard) attacks with her Elemental Ray at-will
  'Tokala': 'chainsaw',   // 3d6 slashing two-hander, crits on 18
  'Lou Candlebean': 'gnomehammer',   // fighter dual-wielder — gnome hooked hammer (2 swings + TWF feats)
  'Nomkath': 'kukri', 'Kelda': 'dagger',   // rogues — dual-wield light blades (dagger / kukri)
  'Ser Toche': 'elvencurve',               // tengu rogue — elven curved blade (DEX two-hander)
  'Gabriel': 'redeemer',                   // Hell's Rebels paladin — green-glass greatsword Redeemer (Divine Bond makes it holy)
};
const weaponForBot = (name, cls) => BOT_WEAPONS[name] || weaponForClass(cls);

function seedRoster() {
  const now = Date.now();
  let humans = 0, bots = 0, prunedBots = 0, builtRace = 0, builtScores = 0;
  const updateBotClass  = db.prepare('UPDATE players SET class = ? WHERE player_id = ? AND is_bot = 1');
  const updateBotWeapon = db.prepare('UPDATE players SET weapon = ? WHERE player_id = ? AND is_bot = 1');
  const updateBotAvatar = db.prepare('UPDATE players SET avatar_id = ? WHERE player_id = ? AND is_bot = 1');
  const updateBotMode   = db.prepare('UPDATE players SET bot_mode = ? WHERE player_id = ? AND is_bot = 1');
  const updateBotIntel  = db.prepare('UPDATE players SET bot_intelligence = ? WHERE player_id = ? AND is_bot = 1');
  // BOT_ROSTER entries may optionally specify a short display `nickname`
  // distinct from the canonical `name` (which is also the persistence key
  // / player_id). When the bot row already exists, we update its nickname
  // column so the seat label flips to the short form on the next render.
  // Player_id never changes, so chips/gear/history stay attached.
  const updateBotNick   = db.prepare('UPDATE players SET nickname = ? WHERE player_id = ? AND is_bot = 1');
  // Bot gender is pinned from BOT_ROSTER and re-synced every boot —
  // the AI characters' pronouns shouldn't drift. Humans' gender is
  // user-set via the dropdown (lobby:setGender) and never touched here.
  const updateBotGender = db.prepare('UPDATE players SET gender = ? WHERE player_id = ? AND is_bot = 1');
  const deleteBot       = db.prepare('DELETE FROM players WHERE player_id = ? AND is_bot = 1');
  const listBotIds      = db.prepare('SELECT player_id FROM players WHERE is_bot = 1');

  const tx = db.transaction(() => {
    for (const p of ROSTER) {
      const id = p.name.toLowerCase();
      const r = stmts.seedPlayer.run(id, p.name, p.avatar, DEFAULT_STACK, now, now, 0, null);
      if (r.changes) humans++;
    }
    const currentBotIds = new Set();
    for (const p of BOT_ROSTER) {
      const id = p.name.toLowerCase();
      const displayNick = p.nickname || p.name;
      currentBotIds.add(id);
      const r = stmts.seedPlayer.run(id, displayNick, p.avatar, DEFAULT_STACK, now, now, 1, p.baseMode);
      if (r.changes) bots++;
      // Always sync the nickname (short label), avatar URL, mode, and
      // intelligence so BOT_ROSTER stays the source of truth for
      // character configuration. (Mode can drift between hands via
      // bot.maybeShiftMode(), but baseMode is what BOT_ROSTER pins.)
      updateBotNick.run(displayNick, id);
      updateBotAvatar.run(p.avatar, id);
      updateBotMode.run(p.baseMode || 'standard', id);
      updateBotIntel.run(p.intelligence || 'average', id);
      updateBotGender.run(p.gender || 'they', id);
      const cls = BOT_CLASSES[p.name] || 'fighter';
      updateBotClass.run(cls, id);
      updateBotWeapon.run(weaponForBot(p.name, cls), id);
    }
    // Prune stale bot rows from previous rosters so they don't show up in
    // the "+ Bot" picker. Humans are never pruned (their chip totals matter).
    for (const row of listBotIds.all()) {
      if (!currentBotIds.has(row.player_id)) {
        deleteBot.run(row.player_id);
        prunedBots++;
      }
    }
    // Pin per-character RACE + optional custom ability build from
    // pf1data/characterBuilds.js — the source of truth, re-synced every boot
    // (like BOT_CLASSES). race is per character; a custom `scores` array
    // overrides the class TEMPLATE for the player's current class (templates
    // stay the fallback for anyone with no custom scores). Builds are validated
    // against the 25-pt buy and warned (never blocked) so a typo can't break boot.
    const _setRaceTx   = db.prepare('UPDATE players SET race = ?, race_flex = ? WHERE player_id = ?');
    const _setScoresTx = db.prepare('UPDATE players SET ability_scores = ? WHERE player_id = ?');
    const _getRowTx    = db.prepare('SELECT player_id, class, ability_scores FROM players WHERE player_id = ?');
    for (const [name, b] of Object.entries(BUILDS)) {
      const id = name.toLowerCase();
      const row = _getRowTx.get(id);
      if (!row) continue;   // character not seeded → skip
      if (b.race) { _setRaceTx.run(RACES.raceKey(b.race), b.flex || '', id); builtRace++; }
      if (b.scores) {
        const cls = row.class || 'fighter';
        const v = validateBuild(b.scores, {});
        if (!v.ok) console.warn(`[builds] ${name} custom build invalid: ${v.errors.join('; ')}`);
        let map = {}; try { map = JSON.parse(row.ability_scores || '{}') || {}; } catch (_) { map = {}; }
        map[cls] = b.scores;
        _setScoresTx.run(JSON.stringify(map), id);
        builtScores++;
      }
    }
  });
  tx();
  if (builtRace || builtScores) console.log(`[builds] pinned race x${builtRace}, custom scores x${builtScores} from characterBuilds`);
  console.log(`[poker] seeded: humans=${humans}/${ROSTER.length} bots=${bots}/${BOT_ROSTER.length} pruned=${prunedBots} stale bots`);
}
seedRoster();

// ---- API used by sockets / game ----
function getPlayer(playerId) {
  return stmts.getPlayer.get(playerId);
}
function listPlayers() {
  return stmts.listPlayers.all();
}
// Create a brand-new HUMAN player from a typed name (the "Create New Player"
// lobby button). Sanitizes the name to a UNIQUE player_id, seeds a fresh
// DEFAULT_STACK + a starter avatar, is_bot = 0. Returns the new row, or null on
// a blank name. Used by sockets-lobby lobby:createPlayer.
function createPlayer(rawName) {
  const name = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  if (!name) return null;
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'player');
  let id = base, n = 1;
  while (stmts.getPlayer.get(id)) id = `${base}${++n}`;   // same name → name2, name3…
  const now = Date.now();
  stmts.seedPlayer.run(id, name, 'fox', DEFAULT_STACK, now, now, 0, null);
  return stmts.getPlayer.get(id);
}
// ── Poker net winnings (won − lost), fed by persistence/logger.js ───────────
// The logger owns the math (it replays hands.jsonl at boot, honors reset
// markers, and updates per hand); it hands us its live Map once via
// setPokerNets. We decorate every roster row with pokerNet/pokerHands so the
// client leaderboards can rank by RESULTS instead of current cash.
let _pokerNets = new Map();
function setPokerNets(map) { if (map) _pokerNets = map; }
function _withNet(r) {
  const n = _pokerNets.get(r.player_id);
  return { ...r, pokerNet: n ? n.net : 0, pokerHands: n ? n.hands : 0 };
}
function listHumans() { return stmts.listHumans.all().map(_withNet); }
function listBots()   { return stmts.listBots.all().map(_withNet);   }
/** Full roster snapshot for the lobby:roster event. Returns humans
 *  first (for the picker UI), then bots. The wealth-ranked
 *  leaderboard + bot picker on the client need this whole list, not
 *  just one half. */
function listAll()    { return [...listHumans(), ...listBots()]; }
function touchPlayer(playerId) {
  stmts.touchPlayer.run(Date.now(), playerId);
}
function setChips(playerId, chips) {
  stmts.updateChips.run(chips, Date.now(), playerId);
}
function addRebuyDebt(playerId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  stmts.addDebt.run(amount, playerId);
}
/** Take `amount` from chips and reduce debt by the same. Caller must
 *  pre-validate (amount > 0, amount <= chips, amount <= rebuy_debt). */
function payRebuyDebt(playerId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  stmts.payDebt.run(amount, amount, playerId);
}
// ── Abadar's compound interest ──────────────────────────────────────────────
// The clock ticks ONCE per completed POKER HAND the player is dealt into, and
// ONCE per DUNGEON RUN — NOT per action, per room, or per combat turn (so a
// player only accrues while actually seated at poker or delving). Every
// DEBT_INTEREST_TURNS ticks while they owe Abadar, the tab compounds by
// DEBT_INTEREST_RATE. Only humans carry debt, so bots never accrue. Tunable:
const DEBT_INTEREST_TURNS = 10;
const DEBT_INTEREST_RATE  = 0.05;   // +5% per 10 hands/runs, compounding
const _debtRowStmt  = db.prepare('SELECT rebuy_debt, debt_turns FROM players WHERE player_id = ?');
const _setDebtTurns = db.prepare('UPDATE players SET debt_turns = ? WHERE player_id = ?');
const _compoundDebt = db.prepare('UPDATE players SET rebuy_debt = ?, debt_turns = ? WHERE player_id = ?');
/** Advance a player's "turns in debt" clock by one. Every DEBT_INTEREST_TURNS
 *  turns the tab compounds — returns { before, after, interest } on a compound
 *  tick, else null. No-ops (and resets the clock) when the player owes nothing. */
function tickDebtTurn(playerId) {
  const row = _debtRowStmt.get(playerId);
  if (!row) return null;
  const debt = Number(row.rebuy_debt || 0);
  if (debt <= 0) { if (row.debt_turns) _setDebtTurns.run(0, playerId); return null; }
  const turns = Number(row.debt_turns || 0) + 1;
  if (turns < DEBT_INTEREST_TURNS) { _setDebtTurns.run(turns, playerId); return null; }
  const after = Math.round(debt * (1 + DEBT_INTEREST_RATE));
  _compoundDebt.run(after, turns - DEBT_INTEREST_TURNS, playerId);   // carry any remainder
  return { before: debt, after, interest: after - debt };
}
/** Update a player's pronoun set. Validates against the known
 *  values; silently no-ops otherwise. Bots' genders are pinned
 *  via seedRoster and shouldn't be set through this path. */
const _setGenderStmt = db.prepare('UPDATE players SET gender = ? WHERE player_id = ?');
function setGender(playerId, gender) {
  if (!['he', 'she', 'they'].includes(gender)) return;
  _setGenderStmt.run(gender, playerId);
}
/** Set a player's PF1e class — validated against the known base classes. */
const _setClassStmt = db.prepare('UPDATE players SET class = ? WHERE player_id = ?');
function setClass(playerId, cls) {
  if (!CLASSES[cls]) return;
  _setClassStmt.run(cls, playerId);
  // Point the legacy `experience` mirror at the NEW class's XP (per-class leveling).
  try { const p = stmts.getPlayer.get(playerId); if (p) db.prepare('UPDATE players SET experience = ? WHERE player_id = ?').run(Math.max(0, Number(_classXp(p)[cls] || 0)), playerId); } catch (_) {}
}
/** Set a player's chosen base weapon — validated against the staple list. */
const _setWeaponStmt = db.prepare('UPDATE players SET weapon = ? WHERE player_id = ?');
function setWeapon(playerId, weapon) {
  if (!STAPLE_BY_KEY[weapon]) return;
  _setWeaponStmt.run(weapon, playerId);
  // The build follows the weapon (greatsword = STR, rapier = finesse/DEX), so drop
  // the derived ability-score cache — it re-derives with the new weapon on next read.
  try { db.prepare("UPDATE players SET ability_scores = '{}' WHERE player_id = ?").run(playerId); } catch (_) {}
}
function getSwords(playerId) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return {};
  try { return JSON.parse(p.swords || '{}') || {}; } catch { return {}; }
}
function setSwords(playerId, swords) {
  const json = JSON.stringify(swords || {});
  db.prepare('UPDATE players SET swords = ? WHERE player_id = ?').run(json, playerId);
}

// ---- Gear API ----
function getGear(playerId) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return {};
  try {
    const obj = JSON.parse(p.gear || '{}') || {};
    // Defensive normalization — clamp tiers to 0..5, null missing keys.
    const out = {};
    for (const k of GEAR_SLOT_KEYS) {
      const t = Math.floor(Number(obj[k]));
      out[k] = (Number.isFinite(t) && t >= 1 && t <= 5) ? t : null;
    }
    return out;
  } catch { return {}; }
}
function setGear(playerId, gear) {
  const json = JSON.stringify(gear || {});
  db.prepare('UPDATE players SET gear = ? WHERE player_id = ?').run(json, playerId);
}

// ---- PF1 ability scores (base 25-pt array, per class — see ability_scores col) ----
const _STD_SCORES = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
const _resolveWeapon = (key) => WEAPON_LOOKUP[key] || STAPLE_BY_KEY[DEFAULT_WEAPON];
/** Compute a player's default base ability array for a class from their build
 *  (class + chosen weapon + name overrides). Pure; does not persist. */
function defaultAbilityScores(p, cls) {
  const klass = cls || p.class || 'fighter';
  return abilityProfiles.seedScores(p.nickname || p.player_id, klass, _resolveWeapon(p.weapon));
}
/** A player's base ability array for their CURRENT class (or `cls`), seeding +
 *  caching it in the per-class map on first access (mirrors class_xp). */
function getAbilityScores(playerId, cls) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return { ..._STD_SCORES };
  const klass = cls || p.class || 'fighter';
  let map = {};
  try { map = JSON.parse(p.ability_scores || '{}') || {}; } catch { map = {}; }
  if (map[klass] && Number.isFinite(map[klass].str)) return map[klass];
  const arr = defaultAbilityScores(p, klass);
  map[klass] = arr;
  try { db.prepare('UPDATE players SET ability_scores = ? WHERE player_id = ?').run(JSON.stringify(map), playerId); } catch (_) {}
  return arr;
}
/** Set a player's base ability array for a class (the future editor's write path). */
function setAbilityScores(playerId, cls, scores) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return;
  const klass = cls || p.class || 'fighter';
  let map = {};
  try { map = JSON.parse(p.ability_scores || '{}') || {}; } catch { map = {}; }
  map[klass] = scores || { ..._STD_SCORES };
  db.prepare('UPDATE players SET ability_scores = ? WHERE player_id = ?').run(JSON.stringify(map), playerId);
}

// ---- PF1 spell loadouts (per class — see prepared_spells/known_spells cols + loadouts.js) ----
// The character's CURRENT level for a class (drives default slot/known counts).
function _classLevel(p, klass) {
  let xp = 0;
  try { xp = Number(_classXp(p)[klass] || 0); } catch (_) { xp = 0; }
  return levelFromXp(Math.max(0, xp)) || 1;
}
// The casting-stat MODIFIER for a class (base 25-pt array + racial mod), so the default
// loadout's slot count includes PF1 bonus spells. (ASIs are omitted here — a minor
// under-count only matters for big-pool casters like wizard; cleric/druid prepare their
// whole implemented list regardless.)
function _castMod(playerId, klass) {
  try {
    const stat = castingAbilityFor(klass);
    if (!stat) return 0;
    const scores = getAbilityScores(playerId, klass) || {};
    const p = stmts.getPlayer.get(playerId);
    const rm = (p && RACES.raceModsFor) ? (RACES.raceModsFor(RACES.raceKey(p.race), scores, p.race_flex || '') || {}) : {};
    const score = (scores[stat] || 10) + (rm[stat] || 0);
    return Math.floor((score - 10) / 2);
  } catch (_) { return 0; }
}
/** Prepared loadout { <slotLevel>: [spellKey…] } for a class. Returns the player's SAVED
 *  loadout if they've customized one, else a fresh CRB-staple default for their current
 *  level (defaults are NOT persisted, so they auto-grow as the character levels up). */
function getPreparedSpells(playerId, cls) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return {};
  const klass = cls || p.class || 'fighter';
  let map = {};
  try { map = JSON.parse(p.prepared_spells || '{}') || {}; } catch { map = {}; }
  if (map[klass] && typeof map[klass] === 'object' && Object.keys(map[klass]).length) return map[klass];
  return loadouts.buildDefaultPrepared(klass, _classLevel(p, klass), _castMod(playerId, klass)) || {};
}
/** Save a prepared loadout for a class (the Spellbook UI's write path — Phase D). */
function setPreparedSpells(playerId, cls, prepared) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return;
  const klass = cls || p.class || 'fighter';
  let map = {};
  try { map = JSON.parse(p.prepared_spells || '{}') || {}; } catch { map = {}; }
  map[klass] = (prepared && typeof prepared === 'object') ? prepared : {};
  db.prepare('UPDATE players SET prepared_spells = ? WHERE player_id = ?').run(JSON.stringify(map), playerId);
}
/** Spells-known list [spellKey…] for a spontaneous class. Saved list if customized, else
 *  the full implemented kit in priority order (v1: no spells-known cap yet). */
function getKnownSpells(playerId, cls) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return [];
  const klass = cls || p.class || 'fighter';
  let map = {};
  try { map = JSON.parse(p.known_spells || '{}') || {}; } catch { map = {}; }
  if (Array.isArray(map[klass]) && map[klass].length) return map[klass];
  return loadouts.buildDefaultKnown(klass, _classLevel(p, klass)) || [];
}
/** Save a spells-known list for a class (the Spellbook UI's write path — Phase D). */
function setKnownSpells(playerId, cls, known) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return;
  const klass = cls || p.class || 'fighter';
  let map = {};
  try { map = JSON.parse(p.known_spells || '{}') || {}; } catch { map = {}; }
  map[klass] = Array.isArray(known) ? known : [];
  db.prepare('UPDATE players SET known_spells = ? WHERE player_id = ?').run(JSON.stringify(map), playerId);
}

// ---- DOMAINS (Phase A — see pf1data/domains.js + DOMAINS-DESIGN.md) ----------
// Per-class picks, mirroring prepared/known spells. Empty/unset = the class
// DEFAULT (inquisitor liberation; cleric healing+war). setDomains validates the
// count (cleric ≤2, inquisitor ≤1) and that every key is a known domain.
const domainsData = require('../pf1data/domains');
function getDomains(playerId, cls) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return [];
  const klass = cls || p.class || 'fighter';
  const max = domainsData.maxDomainsFor(klass);
  if (!max) return [];
  let map = {};
  try { map = JSON.parse(p.domains || '{}') || {}; } catch { map = {}; }
  const saved = Array.isArray(map[klass]) ? map[klass].filter(k => domainsData.DOMAINS[k]) : [];
  if (saved.length) return saved.slice(0, max);
  const charDef = domainsData.CHAR_DOMAINS && domainsData.CHAR_DOMAINS[playerId];   // per-character default (Binch → trickery+liberation)
  if (charDef) return charDef.filter(k => domainsData.DOMAINS[k]).slice(0, max);
  return (domainsData.DEFAULTS[klass] || []).slice(0, max);
}
function setDomains(playerId, cls, picks) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return { ok: false, error: 'no such player' };
  const klass = cls || p.class || 'fighter';
  const max = domainsData.maxDomainsFor(klass);
  if (!max) return { ok: false, error: 'your class has no domains' };
  const clean = (Array.isArray(picks) ? picks : []).filter(k => domainsData.DOMAINS[k]);
  if (clean.length > max) return { ok: false, error: `a ${klass} may choose at most ${max} domain${max === 1 ? '' : 's'}` };
  let map = {};
  try { map = JSON.parse(p.domains || '{}') || {}; } catch { map = {}; }
  map[klass] = clean;   // empty = revert to the class default
  db.prepare('UPDATE players SET domains = ? WHERE player_id = ?').run(JSON.stringify(map), playerId);
  return { ok: true, domains: getDomains(playerId, klass) };
}

// ---- PF1 race (one per character; see pf1data/races.js + characterBuilds.js) ----
const _setRaceStmt = db.prepare('UPDATE players SET race = ? WHERE player_id = ?');
const _setFlexStmt = db.prepare('UPDATE players SET race_flex = ? WHERE player_id = ?');
/** A player's race key (default 'none' for legacy rows / unknown). */
function getRace(playerId) {
  const p = stmts.getPlayer.get(playerId);
  return RACES.raceKey(p && p.race);
}
/** The chosen ability for a flex race's floating +2 ('' = auto / not a flex race). */
function getRaceFlex(playerId) {
  const p = stmts.getPlayer.get(playerId);
  return (p && p.race_flex) || '';
}
/** Pin a player's race (+ optional flex ability) — boot roster sync + future editor. */
function setRace(playerId, race, flex) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return;
  _setRaceStmt.run(RACES.raceKey(race), playerId);
  if (flex !== undefined) _setFlexStmt.run(flex || '', playerId);
}

// ---- Experience / leveling API (PF1 medium track — see pf1data/xp.js) ----
// XP is PER CLASS — keyed by the player's CURRENT class. `experience` is kept as a
// mirror of the current class's XP for legacy/display. _setClassXpStmt writes both.
const _setClassXpStmt = db.prepare('UPDATE players SET class_xp = ?, experience = ? WHERE player_id = ?');
function _classXp(p) { try { return JSON.parse(p.class_xp || '{}') || {}; } catch { return {}; } }
function getXp(playerId) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return 0;
  return Math.max(0, Number(_classXp(p)[p.class || 'fighter'] || 0));
}
function setXp(playerId, xp) {
  const p = stmts.getPlayer.get(playerId); if (!p) return;
  const cls = p.class || 'fighter';
  const map = _classXp(p); map[cls] = Math.max(0, Math.floor(Number(xp) || 0));
  _setClassXpStmt.run(JSON.stringify(map), map[cls], playerId);
}
/** Add (or subtract) XP for the player's CURRENT class, clamped at 0. Returns new total. */
function addXp(playerId, amount) {
  const amt = Math.floor(Number(amount) || 0);
  if (!amt) return getXp(playerId);
  const p = stmts.getPlayer.get(playerId); if (!p) return 0;
  const cls = p.class || 'fighter';
  const map = _classXp(p); map[cls] = Math.max(0, Number(map[cls] || 0) + amt);
  _setClassXpStmt.run(JSON.stringify(map), map[cls], playerId);
  return map[cls];
}

// ---- Champions API ----
const insertChampion = db.prepare(`
  INSERT INTO champions (player_id, nickname, avatar_id, won_at, hands_to_win, final_chips)
  VALUES (?, ?, ?, ?, ?, ?)
`);
function recordChampion({ playerId, nickname, avatarId, handsToWin, finalChips }) {
  insertChampion.run(playerId, nickname, avatarId || null, Date.now(), handsToWin || null, finalChips || null);
}
function listChampions(limit = 50) {
  return db.prepare('SELECT * FROM champions ORDER BY won_at DESC LIMIT ?').all(limit);
}
/** Wipe the Champions Board (past Loot Lords). Called on a manual Full Reset so a
 *  full wipe is a true clean slate. NOT called on the Loot-Lord auto-reset (that
 *  win was just recorded). */
function resetChampions() {
  db.prepare('DELETE FROM champions').run();
}
/** Crown a player as Loot Lord — PERMANENT, survives every reset. */
const _setCrownedStmt = db.prepare('UPDATE players SET crowned = 1 WHERE player_id = ?');
function setCrowned(playerId) { _setCrownedStmt.run(playerId); }
function isCrowned(playerId) { const p = stmts.getPlayer.get(playerId); return !!(p && p.crowned); }
function recordWin(playerId, amount)  { stmts.recordWin.run(amount, playerId); }
function recordLoss(playerId, amount) { stmts.recordLoss.run(amount, playerId); }
function insertHand({ tableId, board, players, winners }) {
  stmts.insertHand.run(
    tableId,
    Date.now(),
    board,
    JSON.stringify(players),
    JSON.stringify(winners),
  );
}
function recentHands(tableId, limit = 50) {
  return stmts.recentHands.all(tableId, limit);
}

module.exports = {
  db,
  ROSTER,
  BOT_ROSTER,
  DEFAULT_STACK,
  setPokerNets,
  // Gear / Loot Lord
  GEAR_SLOTS,
  GEAR_SLOT_KEYS,
  GEAR_BY_KEY,
  gearPrice,
  gearPriceTable,
  gearHockValue,
  gearTotalValue,
  gearIsLootLord,
  getGear,
  setGear,
  getAbilityScores,
  setAbilityScores,
  getPreparedSpells,
  setPreparedSpells,
  getKnownSpells,
  setKnownSpells,
  getDomains,
  setDomains,
  getRace,
  getRaceFlex,
  setRace,
  defaultAbilityScores,
  getXp,
  setXp,
  addXp,
  recordChampion,
  listChampions,
  resetChampions,
  setCrowned,
  isCrowned,
  // Players
  getPlayer,
  listPlayers,
  createPlayer,
  listHumans,
  listBots,
  listAll,
  touchPlayer,
  setChips,
  addRebuyDebt,
  payRebuyDebt,
  tickDebtTurn,
  setGender,
  setClass,
  setWeapon,
  getSwords,
  setSwords,
  recordWin,
  recordLoss,
  insertHand,
  recentHands,
};
