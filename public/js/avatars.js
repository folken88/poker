/* 12 preset SVG avatars. 100x100 viewBox, designed to read at any size.
   Consistent: round colored background + a single bold character glyph.
   Easy to swap individually later if you want custom art. */
(function () {
  const c = (bg, body) =>
    `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
       <circle cx="50" cy="50" r="50" fill="${bg}"/>${body}
     </svg>`;

  // Each glyph is positioned within the 100x100 viewBox.
  const A = {
    fox: c('#2c1810', `
      <path d="M50 22 L22 38 L25 65 Q35 86 50 86 Q65 86 75 65 L78 38 Z" fill="#ea7a2a"/>
      <path d="M22 38 L18 18 L36 28 Z M78 38 L82 18 L64 28 Z" fill="#ea7a2a"/>
      <path d="M28 24 L33 32 L25 32 Z M72 24 L67 32 L75 32 Z" fill="#fff"/>
      <path d="M40 56 Q50 70 60 56 L50 80 Z" fill="#fff5e6"/>
      <circle cx="38" cy="50" r="3.5" fill="#1a0a04"/><circle cx="62" cy="50" r="3.5" fill="#1a0a04"/>
      <ellipse cx="50" cy="62" rx="3" ry="2" fill="#1a0a04"/>`),

    owl: c('#1f1810', `
      <ellipse cx="50" cy="56" rx="32" ry="34" fill="#7a5230"/>
      <path d="M22 32 L34 18 L40 30 Z M78 32 L66 18 L60 30 Z" fill="#5a3a20"/>
      <circle cx="38" cy="50" r="12" fill="#f5ecd6"/><circle cx="62" cy="50" r="12" fill="#f5ecd6"/>
      <circle cx="38" cy="50" r="5" fill="#1a0a04"/><circle cx="62" cy="50" r="5" fill="#1a0a04"/>
      <circle cx="40" cy="48" r="1.5" fill="#fff"/><circle cx="64" cy="48" r="1.5" fill="#fff"/>
      <path d="M46 62 L50 70 L54 62 Z" fill="#d9b06a"/>`),

    raccoon: c('#1a1a1a', `
      <ellipse cx="50" cy="55" rx="32" ry="32" fill="#9aa0a8"/>
      <path d="M24 38 L34 22 L40 38 Z M76 38 L66 22 L60 38 Z" fill="#9aa0a8"/>
      <path d="M16 50 Q30 42 44 50 Q30 60 16 50 Z M84 50 Q70 42 56 50 Q70 60 84 50 Z" fill="#1a1a1a"/>
      <circle cx="32" cy="50" r="3" fill="#fff"/><circle cx="68" cy="50" r="3" fill="#fff"/>
      <ellipse cx="50" cy="65" rx="5" ry="3.5" fill="#3a2418"/>
      <path d="M50 68 L46 76 L54 76 Z" fill="#3a2418"/>`),

    knight: c('#202840', `
      <path d="M50 18 Q28 22 26 50 L26 70 Q26 88 50 88 Q74 88 74 70 L74 50 Q72 22 50 18 Z" fill="#c7d1de"/>
      <rect x="44" y="44" width="12" height="6" fill="#1a1f2e"/>
      <path d="M50 18 L40 12 L60 12 Z" fill="#ea3535"/>
      <path d="M26 50 L26 60 L74 60 L74 50 Z" fill="#8a96a8" opacity=".5"/>`),

    wizard: c('#1a0e2a', `
      <path d="M22 60 Q50 64 78 60 Q70 86 50 88 Q30 86 22 60 Z" fill="#f0d8b8"/>
      <path d="M28 60 L50 12 L72 60 Z" fill="#6a3aa8"/>
      <circle cx="50" cy="36" r="2" fill="#f5ecd6"/><circle cx="56" cy="48" r="1.5" fill="#f5ecd6"/>
      <circle cx="44" cy="50" r="1.5" fill="#f5ecd6"/>
      <path d="M50 12 L50 6" stroke="#f5ecd6" stroke-width="2" stroke-linecap="round"/>
      <circle cx="50" cy="6" r="3" fill="#f1cf83"/>
      <circle cx="42" cy="74" r="2" fill="#1a0a04"/><circle cx="58" cy="74" r="2" fill="#1a0a04"/>
      <path d="M36 78 Q40 88 50 88 Q60 88 64 78" stroke="#d9d9d9" stroke-width="3" fill="none" stroke-linecap="round"/>`),

    robot: c('#101820', `
      <rect x="22" y="28" width="56" height="48" rx="10" fill="#9aa0a8"/>
      <rect x="32" y="42" width="36" height="14" rx="3" fill="#0a1018"/>
      <circle cx="42" cy="49" r="4" fill="#7af5ff"/><circle cx="58" cy="49" r="4" fill="#7af5ff"/>
      <rect x="44" y="64" width="12" height="3" fill="#0a1018"/>
      <rect x="48" y="18" width="4" height="10" fill="#9aa0a8"/>
      <circle cx="50" cy="16" r="3" fill="#ea3535"/>`),

    cat: c('#100c14', `
      <ellipse cx="50" cy="58" rx="30" ry="30" fill="#1a1418"/>
      <path d="M24 36 L32 18 L40 36 Z M76 36 L68 18 L60 36 Z" fill="#1a1418"/>
      <path d="M28 22 L32 30 L34 24 Z M72 22 L68 30 L66 24 Z" fill="#f5b7c2"/>
      <ellipse cx="38" cy="52" rx="5" ry="7" fill="#7af56b"/>
      <ellipse cx="62" cy="52" rx="5" ry="7" fill="#7af56b"/>
      <ellipse cx="38" cy="52" rx="1.5" ry="6" fill="#1a0a04"/>
      <ellipse cx="62" cy="52" rx="1.5" ry="6" fill="#1a0a04"/>
      <path d="M46 68 L50 72 L54 68 Z" fill="#f5b7c2"/>`),

    bear: c('#2c1810', `
      <circle cx="28" cy="34" r="10" fill="#8b5a3c"/><circle cx="72" cy="34" r="10" fill="#8b5a3c"/>
      <circle cx="28" cy="34" r="5" fill="#4d2e1a"/><circle cx="72" cy="34" r="5" fill="#4d2e1a"/>
      <ellipse cx="50" cy="56" rx="32" ry="30" fill="#a86b40"/>
      <ellipse cx="50" cy="68" rx="14" ry="11" fill="#e4c19a"/>
      <circle cx="40" cy="52" r="3" fill="#1a0a04"/><circle cx="60" cy="52" r="3" fill="#1a0a04"/>
      <ellipse cx="50" cy="64" rx="3" ry="2.5" fill="#1a0a04"/>
      <path d="M50 67 L50 72 M46 72 Q50 76 54 72" stroke="#1a0a04" stroke-width="1.5" fill="none"/>`),

    frog: c('#0c1f10', `
      <ellipse cx="50" cy="58" rx="34" ry="28" fill="#5fbf3a"/>
      <ellipse cx="32" cy="32" rx="12" ry="13" fill="#5fbf3a"/>
      <ellipse cx="68" cy="32" rx="12" ry="13" fill="#5fbf3a"/>
      <circle cx="32" cy="32" r="8" fill="#f5ecd6"/>
      <circle cx="68" cy="32" r="8" fill="#f5ecd6"/>
      <circle cx="32" cy="34" r="4" fill="#1a0a04"/>
      <circle cx="68" cy="34" r="4" fill="#1a0a04"/>
      <path d="M30 64 Q50 76 70 64" stroke="#1a0a04" stroke-width="3" fill="none" stroke-linecap="round"/>
      <circle cx="40" cy="58" r="1.5" fill="#2a4a18"/><circle cx="60" cy="58" r="1.5" fill="#2a4a18"/>`),

    lion: c('#2c1810', `
      <circle cx="50" cy="52" r="34" fill="#c98a3a"/>
      <g fill="#8b5a18">
        <circle cx="20" cy="38" r="8"/><circle cx="18" cy="55" r="8"/><circle cx="22" cy="72" r="7"/>
        <circle cx="80" cy="38" r="8"/><circle cx="82" cy="55" r="8"/><circle cx="78" cy="72" r="7"/>
        <circle cx="35" cy="22" r="7"/><circle cx="50" cy="18" r="7"/><circle cx="65" cy="22" r="7"/>
      </g>
      <circle cx="50" cy="56" r="26" fill="#e4b067"/>
      <circle cx="40" cy="50" r="3" fill="#1a0a04"/><circle cx="60" cy="50" r="3" fill="#1a0a04"/>
      <ellipse cx="50" cy="62" rx="4" ry="3" fill="#1a0a04"/>
      <path d="M50 65 L46 72 M50 65 L54 72" stroke="#1a0a04" stroke-width="1.5"/>`),

    wolf: c('#0e0f12', `
      <path d="M20 50 L30 22 L40 38 L60 38 L70 22 L80 50 L78 70 Q70 88 50 88 Q30 88 22 70 Z" fill="#6e7884"/>
      <path d="M30 22 L34 30 L38 26 Z M70 22 L66 30 L62 26 Z" fill="#3c4250"/>
      <path d="M40 60 Q50 70 60 60 L60 78 L50 84 L40 78 Z" fill="#c5cad4"/>
      <circle cx="38" cy="50" r="3" fill="#f5e636"/><circle cx="62" cy="50" r="3" fill="#f5e636"/>
      <ellipse cx="50" cy="66" rx="3" ry="2" fill="#1a0a04"/>
      <path d="M46 72 L48 76 L52 76 L54 72" stroke="#1a0a04" stroke-width="1.5" fill="none"/>`),

    dragon: c('#0c1810', `
      <path d="M22 56 Q22 30 50 28 Q78 30 78 56 L76 76 Q66 88 50 88 Q34 88 24 76 Z" fill="#3aa86b"/>
      <path d="M30 30 L24 14 L36 22 Z M70 30 L76 14 L64 22 Z" fill="#1f6a40"/>
      <g fill="#28845a">
        <path d="M44 18 L48 8 L52 14 Z"/><path d="M50 14 L54 4 L58 12 Z"/>
      </g>
      <path d="M40 60 Q50 72 60 60 L60 70 L50 76 L40 70 Z" fill="#f1cf83"/>
      <ellipse cx="38" cy="50" rx="3.5" ry="4.5" fill="#ffea7a"/>
      <ellipse cx="62" cy="50" rx="3.5" ry="4.5" fill="#ffea7a"/>
      <circle cx="38" cy="51" r="1.5" fill="#1a0a04"/><circle cx="62" cy="51" r="1.5" fill="#1a0a04"/>`),
  };

  window.FolkenAvatars = A;
})();
