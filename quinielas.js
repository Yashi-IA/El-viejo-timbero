import { initTheme, fetchResultados, startAutoRefresh, formatFechaAR, formatDateTimeAR } from '/common.js';
import { SUENOS, SUENOS_MAP } from '/suenos-data.js';

initTheme();

const ORDER = ['ciudad', 'provincia', 'santafe', 'cordoba', 'entrerios', 'mendoza', 'corrientes'];
const TURNO_ORDER = ['previa', 'primera', 'primero', 'matutina', 'vespertina', 'nocturna', 'turista'];

let data = null;
let currentProv = 'ciudad';
let currentFecha = null;
let currentTurno = null;

function sortTurnos(keys) {
  return [...keys].sort((a, b) => {
    const ia = TURNO_ORDER.indexOf(a);
    const ib = TURNO_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

function getLatestPublishedTurno(turnosObj) {
  const keys = sortTurnos(Object.keys(turnosObj || {}));
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i];
    if (Array.isArray(turnosObj[k]?.extracto) && turnosObj[k].extracto.length > 0) {
      return k;
    }
  }
  return keys[0] || null;
}

function updateLastUpdatedBadge() {
  const updEl = document.getElementById('last-updated');
  if (updEl && data?.actualizadoEl) {
    updEl.textContent = `Actualizado: ${formatDateTimeAR(data.actualizadoEl)}`;
  }
}

async function boot() {
  initSuenosSearch();
  try {
    data = await fetchResultados();
    updateLastUpdatedBadge();
    renderProvPills();
    selectProvince('ciudad');

    startAutoRefresh((freshData) => {
      const prevProv = data?.quinielas?.[currentProv];
      const prevFechas = Object.keys(prevProv?.fechas || {}).sort().reverse();
      const prevLatestFecha = prevFechas[0] || null;
      const prevLatestTurno = prevLatestFecha
        ? getLatestPublishedTurno(prevProv.fechas[prevLatestFecha])
        : null;
      const wasViewingLatestFecha = !currentFecha || currentFecha === prevLatestFecha;
      const wasViewingLatestTurno = wasViewingLatestFecha && (!currentTurno || currentTurno === prevLatestTurno);

      data = freshData;
      updateLastUpdatedBadge();

      const nextProv = data?.quinielas?.[currentProv];
      const nextFechas = Object.keys(nextProv?.fechas || {}).sort().reverse();
      const nextLatestFecha = nextFechas[0] || null;

      if (wasViewingLatestFecha && nextLatestFecha) {
        currentFecha = nextLatestFecha;
        const nextLatestTurno = getLatestPublishedTurno(nextProv.fechas[currentFecha]);
        if (wasViewingLatestTurno || !nextProv.fechas[currentFecha]?.[currentTurno]) {
          currentTurno = nextLatestTurno;
        }
      } else if (currentFecha && !nextProv?.fechas?.[currentFecha]) {
        currentFecha = nextLatestFecha;
        currentTurno = currentFecha ? getLatestPublishedTurno(nextProv.fechas[currentFecha]) : null;
      }

      renderProvPills();
      renderQuiniela();
    });
  } catch (err) {
    const root = document.getElementById('quiniela-root');
    if (root) {
      root.innerHTML = `<div class="card">No se pudieron cargar los extractos de quinielas. Verificá tu conexión o reintentá en unos segundos.</div>`;
    }
  }
}

function renderProvPills() {
  const wrap = document.getElementById('prov-pills');
  if (!wrap) return;
  wrap.innerHTML = ORDER.map(key => {
    const p = data.quinielas[key];
    if (!p) return '';
    return `<button class="game-pill ${key === currentProv ? 'active' : ''}" data-prov="${key}">${p.nombre}</button>`;
  }).join('');

  wrap.querySelectorAll('button[data-prov]').forEach(btn => {
    btn.addEventListener('click', () => selectProvince(btn.dataset.prov));
  });
}

function selectProvince(provKey) {
  currentProv = provKey;
  const prov = data.quinielas[provKey];
  const fechas = Object.keys(prov?.fechas || {}).sort().reverse();
  if (fechas.length === 0) {
    currentFecha = null;
    currentTurno = null;
    renderProvPills();
    renderQuiniela();
    return;
  }
  currentFecha = fechas[0];
  currentTurno = getLatestPublishedTurno(prov.fechas[currentFecha]);
  renderProvPills();
  renderQuiniela();
}

function renderQuiniela() {
  const root = document.getElementById('quiniela-root');
  if (!root) return;
  const prov = data.quinielas[currentProv];
  const fechas = Object.keys(prov?.fechas || {}).sort().reverse();

  if (fechas.length === 0 || !currentFecha || !prov.fechas[currentFecha]) {
    root.innerHTML = `<div class="card"><p style="margin:0;color:var(--muted);">No hay extractos disponibles por el momento para <strong>${prov?.nombre || currentProv}</strong>.</p></div>`;
    return;
  }

  const turnosObj = prov.fechas[currentFecha] || {};
  const turnoKeys = sortTurnos(Object.keys(turnosObj));
  if (turnoKeys.length === 0) {
    root.innerHTML = `<div class="card"><p style="margin:0;color:var(--muted);">No hay turnos cargados para la fecha seleccionada.</p></div>`;
    return;
  }
  const turno = turnosObj[currentTurno] || turnosObj[turnoKeys[0]];

  const fechaOpts = fechas.map(f => `<option value="${f}" ${f === currentFecha ? 'selected' : ''}>${formatFechaAR(f)}</option>`).join('');
  const turnoPills = turnoKeys.map(k => {
    const t = turnosObj[k];
    return `<button class="game-pill ${k === currentTurno ? 'active' : ''}" data-turno="${k}">${t.nombre} (${t.hora})</button>`;
  }).join('');

  const extracto = turno.extracto || [];
  let bodyHtml = '';
  if (extracto.length === 0) {
    bodyHtml = `<div class="card"><p style="margin:0;color:var(--muted);">El sorteo <strong>${turno.nombre} (${turno.hora} hs)</strong> todavía está pendiente de publicación oficial.</p></div>`;
  } else {
    const cabeza = String(extracto[0] ?? '0000');
    const dosCifras = cabeza.padStart(2, '0').slice(-2);
    const sueno = SUENOS_MAP[dosCifras] || '';
    const letrasHtml = turno.letras ? `<span class="badge badge-info">Letras: ${turno.letras}</span>` : '';

    bodyHtml = `
      <div class="cabeza-card">
        <div class="cabeza-label">1º A la Cabeza — ${prov.nombre} (${turno.nombre})</div>
        <div class="cabeza-num">${cabeza}</div>
        <div class="cabeza-sueno">Terminación <strong>${dosCifras}</strong>: ${sueno} ${letrasHtml}</div>
      </div>
      <div class="extracto-grid">
        ${extracto.map((val, idx) => `
          <div class="extracto-item ${idx === 0 ? 'pos-1' : ''}">
            <span class="extracto-pos">${idx + 1}º</span>
            <span class="extracto-val">${val}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  root.innerHTML = `
    <section class="game-banner">
      <div class="banner-left">
        <h1>Quiniela de ${prov.nombre}</h1>
        <div class="banner-meta">
          <span>Sorteo Nº <strong>${turno.sorteo || '-'}</strong></span>
          <span>•</span>
          <span>${formatFechaAR(currentFecha)}</span>
          <span>• Fuente: <a href="${prov.fuenteUrl}" target="_blank" rel="noopener noreferrer">${prov.fuente}</a></span>
        </div>
      </div>
      <div class="banner-right">
        <div>
          <label for="fecha-select" style="display:block;font-size:0.74rem;color:var(--muted);margin-bottom:4px;">Fecha del sorteo</label>
          <select id="fecha-select" class="select-control">${fechaOpts}</select>
        </div>
      </div>
    </section>
    <div class="subnav-pills">${turnoPills}</div>
    ${bodyHtml}
  `;

  document.getElementById('fecha-select')?.addEventListener('change', (e) => {
    currentFecha = e.target.value;
    currentTurno = getLatestPublishedTurno(prov.fechas[currentFecha]);
    renderQuiniela();
  });
  root.querySelectorAll('button[data-turno]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTurno = btn.dataset.turno;
      renderQuiniela();
    });
  });
}

function initSuenosSearch() {
  const input = document.getElementById('suenos-search');
  const grid = document.getElementById('suenos-grid');
  if (!grid) return;

  const render = (q = '') => {
    const term = q.trim().toLowerCase();
    const filtered = SUENOS.filter(s => s.num.includes(term) || s.nombre.toLowerCase().includes(term));
    grid.innerHTML = filtered.map(s => `
      <div class="dream-card">
        <span class="dream-num">${s.num}</span>
        <span>${s.nombre}</span>
      </div>
    `).join('');
  };
  render();
  input?.addEventListener('input', (e) => render(e.target.value));
}

boot();
