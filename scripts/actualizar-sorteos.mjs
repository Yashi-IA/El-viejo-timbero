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
    // Si es exactamente la misma fecha que prev.fecha, puede haber cambiado el número de sorteo
    // (ej. Clarín estimó prev+1 y luego La Nación trajo el número oficial exacto, o viceversa).
    // En ese caso actualizamos ultimo sin duplicar en historico.
    if (prev.fecha && normalizedNew.fecha === prev.fecha && newSorteo !== prevSorteo) {
      if (normalizedNew.numeroPlus === undefined && prev.numeroPlus !== undefined) {
        normalizedNew.numeroPlus = prev.numeroPlus;
      }
      const prevScore = drawCompletenessScore(prev);
      const newScore = drawCompletenessScore(normalizedNew);
      if (newScore >= prevScore || newSorteo > prevSorteo) {
        gameObj.ultimo = normalizedNew;
        gameObj.estadoFuente = 'ok';
        sanitizeHistorico(gameObj);
        return true;
      }
      return changed;
    }

    if (prev.fecha && normalizedNew.fecha < prev.fecha) {
      console.log(`  [${gameKey}] Ignorando regresión de fecha (${normalizedNew.fecha} < ${prev.fecha}).`);
      return changed;
    }
    if (newSorteo < prevSorteo) {
      console.log(`  [${gameKey}] Ignorando regresión de sorteo (${newSorteo} < ${prevSorteo}).`);
      return changed;
    }

    if (newSorteo === prevSorteo) {
      if (normalizedNew.numeroPlus === undefined && prev.numeroPlus !== undefined) {
        normalizedNew.numeroPlus = prev.numeroPlus;
      }
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

    // newSorteo > prevSorteo y fecha distinta (posterior): archivar anterior en historico
    gameObj.historico = gameObj.historico || [];
    gameObj.historico.unshift(prev);
  }

  gameObj.ultimo = normalizedNew;
  gameObj.estadoFuente = 'ok';
  sanitizeHistorico(gameObj);
  return true;
}

// ============================================================================
// EXTRACTOR JSON DE LA NACIÓN (Fusion.globalContent)
// ============================================================================

function extractLaNacionJson(html) {
  const markerRe = /Fusion\.globalContent\s*=\s*/;
  const m = markerRe.exec(html);
  if (!m) {
    throw new Error('La Nación: Fusion.globalContent no encontrado');
  }

  let pos = m.index + m[0].length;
  while (pos < html.length && (html[pos] === ' ' || html[pos] === '\t' || html[pos] === '\n' || html[pos] === '\r' || html[pos] === '(')) {
    pos++;
  }
  if (html[pos] !== '{') {
    throw new Error('La Nación: inicio de objeto JSON no encontrado en Fusion.globalContent');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endPos = -1;

  for (let i = pos; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endPos = i;
        break;
      }
    }
  }

  if (endPos === -1) {
    throw new Error('La Nación: llaves desbalanceadas en Fusion.globalContent');
  }

  return JSON.parse(html.slice(pos, endPos + 1));
}

function extractLaNacionSorteo(html, $, json) {
  const metaNum = cleanText(json?.metaData?.lotteryNumber);
  if (/^\d{3,6}$/.test(metaNum)) {
    return Number(metaNum);
  }
  const metaNumMatch = metaNum.match(/\b(\d{3,6})\b/);
  if (metaNumMatch) {
    return Number(metaNumMatch[1]);
  }

  const details = Array.isArray(json?.dataService?.lotteryDetail) ? json.dataService.lotteryDetail : [];
  for (const item of details) {
    const cand = cleanText(item?.lotteryNumber ?? item?.drawNumber ?? item?.sorteo ?? '');
    if (/^\d{3,6}$/.test(cand)) return Number(cand);
  }

  const candidates = [
    $('title').text(),
    $('meta[property="og:title"]').attr('content'),
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    JSON.stringify(json?.metaData || {}),
    $('h1, h2').map((_, el) => $(el).text()).get().join(' ')
  ];

  const sorteoRe = /sorteo\s*N?\.?[°º]?\s*(\d{3,6})/i;
  for (const raw of candidates) {
    const t = cleanText(raw).replace(/pr[óo]ximo\s+sorteo[^.\n]{0,40}/gi, '');
    const m = t.match(sorteoRe);
    if (m) return Number(m[1]);
  }

  const $bodyClone = $('body').clone();
  $bodyClone.find('script, style, noscript').remove();
  const bodyText = cleanText($bodyClone.text()).replace(/pr[óo]ximo\s+sorteo[^.\n]{0,40}/gi, '');
  const bodyM = bodyText.match(sorteoRe);
  if (bodyM) return Number(bodyM[1]);

  return null;
}

function parseLaNacionWinnersTable(winnersTable, defaultAciertos = '6 aciertos') {
  if (!Array.isArray(winnersTable) || winnersTable.length === 0) {
    return [{
      aciertos: defaultAciertos,
      ganadores: 'A confirmar',
      pozo: 'A confirmar',
      premioIndividual: 'A confirmar'
    }];
  }

  const rows = [];
  for (const row of winnersTable) {
    if (!row || typeof row !== 'object') continue;
    const aciertos = normalizeAciertos(row.name ?? row.aciertos ?? row.category ?? '');
    const ganadores = normalizeGanadores(row.winners ?? row.ganadores ?? '');
    const money = formatMoney(row.amount ?? row.prize ?? row.pozo ?? '');
    const isZeroMoney = !money || /^\$\s*0+(?:[.,]0+)?$/.test(money);

    if (ganadores === 'Vacante') {
      rows.push({
        aciertos,
        ganadores: 'Vacante',
        pozo: isZeroMoney ? 'Vacante' : money,
        premioIndividual: 'Vacante'
      });
    } else if (ganadores === 'A confirmar') {
      rows.push({
        aciertos,
        ganadores: 'A confirmar',
        pozo: isZeroMoney ? 'A confirmar' : money,
        premioIndividual: 'A confirmar'
      });
    } else {
      rows.push({
        aciertos,
        ganadores,
        pozo: isZeroMoney ? 'A confirmar' : money,
        premioIndividual: isZeroMoney ? 'A confirmar' : money
      });
    }
  }

  return rows.length ? rows : [{
    aciertos: defaultAciertos,
    ganadores: 'A confirmar',
    pozo: 'A confirmar',
    premioIndividual: 'A confirmar'
  }];
}

function extractLaNacionPozoProximo(json, details) {
  for (const item of details) {
    const pot = formatMoney(item?.estimatedPot);
    if (pot && !/^\$\s*0+(?:[.,]0+)?$/.test(pot) && pot !== 'Vacante' && pot !== 'A confirmar') {
      return pot;
    }
  }
  const acum = json?.acumuladoGeneral;
  if (typeof acum === 'string' || typeof acum === 'number') {
    const pot = formatMoney(String(acum));
    if (pot && !/^\$\s*0+(?:[.,]0+)?$/.test(pot)) return pot;
  } else if (acum && typeof acum === 'object') {
    for (const k of ['estimatedPot', 'pot', 'amount', 'monto', 'total', 'pozo']) {
      if (acum[k] !== undefined && acum[k] !== null) {
        const pot = formatMoney(String(acum[k]));
        if (pot && !/^\$\s*0+(?:[.,]0+)?$/.test(pot)) return pot;
      }
    }
    for (const v of Object.values(acum)) {
      if (typeof v === 'string' && /[\d$]/.test(v)) {
        const pot = formatMoney(v);
        if (pot && !/^\$\s*0+(?:[.,]0+)?$/.test(pot)) return pot;
      }
    }
  }
  return null;
}

