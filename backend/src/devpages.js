/**
 * Hidden DEV / reference pages — NOT linked anywhere in the UI. Visit directly:
 *   /monsters  — every loaded monster, grouped by CR, compact stats
 *   /spells    — every class ability / spell, compact
 *   /classes   — every class kit (hit die, BAB, saves) + its abilities
 *
 * Read-only for now (pure information); later these can grow edit controls.
 * Data is pulled live from the running game modules, so it's always current.
 */
const { MON, BOSS_KEYS } = require('./game/Dungeon');
const { KITS } = require('./pf1data/abilities');
const { CLASSES } = require('./pf1data/classes');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── shared page shell ───────────────────────────────────────────────────────
const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d100c; color: #d8d2c2; font: 13px/1.45 ui-monospace, "Cascadia Code", Consolas, monospace; }
  header { position: sticky; top: 0; background: #12160f; border-bottom: 1px solid #2a3320; padding: 8px 14px; display: flex; gap: 16px; align-items: baseline; z-index: 2; }
  header h1 { margin: 0; font-size: 15px; color: #e7cf8e; font-weight: 700; }
  header nav a { color: #9fd29f; text-decoration: none; margin-right: 12px; }
  header nav a:hover { color: #e7cf8e; text-decoration: underline; }
  header .count { color: #7d8a6e; font-size: 12px; }
  main { padding: 10px 14px 60px; }
  h2 { color: #e7cf8e; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; margin: 18px 0 6px; border-bottom: 1px solid #2a3320; padding-bottom: 3px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
  th, td { text-align: left; padding: 2px 8px 2px 0; white-space: nowrap; vertical-align: top; }
  th { color: #7d8a6e; font-weight: 600; border-bottom: 1px solid #2a3320; position: sticky; top: 39px; background: #0d100c; }
  tr:hover td { background: #151a10; }
  td.name { color: #f0e9d6; font-weight: 600; }
  td.desc { white-space: normal; color: #aab39a; max-width: 640px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tag { display: inline-block; padding: 0 5px; border-radius: 4px; margin: 0 3px 2px 0; font-size: 11px; }
  .tag.fire { background: #5a2a18; color: #ffb38a; } .tag.cold { background: #1b3a52; color: #9fd2ff; }
  .tag.heal { background: #4a3a14; color: #ffe39a; } .tag.buff { background: #1b2f52; color: #9fb8ff; }
  .tag.debuff { background: #3a1b52; color: #d2a0ff; } .tag.special { background: #233019; color: #b6e08a; }
  .tag.boss { background: #5a3a10; color: #ffcf7a; }
  .img { width: 26px; height: 26px; border-radius: 4px; object-fit: cover; vertical-align: middle; }
  .muted { color: #6b7560; }
`;
function shell(title, count, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} — Folken Dev</title><style>${STYLE}</style></head>
<body><header>
<a href="/" style="color:#e7cf8e;text-decoration:none;border:1px solid #2a3320;border-radius:5px;padding:3px 9px;background:#1a2014">← Back to table</a>
<h1>🛠 ${esc(title)}</h1><span class="count">${esc(count)}</span>
<nav><a href="/api/monsters">monsters</a><a href="/api/spells">spells</a><a href="/api/classes">classes</a></nav></header>
<main>${body}</main></body></html>`;
}

// ── /monsters ───────────────────────────────────────────────────────────────
function monsterSpecials(m) {
  const t = [];
  if (m.caster) t.push(`<span class="tag debuff">caster:${esc(m.caster)}</span>`);
  if (m.shout) t.push(`<span class="tag special">${m.shout.fear ? 'fear-gaze' : 'shout'} DC${m.shout.dc}</span>`);
  if (m.taunt) t.push(`<span class="tag special">taunt DC${m.taunt.dc}</span>`);
  if (m.detonate) t.push(`<span class="tag fire">detonate</span>`);
  if (m.paralyze) t.push(`<span class="tag debuff">paralyze DC${m.paralyzeDC || '?'}</span>`);
  if (m.sneakDice) t.push(`<span class="tag special">sneak ${m.sneakDice}d6</span>`);
  if (m.evasion) t.push(`<span class="tag special">evasion</span>`);
  if (m.flying) t.push(`<span class="tag special">flying</span>`);
  if (m.explode) t.push(`<span class="tag fire">explode</span>`);
  if (m.resist) for (const [k, v] of Object.entries(m.resist)) t.push(`<span class="tag ${k === 'fire' ? 'fire' : k === 'cold' ? 'cold' : 'special'}">${esc(k)} ×${v}</span>`);
  return t.join('');
}
function monstersPage() {
  const keys = Object.keys(MON).sort((a, b) => MON[a].crNum - MON[b].crNum || MON[a].name.localeCompare(MON[b].name));
  // group by CR (use the printed cr label)
  const groups = new Map();
  for (const k of keys) { const cr = MON[k].cr || '?'; if (!groups.has(cr)) groups.set(cr, []); groups.get(cr).push(k); }
  const ordered = [...groups.keys()].sort((a, b) => MON[groups.get(a)[0]].crNum - MON[groups.get(b)[0]].crNum);
  const dmgStr = (m) => `${m.dmgCount && m.dmgCount > 1 ? m.dmgCount : ''}d${m.dmgDie}${m.dmgBonus ? '+' + m.dmgBonus : ''}`;
  let body = '';
  for (const cr of ordered) {
    const rows = groups.get(cr).map(k => {
      const m = MON[k];
      const art = m.art ? `<img class="img" src="${esc(m.art)}" loading="lazy"/>` : `<span style="font-size:18px">${esc(m.glyph || '')}</span>`;
      return `<tr>
        <td>${art}</td>
        <td class="name">${esc(m.name)}${BOSS_KEYS.has(k) ? ' <span class="tag boss">boss</span>' : ''} <span class="muted">${esc(k)}</span></td>
        <td class="num">${m.hp}</td><td class="num">${m.ac}</td>
        <td class="num">+${m.toHit}</td><td>${dmgStr(m)}${m.attacks > 1 ? ` ×${m.attacks}` : ''}</td>
        <td class="num">+${m.fort}</td><td class="num">+${m.reflex}</td>
        <td>${esc(m.align || 'NE')}</td>
        <td>${monsterSpecials(m)}</td>
        <td class="muted">${m.gold ? m.gold[0] + '–' + m.gold[1] : ''}</td>
      </tr>`;
    }).join('');
    body += `<h2>CR ${esc(cr)} <span class="muted">(${groups.get(cr).length})</span></h2>
      <table><thead><tr><th></th><th>Name</th><th>HP</th><th>AC</th><th>Atk</th><th>Dmg</th><th>Fort</th><th>Ref</th><th>Align</th><th>Specials</th><th>Gold</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  return shell('Monsters', `${keys.length} loaded`, body);
}

// ── /spells ─────────────────────────────────────────────────────────────────
function spellsPage() {
  // Collect every ability across all kits, keyed by key, tracking owning classes.
  const byKey = new Map();
  for (const [cls, kit] of Object.entries(KITS)) {
    const all = [kit.atwill, ...(kit.abilities || [])].filter(Boolean);
    for (const ab of all) {
      if (!ab.key) continue;
      if (!byKey.has(ab.key)) byKey.set(ab.key, { ab, classes: new Set() });
      byKey.get(ab.key).classes.add(cls);
    }
  }
  const KIND = { aoe: 'fire', disintegrate: 'fire', touch: 'fire', rays: 'fire', bolt: 'cold', missile: 'buff', heal: 'heal', revive: 'heal', buff: 'buff', smite: 'buff', haste: 'buff', invisible: 'buff', judgment: 'buff', taunt: 'debuff', save_debuff: 'debuff', grease: 'debuff', sleep: 'debuff', slow: 'debuff', fascinate: 'debuff', cleanse: 'buff' };
  const rows = [...byKey.values()]
    .sort((a, b) => (a.ab.slvl ?? 99) - (b.ab.slvl ?? 99) || a.ab.name.localeCompare(b.ab.name))
    .map(({ ab, classes }) => {
      const dice = ab.dice != null ? `${ab.dice}d${ab.die || 6}${ab.dcap ? ` (cap ${ab.dcap})` : ''}` : '';
      const tag = KIND[ab.effect] || 'special';
      return `<tr>
        <td style="font-size:16px">${esc(ab.icon || '')}</td>
        <td class="name">${esc(ab.name)} <span class="muted">${esc(ab.key)}</span></td>
        <td><span class="tag ${tag}">${esc(ab.effect || '')}</span></td>
        <td>${ab.slvl != null ? esc(ab.slvl) : '<span class="muted">—</span>'}</td>
        <td>${esc(ab.cost || '')}</td>
        <td>${ab.save ? esc(ab.save) : '<span class="muted">—</span>'}</td>
        <td>${esc(dice)} ${ab.dtype ? `<span class="tag ${KIND[ab.dtype] || 'special'}">${esc(ab.dtype)}</span>` : ''}</td>
        <td>${ab.maxTargets > 1 ? '×' + ab.maxTargets : (ab.randFoes ? `1d${ab.randFoes}` : ab.randN ? `${ab.randN}d${ab.randDie}` : '1')}</td>
        <td class="muted">${[...classes].sort().join(', ')}</td>
        <td class="desc">${esc(ab.desc || '')}</td>
      </tr>`;
    }).join('');
  const body = `<table><thead><tr><th></th><th>Name</th><th>Effect</th><th>SpLvl</th><th>Cost</th><th>Save</th><th>Dice</th><th>Tgts</th><th>Classes</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`;
  return shell('Spells & Abilities', `${byKey.size} unique`, body);
}

// ── /classes ────────────────────────────────────────────────────────────────
function classesPage() {
  const keys = Object.keys(KITS).sort();
  let body = '';
  for (const cls of keys) {
    const kit = KITS[cls];
    const c = CLASSES[cls] || {};
    const meta = `<span class="muted">HD d${c.hd || '?'} · BAB ${esc(c.bab || '?')} · Fort ${esc(c.fort || '?')} / Ref ${esc(c.ref || '?')} / Will ${esc(c.will || '?')}${kit.caster ? ' · CASTER' : ''}${kit.note ? ' · ' + esc(kit.note) : ''}</span>`;
    const atwill = kit.atwill ? `<tr><td class="name">${esc(kit.atwill.icon || '')} ${esc(kit.atwill.name)}</td><td>at-will</td><td>${esc(kit.atwill.effect || 'attack')}</td><td></td><td></td><td class="desc">${esc(kit.atwill.desc || '')}</td></tr>` : '';
    const rows = (kit.abilities || []).map(ab => `<tr>
      <td class="name">${esc(ab.icon || '')} ${esc(ab.name)}</td>
      <td>${esc(ab.cost || '')}</td>
      <td>${esc(ab.effect || '')}</td>
      <td>${ab.slvl != null ? 'sp' + esc(ab.slvl) : ''}</td>
      <td>${ab.minLevel ? 'Lv' + ab.minLevel : ''}</td>
      <td class="desc">${esc(ab.desc || '')}</td>
    </tr>`).join('');
    body += `<h2>${esc(c.name || cls)} <span class="muted">${esc(cls)}</span></h2><div style="margin-bottom:4px">${meta}</div>
      <table><thead><tr><th>Ability</th><th>Cost</th><th>Effect</th><th>SpLvl</th><th>Unlock</th><th>Description</th></tr></thead><tbody>${atwill}${rows}</tbody></table>`;
  }
  return shell('Classes', `${keys.length} kits`, body);
}

function registerDevPages(app) {
  // Served under /api/* because that path reliably proxies to the backend (the
  // bare /monsters etc. fall through to the SPA's index.html). Both are wired.
  for (const [path, page] of [['monsters', monstersPage], ['spells', spellsPage], ['classes', classesPage]]) {
    const handler = (_req, res) => res.type('html').send(page());
    app.get('/' + path, handler);
    app.get('/api/' + path, handler);
  }
}

module.exports = { registerDevPages };
