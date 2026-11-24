import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const ROOT = process.cwd();
const RESULTADOS_PATH = path.join(ROOT, 'resultados.json');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');

const UA = 'Mozilla/5.0 (compatible; ElViejoTimberoBot/2.0; +https://elviejotimbero.netlify.app/)';

function getFechaAR() {
  const now = new Date();
  const ar = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const y = ar.getFullYear();
  const m = String(ar.getMonth() + 1).padStart(2, '0');
  const d = String(ar.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getIsoAR() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(now).replace(' ', 'T');
  return `${fmt}-03:00`;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'es-AR,es;q=0.9' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

function extractNumbersInRange(text, min, max, count) {
  const matches = (text.match(/\b\d{1,2}\b/g) || [])
    .map(Number)
    .filter(n => n >= min && n <= max);
  const unique = [];
  for (const n of matches) {
    if (!unique.includes(n)) unique.push(n);
    if (unique.length === count) break;
  }
  return unique.length === count ? unique : null;
}

function parseFechaDMY(text) {
  const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function archiveIfNewDraw(gameObj, newDraw) {
  if (!newDraw || !newDraw.sorteo || !Array.isArray(newDraw.modalidades) || newDraw.modalidades.length === 0) {
    return false;
  }
  const prev = gameObj.ultimo;
  if (prev && prev.sorteo && Number(prev.sorteo) !== Number(newDraw.sorteo)) {
    gameObj.historico = gameObj.historico || [];
    const exists = gameObj.historico.some(h => Number(h.sorteo) === Number(prev.sorteo));
    if (!exists) {
      gameObj.historico.unshift(prev);
      gameObj.historico = gameObj.historico.slice(0, 10);
    }
  }
  gameObj.ultimo = newDraw;
  gameObj.estadoFuente = 'ok';
  return true;
}

// --- Parsers oficiales por juego ---

async function updateQuini6(data) {
  const html = await fetchHtml('https://www.loteriasantafe.gov.ar/quini-6-2/');
  const $ = cheerio.load(html);
  const body = cleanText($('body').text());

  const sorteoMatch = body.match(/Sorteo\s*(?:N[°º]?\.?)?\s*(\d{4})/i);
  const fecha = parseFechaDMY(body) || getFechaAR();
  const pozoMatch = body.match(/\$\s*[\d\.]+(?:\s*millones)?/i);

  // Extrae bloques de 6 bolillas entre 00 y 45 dentro de contenedores de extracciones
  const modalidadesNombres = ['Tradicional Primer Sorteo', 'La Segunda del Quini', 'Revancha', 'Siempre Sale'];
  const modalidades = [];
  $('table, .extracciones, .numeros, section').each((_, el) => {
    const t = cleanText($(el).text());
    for (const nombre of modalidadesNombres) {
      if (t.toLowerCase().includes(nombre.split(' ')[0].toLowerCase()) && !modalidades.some(m => m.nombre === nombre)) {
        const bolillas = extractNumbersInRange(t, 0, 45, 6);
        if (bolillas) {
          modalidades.push({
            nombre,
            bolillas,
            premios: [{ aciertos: '6 aciertos', ganadores: 'Ver extracto', pozo: pozoMatch ? pozoMatch[0] : 'A confirmar', premioIndividual: 'Ver extracto' }]
          });
        }
      }
    }
  });

  if (sorteoMatch && modalidades.length >= 2) {
    if (pozoMatch) data.poceados.quini6.pozoProximo = pozoMatch[0];
    return archiveIfNewDraw(data.poceados.quini6, {
      sorteo: Number(sorteoMatch[1]),
      fecha,
      modalidades
    });
  }
  return false;
}

async function updateBrinco(data) {
  const html = await fetchHtml('https://www.loteriasantafe.gov.ar/brinco-3/');
  const $ = cheerio.load(html);
  const body = cleanText($('body').text());

  const sorteoMatch = body.match(/Sorteo\s*(?:N[°º]?\.?)?\s*(\d{4})/i);
  const fecha = parseFechaDMY(body) || getFechaAR();
  const bolillas = extractNumbersInRange(body.slice(body.toLowerCase().indexOf('extracciones')), 0, 39, 6);

  if (sorteoMatch && bolillas) {
    return archiveIfNewDraw(data.poceados.brinco, {
      sorteo: Number(sorteoMatch[1]),
      fecha,
      modalidades: [
        {
          nombre: 'Brinco Tradicional',
          bolillas,
          premios: [{ aciertos: '6 aciertos', ganadores: 'Vacante', pozo: data.poceados.brinco.pozoProximo || 'A confirmar', premioIndividual: 'Vacante' }]
        }
      ]
    });
  }
  return false;
}

async function updateLotoPlus(data) {
  const html = await fetchHtml('https://loto.loteriadelaciudad.gob.ar/');
  const $ = cheerio.load(html);
  const body = cleanText($('body').text());

  const sorteoMatch = body.match(/Sorteo\s*(?:N[°º]?\.?)?\s*(\d{4})/i);
  const fecha = parseFechaDMY(body) || getFechaAR();
  const pozoMatch = body.match(/\$\s*[\d\.]{7,}/);
  if (pozoMatch) data.poceados.lotoPlus.pozoProximo = pozoMatch[0];

  const bolillas = extractNumbersInRange(body, 0, 45, 6);
  if (sorteoMatch && bolillas) {
    return archiveIfNewDraw(data.poceados.lotoPlus, {
      sorteo: Number(sorteoMatch[1]),
      fecha,
      modalidades: [
        {
          nombre: 'Tradicional',
          bolillas,
          premios: [{ aciertos: '6 aciertos', ganadores: 'Ver extracto', pozo: pozoMatch ? pozoMatch[0] : 'A confirmar', premioIndividual: 'Ver extracto' }]
        }
      ]
    });
  }
  return false;
}

async function updateLaPoceada(data) {
  const html = await fetchHtml('https://poceada.loteriadelaciudad.gob.ar/');
  const $ = cheerio.load(html);
  const body = cleanText($('body').text());

  const sorteoMatch = body.match(/Sorteo\s*(?:N[°º]?\.?)?\s*(\d{4,5})/i);
  const fecha = parseFechaDMY(body) || getFechaAR();
  const pozoMatch = body.match(/\$\s*[\d\.]{7,}/);
  if (pozoMatch) data.poceados.laPoceada.pozoProximo = pozoMatch[0];

  const bolillas = extractNumbersInRange(body, 0, 99, 20);
  if (sorteoMatch && bolillas) {
    return archiveIfNewDraw(data.poceados.laPoceada, {
      sorteo: Number(sorteoMatch[1]),
      fecha,
      modalidades: [
        {
          nombre: 'Extracto de 20 números (00 al 99)',
          bolillas,
          premios: [{ aciertos: '8 aciertos', ganadores: 'Ver extracto', pozo: pozoMatch ? pozoMatch[0] : 'A confirmar', premioIndividual: 'Ver extracto' }]
        }
      ]
    });
  }
  return false;
}

async function updateTelekino(data) {
  const html = await fetchHtml('https://www.loteriadesalta.com/resultados-oficiales/telekino/');
  const $ = cheerio.load(html);
  const body = cleanText($('body').text());

  const sorteoMatch = body.match(/Sorteo\s*(?:N[°º]?\.?)?\s*(\d{4})/i);
  const fecha = parseFechaDMY(body) || getFechaAR();
  const bolillas = extractNumbersInRange(body, 1, 25, 15);

  if (sorteoMatch && bolillas) {
    return archiveIfNewDraw(data.poceados.telekino, {
      sorteo: Number(sorteoMatch[1]),
      fecha,
      modalidades: [
        {
          nombre: 'Telekino Tradicional',
          bolillas: bolillas.sort((a, b) => a - b),
          premios: [{ aciertos: '15 aciertos', ganadores: 'Ver extracto', pozo: data.poceados.telekino.pozoProximo || 'A confirmar', premioIndividual: 'Ver extracto' }]
        }
      ]
    });
  }
  return false;
}

async function updateQuinielaProvincia(data) {
  const html = await fetchHtml('https://loteria.gba.gob.ar/resultados');
  const $ = cheerio.load(html);
  const body = cleanText($('body').text());
  const hoy = getFechaAR();

  const cuatroCifras = (body.match(/\b\d{4}\b/g) || []).filter(n => !/^202[4-9]$/.test(n));
  if (cuatroCifras.length >= 20) {
    const prov = data.quinielas.provincia;
    prov.fechas[hoy] = prov.fechas[hoy] || {
      previa: { nombre: 'La Previa', hora: '10:15', sorteo: 0, extracto: [] },
      primero: { nombre: 'El Primero', hora: '12:00', sorteo: 0, extracto: [] },
      matutina: { nombre: 'Matutina', hora: '15:00', sorteo: 0, extracto: [] },
      vespertina: { nombre: 'Vespertina', hora: '18:00', sorteo: 0, extracto: [] },
      nocturna: { nombre: 'Nocturna', hora: '21:00', sorteo: 0, extracto: [] }
    };
    // Asigna al turno más reciente según hora de Argentina
    const horaAR = Number(getIsoAR().slice(11, 13));
    const turnoKey = horaAR >= 21 ? 'nocturna' : horaAR >= 18 ? 'vespertina' : horaAR >= 15 ? 'matutina' : horaAR >= 12 ? 'primero' : 'previa';
    prov.fechas[hoy][turnoKey].extracto = cuatroCifras.slice(0, 20);
    return true;
  }
  return false;
}

// Respaldo opcional vía RapidAPI (Downtack) si configurás el secreto RAPIDAPI_KEY en GitHub
async function updateFromRapidApi(data) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return false;
  const res = await fetch('https://loterias-y-quinielas-argentinas.p.rapidapi.com/quinielas', {
    headers: {
      'x-rapidapi-key': key,
      'x-rapidapi-host': 'loterias-y-quinielas-argentinas.p.rapidapi.com'
    }
  });
  if (!res.ok) return false;
  const payload = await res.json();
  console.log('RapidAPI respondió correctamente:', Object.keys(payload).length, 'claves');
  return true;
}

async function updateSitemapLastmod(fecha) {
  try {
    let xml = await fs.readFile(SITEMAP_PATH, 'utf-8');
    xml = xml.replace(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g, `<lastmod>${fecha}</lastmod>`);
    await fs.writeFile(SITEMAP_PATH, xml, 'utf-8');
  } catch (err) {
    console.warn('No se pudo actualizar sitemap.xml:', err.message);
  }
}

async function main() {
  const raw = await fs.readFile(RESULTADOS_PATH, 'utf-8');
  const data = JSON.parse(raw);

  const tasks = [
    ['Quini 6', () => updateQuini6(data)],
    ['Brinco', () => updateBrinco(data)],
    ['Loto Plus', () => updateLotoPlus(data)],
    ['La Poceada', () => updateLaPoceada(data)],
    ['Telekino', () => updateTelekino(data)],
    ['Quiniela Provincia', () => updateQuinielaProvincia(data)],
    ['Respaldo RapidAPI', () => updateFromRapidApi(data)]
  ];

  let updatedCount = 0;
  for (const [name, fn] of tasks) {
    try {
      const ok = await fn();
      console.log(`[${ok ? 'OK' : 'SIN CAMBIOS'}] ${name}`);
      if (ok) updatedCount++;
    } catch (err) {
      console.warn(`[AVISO] ${name} falló sin afectar al resto:`, err.message);
    }
  }

  if (updatedCount > 0) {
    data.actualizadoEl = getIsoAR();
    delete data.notaEstado;
    await fs.writeFile(RESULTADOS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await updateSitemapLastmod(getFechaAR());
    console.log(`Guardado resultados.json con ${updatedCount} fuentes actualizadas.`);
  } else {
    console.log('Ninguna fuente devolvió sorteos nuevos; se conserva resultados.json intacto.');
  }
}

main().catch((err) => {
  console.error('Error fatal en actualizador:', err);
  process.exit(1);
});