function extractLotoNumeroPlus(json, $, details) {
  const fromFields = [
    json?.dataService?.numeroPlus,
    json?.dataService?.plus,
    json?.dataService?.additional,
    json?.metaData?.numeroPlus,
    json?.metaData?.plus,
    json?.metaData?.additional,
    ...details.flatMap(d => [d?.numeroPlus, d?.plus, d?.additional, d?.additionalNumber])
  ];
  for (const val of fromFields) {
    if (val === undefined || val === null || val === '') continue;
    const n = Number(String(val).trim());
    if (Number.isInteger(n) && n >= 0 && n <= 9) return n;
  }

  const $bodyClone = $('body').clone();
  $bodyClone.find('script, style, noscript').remove();
  const bodyText = cleanText($bodyClone.text());
  const plusM = bodyText.match(/(?:n[úu]mero\s+plus|bolilla\s+plus|plus\s+n[°º]?)\s*[:\-]?\s*(\d)\b/i);
  if (plusM) {
    const n = Number(plusM[1]);
    if (Number.isInteger(n) && n >= 0 && n <= 9) return n;
  }
  return undefined;
}

// ============================================================================
// PARSERS DE POCEADOS (Primario: La Nación JSON + Respaldo NotiTimba Poceada)
// ============================================================================

const LA_NACION_POCEADOS = {
  quini6: {
    url: 'https://www.lanacion.com.ar/loterias/quini-6/',
    min: 0,
    max: 45,
    expectedBolillas: 6,
    defaultAciertos: '6 aciertos',
    minModalidades: 4,
    canonicalOrder: ['Tradicional Primer Sorteo', 'La Segunda del Quini', 'Revancha', 'Siempre Sale'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('pozo extra') || k === 'extra') return null; // 16 bolillas, se ignora
      if (k.includes('tradicional')) return 'Tradicional Primer Sorteo';
      if (k.includes('segunda')) return 'La Segunda del Quini';
      if (k.includes('revancha')) return 'Revancha';
      if (k.includes('siempre sale')) return 'Siempre Sale';
      return null;
    }
  },
  lotoPlus: {
    url: 'https://www.lanacion.com.ar/loterias/loto/',
    min: 0,
    max: 45,
    expectedBolillas: 6,
    defaultAciertos: '6 aciertos',
    minModalidades: 4,
    hasNumeroPlus: true,
    canonicalOrder: ['Tradicional', 'Match', 'Desquite', 'Sale o Sale'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('tradicional')) return 'Tradicional';
      if (k.includes('match')) return 'Match';
      if (k.includes('desquite')) return 'Desquite';
      if (k.includes('sale o sale')) return 'Sale o Sale';
      return null;
    }
  },
  telekino: {
    url: 'https://www.lanacion.com.ar/loterias/telekino/',
    min: 1,
    max: 25,
    expectedBolillas: 15,
    defaultAciertos: '15 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Telekino Tradicional', 'Rekino'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('rekino')) return 'Rekino';
      if (k.includes('telekino') || k.includes('tradicional')) return 'Telekino Tradicional';
      return null;
    }
  },
  brinco: {
    url: 'https://www.lanacion.com.ar/loterias/brinco/',
    min: 0,
    max: 39,
    expectedBolillas: 6,
    defaultAciertos: '6 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Brinco Tradicional', 'Brinco Junior Siempre Sale'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('junior')) return 'Brinco Junior Siempre Sale';
      if (k.includes('tradicional') || k === 'brinco') return 'Brinco Tradicional';
      return null;
    }
  },
  loto5: {
    url: 'https://www.lanacion.com.ar/loterias/loto-5/',
    min: 0,
    max: 36,
    expectedBolillas: 5,
    defaultAciertos: '5 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Sorteo Tradicional (00 al 36)'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('loto 5') || k.includes('tradicional') || k === 'loto5' || k.includes('sorteo')) {
        return 'Sorteo Tradicional (00 al 36)';
      }
      return 'Sorteo Tradicional (00 al 36)';
    }
  },
  laPoceada: {
    url: 'https://www.lanacion.com.ar/loterias/quiniela-poceada/',
    min: 0,
    max: 99,
    expectedBolillas: 20,
    defaultAciertos: '8 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Extracto de 20 números (00 al 99)'],
    mapModalidad() {
      return 'Extracto de 20 números (00 al 99)';
    }
  },
  quinielaPlus: {
    url: 'https://www.lanacion.com.ar/loterias/quiniela-plus/',
    min: 0,
    max: 99,
    expectedBolillas: 20,
    defaultAciertos: '8 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Quiniela Plus (Tradicional)', 'Super Plus', 'Chance Plus'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('super')) return 'Super Plus';
      if (k.includes('chance')) return 'Chance Plus';
      if (k.includes('quiniela plus') || k.includes('tradicional')) return 'Quiniela Plus (Tradicional)';
      return null;
    }
  }
};

function parseLaNacionPoceadoFromHtml(gameKey, html, existingUltimo = null) {
  const spec = LA_NACION_POCEADOS[gameKey];
  if (!spec) throw new Error(`Configuración de poceado inexistente para ${gameKey}`);

  const json = extractLaNacionJson(html);
  const $ = cheerio.load(html);
  const details = Array.isArray(json?.dataService?.lotteryDetail) ? json.dataService.lotteryDetail : [];
  if (details.length === 0) {
    throw new Error(`La Nación ${gameKey}: dataService.lotteryDetail vacío`);
  }

  const sorteo = extractLaNacionSorteo(html, $, json);
  if (!sorteo || !Number.isInteger(sorteo) || sorteo <= 0) {
    throw new Error(`La Nación ${gameKey}: número de sorteo no encontrado`);
  }

  const fallbackYear = Number(getFechaAR().slice(0, 4));
  const metaFecha = parseFecha(json?.metaData?.completeDay, fallbackYear);
  const datedItems = details.map(item => ({
    item,
    fecha: parseFecha(item?.date, fallbackYear) || metaFecha
  }));
  const validDates = datedItems.map(x => x.fecha).filter(Boolean).sort();
  const fecha = validDates[validDates.length - 1];
  if (!fecha) {
    throw new Error(`La Nación ${gameKey}: fecha inválida o ausente`);
  }

  const modalidadesByName = new Map();
  for (const { item, fecha: itemFecha } of datedItems) {
    if (itemFecha && itemFecha !== fecha) continue;
    const modName = spec.mapModalidad(item?.name || '');
    if (!modName) continue;

    const bolillas = parseNumbersArray(item?.results || [], spec.min, spec.max, spec.expectedBolillas);
    if (!bolillas) continue;

    if (!modalidadesByName.has(modName)) {
      modalidadesByName.set(modName, {
        nombre: modName,
        bolillas: bolillas.sort((a, b) => a - b),
        premios: parseLaNacionWinnersTable(item?.winners_table, spec.defaultAciertos)
      });
    }
  }

  const modalidades = [];
  for (const name of spec.canonicalOrder) {
    if (modalidadesByName.has(name)) {
      modalidades.push(modalidadesByName.get(name));
    }
  }
  for (const [name, mod] of modalidadesByName.entries()) {
    if (!spec.canonicalOrder.includes(name)) {
      modalidades.push(mod);
    }
  }

  if (modalidades.length < spec.minModalidades) {
    throw new Error(`La Nación ${gameKey}: solo ${modalidades.length}/${spec.minModalidades} modalidades válidas`);
  }

  const draw = { sorteo, fecha, modalidades };
  if (spec.hasNumeroPlus) {
    let numeroPlus = extractLotoNumeroPlus(json, $, details);
    if (numeroPlus === undefined && existingUltimo && Number(existingUltimo.sorteo) === sorteo && existingUltimo.numeroPlus !== undefined) {
      numeroPlus = existingUltimo.numeroPlus;
    }
    if (numeroPlus !== undefined) {
      draw.numeroPlus = numeroPlus;
    }
  }

  const pozoProximo = extractLaNacionPozoProximo(json, details);
  return { draw, pozoProximo, source: 'lanacion.com.ar' };
}

