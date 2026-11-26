import { initTheme, fetchResultados, formatFechaAR, pad2, showToast } from '/common.js';
import { saveJugada } from '/storage.js';

initTheme();

let data = null;

const GAME_CONFIG = {
  quini6: { count: 6, min: 0, max: 45, hint: 'Ingresá 6 números del 00 al 45.' },
  lotoPlus: { count: 6, min: 0, max: 45, hint: 'Ingresá 6 números del 00 al 45.' },
  telekino: { count: 15, min: 1, max: 25, hint: 'Ingresá los 15 números de tu cartón (01 al 25).' },
  brinco: { count: 6, min: 0, max: 39, hint: 'Ingresá 6 números del 00 al 39.' },
  loto5: { count: 5, min: 0, max: 36, hint: 'Ingresá 5 números del 00 al 36.' },
  laPoceada: { count: 8, min: 0, max: 99, hint: 'Ingresá 8 números de dos cifras (00 al 99).' },
  quinielaPlus: { count: 8, min: 0, max: 99, hint: 'Ingresá 8 números de dos cifras (00 al 99).' },
  quinielas: { count: 1, min: 0, max: 9999, hint: 'Ingresá tu número apostado (1 a 4 cifras) y elegí jurisdicción.' }
};

function getPoceadoDraws(gameKey) {
  const game = data?.poceados?.[gameKey];
  if (!game) return [];
  const raw = [game.ultimo, ...(game.historico || [])].filter(d => d && d.sorteo);
  const seen = new Set();
  const list = [];
  for (const d of raw) {
    const s = Number(d.sorteo);
    if (seen.has(s)) continue;
    seen.add(s);
    list.push(d);
  }
  return list.sort((a, b) => Number(b.sorteo) - Number(a.sorteo));
}

function populateDrawSelectors() {
  const g = document.getElementById('ctrl-juego')?.value;
  const sorteoWrap = document.getElementById('ctrl-sorteo-wrap');
  const sorteoSel = document.getElementById('ctrl-sorteo');
  const provWrap = document.getElementById('ctrl-prov-wrap');
  const provSel = document.getElementById('ctrl-prov');
  const fechaWrap = document.getElementById('ctrl-fecha-wrap');
  const fechaSel = document.getElementById('ctrl-fecha');

  if (!g) return;

  if (g === 'quinielas') {
    if (sorteoWrap) sorteoWrap.style.display = 'none';
    if (provWrap) provWrap.style.display = 'block';
    if (fechaWrap) fechaWrap.style.display = 'block';

    const prov = data?.quinielas?.[provSel?.value];
    const fechas = Object.keys(prov?.fechas || {}).sort().reverse();
    if (fechaSel) {
      fechaSel.innerHTML = fechas.length
        ? fechas.map((f, idx) => `<option value="${f}">${formatFechaAR(f)}${idx === 0 ? ' (Última)' : ''}</option>`).join('')
        : '<option value="">Sin fechas</option>';
    }
  } else {
    if (sorteoWrap) sorteoWrap.style.display = 'block';
    if (provWrap) provWrap.style.display = 'none';
    if (fechaWrap) fechaWrap.style.display = 'none';

    const draws = getPoceadoDraws(g);
    if (sorteoSel) {
      sorteoSel.innerHTML = draws.length
        ? draws.map((d, idx) => `<option value="${d.sorteo}">Nº ${d.sorteo} — ${formatFechaAR(d.fecha)}${idx === 0 ? ' (Último)' : ''}</option>`).join('')
        : '<option value="">Sin sorteos</option>';
    }
  }
}

function findMatchedPremio(mod, hitsCount) {
  const premios = Array.isArray(mod?.premios) ? mod.premios : [];
  for (const p of premios) {
    const m = String(p.aciertos || '').match(/\b(\d{1,2})\b/);
    if (m && Number(m[1]) === hitsCount) {
      return p;
    }
  }
  return null;
}

