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
  const RANK_LABEL = { T: '10' };  // display "10" but card code uses T

  function rankDisplay(r) { return RANK_LABEL[r] || r; }

  function card(code) {
    if (!code || code.length !== 2) return faceDown();
    const r = code[0].toUpperCase();
    const s = code[1].toLowerCase();
    const color = SUIT_COLOR[s] || '#101418';
    const path = SUIT_PATH[s] || SUIT_PATH.s;
    const rank = rankDisplay(r);
    const rankFontSize = rank.length > 1 ? 18 : 22;
    return `<svg viewBox="0 0 70 100" xmlns="http://www.w3.org/2000/svg" class="card-svg" aria-label="${rank} of ${s}">
      <rect x="1" y="1" width="68" height="98" rx="7" ry="7" fill="#fefefe" stroke="#1a1a1a" stroke-width="1"/>
      <g fill="${color}">
        <text x="6" y="${rankFontSize + 2}" font-family="Inter, sans-serif" font-weight="700" font-size="${rankFontSize}">${rank}</text>
        <g transform="translate(8 ${rankFontSize + 6}) scale(0.13)"><path d="${path}"/></g>
        <g transform="translate(35 50)"><g transform="translate(-25 -25) scale(0.5)"><path d="${path}"/></g></g>
        <g transform="rotate(180 35 50)">
          <text x="6" y="${rankFontSize + 2}" font-family="Inter, sans-serif" font-weight="700" font-size="${rankFontSize}">${rank}</text>
          <g transform="translate(8 ${rankFontSize + 6}) scale(0.13)"><path d="${path}"/></g>
        </g>
      </g>
    </svg>`;
  }

  function faceDown() {
    return `<svg viewBox="0 0 70 100" xmlns="http://www.w3.org/2000/svg" class="card-svg card-svg--back" aria-hidden="true">
      <rect x="1" y="1" width="68" height="98" rx="7" ry="7" fill="#0f2a1c" stroke="#1a1a1a" stroke-width="1"/>
      <rect x="5" y="5" width="60" height="90" rx="5" ry="5" fill="none" stroke="#d9b06a" stroke-width="1.5" opacity="0.5"/>
      <g stroke="#d9b06a" stroke-width="0.8" opacity="0.5" fill="none">
        <path d="M5 5 L65 95 M65 5 L5 95"/>
        <circle cx="35" cy="50" r="10"/>
        <circle cx="35" cy="50" r="18"/>
      </g>
      <text x="35" y="56" text-anchor="middle" font-family="Bebas Neue, sans-serif" font-size="14" fill="#d9b06a" letter-spacing="0.2em" opacity="0.7">FP</text>
    </svg>`;
  }

  function emptySlot() {
    return `<svg viewBox="0 0 70 100" xmlns="http://www.w3.org/2000/svg" class="card-svg card-svg--empty" aria-hidden="true">
      <rect x="1" y="1" width="68" height="98" rx="7" ry="7" fill="rgba(0,0,0,0.25)" stroke="rgba(245,236,214,0.15)" stroke-width="1" stroke-dasharray="4 3"/>
    </svg>`;
  }

  window.FolkenCards = { card, faceDown, emptySlot };
})();
