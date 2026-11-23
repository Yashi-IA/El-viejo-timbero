import { initTheme, JUEGO_LABELS, pad2, showToast } from './common.js';
import { getJugadas, deleteJugada, buildControlarUrl } from './storage.js';

initTheme();

function render() {
  const filter = document.getElementById('mj-filter').value;
  const list = getJugadas().filter(j => filter === 'all' || j.juego === filter);
  const root = document.getElementById('mj-list');

  if (list.length === 0) {
    root.innerHTML = `
      <div class="card">
        <p style="margin:0;color:var(--muted);">Todavía no tenés jugadas guardadas para este filtro. Podés crear una desde el <a href="simulador.html">Simulador</a> o guardar tu boleta en <a href="controlar-boleta.html">Controlar Boleta</a>.</p>
      </div>
    `;
    return;
  }

  root.innerHTML = `<div class="cards-grid-2">` + list.map(j => `
    <article class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">${j.nombre}</h2>
          <span style="font-size:0.8rem;color:var(--muted);">${JUEGO_LABELS[j.juego] || j.juego} • Guardada: ${j.creadaEl}</span>
        </div>
        <span class="badge badge-info">${JUEGO_LABELS[j.juego] || j.juego}</span>
      </div>
      <div class="bolillas-row">
        ${j.numeros.map(n => `<span class="bolilla">${j.juego === 'quinielas' ? n : pad2(n)}</span>`).join('')}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <a class="btn btn-primary btn-sm" href="${buildControlarUrl(j)}">CONTROLAR</a>
        <button class="btn btn-danger btn-sm" data-del="${j.id}">Eliminar</button>
      </div>
    </article>
  `).join('') + `</div>`;

  root.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteJugada(btn.dataset.del);
      showToast('Jugada eliminada.');
      render();
    });
  });
}

document.getElementById('mj-filter').addEventListener('change', render);
window.addEventListener('storage', render);
render();