async function parseLaNacionPoceado(gameKey, url, existingUltimo = null) {
  const html = await fetchHtml(url);
  return parseLaNacionPoceadoFromHtml(gameKey, html, existingUltimo);
}

// ============================================================================
// PARSER DE POCEADOS EN CLARÍN (__NEXT_DATA__ / JSON + fallback DOM/texto)
// ============================================================================

const CLARIN_POCEADOS = {
  quini6: {
    url: 'https://www.clarin.com/loterias-y-quinielas/quini6',
    min: 0,
    max: 45,
    expectedBolillas: 6,
    defaultAciertos: '6 aciertos',
    minModalidades: 4,
    canonicalOrder: ['Tradicional Primer Sorteo', 'La Segunda del Quini', 'Revancha', 'Siempre Sale'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('pozo extra') || k === 'extra') return null;
      if (k.includes('tradicional')) return 'Tradicional Primer Sorteo';
      if (k.includes('segunda')) return 'La Segunda del Quini';
      if (k.includes('revancha')) return 'Revancha';
      if (k.includes('siempre sale')) return 'Siempre Sale';
      return null;
    }
  },
  lotoPlus: {
    url: 'https://www.clarin.com/loterias-y-quinielas/loto',
    min: 0,
    max: 45,
    expectedBolillas: 6,
    defaultAciertos: '6 aciertos',
    minModalidades: 4,
    hasNumeroPlus: true,
    canonicalOrder: ['Tradicional', 'Match', 'Desquite', 'Sale o Sale'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('tradicional')) return 'Tradicional';
      if (k.includes('match')) return 'Match';
      if (k.includes('desquite')) return 'Desquite';
      if (k.includes('sale o sale')) return 'Sale o Sale';
      return null;
    }
  },
  telekino: {
    url: 'https://www.clarin.com/loterias-y-quinielas/telekino',
    min: 1,
    max: 25,
    expectedBolillas: 15,
    defaultAciertos: '15 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Telekino Tradicional', 'Rekino'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('rekino')) return 'Rekino';
      if (k.includes('telekino') || k.includes('tradicional')) return 'Telekino Tradicional';
      return null;
    }
  },
  brinco: {
    url: 'https://www.clarin.com/loterias-y-quinielas/brinco',
    min: 0,
    max: 39,
    expectedBolillas: 6,
    defaultAciertos: '6 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Brinco Tradicional', 'Brinco Junior Siempre Sale'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('junior')) return 'Brinco Junior Siempre Sale';
      if (k.includes('tradicional') || k === 'brinco') return 'Brinco Tradicional';
      return null;
    }
  },
  loto5: {
    url: 'https://www.clarin.com/loterias-y-quinielas/loto5',
    min: 0,
    max: 36,
    expectedBolillas: 5,
    defaultAciertos: '5 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Sorteo Tradicional (00 al 36)'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('loto 5') || k.includes('tradicional') || k === 'loto5' || k.includes('sorteo')) {
        return 'Sorteo Tradicional (00 al 36)';
      }
      return 'Sorteo Tradicional (00 al 36)';
    }
  },
  laPoceada: {
    url: 'https://www.clarin.com/loterias-y-quinielas/poceada',
    min: 0,
    max: 99,
    expectedBolillas: 20,
    defaultAciertos: '8 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Extracto de 20 números (00 al 99)'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('poceada') || k.includes('tradicional') || k.includes('extracto')) {
        return 'Extracto de 20 números (00 al 99)';
      }
      return 'Extracto de 20 números (00 al 99)';
    }
  },
  quinielaPlus: {
    url: 'https://www.clarin.com/loterias-y-quinielas/plus',
    min: 0,
    max: 99,
    expectedBolillas: 20,
    defaultAciertos: '8 aciertos',
    minModalidades: 1,
    canonicalOrder: ['Quiniela Plus (Tradicional)', 'Super Plus', 'Chance Plus'],
    mapModalidad(rawName) {
      const k = normalizeKey(rawName);
      if (k.includes('super')) return 'Super Plus';
      if (k.includes('chance')) return 'Chance Plus';
      if (k.includes('quiniela plus') || k.includes('tradicional')) return 'Quiniela Plus (Tradicional)';
      return null;
    }
  }
};

function resolveClarinSorteoNumber(extractedSorteo, fecha, existingGameObj) {
  if (extractedSorteo && Number.isInteger(extractedSorteo) && extractedSorteo > 0) {
    return extractedSorteo;
  }
  const prevUltimo = existingGameObj?.ultimo;
  const prevSorteo = Number(prevUltimo?.sorteo || 0);
  const prevFecha = prevUltimo?.fecha || null;
  if (!prevSorteo || !prevFecha) return null;

  if (fecha === prevFecha) return prevSorteo;
  if (fecha > prevFecha) return prevSorteo + 1;
  return null; // fecha < prevFecha -> más viejo, se ignora
}

function buildClarinPremiosAligned(aciertosList, ganadoresList, premiosList, defaultAciertos) {
  const len = Math.max(aciertosList.length, ganadoresList.length, premiosList.length);
  if (len === 0) {
    return [{
      aciertos: defaultAciertos,
      ganadores: 'A confirmar',
      pozo: 'A confirmar',
      premioIndividual: 'A confirmar'
    }];
  }

  const rows = [];
  for (let i = 0; i < len; i++) {
    const acRaw = aciertosList[i] ?? '';
    const ganRaw = ganadoresList[i] ?? '';
    const premRaw = premiosList[i] ?? '';

    const aciertos = normalizeAciertos(acRaw || defaultAciertos);
    const ganadores = normalizeGanadores(ganRaw);
    const money = formatMoney(premRaw);
    const isZeroMoney = !money || /^\$\s*0+(?:[.,]0+)?$/.test(money);

    if (ganadores === 'Vacante') {
      rows.push({
        aciertos,
        ganadores: 'Vacante',
        pozo: isZeroMoney ? 'Vacante' : money,
        premioIndividual: 'Vacante'
      });
    } else if (ganadores === 'A confirmar') {
      rows.push({
        aciertos,
        ganadores: 'A confirmar',
        pozo: isZeroMoney ? 'A confirmar' : money,
        premioIndividual: 'A confirmar'
      });
    } else {
      rows.push({
        aciertos,
        ganadores,
        pozo: isZeroMoney ? 'A confirmar' : money,
        premioIndividual: isZeroMoney ? 'A confirmar' : money
      });
    }
  }
  return rows;
}

