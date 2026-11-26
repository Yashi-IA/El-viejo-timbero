import { initTheme, fetchResultados, formatFechaAR, formatDateTimeAR, pad2 } from '/common.js';

initTheme();

const ORDER = ['quini6', 'lotoPlus', 'telekino', 'brinco', 'loto5', 'laPoceada', 'quinielaPlus'];
let data = null;
let currentGame = 'quini6';
let currentDrawIndex = 0;

function formatPozo(raw) {
  if (!raw) return 'A confirmar';
  const s = String(raw).trim();
  if (/^\$\s*\d{6,}$/.test(s)) {
    const digits = s.replace(/[^\d]/g, '');
    const formatted = Number(digits).toLocaleString('es-AR');
    return `$ ${formatted}`;
  }
  return s.replace(/^\$\s*/, '$ ');
}

function getSortedUniqueDraws(game) {
  const raw = [game.ultimo, ...(game.historico || [])].filter(d => d && d.sorteo);
  const seen = new Set();
  const unique = [];
  for (const d of raw) {
    const s = Number(d.sorteo);
    if (seen.has(s)) continue;
    seen.add(s);
    unique.push(d);
  }
  return unique.sort((a, b) => Number(b.sorteo) - Number(a.sorteo));
}

function renderPremioRow(p) {
  const gStr = String(p.ganadores ?? '').trim();
  const isVacante = p.ganadores === 0 || gStr === '0' || /^vac/i.test(gStr) || /^sin\s*gan/i.test(gStr);
  const isPending = !isVacante && (!gStr || /^(ver extracto|a confirmar|procesando|-|—)$/i.test(gStr));

  let ganHtml;
  let montoMostrado;
  if (isVacante) {
    ganHtml = '<span class="vacante-pill">Vacante</span>';
    montoMostrado = formatPozo(p.pozo && p.pozo !== 'Vacante' ? p.pozo : 'Vacante');
  } else if (isPending) {
    ganHtml = '<span style="color:var(--muted);">A confirmar</span>';
    montoMostrado = p.pozo && !/ver extracto/i.test(p.pozo) ? formatPozo(p.pozo) : 'A confirmar';
  } else {
    const numGan = Number(String(gStr).replace(/\./g, ''));
    ganHtml = !Number.isNaN(numGan) && /^\d+$/.test(String(gStr).replace(/\./g, ''))
      ? numGan.toLocaleString('es-AR')
      : gStr;
    const ind = p.premioIndividual && !/^(—|-|ver extracto)$/i.test(String(p.premioIndividual).trim())
      ? p.premioIndividual
      : p.pozo;
    montoMostrado = ind ? formatPozo(ind) : '-';
  }

  return `
    <tr>
      <td>${p.aciertos}</td>
      <td class="num">${ganHtml}</td>
      <td class="num"><strong>${montoMostrado}</strong></td>
    </tr>
  `;
}

async function boot() {
  try {
    data = await fetchResultados();
    const updEl = document.getElementById('last-updated');
    if (updEl && data.actualizadoEl) {
      updEl.textContent = `Actualizado: ${formatDateTimeAR(data.actualizadoEl)}`;
    }
    renderPills();
    renderGame();
  } catch (err) {
    const root = document.getElementById('sorteos-root');
    if (root) root.innerHTML = `<div class="card">No se pudieron cargar los resultados. Verificá que <code>resultados.json</code> esté disponible.</div>`;
  }
}

function renderPills() {
  const wrap = document.getElementById('game-pills');
  if (!wrap) return;
  wrap.innerHTML = ORDER.map(key => {
    const g = data.poceados[key];
    if (!g) return '';
    return `<button class="game-pill ${key === currentGame ? 'active' : ''}" data-game="${key}">${g.nombre}</button>`;
  }).join('') + `<a class="game-pill" href="/quinielas.html">Quinielas (7 provincias) →</a>`;

  wrap.querySelectorAll('button[data-game]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentGame = btn.dataset.game;
      currentDrawIndex = 0;
      renderPills();
      renderGame();
    });
  });
}

function renderGame() {
  const root = document.getElementById('sorteos-root');
  const game = data.poceados[currentGame];
  if (!root || !game) return;

  const draws = getSortedUniqueDraws(game);
  if (draws.length === 0) {
    root.innerHTML = `<div class="card">No hay sorteos disponibles para ${game.nombre}.</div>`;
    return;
  }
  const draw = draws[currentDrawIndex] || draws[0];
  const isLatest = currentDrawIndex === 0;

  const optionsHtml = draws.map((d, idx) =>
    `<option value="${idx}" ${idx === currentDrawIndex ? 'selected' : ''}>Sorteo Nº ${d.sorteo} — ${formatFechaAR(d.fecha)}${idx === 0 ? ' (Último)' : ''}</option>`
  ).join('');

  const bannerHtml = `
    <section class="game-banner">
      <div class="banner-left">
        <h1>${game.nombre}</h1>
        <div class="banner-meta">
          <span>Sorteo Nº <strong>${draw.sorteo}</strong></span>
          <span>•</span>
          <span>${formatFechaAR(draw.fecha)}</span>
          ${isLatest ? '<span class="badge badge-ultimo">Último</span>' : '<span class="badge badge-info">Histórico</span>'}
          <span>• Fuente: <a href="${game.fuenteUrl}" target="_blank" rel="noopener noreferrer">${game.fuente}</a></span>
        </div>
      </div>
      <div class="banner-right">
        <div>
          <label for="historico-select" class="sr-only" style="display:block;font-size:0.74rem;color:var(--muted);margin-bottom:4px;">Ver sorteos anteriores</label>
          <select id="historico-select" class="select-control">${optionsHtml}</select>
        </div>
        <div class="pozo-box">
          <span class="pozo-label">Pozo Próximo Estimado</span>
          <span class="pozo-value">${formatPozo(game.pozoProximo)}</span>
        </div>
      </div>
    </section>
  `;

  const plusChip = draw.numeroPlus !== undefined
    ? `<span class="bolilla plus" title="Número Plus">+${draw.numeroPlus}</span>`
    : '';

  const cardsHtml = `
    <div class="cards-grid-2">
      ${(draw.modalidades || []).map((mod, idx) => `
        <article class="card" id="mod-card-${idx}">
          <div class="card-header">
            <h2 class="card-title">${mod.nombre}</h2>
            <button class="collapse-btn" aria-label="Plegar o desplegar modalidad">^</button>
          </div>
          <div class="card-body">
            <div class="bolillas-row">
              ${(mod.bolillas || []).map(n => `<span class="bolilla">${pad2(n)}</span>`).join('')}
              ${idx === 0 ? plusChip : ''}
            </div>
            <table class="data-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th class="num">Ganadores</th>
                  <th class="num">Pozo / Premio</th>
                </tr>
              </thead>
              <tbody>
                ${(mod.premios || []).map(renderPremioRow).join('')}
              </tbody>
            </table>
          </div>
        </article>
      `).join('')}
    </div>
  `;

  root.innerHTML = bannerHtml + cardsHtml;

  const sel = document.getElementById('historico-select');
  if (sel) {
    sel.addEventListener('change', (e) => {
      currentDrawIndex = Number(e.target.value);
      renderGame();
    });
  }
  root.querySelectorAll('.collapse-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.card').classList.toggle('collapsed'));
  });
}

boot();
