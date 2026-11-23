import { initTheme, pad2, showToast } from './common.js';
import { saveJugada } from './storage.js';

initTheme();

const CONFIGS = {
  quini6: { count: 6, min: 0, max: 45 },
  lotoPlus: { count: 6, min: 0, max: 45 },
  brinco: { count: 6, min: 0, max: 39 },
  loto5: { count: 5, min: 0, max: 36 },
  laPoceada: { count: 8, min: 0, max: 99 },
  quinielaPlus: { count: 8, min: 0, max: 99 }
};

let locked = [];
let currentCombo = [];

function boot() {
  const gameSel = document.getElementById('sim-juego');
  const sumSlider = document.getElementById('sim-suma');
  const sumVal = document.getElementById('sim-suma-val');

  sumSlider.addEventListener('input', () => {
    sumVal.textContent = sumSlider.value === '0' ? 'Sin límite' : `± ${sumSlider.value}`;
  });

  const resetSlots = () => {
    const cfg = CONFIGS[gameSel.value];
    locked = Array(cfg.count).fill(false);
    currentCombo = Array(cfg.count).fill('');
    renderSlots();
  };

  gameSel.addEventListener('change', resetSlots);
  document.getElementById('btn-sim-azar').addEventListener('click', () => generate(false));
  document.getElementById('btn-sim-filtros').addEventListener('click', () => generate(true));
  document.getElementById('btn-sim-guardar').addEventListener('click', () => {
    const nums = readSlots();
    if (nums.length !== CONFIGS[gameSel.value].count) {
      return showToast('Generá o completá todos los números antes de guardar.');
    }
    const nombre = document.getElementById('sim-nombre').value.trim() || `Estrategia ${gameSel.options[gameSel.selectedIndex].text}`;
    saveJugada({ nombre, juego: gameSel.value, numeros: nums.sort((a, b) => a - b) });
    showToast('Guardada en Mis Jugadas.');
  });

  resetSlots();
}

function renderSlots() {
  const cfg = CONFIGS[document.getElementById('sim-juego').value];
  const wrap = document.getElementById('sim-slots');
  wrap.innerHTML = Array.from({ length: cfg.count }, (_, i) => `
    <div class="lock-slot">
      <input type="number" min="${cfg.min}" max="${cfg.max}" class="num-box" data-slot="${i}" value="${currentCombo[i] !== '' ? pad2(currentCombo[i]) : ''}" placeholder="--">
      <button type="button" class="lock-btn ${locked[i] ? 'locked' : ''}" data-lock="${i}">${locked[i] ? '🔒 Fijo' : '🔓 Libre'}</button>
    </div>
  `).join('');

  wrap.querySelectorAll('button[data-lock]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.lock);
      const inp = wrap.querySelector(`input[data-slot="${idx}"]`);
      if (inp.value === '' && !locked[idx]) {
        showToast('Ingresá un número antes de bloquearlo.');
        return;
      }
      currentCombo[idx] = inp.value === '' ? '' : Number(inp.value);
      locked[idx] = !locked[idx];
      renderSlots();
    });
  });
}

function readSlots() {
  return [...document.querySelectorAll('#sim-slots input')]
    .map(i => i.value.trim())
    .filter(v => v !== '')
    .map(Number);
}

function generate(useFilters) {
  const cfg = CONFIGS[document.getElementById('sim-juego').value];
  const exclRaw = document.getElementById('sim-excluir').value.trim();
  const excluded = new Set(exclRaw ? exclRaw.split(/[\s,;]+/).map(Number).filter(n => !Number.isNaN(n)) : []);
  const parityPref = document.getElementById('sim-paridad').value;
  const rangePref = document.getElementById('sim-rango').value;
  const targetSum = Number(document.getElementById('sim-suma').value);

  const inputs = [...document.querySelectorAll('#sim-slots input')];
  const fixedMap = new Map();
  inputs.forEach((inp, idx) => {
    if (locked[idx] && inp.value !== '') fixedMap.set(idx, Number(inp.value));
  });

  const pool = [];
  for (let n = cfg.min; n <= cfg.max; n++) {
    if (!excluded.has(n) && ![...fixedMap.values()].includes(n)) pool.push(n);
  }
  const needed = cfg.count - fixedMap.size;
  if (pool.length < needed) {
    return showToast('Excluiste demasiados números para completar la jugada.');
  }

  let best = null;
  const attempts = useFilters ? 400 : 1;
  const mid = Math.floor((cfg.min + cfg.max) / 2);

  for (let t = 0; t < attempts; t++) {
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const pick = shuffled.slice(0, needed);
    const candidate = [];
    let pIdx = 0;
    for (let i = 0; i < cfg.count; i++) {
      candidate.push(fixedMap.has(i) ? fixedMap.get(i) : pick[pIdx++]);
    }
    if (!useFilters) { best = candidate; break; }

    const pares = candidate.filter(n => n % 2 === 0).length;
    const altos = candidate.filter(n => n > mid).length;
    const suma = candidate.reduce((a, b) => a + b, 0);

    const okPar = parityPref === 'any' || (parityPref === 'equilibrado' && Math.abs(pares - (cfg.count - pares)) <= 2) || (parityPref === 'mas_pares' && pares > cfg.count / 2) || (parityPref === 'mas_impares' && pares < cfg.count / 2);
    const okRan = rangePref === 'any' || (rangePref === 'equilibrado' && Math.abs(altos - (cfg.count - altos)) <= 2) || (rangePref === 'altos' && altos > cfg.count / 2) || (rangePref === 'bajos' && altos < cfg.count / 2);
    const okSum = targetSum === 0 || Math.abs(suma - targetSum) <= 25;

    if (okPar && okRan && okSum) {
      best = candidate;
      break;
    }
    best = candidate;
  }

  currentCombo = best;
  renderSlots();
  const suma = best.reduce((a, b) => a + b, 0);
  const pares = best.filter(n => n % 2 === 0).length;
  document.getElementById('sim-stats').innerHTML = `
    <span class="badge badge-info">Suma total: ${suma}</span>
    <span class="badge badge-ultimo">Pares: ${pares} / Impares: ${best.length - pares}</span>
  `;
}

boot();
