import { initTheme, fetchResultados, formatFechaAR, pad2 } from '/common.js';

initTheme();

const ORDER = ['quini6', 'lotoPlus', 'telekino', 'brinco', 'loto5', 'laPoceada', 'quinielaPlus'];
let data = null;
let currentGame = 'quini6';
let currentDrawIndex = 0; // 0 = ultimo, >=1 = historico[index-1]

async function boot() {
  try {
    data = await fetchResultados();
    const updEl = document.getElementById('last-updated');
    if (updEl && data.actualizadoEl) {
      updEl.textContent = `Actualizado: ${new Date(data.actualizadoEl).toLocaleString('es-AR')}`;
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

  const draws = [game.ultimo, ...(game.historico || [])];
  const draw = draws[currentDrawIndex] || game.ultimo;
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
          <span class="pozo-value">${game.pozoProximo || 'A confirmar'}</span>
        </div>
      </div>
    </section>
  `;

  const plusChip = draw.numeroPlus !== undefined
    ? `<span class="bolilla plus" title="Número Plus">+${draw.numeroPlus}</span>`
    : '';

  const cardsHtml = `
    <div class="cards-grid-2">
      ${draw.modalidades.map((mod, idx) => `
        <article class="card" id="mod-card-${idx}">
          <div class="card-header">
            <h2 class="card-title">${mod.nombre}</h2>
            <button class="collapse-btn" aria-label="Plegar o desplegar modalidad">^</button>
          </div>
          <div class="card-body">
            <div class="bolillas-row">
              ${mod.bolillas.map(n => `<span class="bolilla">${pad2(n)}</span>`).join('')}
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
                ${mod.premios.map(p => {
                  const isVacante = String(p.ganadores).toLowerCase() === 'vacante';
                  const montoMostrado = isVacante ? (p.pozo || 'Vacante') : (p.premioIndividual || p.pozo || '-');
                  return `
                    <tr>
                      <td>${p.aciertos}</td>
                      <td class="num">${isVacante ? '<span class="vacante-pill">Vacante</span>' : p.ganadores}</td>
                      <td class="num"><strong>${montoMostrado}</strong></td>
                    </tr>
                  `;
                }).join('')}
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
