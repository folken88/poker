// Folken Poker — the ONE app version (semver). The boot log, /api/health,
// /api/version and the client topbar all read this. MANDATE (Tobias 2026-07-03):
// bump MINOR for each feature batch, PATCH for fix-only batches, and note the
// change in one line below. Newest first; keep each line short.
//
//  3.2.0  2026-07-03  enemy metamagic parity (lich/arcane blasts+nukes Empower
//                     CL12+/Maximize CL16+, once each per room) · Slow now −1
//                     Reflex (both sides) · prone attacker −4 melee
//  3.1.1  2026-07-03  lightning SFX rotation trimmed (Mjolnir→thrown-weapon
//                     reserve, umbral bolt→umbral spells) per Josh/Tobias
//  3.1.0  2026-07-03  versioning formalized · wave-2 spells (Sunburst/Prismatic/
//                     Waves of Exhaustion/Banishment/Greater Heroism/Mass
//                     Suggestion/inq Greater Dispel) · Domains Phase A data
//  3.0.x  ≤2026-07-03 the informal "v3" era (see git history)
module.exports = { VERSION: '3.2.0' };