function extractClarinColumnTokens($, $el) {
  if (!$el || !$el.length) return [];
  const items = $el.find('li, p, span, div, td').filter((_, node) => {
    return $(node).children().length === 0;
  }).map((_, node) => cleanText($(node).text())).get().filter(Boolean);

  if (items.length > 0) return items;
  const raw = cleanText($el.text());
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function parseClarinColumnsFromText(blockText, spec) {
  // Extraer bolillas del bloque "Sorteo ..." antes de "Aciertos"
  const norm = cleanText(blockText);
  const sorteoSecM = norm.match(/\bSorteo\b([\s\S]*?)(?:\bAciertos\b|$)/i);
  const bolillasText = sorteoSecM ? sorteoSecM[1] : norm;
  const numTokens = bolillasText.match(/\b\d{1,2}\b/g) || [];
  const bolillas = parseNumbersArray(numTokens, spec.min, spec.max, spec.expectedBolillas);
  if (!bolillas) return null;

  let numeroPlus;
  if (spec.hasNumeroPlus) {
    const plusM = norm.match(/(?:n[úu]mero\s+plus|bolilla\s+plus|plus)\s*[:\-]?\s*(\d)\b/i);
    if (plusM) {
      const n = Number(plusM[1]);
      if (Number.isInteger(n) && n >= 0 && n <= 9) numeroPlus = n;
    }
  }

  const acSecM = norm.match(/\bAciertos\b([\s\S]*?)(?:\bGanadores\b|\bPremios\b|$)/i);
  const ganSecM = norm.match(/\bGanadores\b([\s\S]*?)(?:\bPremios\b|$)/i);
  const premSecM = norm.match(/\bPremios\b([\s\S]*)$/i);

  const acTokens = acSecM
    ? (cleanText(acSecM[1]).match(/(?:est[íi]mulo|rekino|\d{1,2}(?:\s*(?:aciertos?|nros?\.?))?)/gi) || [])
    : [];
  const ganTokens = ganSecM
    ? (cleanText(ganSecM[1]).match(/(?:vacante|sin\s*ganadores?|a\s*confirmar|\d{1,3}(?:\.\d{3})*|\d+)/gi) || [])
    : [];
  const premTokens = premSecM
    ? (cleanText(premSecM[1]).match(/(?:\$\s*[\d.,]+(?:\s*millones)?|vacante|a\s*confirmar|[-—])/gi) || [])
    : [];

  const premios = buildClarinPremiosAligned(acTokens, ganTokens, premTokens, spec.defaultAciertos);
  return { bolillas: bolillas.sort((a, b) => a - b), premios, numeroPlus };
}

function tryExtractClarinFromNextData(gameKey, spec, $) {
  const nextRaw = $('script#__NEXT_DATA__').html();
  if (!nextRaw) return null;
  let nextJson;
  try {
    nextJson = JSON.parse(nextRaw);
  } catch (_) {
    return null;
  }

  const fallbackYear = Number(getFechaAR().slice(0, 4));
  let foundFecha = null;
  let foundSorteo = null;
  let foundPlus;
  let foundPozoProximo = null;
  const modalidadesByName = new Map();

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    // Buscar fecha y sorteo si están en el objeto
    for (const k of ['date', 'fecha', 'drawDate', 'completeDay', 'lastDrawDate', 'subtitle']) {
      if (!foundFecha && typeof node[k] === 'string') {
        const pf = parseFecha(node[k], fallbackYear);
        if (pf) foundFecha = pf;
      }
    }
    for (const k of ['sorteo', 'drawNumber', 'lotteryNumber', 'numeroSorteo', 'nroSorteo']) {
      if (!foundSorteo && (typeof node[k] === 'number' || typeof node[k] === 'string')) {
        const m = String(node[k]).match(/\b(\d{3,6})\b/);
        if (m) foundSorteo = Number(m[1]);
      }
    }
    if (spec.hasNumeroPlus && foundPlus === undefined) {
      for (const k of ['numeroPlus', 'plus', 'additional', 'additionalNumber', 'bonus']) {
        if (node[k] !== undefined && node[k] !== null && /^\d$/.test(String(node[k]).trim())) {
          foundPlus = Number(String(node[k]).trim());
        }
      }
    }
    if (!foundPozoProximo) {
      for (const k of ['estimatedPot', 'pozoProximo', 'nextJackpot', 'pozoEstimado']) {
        if (node[k]) {
          const pot = formatMoney(String(node[k]));
          if (pot && pot !== 'Vacante' && pot !== 'A confirmar') foundPozoProximo = pot;
        }
      }
    }

    // Detectar objeto de modalidad: nombre + array de bolillas
    const rawName = node.name || node.nombre || node.title || node.modality || node.modalidad;
    const rawBalls = node.results || node.bolillas || node.numbers || node.numeros || node.sorteo;
    if (typeof rawName === 'string' && Array.isArray(rawBalls)) {
      const modName = spec.mapModalidad(rawName);
      if (modName && !modalidadesByName.has(modName)) {
        const bolillas = parseNumbersArray(rawBalls, spec.min, spec.max, spec.expectedBolillas);
        if (bolillas) {
          let premios = [];
          const rawPremios = node.winners_table || node.premios || node.prizes || node.awards;
          if (Array.isArray(rawPremios) && rawPremios.length > 0) {
            premios = parseLaNacionWinnersTable(rawPremios, spec.defaultAciertos);
          } else if (Array.isArray(node.aciertos) || Array.isArray(node.ganadores)) {
            premios = buildClarinPremiosAligned(
              node.aciertos || [],
              node.ganadores || [],
              node.premios || [],
              spec.defaultAciertos
            );
          } else {
            premios = buildClarinPremiosAligned([], [], [], spec.defaultAciertos);
          }
          modalidadesByName.set(modName, {
            nombre: modName,
            bolillas: bolillas.sort((a, b) => a - b),
            premios
          });
        }
      }
    }

    for (const val of Object.values(node)) {
      if (val && typeof val === 'object') walk(val);
    }
  };

  walk(nextJson);
  if (modalidadesByName.size === 0) return null;

  return {
    fecha: foundFecha,
    sorteo: foundSorteo,
    numeroPlus: foundPlus,
    pozoProximo: foundPozoProximo,
    modalidadesByName
  };
}

