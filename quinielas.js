import { initTheme, fetchResultados, formatFechaAR } from './common.js';
import { SUENOS, SUENOS_MAP } from './suenos-data.js';

initTheme();

const ORDER = ['ciudad', 'provincia', 'santafe', 'cordoba', 'entrerios', 'mendoza', 'corrientes'];
let data = null;
let currentProv = 'ciudad';
let currentFecha = null;
let currentTurno = null;

async function boot() {
  data = await fetchResultados();
  renderProvPills();
  selectProvince('ciudad');
  initSuenosSearch();
}

function renderProvPills() {
  const wrap = document.getElementById('prov-pills');
  if (!wrap) return;
  wrap.innerHTML = ORDER.map(key => {
    const p = data.quinielas[key];
    return `<button class="game-pill ${key === currentProv ? 'active' : ''}" data-prov="${key}">${p.nombre}</button>`;
  }).join('');

  wrap.querySelectorAll('button[data-prov]').forEach(btn => {
    btn.addEventListener('click', () => selectProvince(btn.dataset.prov));
  });
}

function selectProvince(provKey) {
  currentProv = provKey;
  const prov = data.quinielas[provKey];
  const fechas = Object.keys(prov.fechas).sort().reverse();
  currentFecha = fechas[0];
  const turnos = Object.keys(prov.fechas[currentFecha]);
  currentTurno = turnos.find(t => (prov.fechas[currentFecha][t].extracto || []).length > 0) || turnos[0];
  renderProvPills();
  renderQuiniela();
}

function renderQuiniela() {
  const root = document.getElementById('quiniela-root');
  const prov = data.quinielas[currentProv];
  const fechas = Object.keys(prov.fechas).sort().reverse();
  const turnosObj = prov.fechas[currentFecha];
  const turnoKeys = Object.keys(turnosObj);
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
    const cabeza = extracto[0];
    const dosCifras = cabeza.slice(-2);
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
    const tKeys = Object.keys(prov.fechas[currentFecha]);
    currentTurno = tKeys[0];
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
