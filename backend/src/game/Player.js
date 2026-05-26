/**
 * Player — convenience wrapper around the db row.
 * Most code uses the raw row directly; this module is a place to grow if
 * we need richer per-player methods (badges, achievements, etc).
 */

const db = require('../persistence/db');

class Player {
  constructor(row) { Object.assign(this, row); }

  static load(cookieId) {
    const row = db.getPlayer(cookieId);
    return row ? new Player(row) : null;
  }

  setChips(n) { db.setChips(this.cookie_id, n); this.chips = n; }
}

module.exports = { Player };
