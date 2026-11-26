const THEME_KEY = 'evt_theme';
const RAW_DATOS_URL = 'https://raw.githubusercontent.com/Yashi-IA/El-viejo-timbero/datos/resultados.json';
const JSDELIVR_DATOS_URL = 'https://cdn.jsdelivr.net/gh/Yashi-IA/El-viejo-timbero@datos/resultados.json';

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

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || typeof json !== 'object' || !json.poceados || !json.quinielas) {
      throw new Error('Estructura de resultados.json inválida');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

let _cacheResultados = null;
export async function fetchResultados() {
  if (_cacheResultados) return _cacheResultados;

  // 1) Rama datos en GitHub Raw (0 créditos en Netlify)
  try {
    _cacheResultados = await fetchJsonWithTimeout(
      `${RAW_DATOS_URL}?t=${Date.now()}`,
      { cache: 'no-store' },
      5000
    );
    return _cacheResultados;
  } catch (_) {
    // Continúa con jsDelivr CDN
  }

  // 2) Fallback 1: CDN jsDelivr sobre rama datos
  try {
    _cacheResultados = await fetchJsonWithTimeout(
      `${JSDELIVR_DATOS_URL}?t=${Math.floor(Date.now() / 60000)}`,
      {},
      5000
    );
    return _cacheResultados;
  } catch (_) {
    // Continúa con copia local en Netlify
  }

  // 3) Fallback 2: Copia estática local
  try {
    _cacheResultados = await fetchJsonWithTimeout(
      `/resultados.json?t=${Date.now()}`,
      { cache: 'no-store' },
      5000
    );
    return _cacheResultados;
  } catch (err) {
    throw new Error(`No se pudo cargar resultados.json (${err.message})`);
  }
}

export function formatFechaAR(isoDate) {
  if (!isoDate) return '-';
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function formatDateTimeAR(isoString) {
  if (!isoString) return '-';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return String(isoString);
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(dt);
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