function parseClarinFromDomAndText(gameKey, spec, $) {
  const $bodyClone = $('body').clone();
  $bodyClone.find('script, style, noscript, svg').remove();

  // Convertir estructura HTML a texto preservando saltos entre bloques
  $bodyClone.find('h1, h2, h3, h4, h5, p, li, tr, div, section, article').each((_, el) => {
    $(el).prepend('\n').append('\n');
  });
  const rawLines = $bodyClone.text()
    .split('\n')
    .map(l => cleanText(l))
    .filter(Boolean);
  const fullText = rawLines.join('\n');
  const flatText = cleanText(rawLines.join(' '));

  const fallbackYear = Number(getFechaAR().slice(0, 4));
  let fecha = null;
  const ultM = flatText.match(/[ÚU]ltimos\s+resultados\s*[:\-]?\s*([^|\n]{6,80})/i);
  if (ultM) {
    fecha = parseFecha(ultM[1], fallbackYear);
  }
  if (!fecha) {
    fecha = parseFecha($('h1, h2, .fecha, time').text(), fallbackYear) || parseFecha(flatText, fallbackYear);
  }

  let sorteo = null;
  const cleanedForSorteo = flatText.replace(/pr[óo]ximo\s+sorteo[^.\n]{0,40}/gi, '');
  const sorteoM = cleanedForSorteo.match(/sorteo\s*N?\.?[°º]?\s*(\d{3,6})/i);
  if (sorteoM) sorteo = Number(sorteoM[1]);

  let pozoProximo = null;
  const pozoM = flatText.match(/(?:pozo\s+(?:pr[óo]ximo|estimado|acumulado)[^$\n]{0,40})(\$\s*[\d.,]+(?:\s*millones)?)/i);
  if (pozoM) pozoProximo = formatMoney(pozoM[1]);

  let numeroPlus;
  if (spec.hasNumeroPlus) {
    const plusM = flatText.match(/(?:n[úu]mero\s+plus|bolilla\s+plus|plus\s+n[°º]?)\s*[:\-]?\s*(\d)\b/i);
    if (plusM) {
      const n = Number(plusM[1]);
      if (Number.isInteger(n) && n >= 0 && n <= 9) numeroPlus = n;
    }
  }

  const modalidadesByName = new Map();

  // 1) Intentar primero por contenedores DOM que contengan "Sorteo" y "Aciertos"
  const modHeaderCandidates = [];
  $('h1, h2, h3, h4, h5, strong, .title, [class*="modal"], [class*="title"], [class*="header"], [class*="sub"]').each((_, el) => {
    const txt = cleanText($(el).text());
    if (!txt || txt.length > 60) return;
    const mapped = spec.mapModalidad(txt);
    if (mapped) {
      modHeaderCandidates.push({ el, mapped, raw: txt });
    }
  });

  for (const cand of modHeaderCandidates) {
    if (modalidadesByName.has(cand.mapped)) continue;
    let $container = $(cand.el).parent();
    for (let depth = 0; depth < 4 && $container.length; depth++) {
      const cText = cleanText($container.text());
      // Evitar contenedor padre que engloba múltiples modalidades a la vez
      const otherMods = spec.canonicalOrder.filter(m => {
        if (m === cand.mapped) return false;
        const shortKey = normalizeKey(m.split(' ')[0]);
        return shortKey.length >= 4 && normalizeKey(cText).includes(shortKey);
      });
      if (/sorteo/i.test(cText) && (/\baciertos\b/i.test(cText) || /\d{1,2}/.test(cText)) && otherMods.length <= 1) {
        // Si contiene una tabla HTML estándar de premios, usar parseTablePremios
        const $innerTable = $container.find('table').first();
        if ($innerTable.length) {
          const tablePremios = parseTablePremios($, $innerTable);
          const textBeforeTable = cleanText($container.clone().find('table').remove().end().text());
          const parsedBalls = parseClarinColumnsFromText(textBeforeTable || cText, spec);
          if (parsedBalls && tablePremios.length > 0) {
            modalidadesByName.set(cand.mapped, {
              nombre: cand.mapped,
              bolillas: parsedBalls.bolillas,
              premios: tablePremios
            });
            if (numeroPlus === undefined && parsedBalls.numeroPlus !== undefined) {
              numeroPlus = parsedBalls.numeroPlus;
            }
            break;
          }
        }

        // Intentar columnas DOM explícitas si existen
        const $cols = $container.find('[class*="acierto"], [class*="ganador"], [class*="premio"]');
        if ($cols.length >= 2) {
          const acEl = $container.find('[class*="acierto"]').first();
          const ganEl = $container.find('[class*="ganador"]').first();
          const premEl = $container.find('[class*="premio"]').first();
          const parsed = parseClarinColumnsFromText(cText, spec);
          if (parsed) {
            const acList = extractClarinColumnTokens($, acEl).filter(t => !/^aciertos$/i.test(t));
            const ganList = extractClarinColumnTokens($, ganEl).filter(t => !/^ganadores$/i.test(t));
            const premList = extractClarinColumnTokens($, premEl).filter(t => !/^premios?$/i.test(t));
            const premios = (acList.length || ganList.length || premList.length)
              ? buildClarinPremiosAligned(acList, ganList, premList, spec.defaultAciertos)
              : parsed.premios;
            modalidadesByName.set(cand.mapped, {
              nombre: cand.mapped,
              bolillas: parsed.bolillas,
              premios
            });
            if (numeroPlus === undefined && parsed.numeroPlus !== undefined) {
              numeroPlus = parsed.numeroPlus;
            }
            break;
          }
        }
        const parsed = parseClarinColumnsFromText(cText, spec);
        if (parsed) {
          modalidadesByName.set(cand.mapped, {
            nombre: cand.mapped,
            bolillas: parsed.bolillas,
            premios: parsed.premios
          });
          if (numeroPlus === undefined && parsed.numeroPlus !== undefined) {
            numeroPlus = parsed.numeroPlus;
          }
          break;
        }
      }
      $container = $container.parent();
    }
  }

  // 2) Fallback: segmentar el texto lineal por encabezados de modalidad
  if (modalidadesByName.size < spec.minModalidades) {
    const modMarkers = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line.length > 60) continue;
      const mapped = spec.mapModalidad(line);
      if (mapped) {
        modMarkers.push({ idx: i, mapped });
      }
    }

    for (let m = 0; m < modMarkers.length; m++) {
      const cur = modMarkers[m];
      if (modalidadesByName.has(cur.mapped)) continue;
      const nextIdx = m + 1 < modMarkers.length ? modMarkers[m + 1].idx : Math.min(rawLines.length, cur.idx + 80);
      const blockText = rawLines.slice(cur.idx, nextIdx).join(' ');
      const parsed = parseClarinColumnsFromText(blockText, spec);
      if (parsed) {
        modalidadesByName.set(cur.mapped, {
          nombre: cur.mapped,
          bolillas: parsed.bolillas,
          premios: parsed.premios
        });
        if (numeroPlus === undefined && parsed.numeroPlus !== undefined) {
          numeroPlus = parsed.numeroPlus;
        }
      }
    }

    // Caso de juego de modalidad única sin título explícito (ej. loto5 / poceada)
    if (modalidadesByName.size === 0 && spec.canonicalOrder.length === 1) {
      const parsed = parseClarinColumnsFromText(fullText, spec);
      if (parsed) {
        const onlyName = spec.canonicalOrder[0];
        modalidadesByName.set(onlyName, {
          nombre: onlyName,
          bolillas: parsed.bolillas,
          premios: parsed.premios
        });
        if (numeroPlus === undefined && parsed.numeroPlus !== undefined) {
          numeroPlus = parsed.numeroPlus;
        }
      }
    }
  }

  return { fecha, sorteo, numeroPlus, pozoProximo, modalidadesByName };
}

function parseClarinPoceadoFromHtml(gameKey, html, existingGameObj = null) {
  const spec = CLARIN_POCEADOS[gameKey];
  if (!spec) throw new Error(`Configuración de Clarín inexistente para ${gameKey}`);

  const $ = cheerio.load(html);
  const nextRes = tryExtractClarinFromNextData(gameKey, spec, $);
  const domRes = parseClarinFromDomAndText(gameKey, spec, $);

  const fecha = nextRes?.fecha || domRes.fecha;
  if (!fecha) {
    throw new Error(`Clarín ${gameKey}: fecha inválida o ausente`);
  }

  const rawSorteo = nextRes?.sorteo || domRes.sorteo;
  const sorteo = resolveClarinSorteoNumber(rawSorteo, fecha, existingGameObj);
  if (!sorteo || !Number.isInteger(sorteo) || sorteo <= 0) {
    throw new Error(`Clarín ${gameKey}: no se pudo determinar número de sorteo (fecha=${fecha})`);
  }

  // Combinar modalidades dando prioridad al de mayor completitud
  const mergedMods = new Map(domRes.modalidadesByName);
  if (nextRes?.modalidadesByName) {
    for (const [k, v] of nextRes.modalidadesByName.entries()) {
      const prev = mergedMods.get(k);
      if (!prev || (v.premios?.length || 0) >= (prev.premios?.length || 0)) {
        mergedMods.set(k, v);
      }
    }
  }

  const modalidades = [];
  for (const name of spec.canonicalOrder) {
    if (mergedMods.has(name)) modalidades.push(mergedMods.get(name));
  }
  for (const [name, mod] of mergedMods.entries()) {
    if (!spec.canonicalOrder.includes(name)) modalidades.push(mod);
  }

  if (modalidades.length < spec.minModalidades) {
    throw new Error(`Clarín ${gameKey}: solo ${modalidades.length}/${spec.minModalidades} modalidades válidas`);
  }

  const draw = { sorteo, fecha, modalidades };
  if (spec.hasNumeroPlus) {
    let numeroPlus = nextRes?.numeroPlus ?? domRes.numeroPlus;
    const prevUlt = existingGameObj?.ultimo;
    if (numeroPlus === undefined && prevUlt && Number(prevUlt.sorteo) === sorteo && prevUlt.numeroPlus !== undefined) {
      numeroPlus = prevUlt.numeroPlus;
    }
    if (numeroPlus !== undefined) {
      draw.numeroPlus = numeroPlus;
    }
  }

  const pozoProximo = nextRes?.pozoProximo || domRes.pozoProximo || null;
  return { draw, pozoProximo, source: 'clarin.com' };
}

