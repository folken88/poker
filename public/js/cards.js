/* SVG card generator — programmatic so we don't ship 52 image files.
   Card code: "As" "Td" "2c" "Kh" — pokersolver/Foundry-style.
   Ranks: 2 3 4 5 6 7 8 9 T J Q K A    Suits: s h d c */
(function () {
  const SUIT_PATH = {
    s: 'M50 14 C 32 38, 18 50, 26 68 C 30 78, 44 78, 48 70 L 46 86 L 54 86 L 52 70 C 56 78, 70 78, 74 68 C 82 50, 68 38, 50 14 Z',
    h: 'M50 86 C 18 64, 14 38, 30 26 C 42 18, 50 30, 50 36 C 50 30, 58 18, 70 26 C 86 38, 82 64, 50 86 Z',
    d: 'M50 12 L80 50 L50 88 L20 50 Z',
    c: 'M50 12 C 60 12, 66 22, 60 32 C 70 24, 84 32, 82 46 C 80 60, 64 60, 56 54 C 60 60, 60 70, 56 76 L 60 88 L 40 88 L 44 76 C 40 70, 40 60, 44 54 C 36 60, 20 60, 18 46 C 16 32, 30 24, 40 32 C 34 22, 40 12, 50 12 Z',
  };
  const SUIT_COLOR = { s: '#101418', c: '#101418', h: '#d83a3a', d: '#d83a3a' };
  // T → 10 for display. '1' → A because pokersolver represents the
  // low Ace in a wheel straight (A-2-3-4-5) as '1h' / '1s' / etc.
  // Internally we keep the '1' code so wheel cards sort correctly
  // (RANK_ORDER['1']||0 = 0 puts the Ace before the 2 in low→high
  // displays); only the rendered glyph swaps back to 'A'.
  const RANK_LABEL = { T: '10', '1': 'A' };

  function rankDisplay(r) { return RANK_LABEL[r] || r; }

  // Card viewBox is 70×106 (aspect ≈ 0.66) — matches the back-art PNG
  // exactly so face-down cards aren't cropped. Face cards inherit the
  // same dimensions for consistency. CSS sizes cards by width only,
  // using aspect-ratio: 70 / 106 to derive height.
  function card(code) {
    if (!code || code.length !== 2) return faceDown();
    const r = code[0].toUpperCase();
    const s = code[1].toLowerCase();
    const color = SUIT_COLOR[s] || '#101418';
    const path = SUIT_PATH[s] || SUIT_PATH.s;
    const rank = rankDisplay(r);
    const rankFontSize = rank.length > 1 ? 18 : 22;
    // Center of the new 70×106 viewBox is (35, 53) — the big center
    // pip + rotation pivot move with it.
    return `<svg viewBox="0 0 70 106" xmlns="http://www.w3.org/2000/svg" class="card-svg" aria-label="${rank} of ${s}">
      <rect x="1" y="1" width="68" height="104" rx="7" ry="7" fill="#fefefe" stroke="#1a1a1a" stroke-width="1"/>
      <g fill="${color}">
        <text x="6" y="${rankFontSize + 2}" font-family="Inter, sans-serif" font-weight="700" font-size="${rankFontSize}">${rank}</text>
        <g transform="translate(8 ${rankFontSize + 6}) scale(0.13)"><path d="${path}"/></g>
        <g transform="translate(35 53)"><g transform="translate(-25 -25) scale(0.5)"><path d="${path}"/></g></g>
        <g transform="rotate(180 35 53)">
          <text x="6" y="${rankFontSize + 2}" font-family="Inter, sans-serif" font-weight="700" font-size="${rankFontSize}">${rank}</text>
          <g transform="translate(8 ${rankFontSize + 6}) scale(0.13)"><path d="${path}"/></g>
        </g>
      </g>
    </svg>`;
  }

  // Card back uses a single PNG (Shackles-themed art) clipped to the
  // standard rounded-rect card silhouette. The PNG is ~2:3 native;
  // preserveAspectRatio "slice" crops it to fit the 70×100 viewbox so
  // it fills the card edge-to-edge with the corners rounded by the clip
  // path. A thin dark stroke around the rect ties it to the face cards.
  //
  // Each call uses a unique clipPath ID — the page can have many
  // face-down cards (every opponent's hole cards × 8 seats) and SVG
  // IDs are document-global, so a collision would route every clip
  // ref to whichever <defs> was parsed first.
  let _backClipSeq = 0;
  function faceDown() {
    const clipId = `cardBackClip_${++_backClipSeq}`;
    return `<svg viewBox="0 0 70 106" xmlns="http://www.w3.org/2000/svg" class="card-svg card-svg--back" aria-hidden="true">
      <defs>
        <clipPath id="${clipId}"><rect x="1" y="1" width="68" height="104" rx="7" ry="7"/></clipPath>
      </defs>
      <image href="/assets/cards/back-shackles.png?v=3" x="1" y="1" width="68" height="104" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>
      <rect x="1" y="1" width="68" height="104" rx="7" ry="7" fill="none" stroke="#1a1a1a" stroke-width="1"/>
    </svg>`;
  }

  function emptySlot() {
    return `<svg viewBox="0 0 70 106" xmlns="http://www.w3.org/2000/svg" class="card-svg card-svg--empty" aria-hidden="true">
      <rect x="1" y="1" width="68" height="104" rx="7" ry="7" fill="rgba(0,0,0,0.25)" stroke="rgba(245,236,214,0.15)" stroke-width="1" stroke-dasharray="4 3"/>
    </svg>`;
  }

  window.FolkenCards = { card, faceDown, emptySlot };
})();