function formatPremioStatus(premio) {
  if (!premio) return '';
  const gStr = String(premio.ganadores ?? '').trim();
  const isVacante = premio.ganadores === 0 || gStr === '0' || /^vac/i.test(gStr) || /^sin\s*gan/i.test(gStr);
  if (isVacante) {
    return `<span style="color:var(--amber);font-size:0.84rem;">Premio correspondiente (${premio.aciertos}): pozo ${premio.pozo || 'Vacante'} (tu boleta sería ganadora)</span>`;
  }
  const monto = premio.premioIndividual && !/^(—|-|ver extracto)$/i.test(String(premio.premioIndividual))
    ? premio.premioIndividual
    : (premio.pozo || 'A confirmar');
  const ganTxt = !gStr || /ver extracto|a confirmar/i.test(gStr) ? 'A confirmar' : `${gStr} ganador(es)`;
  return `<span style="color:var(--emerald);font-size:0.84rem;font-weight:600;">¡Con premio! (${premio.aciertos}) — ${monto} • ${ganTxt}</span>`;
}

async function boot() {
  const out = document.getElementById('ctrl-result');
  try {
    data = await fetchResultados();
  } catch (err) {
    if (out) {
      out.innerHTML = `<div class="result-box">No se pudieron cargar los resultados oficiales. Recargá la página en unos segundos.</div>`;
    }
    return;
  }

  const gameSel = document.getElementById('ctrl-juego');
  const provSel = document.getElementById('ctrl-prov');

  const params = new URLSearchParams(window.location.search);
  const paramGame = params.get('juego');
  const paramNums = params.get('nums');
  const paramAuto = params.get('auto');

  if (paramGame && GAME_CONFIG[paramGame]) {
    gameSel.value = paramGame;
  }

  const updateInputs = (prefill = []) => {
    const g = gameSel.value;
    const cfg = GAME_CONFIG[g];
    populateDrawSelectors();
    document.getElementById('ctrl-hint').textContent = cfg.hint;
    const wrap = document.getElementById('ctrl-inputs');

    if (g === 'quinielas') {
      wrap.innerHTML = `<input type="text" maxlength="4" class="num-box" style="width:140px;" id="ctrl-q-num" placeholder="Ej: 4825" value="${prefill[0] ?? ''}">`;
    } else {
      wrap.innerHTML = Array.from({ length: cfg.count }, (_, i) => `
        <input type="number" min="${cfg.min}" max="${cfg.max}" class="num-box" data-idx="${i}" placeholder="${pad2(i + 1)}" value="${prefill[i] ?? ''}">
      `).join('');
    }
  };

  gameSel.addEventListener('change', () => {
    updateInputs();
    out.innerHTML = '';
  });

  provSel?.addEventListener('change', () => {
    populateDrawSelectors();
    out.innerHTML = '';
  });

  document.getElementById('btn-limpiar').addEventListener('click', () => {
    updateInputs();
    out.innerHTML = '';
  });

  document.getElementById('btn-controlar').addEventListener('click', runCheck);
  document.getElementById('btn-guardar-ctrl').addEventListener('click', () => {
    const g = gameSel.value;
    if (g === 'quinielas') {
      const v = document.getElementById('ctrl-q-num')?.value.trim();
      if (!v) return showToast('Ingresá un número antes de guardar.');
      saveJugada({ nombre: `Quiniela ${v}`, juego: g, numeros: [v] });
      return showToast('Jugada guardada en Mis Jugadas.');
    }
    const nums = readPoceadoNumbers();
    if (!nums) return;
    saveJugada({ nombre: `Boleta ${gameSel.options[gameSel.selectedIndex].text}`, juego: g, numeros: nums });
    showToast('Boleta guardada en Mis Jugadas.');
  });

  const initialNums = paramNums ? paramNums.split(',').map(s => s.trim()) : [];
  updateInputs(initialNums);
  if (paramAuto === '1' && initialNums.length > 0) {
    runCheck();
  }
}

function readPoceadoNumbers() {
  const g = document.getElementById('ctrl-juego').value;
  const cfg = GAME_CONFIG[g];
  const inputs = [...document.querySelectorAll('#ctrl-inputs input')];
  const vals = inputs.map(i => i.value.trim()).filter(v => v !== '').map(Number);
  if (vals.length !== cfg.count) {
    showToast(`Completá los ${cfg.count} números para controlar.`);
    return null;
  }
  const unique = new Set(vals);
  if (unique.size !== vals.length) {
    showToast('No repitas números en la misma boleta.');
    return null;
  }
  if (vals.some(n => Number.isNaN(n) || n < cfg.min || n > cfg.max)) {
    showToast(`Los números deben estar entre ${cfg.min} y ${cfg.max}.`);
    return null;
  }
  return vals.sort((a, b) => a - b);
}

