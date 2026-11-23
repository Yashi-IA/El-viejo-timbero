const KEY_JUGADAS = 'evt_mis_jugadas_v2';

const DEFAULT_JUGADAS = [
  {
    id: 'demo-quini-1',
    nombre: 'Jugada Fija Quini',
    juego: 'quini6',
    numeros: [4, 12, 19, 28, 35, 41],
    creadaEl: '2026-11-20'
  },
  {
    id: 'demo-brinco-1',
    nombre: 'Clásica Brinco',
    juego: 'brinco',
    numeros: [6, 9, 16, 28, 33, 34],
    creadaEl: '2026-11-21'
  }
];

export function getJugadas() {
  try {
    const raw = localStorage.getItem(KEY_JUGADAS);
    if (!raw) {
      localStorage.setItem(KEY_JUGADAS, JSON.stringify(DEFAULT_JUGADAS));
      return [...DEFAULT_JUGADAS];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveJugada(jugada) {
  const list = getJugadas();
  const item = {
    id: 'jug-' + Date.now(),
    nombre: (jugada.nombre || 'Mi Jugada').trim(),
    juego: jugada.juego,
    numeros: jugada.numeros,
    creadaEl: new Date().toISOString().slice(0, 10)
  };
  list.unshift(item);
  localStorage.setItem(KEY_JUGADAS, JSON.stringify(list));
  return item;
}

export function deleteJugada(id) {
  const list = getJugadas().filter(j => j.id !== id);
  localStorage.setItem(KEY_JUGADAS, JSON.stringify(list));
  return list;
}

export function buildControlarUrl(jugada) {
  const params = new URLSearchParams({
    juego: jugada.juego,
    nums: jugada.numeros.join(','),
    nombre: jugada.nombre || '',
    auto: '1'
  });
  return `/controlar-boleta.html?${params.toString()}`;
}
