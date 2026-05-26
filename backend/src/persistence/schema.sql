-- Folken Poker schema. Idempotent.
-- v0.2: prototype/testing identity model — players are a fixed roster
-- seeded on boot. Each connection picks a player from the roster; no auth.
-- Chips are persistent per player name across sessions.

CREATE TABLE IF NOT EXISTS players (
    player_id      TEXT PRIMARY KEY,           -- lowercased name, used as stable id
    nickname       TEXT NOT NULL,              -- display form ("LEEESA", "Tobis", ...)
    avatar_id      TEXT NOT NULL,
    chips          INTEGER NOT NULL DEFAULT 5000,
    total_won      INTEGER NOT NULL DEFAULT 0,
    total_lost     INTEGER NOT NULL DEFAULT 0,
    hands_played   INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at);

CREATE TABLE IF NOT EXISTS hand_history (
    id             INTEGER PRIMARY KEY,
    table_id       TEXT NOT NULL,
    played_at      INTEGER NOT NULL,
    board          TEXT,
    players_json   TEXT NOT NULL,
    winners_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hand_history_played ON hand_history(played_at);
CREATE INDEX IF NOT EXISTS idx_hand_history_table  ON hand_history(table_id, played_at);