function runCheck() {
  if (!data) return showToast('Esperá a que carguen los resultados.');
  const g = document.getElementById('ctrl-juego').value;
  const out = document.getElementById('ctrl-result');

  if (g === 'quinielas') {
    const raw = (document.getElementById('ctrl-q-num')?.value || '').trim();
    if (!/^\d{1,4}$/.test(raw)) {
      showToast('Ingresá entre 1 y 4 dígitos numéricos.');
      return;
    }
    const provKey = document.getElementById('ctrl-prov').value;
    const prov = data.quinielas[provKey];
    const selectedFecha = document.getElementById('ctrl-fecha')?.value
      || Object.keys(prov?.fechas || {}).sort().reverse()[0];
    const turnos = prov?.fechas?.[selectedFecha];
    if (!turnos) {
      out.innerHTML = `<div class="result-box">No hay extractos cargados para ${prov?.nombre || provKey}.</div>`;
      return;
    }
    const rows = Object.values(turnos).map(t => {
      if (!t.extracto || t.extracto.length === 0) {
        return `<tr><td>${t.nombre}</td><td>Pendiente</td><td>-</td></tr>`;
      }
      const hits = t.extracto
        .map((num, idx) => ({ num, pos: idx + 1 }))
        .filter(item => item.num.endsWith(raw));
      const summary = hits.length
        ? hits.map(h => `<strong>${h.pos}º (${h.num})</strong>`).join(', ')
        : 'Sin aciertos';
      return `<tr><td>${t.nombre} (${t.hora})</td><td>${hits.length ? '¡Acierto!' : 'No salió'}</td><td>${summary}</td></tr>`;
    }).join('');

    out.innerHTML = `
      <div class="result-box">
        <h3 style="margin-top:0;">Resultado para el número <strong>${raw}</strong> en ${prov.nombre} (${formatFechaAR(selectedFecha)})</h3>
        <table class="data-table">
          <thead><tr><th>Turno</th><th>Estado</th><th>Posiciones encontradas</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    return;
  }

  const nums = readPoceadoNumbers();
  if (!nums) return;
  const game = data.poceados[g];
  const draws = getPoceadoDraws(g);
  const selectedSorteo = Number(document.getElementById('ctrl-sorteo')?.value || 0);
  const draw = draws.find(d => Number(d.sorteo) === selectedSorteo) || draws[0] || game.ultimo;

  const modHtml = (draw.modalidades || []).map(mod => {
    const set = new Set(mod.bolillas);
    const hits = nums.filter(n => set.has(n));
    const matchedPremio = findMatchedPremio(mod, hits.length);
    const premioInfo = formatPremioStatus(matchedPremio);
    return `
      <div class="card" style="margin-bottom:12px;">
        <div class="card-header">
          <div>
            <strong>${mod.nombre}</strong>
            ${premioInfo ? `<div style="margin-top:4px;">${premioInfo}</div>` : ''}
          </div>
          <span class="badge ${matchedPremio ? 'badge-ultimo' : 'badge-info'}">${hits.length} acierto${hits.length === 1 ? '' : 's'}</span>
        </div>
        <div class="bolillas-row">
          ${mod.bolillas.map(b => `<span class="bolilla ${nums.includes(b) ? 'match' : ''}">${pad2(b)}</span>`).join('')}
        </div>
      </div>
    `;
  }).join('');

  out.innerHTML = `
    <div class="result-box">
      <h3 style="margin-top:0;">Control contra ${game.nombre} — Sorteo Nº ${draw.sorteo} (${formatFechaAR(draw.fecha)})</h3>
      <p style="color:var(--muted);margin-top:0;">Tus números: <strong>${nums.map(pad2).join(' - ')}</strong></p>
      ${modHtml}
    </div>
  `;
}

boot();