async function parseClarinPoceado(gameKey, url, existingGameObj = null) {
  const html = await fetchHtml(url);
  return parseClarinPoceadoFromHtml(gameKey, html, existingGameObj);
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

// ============================================================================
// PARSERS DE QUINIELAS (Primario: La Nación JSON / Loterías Mundiales + Respaldo)
// ============================================================================

const QUINIELAS_CONFIG = {
  ciudad: {
    laNacionUrl: 'https://www.lanacion.com.ar/loterias/quiniela-nacional/',
    loteriasMundialesUrls: [
      'https://www.loteriasmundiales.com.ar/Quinielas/nacional',
      'https://www.loteriasmundiales.com.ar/Quinielas/ciudad',
      'https://www.loteriasmundiales.com.ar/Quinielas/entre-rios'
    ],
    hasLetras: true,
    provMatchRe: /\b(ciudad|nacional|caba|capital)\b/i,
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      primero: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  },
  provincia: {
    laNacionUrl: 'https://www.lanacion.com.ar/loterias/quiniela-provincia/',
    loteriasMundialesUrls: [
      'https://www.loteriasmundiales.com.ar/Quinielas/buenos-aires',
      'https://www.loteriasmundiales.com.ar/Quinielas/provincia',
      'https://www.loteriasmundiales.com.ar/Quinielas/entre-rios'
    ],
    provMatchRe: /\b(buenos\s*aires|provincia|pba)\b/i,
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
    laNacionUrl: 'https://www.lanacion.com.ar/loterias/quiniela-santa-fe/',
    loteriasMundialesUrls: [
      'https://www.loteriasmundiales.com.ar/Quinielas/santa-fe',
      'https://www.loteriasmundiales.com.ar/Quinielas/entre-rios'
    ],
    provMatchRe: /\bsanta\s*fe\b/i,
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      primero: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  },
  cordoba: {
    laNacionUrl: 'https://www.lanacion.com.ar/loterias/quiniela-cordoba/',
    loteriasMundialesUrls: [
      'https://www.loteriasmundiales.com.ar/Quinielas/cordoba',
      'https://www.loteriasmundiales.com.ar/Quinielas/entre-rios'
    ],
    provMatchRe: /\bcordoba\b/i,
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      primero: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' },
      turista: { key: 'turista', nombre: 'Turista', hora: '22:15' }
    }
  },
  entrerios: {
    loteriasMundialesUrls: [
      'https://www.loteriasmundiales.com.ar/Quinielas/entre-rios'
    ],
    provMatchRe: /\bentre\s*rios\b/i,
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      primero: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' },
      turista: { key: 'turista', nombre: 'Turista', hora: '22:15' }
    }
  },
  mendoza: {
    loteriasMundialesUrls: [
      'https://www.loteriasmundiales.com.ar/Quinielas/mendoza'
    ],
    provMatchRe: /\bmendoza\b/i,
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  },
  corrientes: {
    loteriasMundialesUrls: [
      'https://www.loteriasmundiales.com.ar/Quinielas/correntina'
    ],
    provMatchRe: /\b(correntina|corrientes)\b/i,
    turnosMap: {
      previa: { key: 'previa', nombre: 'La Previa', hora: '10:15' },
      primera: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      primero: { key: 'primera', nombre: 'La Primera', hora: '12:00' },
      matutina: { key: 'matutina', nombre: 'Matutina', hora: '15:00' },
      vespertina: { key: 'vespertina', nombre: 'Vespertina', hora: '18:00' },
      nocturna: { key: 'nocturna', nombre: 'Nocturna', hora: '21:00' }
    }
  }
};

function normalizeQuinielaExtracto(results) {
  if (!Array.isArray(results) || results.length !== 20) return null;
  const out = [];
  for (const raw of results) {
    const digits = String(raw ?? '').replace(/\D/g, '');
    if (!digits) return null;
    const val4 = digits.slice(-4).padStart(4, '0');
    if (!/^\d{4}$/.test(val4)) return null;
    out.push(val4);
  }
  if (out.every(v => v === '0000')) return null;
  return out;
}

