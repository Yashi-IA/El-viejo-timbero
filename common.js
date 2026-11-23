const THEME_KEY = 'evt_theme';

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  }
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY && e.newValue) applyTheme(e.newValue);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.setAttribute('aria-label', theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  }
}

let _cacheResultados = null;
export async function fetchResultados() {
  if (_cacheResultados) return _cacheResultados;
  const res = await fetch(`data/resultados.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('No se pudo cargar data/resultados.json');
  _cacheResultados = await res.json();
  return _cacheResultados;
}

export function formatFechaAR(isoDate) {
  if (!isoDate) return '-';
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function showToast(msg) {
  let el = document.getElementById('evt-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'evt-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window.__evtToastTimer);
  window.__evtToastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

export const JUEGO_LABELS = {
  quini6: 'Quini 6',
  lotoPlus: 'Loto Plus',
  telekino: 'Telekino',
  brinco: 'Brinco',
  loto5: 'Loto 5 Plus',
  laPoceada: 'La Poceada',
  quinielaPlus: 'Quiniela Plus',
  quinielas: 'Quinielas'
};
