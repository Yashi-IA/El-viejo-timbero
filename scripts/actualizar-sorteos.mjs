import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const ROOT = process.cwd();
const RESULTADOS_PATH = path.join(ROOT, 'resultados.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// --- Helpers de fecha y hora en Argentina (UTC-3) ---

function getFechaAR(offsetDays = 0) {
  const base = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(base);
}

function getIsoAR() {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date()).replace(' ', 'T');
  return `${fmt}-03:00`;
}

// --- Fetch HTTP resiliente con decodificación correcta (UTF-8 / ISO-8859-1) ---

async function fetchHtml(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.5',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (ct.includes('iso-8859-1') || ct.includes('windows-1252')) {
      return new TextDecoder('latin1').decode(buf);
    }
    const utf8 = buf.toString('utf8');
    if (/charset=["']?\s*(iso-8859-1|windows-1252)/i.test(utf8.slice(0, 2000))) {
      return new TextDecoder('latin1').decode(buf);
    }
    return utf8;
  } finally {
    clearTimeout(timer);
  }
}

// --- Utilidades de texto, fechas y normalización ---

function cleanText(str) {
  return String(str || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKey(str) {
  return cleanText(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const MESES_ES = {
  enero: '01', febrero: '02', marzo: '03', abril: '04',
  mayo: '05', junio: '06', julio: '07', agosto: '08',
  septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12'
};

function isValidIsoDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) return false;
  const maxDate = getFechaAR(1);
  return iso >= '2020-01-01' && iso <= maxDate;
}

function parseFecha(text, fallbackYear = null) {
  const t = cleanText(text);
  // DD/MM/YYYY o DD-MM-YYYY
  let m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (isValidIsoDate(iso)) return iso;
  }
  // "25 de noviembre de 2026" o "25 de noviembre 2026"
  m = normalizeKey(t).match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de)?\s+(20\d{2})\b/);
  if (m && MESES_ES[m[2]]) {
    const iso = `${m[3]}-${MESES_ES[m[2]]}-${m[1].padStart(2, '0')}`;
    if (isValidIsoDate(iso)) return iso;
  }
  // DD/MM sin año (ej. títulos)
  if (fallbackYear) {
    m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (m) {
      const iso = `${fallbackYear}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      if (isValidIsoDate(iso)) return iso;
    }
  }
  return null;
}

function formatMoney(raw) {
  const s = cleanText(raw);
  if (!s || /^[-—–]+$/.test(s)) return null;
  if (/vac/i.test(s)) return 'Vacante';
  if (/confirmar|procesando/i.test(s)) return 'A confirmar';
  // Normalizar espacios tras $
  const m = s.match(/\$\s*[\d.,]+(?:\s*millones)?/i);
  if (m) return cleanText(m[0]).replace(/^\$\s*/, '$ ');
  if (/^[\d.,]+$/.test(s)) return `$ ${s}`;
  return s;
}

function normalizeGanadores(raw) {
  const s = cleanText(raw);
  if (!s) return 'A confirmar';
  if (/^vac/i.test(s) || /^sin\s*gan/i.test(s)) return 'Vacante';
  if (/^-|—|–$/.test(s)) return 'A confirmar';
  // Ej: "1 Ganador", "17 Ganadores", "2.980", "0"
  const numStr = s.replace(/\./g, '').match(/^\d+/);
  if (numStr) {
    const n = Number(numStr[0]);
    if (n === 0) return 'Vacante';
    return n;
  }
  if (/confirmar|procesando|ver/i.test(s)) return 'A confirmar';
  return s;
}

function normalizeAciertos(raw) {
  const s = cleanText(raw);
  if (!s) return 'Categoría';
  const m = s.match(/^(\d{1,2})(?:\s*(?:nros?\.?|aciertos?))?$/i);
  if (m) return `${m[1]} aciertos`;
  if (/est[íi]mulo/i.test(s)) return 'Estímulo';
  if (/rekino/i.test(s)) return '14 aciertos (Rekino)';
  return s;
}

function parseNumbersArray(tokens, min, max, expectedCount, allowDuplicates = false) {
  const out = [];
  for (const tok of tokens) {
    const clean = String(tok).trim();
    if (!/^\d{1,2}$/.test(clean)) continue;
    const n = Number(clean);
    if (n < min || n > max) continue;
    if (!allowDuplicates && out.includes(n)) continue;
    out.push(n);
    if (out.length === expectedCount) break;
  }
  return out.length === expectedCount ? out : null;
}

function parseTablePremios($, $table) {
  if (!$table || !$table.length) return [];
  const rows = [];
  const headers = [];

  $table.find('tr').each((idx, tr) => {
    const cells = $(tr).find('th, td').map((_, td) => cleanText($(td).text())).get();
    if (cells.length === 0) return;

    const joined = normalizeKey(cells.join(' '));
    if (idx === 0 || $(tr).find('th').length > 0 || /aciertos|categoria|ganad|premio|pozo/.test(joined)) {
      if (headers.length === 0 && /aciertos|categoria|ganad|premio|cant/.test(joined)) {
        cells.forEach((c, i) => { headers[i] = normalizeKey(c); });
        return;
      }
    }

    if (cells.length < 2) return;
    // Detectar columnas dinámicamente según headers o por heurística
    let idxAciertos = headers.findIndex(h => /aciert|categ|cant|con numero/.test(h));
    let idxGan = headers.findIndex(h => /gan/.test(h));
    let idxPremioInd = headers.findIndex(h => /por apuesta|por carton|c\/u|individual/.test(h));
    let idxPozo = headers.findIndex(h => /pozo/.test(h));
    if (idxPremioInd === -1 && idxPozo === -1) {
      idxPremioInd = headers.findIndex(h => /premio/.test(h));
    }

    if (idxAciertos === -1) idxAciertos = 0;
    if (idxGan === -1) idxGan = 1;

    const aciertosRaw = cells[idxAciertos] || cells[0];
    if (/aciertos|categoria|cant/i.test(aciertosRaw) && !/\d/.test(aciertosRaw)) return;

    const ganadores = normalizeGanadores(cells[idxGan]);
    const pozoRaw = idxPozo >= 0 ? cells[idxPozo] : null;
    const premioRaw = idxPremioInd >= 0 ? cells[idxPremioInd] : (cells[2] || null);

    let pozo = formatMoney(pozoRaw);
    let premioIndividual = formatMoney(premioRaw);

    if (ganadores === 'Vacante') {
      if (!pozo && premioIndividual && premioIndividual !== 'Vacante') {
        pozo = premioIndividual.replace(/\s*\(vacante\)/i, '');
      }
      premioIndividual = 'Vacante';
    } else {
      if (!pozo && premioIndividual) pozo = premioIndividual;
      if (!premioIndividual && pozo) premioIndividual = pozo;
    }

    rows.push({
      aciertos: normalizeAciertos(aciertosRaw),
      ganadores,
      pozo: pozo || 'A confirmar',
      premioIndividual: premioIndividual || (ganadores === 'Vacante' ? 'Vacante' : 'A confirmar')
    });
  });

  return rows;
}

// --- Validación e integración segura en resultados.json ---

function drawCompletenessScore(draw) {
  if (!draw || !Array.isArray(draw.modalidades)) return 0;
  let score = draw.modalidades.length * 100;
  if (draw.numeroPlus !== undefined) score += 20;
  for (const mod of draw.modalidades) {
    const premios = Array.isArray(mod.premios) ? mod.premios : [];
    score += premios.length * 5;
    for (const p of premios) {
      const g = String(p.ganadores ?? '');
      if (g && !/ver extracto|a confirmar/i.test(g)) score += 15;
      if (p.pozo && !/a confirmar/i.test(String(p.pozo))) score += 5;
      if (p.premioIndividual && !/ver extracto|a confirmar/i.test(String(p.premioIndividual))) score += 5;
    }
  }
  return score;
}

function validateDrawForGame(gameKey, gameCfg, draw) {
  if (!draw || !Number.isInteger(Number(draw.sorteo)) || Number(draw.sorteo) <= 0) {
    return 'sorteo inválido';
  }
  if (!isValidIsoDate(draw.fecha)) {
    return `fecha inválida (${draw.fecha})`;
  }
  if (!Array.isArray(draw.modalidades) || draw.modalidades.length === 0) {
    return 'sin modalidades';
  }
  const [min, max] = gameCfg.rango || [0, 99];
  const expectedBolillas = gameKey === 'laPoceada' || gameKey === 'quinielaPlus'
    ? 20
    : Number(gameCfg.cantidadBolillas);

  for (const mod of draw.modalidades) {
    if (!mod || !mod.nombre || !Array.isArray(mod.bolillas)) {
      return 'modalidad sin bolillas';
    }
    if (mod.bolillas.length !== expectedBolillas) {
      return `${mod.nombre}: se esperaban ${expectedBolillas} bolillas y llegaron ${mod.bolillas.length}`;
    }
    const seen = new Set();
    for (const b of mod.bolillas) {
      if (!Number.isInteger(b) || b < min || b > max) {
        return `${mod.nombre}: bolilla fuera de rango (${b})`;
      }
      if (seen.has(b)) {
        return `${mod.nombre}: bolilla duplicada (${b})`;
      }
      seen.add(b);
    }
  }
  if (draw.numeroPlus !== undefined) {
    if (!Number.isInteger(draw.numeroPlus) || draw.numeroPlus < 0 || draw.numeroPlus > 9) {
      return `numeroPlus fuera de rango (${draw.numeroPlus})`;
    }
  }
  return null;
}

function sanitizeHistorico(gameObj) {
  const ultimoSorteo = Number(gameObj?.ultimo?.sorteo || 0);
  const seen = new Set();
  const clean = [];
  for (const h of gameObj.historico || []) {
    const s = Number(h?.sorteo || 0);
    if (!s || s === ultimoSorteo || seen.has(s)) continue;
    if (!isValidIsoDate(h.fecha)) continue;
    seen.add(s);
    clean.push({ ...h, sorteo: s });
  }
  clean.sort((a, b) => b.sorteo - a.sorteo);
  gameObj.historico = clean.slice(0, 10);
}

function archiveIfNewDraw(gameKey, gameObj, newDraw, pozoProximo = null) {
  const err = validateDrawForGame(gameKey, gameObj, newDraw);
  if (err) {
    throw new Error(`Validación fallida para ${gameKey}: ${err}`);
  }

  let changed = false;
  if (pozoProximo && pozoProximo !== gameObj.pozoProximo) {
    gameObj.pozoProximo = pozoProximo;
    changed = true;
  }

  const normalizedNew = {
    ...newDraw,
    sorteo: Number(newDraw.sorteo)
  };

  const prev = gameObj.ultimo;
  const prevSorteo = Number(prev?.sorteo || 0);
  const newSorteo = normalizedNew.sorteo;

  if (prev && prevSorteo > 0) {
    if (newSorteo < prevSorteo) {
      console.log(`  [${gameKey}] Ignorando regresión de sorteo (${newSorteo} < ${prevSorteo}).`);
      return changed;
    }
    if (prev.fecha && normalizedNew.fecha < prev.fecha && newSorteo === prevSorteo) {
      console.log(`  [${gameKey}] Ignorando regresión de fecha (${normalizedNew.fecha} < ${prev.fecha}).`);
      return changed;
    }

    if (newSorteo === prevSorteo) {
      // Mismo sorteo: solo actualiza si aporta datos más completos (ej. escrutinio o más modalidades)
      const prevScore = drawCompletenessScore(prev);
      const newScore = drawCompletenessScore(normalizedNew);
      if (newScore > prevScore) {
        gameObj.ultimo = normalizedNew;
        gameObj.estadoFuente = 'ok';
        sanitizeHistorico(gameObj);
        return true;
      }
      // También revisar si cambió el string de premios/ganadores sin bajar calidad
      if (newScore === prevScore && JSON.stringify(prev) !== JSON.stringify(normalizedNew)) {
        // Solo actualizar si no degrada ningún premio existente
        const prevHasRealWinners = prev.modalidades.some(m =>
          (m.premios || []).some(p => !/ver extracto|a confirmar/i.test(String(p.ganadores)))
        );
        const newHasRealWinners = normalizedNew.modalidades.some(m =>
          (m.premios || []).some(p => !/ver extracto|a confirmar/i.test(String(p.ganadores)))
        );
        if (newHasRealWinners || !prevHasRealWinners) {
          gameObj.ultimo = normalizedNew;
          gameObj.estadoFuente = 'ok';
          sanitizeHistorico(gameObj);
          return true;
        }
      }
      return changed;
    }

    // newSorteo > prevSorteo: archivar anterior en historico
    gameObj.historico = gameObj.historico || [];
    gameObj.historico.unshift(prev);
  }

  gameObj.ultimo = normalizedNew;
  gameObj.estadoFuente = 'ok';
  sanitizeHistorico(gameObj);
  return true;
}

// --- Limpieza anti-copia de TuJugada y parsers de secciones ---

function stripTuJugadaHidden($, $el) {
  const $clone = $el.clone();
  $clone.find('script, style, noscript').remove();
  $clone.find('[style]').each((_, node) => {
    const st = ($(node).attr('style') || '').toLowerCase();
    if (/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0/.test(st)) {
      $(node).remove();
    }
  });
  return cleanText($clone.text())
    .replace(/---\s*MENSAJE PARA EL VISITANTE[\s\S]*?TUJUGADA\.COM\.AR!*/gi, ' ');
}

function extractHeadingBlocks($, containerSelector, headingSelector) {
  const blocks = [];
  const $root = $(containerSelector).first().length ? $(containerSelector).first() : $('body');
  $root.find(headingSelector).each((_, h) => {
    const title = cleanText($(h).text());
    const $sibs = $(h).nextUntil(headingSelector);
    blocks.push({ title, $heading: $(h), $content: $sibs });
  });
  return blocks;
}

// ============================================================================
// PARSERS DE POCEADOS (Primario: Lotería de Salta / TuJugada + Respaldos)
// ============================================================================

async function parseQuini6Salta() {
  const html = await fetchHtml('https://www.loteriadesalta.com/resultados-oficiales/quini-6/');
  const $ = cheerio.load(html);

  const mainText = cleanText($('main, .entry-content, article, body').first().text());
  const sorteoMatch = mainText.match(/Sorteo\s*N\.?[°º]?\s*(\d{4})/i);
  if (!sorteoMatch) throw new Error('Quini6 Salta: sorteo no encontrado');
  const sorteo = Number(sorteoMatch[1]);
  const fecha = parseFecha(mainText) || getFechaAR();

  let pozoProximo = null;
  const pozoCard = mainText.match(/Quini 6[\s\S]{0,120}?Pozo estimado\s*(\$\s*[\d.,]+)/i)
    || mainText.match(/Pr[óo]ximo pozo[^$]{0,40}(\$\s*[\d.,]+)/i);
  if (pozoCard) pozoProximo = formatMoney(pozoCard[1]);

  // Extraer las 4 modalidades desde los bloques de números y tablas en el área principal
  const MOD_SPECS = [
    { key: 'tradicional', nombre: 'Tradicional Primer Sorteo', match: /^tradicional$/i },
    { key: 'segunda', nombre: 'La Segunda del Quini', match: /^la segunda$/i },
    { key: 'revancha', nombre: 'Revancha', match: /^revancha$/i },
    { key: 'siempre', nombre: 'Siempre Sale', match: /^siempre sale$/i }
  ];

  // Buscar tablas dentro de la sección de premios y bloques con título de modalidad
  const $scope = $('main, .entry-content, article').first().length ? $('main, .entry-content, article').first() : $('body');
  const premiosByMod = {};

  $scope.find('table').each((_, tbl) => {
    const $tbl = $(tbl);
    const prevHeading = cleanText($tbl.prevAll('h2, h3, h4, strong, p').first().text());
    const parentHeading = cleanText($tbl.closest('div, section').find('h2, h3, h4').first().text());
    const label = normalizeKey(prevHeading || parentHeading);
    for (const spec of MOD_SPECS) {
      if (label.includes(normalizeKey(spec.nombre.split(' ')[0])) || (spec.key === 'segunda' && label.includes('segunda'))) {
        if (!premiosByMod[spec.key]) {
          const parsed = parseTablePremios($, $tbl);
          if (parsed.length) premiosByMod[spec.key] = parsed;
        }
      }
    }
  });

  // Fallback si las tablas de premios están ordenadas secuencialmente (4 tablas de premios)
  const premioTables = $scope.find('table').filter((_, tbl) => {
    const t = normalizeKey($(tbl).text());
    return t.includes('aciertos') && (t.includes('ganadores') || t.includes('pozo'));
  }).toArray();
  if (Object.keys(premiosByMod).length < 4 && premioTables.length >= 4) {
    MOD_SPECS.forEach((spec, idx) => {
      if (!premiosByMod[spec.key]) {
        premiosByMod[spec.key] = parseTablePremios($, $(premioTables[idx]));
      }
    });
  }

  const modalidades = [];
  for (const spec of MOD_SPECS) {
    // Buscar el encabezado de la modalidad que precede a sus 6 bolillas
    let bolillas = null;
    $scope.find('h2, h3, h4, h5, p, span, div').each((_, el) => {
      if (bolillas) return;
      const txt = cleanText($(el).text());
      if (spec.match.test(txt)) {
        // Buscar en el contenedor padre o hermano inmediato los 6 números
        const candidates = [
          cleanText($(el).next().text()),
          cleanText($(el).parent().text()),
          cleanText($(el).nextAll().slice(0, 3).text())
        ];
        for (const c of candidates) {
          const toks = c.replace(txt, '').match(/\b\d{1,2}\b/g) || [];
          const parsed = parseNumbersArray(toks, 0, 45, 6);
          if (parsed) {
            bolillas = parsed.sort((a, b) => a - b);
            break;
          }
        }
      }
    });

    if (bolillas) {
      modalidades.push({
        nombre: spec.nombre,
        bolillas,
        premios: premiosByMod[spec.key]?.length
          ? premiosByMod[spec.key]
          : [{ aciertos: '6 aciertos', ganadores: 'A confirmar', pozo: 'A confirmar', premioIndividual: 'A confirmar' }]
      });
    }
  }

  if (modalidades.length < 4) {
    throw new Error(`Quini6 Salta: solo ${modalidades.length}/4 modalidades parseadas`);
  }
  return { draw: { sorteo, fecha, modalidades }, pozoProximo, source: 'loteriadesalta.com' };
}

async function parseQuini6TuJugada() {
  const html = await fetchHtml('https://www.tujugada.com.ar/quini6.asp');
  const $ = cheerio.load(html);
  const bodyText = cleanText($('main, #main, .content, body').first().text());
  const headerM = bodyText.match(/QUINI 6\s*Nro:\s*(\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if (!headerM) throw new Error('Quini6 TuJugada: cabecera no encontrada');

  const sorteo = Number(headerM[1]);
  const fecha = parseFecha(headerM[2]) || getFechaAR();

  const pozoM = bodyText.match(/PROXIMO POZO\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const MODS = [
    { marker: 'TRADICIONAL', end: 'PREMIOS TRADICIONAL', nombre: 'Tradicional Primer Sorteo' },
    { marker: 'SEGUNDA VUELTA', end: 'PREMIOS 2DA VUELTA', nombre: 'La Segunda del Quini' },
    { marker: 'REVANCHA', end: 'PREMIOS REVANCHA', nombre: 'Revancha' },
    { marker: 'SIEMPRE SALE', end: 'PREMIOS SIEMPRE SALE', nombre: 'Siempre Sale' }
  ];

  const tables = $('table').toArray();
  const modalidades = [];

  for (let i = 0; i < MODS.length; i++) {
    const m = MODS[i];
    const startIdx = bodyText.indexOf(m.marker);
    const endIdx = bodyText.indexOf(m.end, startIdx);
    if (startIdx === -1 || endIdx === -1) continue;
    const chunk = bodyText.slice(startIdx + m.marker.length, endIdx);
    const bolillas = parseNumbersArray(chunk.match(/\b\d{1,2}\b/g) || [], 0, 45, 6);
    if (!bolillas) continue;

    // Buscar la tabla de premios correspondiente
    const tbl = tables.find(t => {
      const prev = cleanText($(t).prevAll().slice(0, 3).text());
      return prev.includes(m.end) || cleanText($(t).text()).includes(m.end);
    }) || tables[i];

    const premios = tbl ? parseTablePremios($, $(tbl)) : [];
    modalidades.push({
      nombre: m.nombre,
      bolillas: bolillas.sort((a, b) => a - b),
      premios: premios.length ? premios : [{ aciertos: '6 aciertos', ganadores: 'A confirmar', pozo: 'A confirmar', premioIndividual: 'A confirmar' }]
    });
  }

  if (modalidades.length < 4) throw new Error(`Quini6 TuJugada: ${modalidades.length}/4 modalidades`);
  return { draw: { sorteo, fecha, modalidades }, pozoProximo, source: 'tujugada.com.ar' };
}

async function parseLotoPlusSalta() {
  const html = await fetchHtml('https://www.loteriadesalta.com/resultados-oficiales/loto/');
  const $ = cheerio.load(html);
  const $scope = $('main, .entry-content, article').first().length ? $('main, .entry-content, article').first() : $('body');
  const mainText = cleanText($scope.text());

  const sorteoMatch = mainText.match(/Sorteo\s*N\.?[°º]?\s*(\d{4})/i);
  if (!sorteoMatch) throw new Error('Loto Plus Salta: sorteo no encontrado');
  const sorteo = Number(sorteoMatch[1]);
  const fecha = parseFecha(mainText) || getFechaAR();

  let pozoProximo = null;
  const pozoM = mainText.match(/Loto Plus[\s\S]{0,120}?Pozo estimado\s*(\$\s*[\d.,]+)/i);
  if (pozoM) pozoProximo = formatMoney(pozoM[1]);

  let numeroPlus;
  const plusM = mainText.match(/N[úu]mero Plus\s*(\d)\b/i);
  if (plusM) numeroPlus = Number(plusM[1]);

  const MOD_SPECS = [
    { key: 'tradicional', nombre: 'Tradicional', match: /^Tradicional$/i },
    { key: 'match', nombre: 'Match', match: /^Match$/i },
    { key: 'desquite', nombre: 'Desquite', match: /^Desquite$/i },
    { key: 'sale', nombre: 'Sale o Sale', match: /^Sale o Sale$/i }
  ];

  const premioTables = $scope.find('table').filter((_, tbl) => {
    const t = normalizeKey($(tbl).text());
    return t.includes('aciertos') && (t.includes('ganadores') || t.includes('pozo'));
  }).toArray();

  const modalidades = [];
  MOD_SPECS.forEach((spec, idx) => {
    let bolillas = null;
    $scope.find('h2, h3, h4, h5, p, span, div').each((_, el) => {
      if (bolillas) return;
      const txt = cleanText($(el).text());
      if (spec.match.test(txt)) {
        const candidates = [
          cleanText($(el).next().text()),
          cleanText($(el).parent().text()),
          cleanText($(el).nextAll().slice(0, 3).text())
        ];
        for (const c of candidates) {
          const toks = c.replace(txt, '').match(/\b\d{1,2}\b/g) || [];
          const parsed = parseNumbersArray(toks, 0, 45, 6);
          if (parsed) {
            bolillas = parsed.sort((a, b) => a - b);
            break;
          }
        }
      }
    });

    if (bolillas) {
      const premios = premioTables[idx] ? parseTablePremios($, $(premioTables[idx])) : [];
      modalidades.push({
        nombre: spec.nombre,
        bolillas,
        premios: premios.length ? premios : [{ aciertos: '6 aciertos', ganadores: 'A confirmar', pozo: 'A confirmar', premioIndividual: 'A confirmar' }]
      });
    }
  });

  if (modalidades.length < 4) throw new Error(`Loto Plus Salta: ${modalidades.length}/4 modalidades`);
  const draw = { sorteo, fecha, modalidades };
  if (numeroPlus !== undefined && numeroPlus >= 0 && numeroPlus <= 9) draw.numeroPlus = numeroPlus;
  return { draw, pozoProximo, source: 'loteriadesalta.com' };
}

async function parseLotoPlusTuJugada() {
  const html = await fetchHtml('https://www.tujugada.com.ar/loto.asp');
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());

  const headerM = bodyText.match(/LOTO PLUS\s*Nro:\s*(\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if (!headerM) throw new Error('Loto Plus TuJugada: cabecera no encontrada');
  const sorteo = Number(headerM[1]);
  const fecha = parseFecha(headerM[2]) || getFechaAR();

  const pozoM = bodyText.match(/PROXIMO POZO LOTO PLUS\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const plusM = bodyText.match(/N[úu]mero plus:\s*(\d)\b/i);
  const numeroPlus = plusM ? Number(plusM[1]) : undefined;

  const MODS = [
    { marker: 'TRADICIONAL', end: 'PREMIOS SORTEO TRADICIONAL', nombre: 'Tradicional' },
    { marker: 'MATCH', end: 'PREMIOS SORTEO MATCH', nombre: 'Match' },
    { marker: 'DESQUITE', end: 'PREMIOS SORTEO DESQUITE', nombre: 'Desquite' },
    { marker: 'SALE O SALE', end: 'PREMIOS SALE O SALE', nombre: 'Sale o Sale' }
  ];

  const tables = $('table').filter((_, t) => normalizeKey($(t).text()).includes('gan.')).toArray();
  const modalidades = [];

  for (let i = 0; i < MODS.length; i++) {
    const m = MODS[i];
    const startIdx = bodyText.indexOf(m.marker);
    const endIdx = bodyText.indexOf(m.end, startIdx);
    if (startIdx === -1 || endIdx === -1) continue;
    const chunk = bodyText.slice(startIdx + m.marker.length, endIdx);
    const bolillas = parseNumbersArray(chunk.match(/\b\d{1,2}\b/g) || [], 0, 45, 6);
    if (!bolillas) continue;
    const premios = tables[i] ? parseTablePremios($, $(tables[i])) : [];
    modalidades.push({
      nombre: m.nombre,
      bolillas: bolillas.sort((a, b) => a - b),
      premios: premios.length ? premios : [{ aciertos: '6 aciertos', ganadores: 'A confirmar', pozo: 'A confirmar', premioIndividual: 'A confirmar' }]
    });
  }

  if (modalidades.length < 4) throw new Error(`Loto Plus TuJugada: ${modalidades.length}/4 modalidades`);
  const draw = { sorteo, fecha, modalidades };
  if (numeroPlus !== undefined) draw.numeroPlus = numeroPlus;
  return { draw, pozoProximo, source: 'tujugada.com.ar' };
}

async function parseBrincoSalta() {
  const html = await fetchHtml('https://www.loteriadesalta.com/resultados-oficiales/brinco/');
  const $ = cheerio.load(html);
  const $scope = $('main, .entry-content, article').first().length ? $('main, .entry-content, article').first() : $('body');
  const mainText = cleanText($scope.text());

  const sorteoMatch = mainText.match(/Sorteo\s*Nro\.?\s*(\d{4})/i) || mainText.match(/sorteo\s*N\.?[°º]?\s*(\d{4})/i);
  if (!sorteoMatch) throw new Error('Brinco Salta: sorteo no encontrado');
  const sorteo = Number(sorteoMatch[1]);
  const fecha = parseFecha(mainText) || getFechaAR();

  const pozoM = mainText.match(/PR[ÓO]XIMO POZO ESTIMADO:\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const tradM = mainText.match(/Tradicional\s+((?:\d{1,2}\s+){6})/i) || mainText.match(/Tradicional:\s*([\d\s\-]+)/i);
  const junM = mainText.match(/Brinco Junior(?:\s+Siempre Sale)?(?:\s+N[úu]meros:)?\s+([\d\s\-]+)/i);

  const bolTrad = tradM ? parseNumbersArray(tradM[1].match(/\b\d{1,2}\b/g) || [], 0, 39, 6) : null;
  const bolJun = junM ? parseNumbersArray(junM[1].match(/\b\d{1,2}\b/g) || [], 0, 39, 6) : null;

  const premioTables = $scope.find('table').filter((_, t) => {
    const k = normalizeKey($(t).text());
    return k.includes('aciertos') && k.includes('ganadores');
  }).toArray();

  const modalidades = [];
  if (bolTrad) {
    const premios = premioTables[0] ? parseTablePremios($, $(premioTables[0])) : [];
    modalidades.push({
      nombre: 'Brinco Tradicional',
      bolillas: bolTrad.sort((a, b) => a - b),
      premios: premios.length ? premios : [{ aciertos: '6 aciertos', ganadores: 'A confirmar', pozo: 'A confirmar', premioIndividual: 'A confirmar' }]
    });
  }
  if (bolJun) {
    const premios = premioTables[1] ? parseTablePremios($, $(premioTables[1])) : [];
    modalidades.push({
      nombre: 'Brinco Junior Siempre Sale',
      bolillas: bolJun.sort((a, b) => a - b),
      premios: premios.length ? premios : [{ aciertos: '5 aciertos', ganadores: 'A confirmar', pozo: 'A confirmar', premioIndividual: 'A confirmar' }]
    });
  }

  if (!bolTrad) throw new Error('Brinco Salta: no se obtuvieron bolillas Tradicional');
  return { draw: { sorteo, fecha, modalidades }, pozoProximo, source: 'loteriadesalta.com' };
}

async function parseBrincoTuJugada() {
  const html = await fetchHtml('https://www.tujugada.com.ar/brinco.asp');
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());

  const headerM = bodyText.match(/BRINCO\s*Sorteo:\s*(\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if (!headerM) throw new Error('Brinco TuJugada: cabecera no encontrada');
  const sorteo = Number(headerM[1]);
  const fecha = parseFecha(headerM[2]) || getFechaAR();

  const pozoM = bodyText.match(/PROXIMO POZO\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const tradSection = bodyText.slice(bodyText.indexOf('MODALIDAD TRADICIONAL'), bodyText.indexOf('PREMIOS TRADICIONAL'));
  const junSection = bodyText.slice(bodyText.indexOf('MODALIDAD JUNIOR'), bodyText.indexOf('PREMIOS JUNIOR'));

  const bolTrad = parseNumbersArray(tradSection.match(/\b\d{1,2}\b/g) || [], 0, 39, 6);
  const bolJun = parseNumbersArray(junSection.match(/\b\d{1,2}\b/g) || [], 0, 39, 6);
  if (!bolTrad) throw new Error('Brinco TuJugada: sin bolillas');

  const tables = $('table').filter((_, t) => normalizeKey($(t).text()).includes('ganad')).toArray();
  const modalidades = [{
    nombre: 'Brinco Tradicional',
    bolillas: bolTrad.sort((a, b) => a - b),
    premios: tables[0] ? parseTablePremios($, $(tables[0])) : []
  }];
  if (bolJun) {
    modalidades.push({
      nombre: 'Brinco Junior Siempre Sale',
      bolillas: bolJun.sort((a, b) => a - b),
      premios: tables[1] ? parseTablePremios($, $(tables[1])) : []
    });
  }

  return { draw: { sorteo, fecha, modalidades }, pozoProximo, source: 'tujugada.com.ar' };
}

async function parseTelekinoSalta() {
  const html = await fetchHtml('https://www.loteriadesalta.com/resultados-oficiales/telekino/');
  const $ = cheerio.load(html);
  const $scope = $('main, .entry-content, article').first().length ? $('main, .entry-content, article').first() : $('body');
  const mainText = cleanText($scope.text());

  const sorteoMatch = mainText.match(/Sorteo\s*N\.?[°º]?\s*(\d{4})/i);
  if (!sorteoMatch) throw new Error('Telekino Salta: sorteo no encontrado');
  const sorteo = Number(sorteoMatch[1]);
  const fecha = parseFecha(mainText) || getFechaAR();

  let pozoProximo = null;
  const pozoM = mainText.match(/Pr[óo]ximo sorteo N°?\s*\d+:\s*Pozo estimado[^$]*(\$\s*[\d.,]+(?:\s*Millones)?)/i)
    || mainText.match(/Telekino[\s\S]{0,120}?Pozo estimado\s*(\$\s*[\d.,]+)/i);
  if (pozoM) pozoProximo = formatMoney(pozoM[1]);

  let bolTele = null;
  let bolRek = null;
  $scope.find('h2, h3, h4, h5, p, span, div').each((_, el) => {
    const txt = cleanText($(el).text());
    if (!bolTele && /^Telekino$/i.test(txt)) {
      const cand = cleanText($(el).next().text()) || cleanText($(el).parent().text());
      const parsed = parseNumbersArray(cand.replace(txt, '').match(/\b\d{1,2}\b/g) || [], 1, 25, 15);
      if (parsed) bolTele = parsed.sort((a, b) => a - b);
    }
    if (!bolRek && /^Rekino$/i.test(txt)) {
      const cand = cleanText($(el).next().text()) || cleanText($(el).parent().text());
      const parsed = parseNumbersArray(cand.replace(txt, '').match(/\b\d{1,2}\b/g) || [], 1, 25, 15);
      if (parsed) bolRek = parsed.sort((a, b) => a - b);
    }
  });

  if (!bolTele) throw new Error('Telekino Salta: sin bolillas Telekino');

  const tables = $scope.find('table').filter((_, t) => normalizeKey($(t).text()).includes('ganadores')).toArray();
  const teleTable = tables.find(t => normalizeKey($(t).text()).includes('15 aciertos'));
  const rekTable = tables.find(t => normalizeKey($(t).text()).includes('rekino'));

  const modalidades = [{
    nombre: 'Telekino Tradicional',
    bolillas: bolTele,
    premios: teleTable ? parseTablePremios($, $(teleTable)) : []
  }];
  if (bolRek) {
    modalidades.push({
      nombre: 'Rekino',
      bolillas: bolRek,
      premios: rekTable ? parseTablePremios($, $(rekTable)) : []
    });
  }

  return { draw: { sorteo, fecha, modalidades }, pozoProximo, source: 'loteriadesalta.com' };
}

async function parseTelekinoTuJugada() {
  const html = await fetchHtml('https://www.tujugada.com.ar/telekino.asp');
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());

  const headerM = bodyText.match(/RESULTADO TELEKINO\s*Sorteo:\s*(\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if (!headerM) throw new Error('Telekino TuJugada: cabecera no encontrada');
  const sorteo = Number(headerM[1]);
  const fecha = parseFecha(headerM[2]) || getFechaAR();

  const pozoM = bodyText.match(/PROXIMO POZO TELEKINO\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const teleChunk = bodyText.slice(bodyText.indexOf('RESULTADO TELEKINO'), bodyText.indexOf('PREMIOS SORTEO TELEKINO'));
  const rekStart = bodyText.indexOf('RESULTADO REKINO');
  const rekEnd = bodyText.indexOf('PREMIOS SORTEO REKINO');
  const rekChunk = rekStart >= 0 && rekEnd > rekStart ? bodyText.slice(rekStart, rekEnd) : '';

  const bolTele = parseNumbersArray(teleChunk.replace(headerM[0], '').match(/\b\d{1,2}\b/g) || [], 1, 25, 15);
  const bolRek = rekChunk ? parseNumbersArray(rekChunk.replace(/Sorteo:\s*\d+\s*-\s*\d+\/\d+\/\d+/i, '').match(/\b\d{1,2}\b/g) || [], 1, 25, 15) : null;
  if (!bolTele) throw new Error('Telekino TuJugada: sin bolillas');

  const tables = $('table').filter((_, t) => normalizeKey($(t).text()).includes('ganad')).toArray();
  const modalidades = [{
    nombre: 'Telekino Tradicional',
    bolillas: bolTele.sort((a, b) => a - b),
    premios: tables[0] ? parseTablePremios($, $(tables[0])) : []
  }];
  if (bolRek) {
    modalidades.push({
      nombre: 'Rekino',
      bolillas: bolRek.sort((a, b) => a - b),
      premios: tables[1] ? parseTablePremios($, $(tables[1])) : []
    });
  }

  return { draw: { sorteo, fecha, modalidades }, pozoProximo, source: 'tujugada.com.ar' };
}

async function parseLoto5Salta() {
  const html = await fetchHtml('https://www.loteriadesalta.com/resultados-oficiales/loto-5/');
  const $ = cheerio.load(html);
  const $scope = $('main, .entry-content, article').first().length ? $('main, .entry-content, article').first() : $('body');
  const mainText = cleanText($scope.text());

  const sorteoMatch = mainText.match(/Sorteo\s*Nro\.?\s*(\d{4})/i) || mainText.match(/sorteo\s*N\.?[°º]?\s*(\d{4})/i);
  if (!sorteoMatch) throw new Error('Loto 5 Salta: sorteo no encontrado');
  const sorteo = Number(sorteoMatch[1]);
  const fecha = parseFecha(mainText) || getFechaAR();

  const pozoM = mainText.match(/PR[ÓO]XIMO POZO ESTIMADO:\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const combM = mainText.match(/Extracciones\s+([\d\s]+?)\s+Aciertos/i)
    || mainText.match(/Combinaci[óo]n ganadora:\s*([\d\s\-]+)/i);
  const bolillas = combM ? parseNumbersArray(combM[1].match(/\b\d{1,2}\b/g) || [], 0, 36, 5) : null;
  if (!bolillas) throw new Error('Loto 5 Salta: sin bolillas');

  const table = $scope.find('table').filter((_, t) => {
    const k = normalizeKey($(t).text());
    return k.includes('5 aciertos') && k.includes('ganadores');
  }).last();

  const premios = table.length ? parseTablePremios($, table) : [];
  return {
    draw: {
      sorteo,
      fecha,
      modalidades: [{
        nombre: 'Sorteo Tradicional (00 al 36)',
        bolillas: bolillas.sort((a, b) => a - b),
        premios
      }]
    },
    pozoProximo,
    source: 'loteriadesalta.com'
  };
}

async function parseLoto5TuJugada() {
  const html = await fetchHtml('https://www.tujugada.com.ar/loto5.asp');
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());

  const headerM = bodyText.match(/Loto 5 Plus\s*Sorteo:\s*(\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if (!headerM) throw new Error('Loto 5 TuJugada: cabecera no encontrada');
  const sorteo = Number(headerM[1]);
  const fecha = parseFecha(headerM[2]) || getFechaAR();

  const pozoM = bodyText.match(/PROXIMO POZO\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const start = bodyText.indexOf('NUMEROS GANADORES');
  const end = bodyText.indexOf('PREMIOS DEL SORTEO', start);
  const chunk = start >= 0 && end > start ? bodyText.slice(start, end) : '';
  const bolillas = parseNumbersArray(chunk.match(/\b\d{1,2}\b/g) || [], 0, 36, 5);
  if (!bolillas) throw new Error('Loto 5 TuJugada: sin bolillas');

  const table = $('table').filter((_, t) => normalizeKey($(t).text()).includes('ganad')).first();
  return {
    draw: {
      sorteo,
      fecha,
      modalidades: [{
        nombre: 'Sorteo Tradicional (00 al 36)',
        bolillas: bolillas.sort((a, b) => a - b),
        premios: table.length ? parseTablePremios($, table) : []
      }]
    },
    pozoProximo,
    source: 'tujugada.com.ar'
  };
}

async function parsePoceadaTuJugada() {
  const html = await fetchHtml('https://www.tujugada.com.ar/poceada.asp');
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());

  const headerM = bodyText.match(/RESULTADO QUINIELA POCEADA\s*Nro:\s*(\d{4,5})\s*-\s*(\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if (!headerM) throw new Error('Poceada TuJugada: cabecera no encontrada');
  const sorteo = Number(headerM[1]);
  const fecha = parseFecha(headerM[2]) || getFechaAR();

  const pozoM = bodyText.match(/PROXIMO POZO POCEADA\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const start = bodyText.indexOf('NUMEROS GANADORES', bodyText.indexOf('RESULTADO QUINIELA POCEADA'));
  const end = bodyText.indexOf('PREMIOS DEL SORTEO', start);
  const chunk = start >= 0 && end > start ? bodyText.slice(start, end) : '';
  const bolillas = parseNumbersArray(chunk.match(/\b\d{1,2}\b/g) || [], 0, 99, 20);
  if (!bolillas) throw new Error('Poceada TuJugada: se esperaban 20 bolillas');

  const table = $('table').filter((_, t) => {
    const k = normalizeKey($(t).text());
    return k.includes('cant') && k.includes('gan.');
  }).first();

  return {
    draw: {
      sorteo,
      fecha,
      modalidades: [{
        nombre: 'Extracto de 20 números (00 al 99)',
        bolillas: bolillas.sort((a, b) => a - b),
        premios: table.length ? parseTablePremios($, table) : []
      }]
    },
    pozoProximo,
    source: 'tujugada.com.ar'
  };
}

async function parsePoceadaNotitimba() {
  const html = await fetchHtml('https://www.notitimba.com/poceada/');
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());

  const sorteoM = bodyText.match(/SORTEO\s*N[°º]\s*(\d{4,5})/i);
  if (!sorteoM) throw new Error('Poceada NotiTimba: sorteo no encontrado');
  const sorteo = Number(sorteoM[1]);
  const fecha = parseFecha(bodyText) || getFechaAR();

  const bolillas = [];
  $('table').first().find('td').each((_, td) => {
    const txt = cleanText($(td).text());
    if (/^\d{2}$/.test(txt)) {
      const n = Number(txt);
      if (n >= 0 && n <= 99 && !bolillas.includes(n)) bolillas.push(n);
    }
  });
  if (bolillas.length !== 20) throw new Error(`Poceada NotiTimba: ${bolillas.length}/20 bolillas`);

  const premios = [];
  const matches = [...bodyText.matchAll(/(8|7|6|5)\s+aciertos\s+(VACANTE|\d+\s+Ganador(?:es)?)\s+(?:Pozo:|Cobra(?:\s+c\/u)?)\s*(\$\s*[\d.,]+)/gi)];
  for (const m of matches) {
    const g = normalizeGanadores(m[2]);
    const money = formatMoney(m[3]);
    premios.push({
      aciertos: `${m[1]} aciertos`,
      ganadores: g,
      pozo: money || 'A confirmar',
      premioIndividual: g === 'Vacante' ? 'Vacante' : (money || 'A confirmar')
    });
  }

  return {
    draw: {
      sorteo,
      fecha,
      modalidades: [{
        nombre: 'Extracto de 20 números (00 al 99)',
        bolillas: bolillas.sort((a, b) => a - b),
        premios
      }]
    },
    pozoProximo: null,
    source: 'notitimba.com'
  };
}

async function parseQuinielaPlusTuJugada() {
  const html = await fetchHtml('https://www.tujugada.com.ar/quiniela-plus.asp');
  const $ = cheerio.load(html);
  const bodyText = cleanText($('body').text());

  const headerM = bodyText.match(/RESULTADO QUINIELA PLUS\s*Nro:\s*(\d{4,6})\s*-\s*(\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if (!headerM) throw new Error('Quiniela Plus TuJugada: cabecera no encontrada');
  const sorteo = Number(headerM[1]);
  const fecha = parseFecha(headerM[2]) || getFechaAR();

  const pozoM = bodyText.match(/PROXIMO POZO QUINIELA PLUS\s*(\$\s*[\d.,]+)/i);
  const pozoProximo = pozoM ? formatMoney(pozoM[1]) : null;

  const MODS = [
    { marker: 'RESULTADO QUINIELA PLUS', nombre: 'Quiniela Plus (Tradicional)' },
    { marker: 'RESULTADO SUPER PLUS', nombre: 'Super Plus' },
    { marker: 'RESULTADO CHANCE PLUS', nombre: 'Chance Plus' }
  ];

  const premioTables = $('table').filter((_, t) => {
    const k = normalizeKey($(t).text());
    return k.includes('cant') && k.includes('gan.');
  }).toArray();

  // En TuJugada las 3 grillas tienen su bloque "NUMEROS GANADORES ... PREMIOS DEL SORTEO"
  const modalidades = [];
  for (let i = 0; i < MODS.length; i++) {
    const m = MODS[i];
    const mIdx = bodyText.indexOf(m.marker);
    if (mIdx === -1) continue;
    const numStart = bodyText.indexOf('NUMEROS GANADORES', mIdx);
    const numEnd = bodyText.indexOf('PREMIOS DEL SORTEO', numStart);
    if (numStart === -1 || numEnd === -1) continue;
    const chunk = bodyText.slice(numStart, numEnd);
    const bolillas = parseNumbersArray(chunk.match(/\b\d{1,2}\b/g) || [], 0, 99, 20);
    if (!bolillas) continue;

    // Asociar la tabla de premios correcta (Super Plus a veces solo muestra 7 aciertos, Chance Plus 8..5)
    let premios = [];
    if (premioTables[i]) {
      premios = parseTablePremios($, $(premioTables[i]));
    }
    // En TuJugada a veces la tabla de Chance Plus precede en orden DOM a Super Plus o viceversa;
    // validamos contra el texto posterior a PREMIOS DEL SORTEO
    const nextMarkerIdx = i + 1 < MODS.length ? bodyText.indexOf(MODS[i + 1].marker, numEnd) : bodyText.indexOf('Controlar Jugadas', numEnd);
    const afterText = bodyText.slice(numEnd, nextMarkerIdx > numEnd ? nextMarkerIdx : numEnd + 400);
    const textPremios = [];
    const rowRe = /\b(8|7|6|5)\s+(Vac\.?|Vacante|\d+)\s+(\$\s*[\d.,]+)/gi;
    let rm;
    while ((rm = rowRe.exec(afterText)) !== null) {
      const g = normalizeGanadores(rm[2]);
      const money = formatMoney(rm[3]);
      textPremios.push({
        aciertos: `${rm[1]} aciertos`,
        ganadores: g,
        pozo: money || 'A confirmar',
        premioIndividual: g === 'Vacante' ? 'Vacante' : (money || 'A confirmar')
      });
    }

    modalidades.push({
      nombre: m.nombre,
      bolillas: bolillas.sort((a, b) => a - b),
      premios: textPremios.length ? textPremios : premios
    });
  }

  if (modalidades.length === 0) throw new Error('Quiniela Plus TuJugada: sin modalidades');
  return { draw: { sorteo, fecha, modalidades }, pozoProximo, source: 'tujugada.com.ar' };
}

// ============================================================================
// PARSERS DE QUINIELAS (Todas las 7 provincias desde TuJugada)
// ============================================================================

const QUINIELAS_SOURCES = {
  ciudad: {
    url: 'https://www.tujugada.com.ar/quiniela-nacional.asp',
    hasLetras: true,
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  },
  provincia: {
    url: 'https://www.tujugada.com.ar/quiniela_provincia_buenos_aires.asp',
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primero', nombre: 'El Primero', hora: '12:00' },
      primero: { key: 'primero', nombre: 'El Primero', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  },
  santafe: {
    url: 'https://www.tujugada.com.ar/quiniela_santa_fe.asp',
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  },
  cordoba: {
    url: 'https://www.tujugada.com.ar/quiniela_cordoba.asp',
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' },
      turista: { key: 'turista', nombre: 'Turista', hora: '22:15' }
    }
  },
  entrerios: {
    url: 'https://www.tujugada.com.ar/quiniela_entre_rios.asp',
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' },
      turista: { key: 'turista', nombre: 'Turista', hora: '22:15' }
    }
  },
  mendoza: {
    url: 'https://www.tujugada.com.ar/quiniela_mendoza.asp',
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  },
  corrientes: {
    url: 'https://www.tujugada.com.ar/quiniela_correntina.asp',
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  }
};

function parseTuJugadaQuinielaTable($, $tbl) {
  const byPos = new Map();
  $tbl.find('tr').each((_, tr) => {
    const cells = $(tr).find('td, th').map((__, td) => stripTuJugadaHidden($, $(td))).get();
    // Las tablas de TuJugada tienen 4 columnas: [Ubic, NUMERO, Ubic, NUMERO]
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const posM = cells[i].match(/^\d{1,2}$/);
      if (!posM) continue;
      const pos = Number(posM[0]);
      if (pos < 1 || pos > 20) continue;
      const numM = cells[i + 1].match(/\b(\d{4,5})\b/);
      if (!numM) continue;
      const val4 = numM[1].slice(-4);
      byPos.set(pos, val4);
    }
  });
  if (byPos.size !== 20) return null;
  const extracto = [];
  for (let p = 1; p <= 20; p++) {
    const v = byPos.get(p);
    if (!v || !/^\d{4}$/.test(v)) return null;
    extracto.push(v);
  }
  return extracto;
}

async function updateQuinielaFromTuJugada(provKey, data) {
  const cfg = QUINIELAS_SOURCES[provKey];
  const prov = data.quinielas[provKey];
  if (!cfg || !prov) return { updated: false, info: 'sin config' };

  const html = await fetchHtml(cfg.url);
  const $ = cheerio.load(html);

  const parsedTurnos = [];

  $('table').each((_, tbl) => {
    const $tbl = $(tbl);
    const tblHeader = normalizeKey($tbl.find('tr').first().text());
    if (!tblHeader.includes('ubic') && !tblHeader.includes('numero')) return;

    const extracto = parseTuJugadaQuinielaTable($, $tbl);
    if (!extracto) return;

    // Buscar el encabezado de fecha + turno inmediatamente anterior a la tabla
    const contextParts = [];
    const $prev = $tbl.prevAll();
    for (let i = 0; i < Math.min(6, $prev.length); i++) {
      contextParts.unshift(stripTuJugadaHidden($, $prev.eq(i)));
    }
    if (contextParts.join(' ').length < 15) {
      contextParts.unshift(stripTuJugadaHidden($, $tbl.parent()));
    }
    const ctx = contextParts.join(' ');

    const fecha = parseFecha(ctx);
    if (!fecha) return;

    const turnoRegex = /\b(previa|primera|primero|matutina|vespertina|nocturna|turista)\b/i;
    const turnoM = ctx.match(turnoRegex);
    if (!turnoM) return;

    const turnoRawKey = turnoM[1].toLowerCase();
    const spec = cfg.turnosMap[turnoRawKey];
    if (!spec) return;

    // Letras para Ciudad (ej. "Letras: AUBS")
    let letras;
    if (cfg.hasLetras) {
      const afterText = stripTuJugadaHidden($, $tbl.nextAll().slice(0, 2));
      const letrasM = (ctx + ' ' + afterText).match(/Letras:\s*([A-Z]{4}|[A-Z](?:-[A-Z]){3})/i);
      if (letrasM) {
        letras = letrasM[1].toUpperCase().includes('-')
          ? letrasM[1].toUpperCase()
          : letrasM[1].toUpperCase().split('').join('-');
      }
    }

    parsedTurnos.push({ fecha, spec, extracto, letras });
  });

  if (parsedTurnos.length === 0) {
    throw new Error(`TuJugada ${provKey}: 0 extractos válidos encontrados`);
  }

  let updated = false;
  for (const item of parsedTurnos) {
    prov.fechas[item.fecha] = prov.fechas[item.fecha] || {};
    const existing = prov.fechas[item.fecha][item.spec.key];
    const nextTurno = {
      nombre: item.spec.nombre,
      hora: item.spec.hora,
      sorteo: existing?.sorteo || 0,
      ...(item.letras ? { letras: item.letras } : (existing?.letras ? { letras: existing.letras } : {})),
      extracto: item.extracto
    };

    if (!existing || JSON.stringify(existing.extracto) !== JSON.stringify(nextTurno.extracto) || existing.letras !== nextTurno.letras) {
      prov.fechas[item.fecha][item.spec.key] = nextTurno;
      updated = true;
    }
  }

  // Asegurar que las fechas estén ordenadas y limitar a las 10 más recientes
  const sortedDates = Object.keys(prov.fechas).filter(isValidIsoDate).sort();
  const keptDates = sortedDates.slice(-10);
  const nextFechas = {};
  for (const d of keptDates) {
    nextFechas[d] = prov.fechas[d];
  }
  if (JSON.stringify(prov.fechas) !== JSON.stringify(nextFechas)) {
    prov.fechas = nextFechas;
    updated = true;
  }

  const lastDate = keptDates[keptDates.length - 1];
  const lastTurnos = lastDate ? Object.keys(prov.fechas[lastDate]).join(',') : '-';
  return { updated, info: `fecha=${lastDate} turnos=[${lastTurnos}] (${parsedTurnos.length} extractos)` };
}

// --- Ejecución con fallback por cada poceado ---

async function runWithFallbacks(gameKey, data, parsers) {
  const errors = [];
  for (const [label, fn] of parsers) {
    try {
      const res = await fn();
      const changed = archiveIfNewDraw(gameKey, data.poceados[gameKey], res.draw, res.pozoProximo);
      console.log(`[${changed ? 'ACTUALIZADO' : 'SIN CAMBIOS'}] ${gameKey} | fuente=${label} | sorteo=${res.draw.sorteo} | fecha=${res.draw.fecha} | mods=${res.draw.modalidades.length}`);
      return changed;
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  }
  console.warn(`[AVISO] ${gameKey} falló en todas las fuentes -> ${errors.join(' | ')}`);
  return false;
}

async function main() {
  const raw = await fs.readFile(RESULTADOS_PATH, 'utf-8');
  const data = JSON.parse(raw);
  const beforeSnapshot = JSON.stringify({ poceados: data.poceados, quinielas: data.quinielas });

  const poceadoTasks = [
    ['quini6', [
      ['loteriadesalta', parseQuini6Salta],
      ['tujugada', parseQuini6TuJugada]
    ]],
    ['lotoPlus', [
      ['loteriadesalta', parseLotoPlusSalta],
      ['tujugada', parseLotoPlusTuJugada]
    ]],
    ['brinco', [
      ['loteriadesalta', parseBrincoSalta],
      ['tujugada', parseBrincoTuJugada]
    ]],
    ['telekino', [
      ['loteriadesalta', parseTelekinoSalta],
      ['tujugada', parseTelekinoTuJugada]
    ]],
    ['loto5', [
      ['loteriadesalta', parseLoto5Salta],
      ['tujugada', parseLoto5TuJugada]
    ]],
    ['laPoceada', [
      ['tujugada', parsePoceadaTuJugada],
      ['notitimba', parsePoceadaNotitimba]
    ]],
    ['quinielaPlus', [
      ['tujugada', parseQuinielaPlusTuJugada]
    ]]
  ];

  for (const [gameKey, parsers] of poceadoTasks) {
    await runWithFallbacks(gameKey, data, parsers);
  }

  for (const provKey of Object.keys(QUINIELAS_SOURCES)) {
    try {
      const res = await updateQuinielaFromTuJugada(provKey, data);
      console.log(`[${res.updated ? 'ACTUALIZADO' : 'SIN CAMBIOS'}] quiniela:${provKey} | fuente=tujugada | ${res.info}`);
    } catch (err) {
      console.warn(`[AVISO] quiniela:${provKey} falló -> ${err.message}`);
    }
  }

  const afterSnapshot = JSON.stringify({ poceados: data.poceados, quinielas: data.quinielas });

  if (beforeSnapshot === afterSnapshot) {
    console.log('Sin cambios reales en poceados ni quinielas; no se sobrescribe resultados.json.');
    return;
  }

  data.actualizadoEl = getIsoAR();
  delete data.notaEstado;
  await fs.writeFile(RESULTADOS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`Guardado resultados.json (${data.actualizadoEl}).`);
}

main().catch((err) => {
  console.error('Error fatal en actualizador:', err);
  process.exit(1);
});
