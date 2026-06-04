/**
 * Voice-intent interpreter — LLM fallback for blind-mode push-to-talk.
 *
 * When the browser's regex command parser can't map a spoken phrase to a
 * routine action ("fold" / "call" / "raise 500" / ...), it forwards the
 * raw transcript here (via the `blind:interpret` socket event). We ask the
 * local Ollama model to coerce the phrase into ONE structured poker action.
 * The client then CONFIRMS that action aloud before dispatching it — an LLM
 * guess must never auto-act on a blind player's behalf.
 *
 * Lives server-side because the browser can't reach Ollama
 * (host.docker.internal / localhost:11434 aren't routable from a remote
 * client). Reuses the same endpoint/model/timeout env as banter.js.
 *
 * Returns { action, amount } where action ∈ fold|check|call|raise|allin|none
 * and amount is the raise-TO total (only for "raise", else null). Returns
 * null on any failure (model down, junk output, timeout) — the caller
 * treats both null and {action:'none'} as "didn't understand".
 */

const ENDPOINT   = process.env.LLM_ENDPOINT || 'http://host.docker.internal:11434/api/chat';
const MODEL      = process.env.LLM_MODEL || 'gemma4:e4b';
const API_KEY    = process.env.LLM_API_KEY || '';   // Bearer auth for OpenRouter / OpenAI-compatible endpoints
const TIMEOUT_MS = parseInt(process.env.LLM_BANTER_TIMEOUT_MS || '8000', 10);

const ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin', 'none']);

/**
 * @param {string} transcript  raw speech-to-text from the player
 * @param {object} ctx         { toCall, canCheck, minRaiseTo, maxTo, stack, pot }
 * @returns {Promise<{action:string, amount:number|null}|null>}
 */
async function interpretVoiceCommand(transcript, ctx = {}) {
  if (!transcript || typeof fetch !== 'function') return null;
  const sys = [
    'You translate ONE spoken phrase from a poker player into a single table action.',
    'Reply with ONLY a JSON object of the form {"action": string, "amount": number or null}.',
    'action must be exactly one of: fold, check, call, raise, allin, none.',
    'amount is the TOTAL chips to raise TO — set it only for action "raise", otherwise null.',
    'Use "call" to match the current bet, "check" only when checking is allowed,',
    '"allin" to bet everything, and "none" when the phrase is not a poker action.',
    'Interpret loose phrasing: "I\'m out"/"pass"/"muck" = fold; "match"/"see it"/"I call" = call;',
    '"bump it to 500"/"make it five hundred"/"go to 500" = raise with amount 500;',
    '"shove"/"jam"/"all the chips"/"everything" = allin; "I\'ll stay"/"knock"/"rap" = check.',
    'If they name a raise amount in words, convert it to a number.',
    `Table context: toCall=${ctx.toCall || 0}, canCheck=${!!ctx.canCheck}, ` +
      `minRaiseTo=${ctx.minRaiseTo || 0}, allInTo=${ctx.maxTo || 0}, ` +
      `myStack=${ctx.stack || 0}, pot=${ctx.pot || 0}.`,
  ].join(' ');

  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: String(transcript).slice(0, 160) },
  ];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,            // skip Gemma 4 reasoning preamble
        format: 'json',          // constrain Ollama output to valid JSON
        messages,
        options: { temperature: 0.1, num_predict: 60 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json.message?.content
             ?? json.choices?.[0]?.message?.content
             ?? json.response
             ?? null;
    if (!raw || typeof raw !== 'string') return null;

    let obj;
    try { obj = JSON.parse(raw); }
    catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);   // salvage JSON embedded in prose
      if (!m) return null;
      try { obj = JSON.parse(m[0]); } catch (_) { return null; }
    }

    let action = String(obj.action || '').toLowerCase().trim();
    if (/^all[\s-]?in$/.test(action) || action === 'shove' || action === 'jam') action = 'allin';
    if (!ACTIONS.has(action) || action === 'none') return { action: 'none', amount: null };

    let amount = null;
    if (action === 'raise') {
      amount = Number(obj.amount);
      if (!Number.isFinite(amount) || amount <= 0) amount = ctx.minRaiseTo || null;
      if (amount == null) return { action: 'none', amount: null };
      if (ctx.minRaiseTo) amount = Math.max(amount, ctx.minRaiseTo);
      if (ctx.maxTo)      amount = Math.min(amount, ctx.maxTo);
      // A raise to (or past) the all-in ceiling is just an all-in.
      if (ctx.maxTo && amount >= ctx.maxTo) { action = 'allin'; amount = null; }
    }
    // "check" when there's a bet to face is really "proceed cheaply" → call.
    if (action === 'check' && ctx.canCheck === false) action = 'call';

    return { action, amount };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { interpretVoiceCommand };