function mergeQuinielaTurnos(prov, parsedTurnos) {
  let updated = false;
  for (const item of parsedTurnos) {
    if (!isValidIsoDate(item.fecha)) continue;
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

function parseQuinielaFromLaNacionHtml(provKey, html) {
  const cfg = QUINIELAS_CONFIG[provKey];
  if (!cfg) throw new Error(`Configuración de quiniela inexistente para ${provKey}`);

  const json = extractLaNacionJson(html);
  const details = Array.isArray(json?.dataService?.lotteryDetail) ? json.dataService.lotteryDetail : [];
  if (details.length === 0) {
    throw new Error(`La Nación ${provKey}: lotteryDetail vacío`);
  }

  const fallbackYear = Number(getFechaAR().slice(0, 4));
  const parsedTurnos = [];

  for (const item of details) {
    const fecha = parseFecha(item?.date, fallbackYear);
    if (!fecha) continue;

    const turnoNorm = normalizeKey(item?.name || '');
    const turnoM = turnoNorm.match(/\b(previa|primera|primero|matutina|vespertina|nocturna|turista)\b/);
    if (!turnoM) continue;

    const spec = cfg.turnosMap[turnoM[1]];
    if (!spec) continue;

    const extracto = normalizeQuinielaExtracto(item?.results);
    if (!extracto) continue;

    let letras;
    if (cfg.hasLetras && Array.isArray(item?.letters) && item.letters[0]) {
      const cleanLetras = String(item.letters[0]).replace(/[^a-zA-Z]/g, '').toUpperCase();
      if (cleanLetras.length === 4) {
        letras = cleanLetras.split('').join('-');
      }
    }

    parsedTurnos.push({ fecha, spec, extracto, letras });
  }

  if (parsedTurnos.length === 0) {
    throw new Error(`La Nación ${provKey}: 0 extractos válidos encontrados`);
  }

  return parsedTurnos;
}

async function updateQuinielaFromLaNacion(provKey, url, data) {
  const prov = data.quinielas[provKey];
  if (!prov) return { updated: false, info: 'sin provincia en resultados.json' };
  const html = await fetchHtml(url);
  const parsedTurnos = parseQuinielaFromLaNacionHtml(provKey, html);
  return mergeQuinielaTurnos(prov, parsedTurnos);
}

function parseLoteriasMundialesTable($, $tbl) {
  const byPos = new Map();
  $tbl.find('tr').each((_, tr) => {
    const cells = $(tr).find('td, th').map((__, td) => cleanText($(td).text())).get();
    if (cells.length < 2) return;
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const posM = cells[i].match(/^(\d{1,2})[°º.]?$/);
      if (!posM) continue;
      const pos = Number(posM[1]);
      if (pos < 1 || pos > 20) continue;
      const numCell = cells[i + 1];
      const numM = numCell.match(/^(\d{1,5})$/) || numCell.match(/\b(\d{4,5})\b/);
      if (!numM) continue;
      const val4 = numM[1].slice(-4).padStart(4, '0');
      if (!/^\d{4}$/.test(val4)) continue;
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
  if (extracto.every(v => v === '0000')) return null;
  return extracto;
}

function getTableImmediateHeader($, $tbl) {
  const parts = [];
  const cap = cleanText($tbl.find('caption').text());
  if (cap) parts.push(cap);

  $tbl.find('tr').slice(0, 3).each((_, tr) => {
    const cells = $(tr).find('th, td').map((__, el) => cleanText($(el).text())).get();
    if (!cells.length) return;
    const isDataRow = cells.length >= 2 && /^\d{1,2}[°º.]?$/.test(cells[0]) && /^\d{1,5}$/.test(cells[1]);
    if (!isDataRow) {
      parts.push(cells.join(' '));
    }
  });

  let $node = $tbl;
  for (let depth = 0; depth < 4; depth++) {
    const $prevs = $node.prevAll();
    for (let i = 0; i < Math.min(6, $prevs.length); i++) {
      const $p = $prevs.eq(i);
      if ($p.is('table') || $p.find('table').length > 0) break;
      const t = cleanText($p.text());
      if (t) parts.unshift(t);
    }
    const $parent = $node.parent();
    if (!$parent.length || $parent.is('body, html')) break;
    if ($parent.find('table').length === 1) {
      const ownText = cleanText($parent.clone().find('table').remove().end().text());
      if (ownText && !parts.some(p => p.includes(ownText))) {
        parts.unshift(ownText);
      }
      $node = $parent;
    } else {
      // Si el padre agrupa varias tablas (ej. fila/grilla), revisar el heading inmediato previo al padre si existe y cortar
      const $parentPrev = $parent.prevAll('h1, h2, h3, h4, h5, .card-header, .panel-heading, strong, p, div').first();
      if ($parentPrev.length && $parentPrev.find('table').length === 0 && !$parentPrev.is('table')) {
        const pt = cleanText($parentPrev.text());
        if (pt && pt.length <= 120 && !parts.some(p => p.includes(pt))) {
          parts.unshift(pt);
        }
      }
      break;
    }
  }

  return cleanText(parts.join(' | '));
}

function resolveLoteriasMundialesTurno(provKey, headerText) {
  const cfg = QUINIELAS_CONFIG[provKey];
  if (!cfg) return null;
  const k = normalizeKey(headerText);

  if (provKey === 'mendoza') {
    if (/\b(?:la\s+)?previa\b/.test(k) || /\b10[:.,]15\b/.test(k)) return cfg.turnosMap.previa;
    if (/\bde\s+la\s+tarde\b/.test(k) || /\btarde\b/.test(k) || /\b17[:.,]30\b/.test(k) || /\b18[:.,]00\b/.test(k)) return cfg.turnosMap.vespertina;
    if (/\bvespertina\b/.test(k) || /\b14[:.,]00\b/.test(k) || /\b15[:.,]00\b/.test(k)) return cfg.turnosMap.matutina;
    if (/\bmatutina\b/.test(k) || /\b11[:.,]30\b/.test(k) || /\b12[:.,]00\b/.test(k) || /\bprimera\b/.test(k) || /\b1[aª°]?\.?\s+de\s+la\s+manana\b/.test(k)) return cfg.turnosMap.primera;
    if (/\bnocturna\b/.test(k) || /\b21[:.,]00\b/.test(k)) return cfg.turnosMap.nocturna;
    return null;
  }

  if (/\b(?:la\s+)?previa\b/.test(k) || /\b10[:.,]15\b/.test(k)) return cfg.turnosMap.previa || null;
  if (/\b1[aª°]?\.?\s+de\s+la\s+manana\b/.test(k) || /\b(primera|primero)\b/.test(k) || /\b11[:.,]30\b/.test(k) || /\b12[:.,]00\b/.test(k)) {
    return cfg.turnosMap.primera || cfg.turnosMap.primero || null;
  }
  if (/\bmatutina\b/.test(k) || /\b14[:.,]00\b/.test(k) || /\b15[:.,]00\b/.test(k)) return cfg.turnosMap.matutina || null;
  if (/\bvespertina\b/.test(k) || /\b17[:.,]30\b/.test(k) || /\b18[:.,]00\b/.test(k)) return cfg.turnosMap.vespertina || null;
  if (/\bnocturna\b/.test(k) || /\b21[:.,]00\b/.test(k)) return cfg.turnosMap.nocturna || null;
  if (/\bturista\b/.test(k) || /\b22[:.,]15\b/.test(k)) return cfg.turnosMap.turista || null;

  return null;
}

function getSectionFallbackTurnoText($, $tbl) {
  let $cur = $tbl;
  for (let depth = 0; depth < 4; depth++) {
    const $parent = $cur.parent();
    if (!$parent.length || $parent.is('body, html')) break;
    const $prevHeading = $cur.prevAll('h1, h2, h3, h4, h5, .card-header, .panel-heading, strong, p, div').first();
    if ($prevHeading.length && $prevHeading.find('table').length === 0) {
      const txt = cleanText($prevHeading.text());
      if (txt) return txt;
    }
    $cur = $parent;
  }
  return '';
}

function parseQuinielaFromLoteriasMundialesHtml(provKey, html) {
  const cfg = QUINIELAS_CONFIG[provKey];
  if (!cfg) throw new Error(`Configuración de quiniela inexistente para ${provKey}`);

  const $ = cheerio.load(html);
  const $bodyClone = $('body').clone();
  $bodyClone.find('script, style, noscript').remove();
  const bodyText = cleanText($bodyClone.text());

  const dateHeaderM = bodyText.match(/Resultados\s+del\s+d[íi]a\s+([^.|]{6,60})/i);
  const pageFecha = (dateHeaderM && parseFecha(dateHeaderM[1]))
    || parseFecha($('h1, h2').text())
    || parseFecha(bodyText);

  const parsedTurnos = [];

  $('table').each((_, tbl) => {
    const $tbl = $(tbl);
    if ($tbl.find('table').length > 0) return; // Ignorar tablas contenedoras

    const extracto = parseLoteriasMundialesTable($, $tbl);
    if (!extracto) return;

    const immediateHeader = getTableImmediateHeader($, $tbl);
    const normHeader = normalizeKey(immediateHeader);

    // Filtrar estrictamente que el encabezado inmediato pertenezca a la provincia buscada
    if (!cfg.provMatchRe.test(normHeader)) return;

    let spec = resolveLoteriasMundialesTurno(provKey, immediateHeader);
    if (!spec) {
      const fallbackCtx = getSectionFallbackTurnoText($, $tbl);
      if (fallbackCtx) {
        spec = resolveLoteriasMundialesTurno(provKey, fallbackCtx);
      }
    }
    if (!spec) return;

    const fecha = parseFecha(immediateHeader) || pageFecha;
    if (!fecha) return;

    let letras;
    if (cfg.hasLetras) {
      const afterText = cleanText($tbl.nextAll().slice(0, 2).text());
      const letrasM = (immediateHeader + ' ' + afterText).match(/Letras[:\s]*([A-Z]{4}|[A-Z](?:-[A-Z]){3})\b/i);
      if (letrasM) {
        letras = letrasM[1].toUpperCase().includes('-')
          ? letrasM[1].toUpperCase()
          : letrasM[1].toUpperCase().split('').join('-');
      }
    }

    parsedTurnos.push({ fecha, spec, extracto, letras });
  });

  if (parsedTurnos.length === 0) {
    throw new Error(`Loterías Mundiales ${provKey}: 0 extractos válidos encontrados`);
  }

  return parsedTurnos;
}

async function updateQuinielaFromLoteriasMundiales(provKey, url, data) {
  const prov = data.quinielas[provKey];
  if (!prov) return { updated: false, info: 'sin provincia en resultados.json' };
  const html = await fetchHtml(url);
  const parsedTurnos = parseQuinielaFromLoteriasMundialesHtml(provKey, html);
  return mergeQuinielaTurnos(prov, parsedTurnos);
}

// --- Selección de mejor fuente (más reciente + más completa) por poceado ---

async function runBestSource(gameKey, data, parsers) {
  const gameCfg = data.poceados[gameKey];
  const results = [];
  const errors = [];

  for (const [label, fn] of parsers) {
    try {
      const res = await fn();
      const err = validateDrawForGame(gameKey, gameCfg, res?.draw);
      if (err) {
        errors.push(`${label}: ${err}`);
        continue;
      }
      results.push({ label, res });
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  }

  if (results.length === 0) {
    console.warn(`[AVISO] ${gameKey} falló en todas las fuentes -> ${errors.join(' | ')}`);
    return false;
  }

  results.sort((a, b) => {
    const fechaCmp = String(b.res.draw.fecha || '').localeCompare(String(a.res.draw.fecha || ''));
    if (fechaCmp !== 0) return fechaCmp;
    const sorteoCmp = Number(b.res.draw.sorteo || 0) - Number(a.res.draw.sorteo || 0);
    if (sorteoCmp !== 0) return sorteoCmp;
    return drawCompletenessScore(b.res.draw) - drawCompletenessScore(a.res.draw);
  });

  const best = results[0];
  const bestPozo = best.res.pozoProximo || results.find(r => r.res.pozoProximo)?.res.pozoProximo || null;
  const changed = archiveIfNewDraw(gameKey, gameCfg, best.res.draw, bestPozo);
  const summary = results.map(r => `${r.label}:${r.res.draw.fecha}#${r.res.draw.sorteo}`).join(', ');
  console.log(`[${changed ? 'ACTUALIZADO' : 'SIN CAMBIOS'}] ${gameKey} | elegida=${best.label} | fecha=${best.res.draw.fecha} | sorteo=${best.res.draw.sorteo} | mods=${best.res.draw.modalidades.length} | candidatas=[${summary}]${errors.length ? ` | fallos=[${errors.join(' | ')}]` : ''}`);
  return changed;
}

async function runQuinielaWithFallbacks(provKey, data) {
  const cfg = QUINIELAS_CONFIG[provKey];
  const attempts = [];

  if (cfg.laNacionUrl) {
    attempts.push(['lanacion', () => updateQuinielaFromLaNacion(provKey, cfg.laNacionUrl, data)]);
  }
  for (const lmUrl of cfg.loteriasMundialesUrls || []) {
    attempts.push([`loteriasmundiales(${lmUrl.split('/').pop()})`, () => updateQuinielaFromLoteriasMundiales(provKey, lmUrl, data)]);
  }

  const errors = [];
  for (const [label, fn] of attempts) {
    try {
      const res = await fn();
      console.log(`[${res.updated ? 'ACTUALIZADO' : 'SIN CAMBIOS'}] quiniela:${provKey} | fuente=${label} | ${res.info}`);
      return res.updated;
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  }
  console.warn(`[AVISO] quiniela:${provKey} falló en todas las fuentes -> ${errors.join(' | ')}`);
  return false;
}

async function main() {
  const raw = await fs.readFile(RESULTADOS_PATH, 'utf-8');
  const data = JSON.parse(raw);
  const beforeSnapshot = JSON.stringify({ poceados: data.poceados, quinielas: data.quinielas });

  const poceadoTasks = [
    ['quini6', [
      ['clarin', () => parseClarinPoceado('quini6', CLARIN_POCEADOS.quini6.url, data.poceados.quini6)],
      ['lanacion', () => parseLaNacionPoceado('quini6', LA_NACION_POCEADOS.quini6.url, data.poceados.quini6?.ultimo)]
    ]],
    ['lotoPlus', [
      ['clarin', () => parseClarinPoceado('lotoPlus', CLARIN_POCEADOS.lotoPlus.url, data.poceados.lotoPlus)],
      ['lanacion', () => parseLaNacionPoceado('lotoPlus', LA_NACION_POCEADOS.lotoPlus.url, data.poceados.lotoPlus?.ultimo)]
    ]],
    ['telekino', [
      ['clarin', () => parseClarinPoceado('telekino', CLARIN_POCEADOS.telekino.url, data.poceados.telekino)],
      ['lanacion', () => parseLaNacionPoceado('telekino', LA_NACION_POCEADOS.telekino.url, data.poceados.telekino?.ultimo)]
    ]],
    ['brinco', [
      ['clarin', () => parseClarinPoceado('brinco', CLARIN_POCEADOS.brinco.url, data.poceados.brinco)],
      ['lanacion', () => parseLaNacionPoceado('brinco', LA_NACION_POCEADOS.brinco.url, data.poceados.brinco?.ultimo)]
    ]],
    ['loto5', [
      ['clarin', () => parseClarinPoceado('loto5', CLARIN_POCEADOS.loto5.url, data.poceados.loto5)],
      ['lanacion', () => parseLaNacionPoceado('loto5', LA_NACION_POCEADOS.loto5.url, data.poceados.loto5?.ultimo)]
    ]],
    ['laPoceada', [
      ['clarin', () => parseClarinPoceado('laPoceada', CLARIN_POCEADOS.laPoceada.url, data.poceados.laPoceada)],
      ['lanacion', () => parseLaNacionPoceado('laPoceada', LA_NACION_POCEADOS.laPoceada.url, data.poceados.laPoceada?.ultimo)],
      ['notitimba', parsePoceadaNotitimba]
    ]],
    ['quinielaPlus', [
      ['clarin', () => parseClarinPoceado('quinielaPlus', CLARIN_POCEADOS.quinielaPlus.url, data.poceados.quinielaPlus)],
      ['lanacion', () => parseLaNacionPoceado('quinielaPlus', LA_NACION_POCEADOS.quinielaPlus.url, data.poceados.quinielaPlus?.ultimo)]
    ]]
  ];

  for (const [gameKey, parsers] of poceadoTasks) {
    await runBestSource(gameKey, data, parsers);
  }

  for (const provKey of Object.keys(QUINIELAS_CONFIG)) {
    await runQuinielaWithFallbacks(provKey, data);
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

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((err) => {
    console.error('Error fatal en actualizador:', err);
    process.exit(1);
  });
}

export {
  extractLaNacionJson,
  parseLaNacionPoceadoFromHtml,
  parseClarinPoceadoFromHtml,
  parseQuinielaFromLaNacionHtml,
  parseQuinielaFromLoteriasMundialesHtml,
  mergeQuinielaTurnos,
  archiveIfNewDraw,
  runBestSource
};

