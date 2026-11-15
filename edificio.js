// Dibujo de la fachada: torres A y B (22 pisos, 4 aptos por piso) y los 4 parrilleros en la base.
window.Edificio = (() => {
  const PISOS = 22, APTOS = 4, FH = 23, TOP = 96, BASE = TOP + PISOS * FH;
  function dibujar(svg, onPick) {
    let s = `<defs><linearGradient id="gl" x1="0" x2="1"><stop offset="0" stop-color="#cfe6f2"/><stop offset=".55" stop-color="#eef6fb"/><stop offset="1" stop-color="#a9cde0"/></linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f86b3"/><stop offset="1" stop-color="#0e4a6b"/></linearGradient></defs>
    <circle cx="470" cy="150" r="46" fill="#ffb36b" opacity=".75"/>
    <rect x="0" y="${BASE + 46}" width="600" height="200" fill="url(#sea)"/>
    <path d="M0 ${BASE + 46} Q150 ${BASE + 38} 300 ${BASE + 46} T600 ${BASE + 46} V${BASE + 70} H0Z" fill="#f1dfc0"/>`;
    [['A', 70], ['B', 330]].forEach(([t, x]) => {
      const W = 200;
      s += `<rect x="${x + 8}" y="${TOP - 14}" width="${W}" height="${PISOS * FH + 14}" fill="#000" opacity=".12"/>
      <rect x="${x}" y="${TOP - 18}" width="${W}" height="${PISOS * FH + 18}" rx="3" fill="url(#gl)" stroke="#7c97a8"/>
      <rect x="${x + 70}" y="${TOP - 34}" width="60" height="16" fill="#9fb6c4"/>
      <text x="${x + W / 2}" y="${TOP - 4}" text-anchor="middle" font-size="13" font-weight="800" fill="#0e4a6b">TORRE ${t}</text>`;
      for (let p = 1; p <= PISOS; p++) {
        const y = BASE - p * FH;
        s += `<line x1="${x}" x2="${x + W}" y1="${y + FH}" y2="${y + FH}" stroke="#7c97a8" stroke-width=".6"/>`;
        for (let u = 1; u <= APTOS; u++) s += `<rect class="w" data-t="${t}" data-p="${p}" data-u="${u}" x="${x + 8 + (u - 1) * 48}" y="${y + 4}" width="40" height="${FH - 8}" rx="2" fill="#5d87a0"><title>Apto ${t}-${p * 100 + u}</title></rect>`;
      }
    });
    s += `<rect x="40" y="${BASE}" width="520" height="40" fill="#d9c6a6" stroke="#a88f68"/>`;
    for (let i = 1; i <= 4; i++) {
      const cx = 100 + i * 80;
      s += `<g><rect x="${cx - 24}" y="${BASE + 6}" width="48" height="28" rx="4" fill="#6b4a33"/><rect class="fuego" data-g="${i}" x="${cx - 18}" y="${BASE + 10}" width="36" height="8" fill="#e4572e"/>
      <text x="${cx}" y="${BASE + 31}" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">${i}</text></g>`;
    }
    svg.innerHTML = s;
    if (onPick) svg.addEventListener('click', (e) => { const w = e.target.closest('.w'); if (w) onPick(w.dataset.t, +w.dataset.p, +w.dataset.u); });
    else svg.classList.add('static');
  }
  function marcar(svg, t, p, u) {
    svg.querySelectorAll('.w.sel').forEach((w) => w.classList.remove('sel'));
    const w = svg.querySelector(`.w[data-t="${t}"][data-p="${p}"][data-u="${u}"]`);
    if (w) w.classList.add('sel');
  }
  function fuegos(svg, ocupados) { svg.querySelectorAll('.fuego').forEach((f) => f.setAttribute('fill', ocupados.includes(+f.dataset.g) ? '#8a8a8a' : '#e4572e')); }
  return { dibujar, marcar, fuegos, PISOS, APTOS };
})();
