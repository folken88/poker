/**
 * Action validators — pure functions. Take a hand snapshot + an action,
 * return { ok: true, normalized: {...} } or { ok: false, error: '...' }.
 *
 * Normalized form (server uses this, not raw client input):
 *   { type: 'fold' }
 *   { type: 'check' }
 *   { type: 'call', amount: N }      -- amount that will be added to the pot
 *   { type: 'raise', to: N, add: M } -- raise current bet TO N, costs M more
 *   { type: 'allin', add: M }        -- shove all chips
 */

const LEGAL = new Set(['fold', 'check', 'call', 'raise', 'allin']);

/**
 * @param {Object} ctx
 * @param {Object} ctx.seat          - seat state: { chipsAtTable }
 * @param {number} ctx.invested      - chips this player has put in THIS betting round
 * @param {number} ctx.currentBet    - highest bet THIS betting round any player has made
 * @param {number} ctx.minRaise      - minimum raise increment (last raise size, or BB)
 * @param {string} action            - 'fold' | 'check' | 'call' | 'raise' | 'allin'
 * @param {number|undefined} amount  - 'raise' uses `amount` as the to-amount
 */
function validate(ctx, action, amount) {
  const { seat, invested, currentBet, minRaise } = ctx;
  if (!LEGAL.has(action)) return { ok: false, error: 'illegal action: ' + action };

  const toCall = Math.max(0, currentBet - invested);
  const stack  = seat.chipsAtTable;

  if (action === 'fold') {
    return { ok: true, normalized: { type: 'fold' } };
  }

  if (action === 'check') {
    if (toCall > 0) return { ok: false, error: 'cannot check; ' + toCall + ' to call' };
    return { ok: true, normalized: { type: 'check' } };
  }

  if (action === 'call') {
    if (toCall === 0) return { ok: false, error: 'nothing to call; check instead' };
    const add = Math.min(toCall, stack);  // call short = all-in for less
    return { ok: true, normalized: { type: 'call', amount: add, allIn: add === stack } };
  }

  if (action === 'allin') {
    if (stack === 0) return { ok: false, error: 'no chips' };
    return { ok: true, normalized: { type: 'allin', add: stack, total: invested + stack } };
  }

  if (action === 'raise') {
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'raise amount required' };
    const to = Math.floor(amount);
    if (to <= currentBet) return { ok: false, error: 'raise must exceed current bet of ' + currentBet };
    const minTo = currentBet + Math.max(minRaise, 1);
    // Allow under-min raise only if it's a true all-in (player can't afford the min raise).
    const add = to - invested;
    if (add > stack) return { ok: false, error: 'not enough chips for that raise' };
    if (to < minTo && add < stack) {
      return { ok: false, error: 'raise must be at least to ' + minTo };
    }
    return { ok: true, normalized: { type: 'raise', to, add, allIn: add === stack } };
  }

  return { ok: false, error: 'unreachable' };
}

module.exports = { LEGAL, validate };
