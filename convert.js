'use strict';

/* =========================================================================
   ZeroPDF - Conversión de documentos
   Motor propio: DOCX (.docx) -> HTML para imprimir a PDF y modelo de PDF ->
   DOCX. No necesita Word ni LibreOffice; si están instalados, main.js los usa
   antes que este motor porque conservan mejor el formato.
   ========================================================================= */

const path = require('path');
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');

/* --------------------------------- ZIP ----------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

// Lector de ZIP mínimo (store y deflate), suficiente para un .docx.
function readZip(buffer) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('El archivo no es un DOCX válido (ZIP incompleto).');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (!name || name.endsWith('/')) continue;
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else continue;
    entries.set(name.replace(/\\/g, '/'), data);
  }
  return entries;
}

// Escritor de ZIP (deflate) para generar el .docx.
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach(({ name, data }) => {
    const nameBuffer = Buffer.from(name, 'utf8');
    const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const compressed = zlib.deflateRawSync(content, { level: 9 });
    const crc = crc32(content);

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  });

  const centralSize = centrals.reduce((total, item) => total + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

/* -------------------------------- XML ------------------------------------ */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => ['p', 'r', 'tbl', 'tr', 'tc', 'sectPr', 'br', 'drawing', 'inline', 'anchor', 'lvl', 'num'].includes(name)
});

function parseXml(buffer) {
  if (!buffer) return null;
  try {
    return parser.parse(buffer.toString('utf8'));
  } catch (error) {
    return null;
  }
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function tag(node, name) {
  if (!node || typeof node !== 'object') return null;
  return node[name] === undefined ? null : node[name];
}

function attr(node, name, fallback = null) {
  if (!node || typeof node !== 'object') return fallback;
  const value = node[`@${name}`];
  return value === undefined || value === null ? fallback : String(value);
}

function nodeText(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object') {
    if (node['#text'] !== undefined) return String(node['#text']);
  }
  return '';
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------- DOCX -> HTML (para PDF) ------------------------ */

const TWIP_TO_PT = 1 / 20;
const EMU_TO_PX = 1 / 9525;

function readRelationships(entries) {
  const map = new Map();
  const file = entries.get('word/_rels/document.xml.rels');
  if (!file) return map;
  const parsed = parseXml(file);
  const root = parsed && parsed.Relationships;
  asArray(root && root.Relationship).forEach((rel) => {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) map.set(id, target.replace(/^\.\//, ''));
  });
  return map;
}

function readStyles(entries) {
  const file = entries.get('word/styles.xml');
  const parsed = parseXml(file);
  const styles = new Map();
  const defaults = { font: 'Calibri', size: 11 };
  if (!parsed || !parsed.styles) return { styles, defaults };

  const docDefaults = parsed.styles.docDefaults;
  const rPrDefault = docDefaults && docDefaults.rPrDefault && docDefaults.rPrDefault.rPr;
  if (rPrDefault) {
    const fonts = tag(rPrDefault, 'rFonts');
    if (fonts && attr(fonts, 'ascii')) defaults.font = attr(fonts, 'ascii');
    const size = tag(rPrDefault, 'sz');
    if (size && attr(size, 'val')) defaults.size = Number(attr(size, 'val')) / 2;
  }

  asArray(parsed.styles.style).forEach((style) => {
    const id = attr(style, 'styleId');
    if (!id) return;
    styles.set(id, {
      name: attr(tag(style, 'name'), 'val', id),
      basedOn: attr(tag(style, 'basedOn'), 'val', null),
      pPr: tag(style, 'pPr'),
      rPr: tag(style, 'rPr')
    });
  });
  return { styles, defaults };
}

function resolveStyle(styles, id, seen = new Set()) {
  if (!id || seen.has(id)) return { pPr: null, rPr: null };
  seen.add(id);
  const style = styles.get(id);
  if (!style) return { pPr: null, rPr: null };
  const parent = resolveStyle(styles, style.basedOn, seen);
  return {
    pPr: { ...(parent.pPr || {}), ...(style.pPr || {}) },
    rPr: { ...(parent.rPr || {}), ...(style.rPr || {}) }
  };
}

function readNumbering(entries) {
  const file = entries.get('word/numbering.xml');
  const parsed = parseXml(file);
  const nums = new Map();
  const abstracts = new Map();
  if (!parsed || !parsed.numbering) return { nums, abstracts };
  asArray(parsed.numbering.abstractNum).forEach((abstract) => {
    const id = attr(abstract, 'abstractNumId');
    if (!id) return;
    const levels = new Map();
    asArray(tag(abstract, 'lvl')).forEach((lvl) => {
      levels.set(attr(lvl, 'ilvl', '0'), {
        format: attr(tag(lvl, 'numFmt'), 'val', 'bullet'),
        text: attr(tag(lvl, 'lvlText'), 'val', ''),
        start: Number(attr(tag(lvl, 'start'), 'val', '1')) || 1
      });
    });
    abstracts.set(id, levels);
  });
  asArray(parsed.numbering.num).forEach((num) => {
    const id = attr(num, 'numId');
    const abstractId = attr(tag(num, 'abstractNumId'), 'val');
    if (id && abstractId) nums.set(id, abstractId);
  });
  return { nums, abstracts };
}

function colorFromHex(value) {
  if (!value || value === 'auto') return null;
  return `#${value}`;
}

function runStyle(rPr, defaults, rels) {
  const style = {};
  if (!rPr) return style;
  if (tag(rPr, 'b') && attr(tag(rPr, 'b'), 'val', 'true') !== '0' && attr(tag(rPr, 'b'), 'val', 'true') !== 'false') {
    style.bold = true;
  }
  if (tag(rPr, 'i') && attr(tag(rPr, 'i'), 'val', 'true') !== '0' && attr(tag(rPr, 'i'), 'val', 'true') !== 'false') {
    style.italic = true;
  }
  const underline = tag(rPr, 'u');
  if (underline && attr(underline, 'val', 'single') !== 'none') style.underline = true;
  const strike = tag(rPr, 'strike');
  if (strike && attr(strike, 'val', 'true') !== '0') style.strike = true;
  const color = colorFromHex(attr(tag(rPr, 'color'), 'val'));
  if (color) style.color = color;
  const size = tag(rPr, 'sz');
  if (size && attr(size, 'val')) style.size = Number(attr(size, 'val')) / 2;
  const fonts = tag(rPr, 'rFonts');
  if (fonts) {
    const name = attr(fonts, 'ascii') || attr(fonts, 'hAnsi');
    if (name) style.font = name;
  }
  const highlight = tag(rPr, 'highlight');
  if (highlight && attr(highlight, 'val') && attr(highlight, 'val') !== 'none') {
    style.background = attr(highlight, 'val');
  }
  const vertAlign = tag(rPr, 'vertAlign');
  if (vertAlign && attr(vertAlign, 'val')) style.vertAlign = attr(vertAlign, 'val');
  return style;
}

function styleToCss(style, defaults) {
  const parts = [];
  if (style.bold) parts.push('font-weight:bold');
  if (style.italic) parts.push('font-style:italic');
  if (style.underline) parts.push('text-decoration:underline');
  if (style.strike) parts.push('text-decoration:line-through');
  if (style.color) parts.push(`color:${style.color}`);
  if (style.size) parts.push(`font-size:${style.size}pt`);
  if (style.font) parts.push(`font-family:'${style.font.replace(/'/g, '')}', '${defaults.font}', sans-serif`);
  if (style.background && /^[0-9a-f]{6}$/i.test(style.background)) {
    parts.push(`background:#${style.background}`);
  }
  if (style.vertAlign === 'superscript') parts.push('vertical-align:super;font-size:70%');
  if (style.vertAlign === 'subscript') parts.push('vertical-align:sub;font-size:70%');
  return parts.join(';');
}

function paragraphCss(pPr, styles, defaults) {
  const style = [];
  if (!pPr) return style.join(';');
  const jc = attr(tag(pPr, 'jc'), 'val');
  if (jc === 'center') style.push('text-align:center');
  else if (jc === 'right' || jc === 'end') style.push('text-align:right');
  else if (jc === 'both' || jc === 'distribute') style.push('text-align:justify');
  const spacing = tag(pPr, 'spacing');
  if (spacing) {
    const before = attr(spacing, 'before');
    const after = attr(spacing, 'after');
    if (before !== null) style.push(`margin-top:${Number(before) * TWIP_TO_PT}pt`);
    if (after !== null) style.push(`margin-bottom:${Number(after) * TWIP_TO_PT}pt`);
    const line = attr(spacing, 'line');
    if (line !== null) {
      const rule = attr(spacing, 'lineRule', 'auto');
      if (rule === 'auto') style.push(`line-height:${(Number(line) / 240).toFixed(2)}`);
      else style.push(`line-height:${Number(line) * TWIP_TO_PT}pt`);
    }
  }
  const ind = tag(pPr, 'ind');
  if (ind) {
    const left = attr(ind, 'left') || attr(ind, 'start');
    const right = attr(ind, 'right') || attr(ind, 'end');
    const first = attr(ind, 'firstLine');
    const hanging = attr(ind, 'hanging');
    if (left !== null) style.push(`margin-left:${Number(left) * TWIP_TO_PT}pt`);
    if (right !== null) style.push(`margin-right:${Number(right) * TWIP_TO_PT}pt`);
    if (first !== null) style.push(`text-indent:${Number(first) * TWIP_TO_PT}pt`);
    if (hanging !== null) style.push(`text-indent:-${Number(hanging) * TWIP_TO_PT}pt`);
  }
  const shading = tag(pPr, 'shd');
  const fill = attr(shading, 'fill');
  if (fill && /^[0-9a-f]{6}$/i.test(fill) && fill.toLowerCase() !== 'ffffff') {
    style.push(`background:#${fill}`);
  }
  return style.join(';');
}

function renderRun(run, styles, defaults, rels, images) {
  const rPr = tag(run, 'rPr');
  const style = runStyle(rPr, defaults, rels);
  let html = '';
  asArray(tag(run, 't')).forEach((node) => {
    const text = nodeText(node);
    if (text) html += `<span style="${styleToCss(style, defaults)}">${escapeHtml(text)}</span>`;
  });
  asArray(tag(run, 'tab')).forEach(() => {
    html += '<span style="display:inline-block;width:2em"></span>';
  });
  asArray(tag(run, 'br')).forEach((br) => {
    html += attr(br, 'type') === 'page' ? '<div style="break-after:page"></div>' : '<br>';
  });
  asArray(tag(run, 'drawing')).forEach((drawing) => {
    html += renderDrawing(drawing, rels, images);
  });
  const noBreak = tag(run, 'noBreakHyphen');
  if (noBreak) html += '-';
  return html;
}

function renderDrawing(drawing, rels, images) {
  const holder = asArray(tag(drawing, 'inline')).concat(asArray(tag(drawing, 'anchor')))[0];
  if (!holder) return '';
  const extent = tag(holder, 'extent');
  const cx = Number(attr(extent, 'cx', '0')) || 0;
  const cy = Number(attr(extent, 'cy', '0')) || 0;
  const blip = findDeep(holder, 'blip');
  const embed = blip ? attr(blip, 'embed') : null;
  if (!embed || !rels.has(embed)) return '';
  const target = rels.get(embed);
  const data = images.get(`word/${target}`) || images.get(target);
  if (!data) return '';
  const extension = path.extname(target).replace('.', '').toLowerCase();
  const mime = extension === 'jpg' ? 'jpeg' : extension || 'png';
  const width = cx ? (cx * EMU_TO_PX).toFixed(1) : 'auto';
  const height = cy ? (cy * EMU_TO_PX).toFixed(1) : 'auto';
  return `<img src="data:image/${mime};base64,${data.toString('base64')}" style="width:${width}px;height:${height}px">`;
}

function findDeep(node, name, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDeep(item, name, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (node[name] !== undefined) {
    const value = node[name];
    return Array.isArray(value) ? value[0] : value;
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith('@')) continue;
    const found = findDeep(node[key], name, depth + 1);
    if (found) return found;
  }
  return null;
}

function renderTable(tbl, styles, defaults, rels, images, counters, numbering) {
  const rows = asArray(tag(tbl, 'tr'));
  let html = '<table style="border-collapse:collapse;width:100%;margin:6pt 0">';
  rows.forEach((row) => {
    html += '<tr>';
    asArray(tag(row, 'tc')).forEach((cell) => {
      const tcPr = tag(cell, 'tcPr');
      const gridSpan = Number(attr(tag(tcPr, 'gridSpan'), 'val', '1')) || 1;
      const cellStyle = [];
      const width = tag(tcPr, 'tcW');
      if (width && attr(width, 'type') === 'pct') {
        cellStyle.push(`width:${(Number(attr(width, 'w')) / 50).toFixed(1)}%`);
      }
      const shading = tag(tcPr, 'shd');
      const fill = attr(shading, 'fill');
      if (fill && /^[0-9a-f]{6}$/i.test(fill) && fill !== 'auto') {
        cellStyle.push(`background:#${fill}`);
      }
      const borders = tag(tcPr, 'tcBorders') || tag(tbl, 'tblPr') && tag(tag(tbl, 'tblPr'), 'tblBorders');
      const border = borderCss(borders);
      if (border) cellStyle.push(border);
      const vAlign = attr(tag(tcPr, 'vAlign'), 'val');
      if (vAlign === 'center') cellStyle.push('vertical-align:middle');
      else if (vAlign === 'bottom') cellStyle.push('vertical-align:bottom');
      html += `<td colspan="${gridSpan}" style="${cellStyle.join(';')}">`;
      asArray(tag(cell, 'p')).forEach((paragraph) => {
        html += renderParagraph(paragraph, styles, defaults, rels, images, counters, numbering);
      });
      if (!asArray(tag(cell, 'p')).length) html += '<p></p>';
      html += '</td>';
    });
    html += '</tr>';
  });
  return `${html}</table>`;
}

function borderCss(borders) {
  if (!borders) return '';
  const pick = (name) => {
    const border = tag(borders, name);
    if (!border) return null;
    const val = attr(border, 'val', 'single');
    if (val === 'nil' || val === 'none') return null;
    const size = Number(attr(border, 'sz', '4')) || 4;
    const color = attr(border, 'color', '000000');
    return `${Math.max(0.5, size / 8).toFixed(2)}pt solid #${color === 'auto' ? '000000' : color}`;
  };
  const top = pick('top');
  const left = pick('left');
  const bottom = pick('bottom');
  const right = pick('right');
  const parts = [];
  if (top) parts.push(`border-top:${top}`);
  if (left) parts.push(`border-left:${left}`);
  if (bottom) parts.push(`border-bottom:${bottom}`);
  if (right) parts.push(`border-right:${right}`);
  if (!parts.length) parts.push('border:0.75pt solid #bfbfbf');
  return parts.join(';');
}

function listPrefix(pPr, numbering, counters) {
  const numPr = tag(pPr, 'numPr');
  if (!numPr) return null;
  const numId = attr(tag(numPr, 'numId'), 'val');
  const ilvl = attr(tag(numPr, 'ilvl'), 'val', '0');
  if (!numId || numId === '0') return null;
  const abstractId = numbering.nums.get(numId);
  const levels = abstractId ? numbering.abstracts.get(abstractId) : null;
  const level = levels ? levels.get(ilvl) : null;
  const format = level ? level.format : 'bullet';
  const indent = 18 + Number(ilvl) * 18;

  if (format === 'bullet' || format === 'none') {
    return { text: '•', indent };
  }
  const key = `${numId}:${ilvl}`;
  const value = (counters.get(key) || (level ? level.start - 1 : 0)) + 1;
  counters.set(key, value);
  let label = String(value);
  if (format === 'lowerLetter') label = String.fromCharCode(96 + value);
  else if (format === 'upperLetter') label = String.fromCharCode(64 + value);
  else if (format === 'lowerRoman') label = roman(value).toLowerCase();
  else if (format === 'upperRoman') label = roman(value);
  const text = level && level.text ? level.text.replace(/%\d/g, label) : `${label}.`;
  return { text, indent };
}

function roman(value) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let rest = value;
  let out = '';
  map.forEach(([amount, glyph]) => {
    while (rest >= amount) {
      out += glyph;
      rest -= amount;
    }
  });
  return out;
}

function renderParagraph(paragraph, styles, defaults, rels, images, counters, numbering) {
  const pPr = tag(paragraph, 'pPr') || {};
  const styleId = attr(tag(pPr, 'pStyle'), 'val');
  const style = resolveStyle(styles, styleId);
  const mergedPPr = { ...(style.pPr || {}), ...pPr };
  // Un párrafo normal cierra la lista anterior: la numeración vuelve a empezar.
  if (!tag(mergedPPr, 'numPr')) counters.clear();
  const css = paragraphCss(mergedPPr, styles, defaults);
  const heading = styleId && /^Heading(\d)$/i.test(styleId) ? Number(RegExp.$1) : 0;

  let inner = '';
  const list = listPrefix(mergedPPr, numbering, counters);
  if (list) inner += `<span style="display:inline-block;width:${list.indent}pt">${escapeHtml(list.text)}</span>`;

  asArray(tag(paragraph, 'r')).forEach((run) => {
    inner += renderRun(run, styles, defaults, rels, images);
  });
  if (!inner) inner = '&nbsp;';

  if (heading) {
    const size = Math.max(12, 20 - heading * 2);
    return `<p style="${css};font-weight:bold;font-size:${size}pt;margin-top:12pt;margin-bottom:6pt">${inner}</p>`;
  }
  return `<p style="${css}">${inner}</p>`;
}

function docxToHtml(buffer) {
  const entries = readZip(buffer);
  const documentXml = parseXml(entries.get('word/document.xml'));
  if (!documentXml || !documentXml.document || !documentXml.document.body) {
    throw new Error('El DOCX no contiene un documento válido.');
  }
  const body = documentXml.document.body;
  const { styles, defaults } = readStyles(entries);
  const numbering = readNumbering(entries);
  const rels = readRelationships(entries);
  const images = new Map();
  entries.forEach((data, name) => {
    if (name.startsWith('word/media/')) images.set(name, data);
  });

  // Sección: tamaño de página y márgenes (en twips).
  const sectPr = asArray(tag(body, 'sectPr'))[0] || findDeep(documentXml.document, 'sectPr');
  const pageSize = tag(sectPr, 'pgSz');
  const pageMargins = tag(sectPr, 'pgMar');
  const widthTwips = Number(attr(pageSize, 'w', '11906')) || 11906;
  const heightTwips = Number(attr(pageSize, 'h', '16838')) || 16838;
  const margins = {
    top: Number(attr(pageMargins, 'top', '1417')) || 1417,
    right: Number(attr(pageMargins, 'right', '1417')) || 1417,
    bottom: Number(attr(pageMargins, 'bottom', '1417')) || 1417,
    left: Number(attr(pageMargins, 'left', '1417')) || 1417
  };

  const counters = new Map();
  let content = '';
  const children = body.p || body.tbl ? Object.entries(body) : [];
  children.forEach(([name, value]) => {
    if (name.startsWith('@') || name === 'sectPr') return;
    asArray(value).forEach((node) => {
      if (name === 'p') content += renderParagraph(node, styles, defaults, rels, images, counters, numbering);
      else if (name === 'tbl') content += renderTable(node, styles, defaults, rels, images, counters, numbering);
    });
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page {
      size: ${(widthTwips * TWIP_TO_PT).toFixed(2)}pt ${(heightTwips * TWIP_TO_PT).toFixed(2)}pt;
      margin: ${(margins.top * TWIP_TO_PT).toFixed(2)}pt ${(margins.right * TWIP_TO_PT).toFixed(2)}pt ${(margins.bottom * TWIP_TO_PT).toFixed(2)}pt ${(margins.left * TWIP_TO_PT).toFixed(2)}pt;
    }
    html, body { margin: 0; padding: 0 }
    body {
      font-family: '${defaults.font.replace(/'/g, '')}', Calibri, Arial, sans-serif;
      font-size: ${defaults.size}pt;
      color: #111;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    p { margin: 0; }
    table { page-break-inside: auto }
    tr { page-break-inside: avoid }
    img { max-width: 100% }
    td { padding: 2pt 4pt; vertical-align: top }
  </style></head><body>${content}</body></html>`;

  return {
    html,
    page: {
      widthTwips,
      heightTwips,
      margins,
      widthPt: widthTwips * TWIP_TO_PT,
      heightPt: heightTwips * TWIP_TO_PT,
      marginPt: {
        top: margins.top * TWIP_TO_PT,
        right: margins.right * TWIP_TO_PT,
        bottom: margins.bottom * TWIP_TO_PT,
        left: margins.left * TWIP_TO_PT
      }
    }
  };
}

/* ------------------------- Modelo PDF -> DOCX ---------------------------- */

const FAMILY_TO_WORD = {
  helvetica: 'Arial',
  times: 'Times New Roman',
  courier: 'Courier New'
};

function paragraphXml(block) {
  const runs = (block.runs || []).filter((run) => run.text);
  if (!runs.length) return '';
  const pPr = [];
  if (block.align === 'center') pPr.push('<w:jc w:val="center"/>');
  else if (block.align === 'right') pPr.push('<w:jc w:val="right"/>');
  else if (block.align === 'justify') pPr.push('<w:jc w:val="both"/>');
  const before = Math.round((block.spaceBefore || 0) * 20);
  const after = Math.round((block.spaceAfter || 0) * 20);
  if (before || after) pPr.push(`<w:spacing w:before="${before}" w:after="${after}"/>`);
  if (block.lineHeight) {
    pPr.push(`<w:spacing w:line="${Math.round(block.lineHeight * 240)}" w:lineRule="auto"/>`);
  }
  if (block.indent) pPr.push(`<w:ind w:left="${Math.round(block.indent * 20)}"/>`);
  if (block.background && /^#[0-9a-f]{6}$/i.test(block.background)) {
    const fill = block.background.slice(1).toUpperCase();
    if (fill !== 'FFFFFF') {
      pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`);
    }
  }

  const body = runs.map((run) => {
    const rPr = [];
    if (run.bold) rPr.push('<w:b/>');
    if (run.italic) rPr.push('<w:i/>');
    if (run.color && /^#[0-9a-f]{6}$/i.test(run.color)) {
      rPr.push(`<w:color w:val="${run.color.slice(1).toUpperCase()}"/>`);
    }
    if (run.size) rPr.push(`<w:sz w:val="${Math.round(run.size * 2)}"/>`);
    if (run.family) {
      const name = escapeXml(FAMILY_TO_WORD[run.family] || run.family);
      rPr.push(`<w:rFonts w:ascii="${name}" w:hAnsi="${name}"/>`);
    }
    const text = escapeXml(run.text);
    return `<w:r>${rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  }).join('');

  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${body}</w:p>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;

function buildDocx(model) {
  const pages = Array.isArray(model.pages) ? model.pages : [];
  const blocks = [];
  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) blocks.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    (page.blocks || []).forEach((block) => blocks.push(paragraphXml(block)));
  });
  if (!blocks.length) blocks.push('<w:p/>');

  const widthTwips = Math.round((pages[0] && pages[0].width ? pages[0].width : 595) * 20);
  const heightTwips = Math.round((pages[0] && pages[0].height ? pages[0].height : 842) * 20);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.join('')}
<w:sectPr><w:pgSz w:w="${widthTwips}" w:h="${heightTwips}"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;

  const title = escapeXml(model.title || 'Documento');
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${title}</dc:title><dc:creator>ZeroPDF</dc:creator><cp:lastModifiedBy>ZeroPDF</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>`;

  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ZeroPDF</Application></Properties>`;

  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'docProps/core.xml', data: coreXml },
    { name: 'docProps/app.xml', data: appXml },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
    { name: 'word/styles.xml', data: STYLES_XML }
  ]);
}

/* ------------------------- Imagen -> PDF (con OCR) ----------------------- */

function pdfSafeText(text) {
  const replacements = {
    '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
    '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00A0': ' '
  };
  return String(text)
    .replace(/\r/g, '')
    .replace(/[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0]/g, (char) => replacements[char] || char)
    .replace(/[^\x09\x0A\x20-\xFF]/g, '?');
}

// Coloca la imagen en una página A4 y añade el texto del OCR como capa
// invisible (modo de renderizado 3): se puede seleccionar y buscar, pero no
// se ve sobre la imagen.
async function buildImagePdf(payload) {
  const { PDFDocument, StandardFonts, PDFOperator, PDFOperatorNames, PDFNumber, rgb } = require('pdf-lib');
  const width = Math.max(1, Number(payload.width) || 1);
  const height = Math.max(1, Number(payload.height) || 1);
  const landscape = width > height;
  const pageWidth = landscape ? 841.89 : 595.28;
  const pageHeight = landscape ? 595.28 : 841.89;
  const scale = Math.min(pageWidth / width, pageHeight / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  const offsetX = (pageWidth - drawWidth) / 2;
  const offsetY = (pageHeight - drawHeight) / 2;

  const document = await PDFDocument.create();
  const image = await document.embedPng(Buffer.from(payload.png));
  const page = document.addPage([pageWidth, pageHeight]);
  page.drawImage(image, { x: offsetX, y: offsetY, width: drawWidth, height: drawHeight });

  const font = await document.embedFont(StandardFonts.Helvetica);
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length) {
    page.pushOperators(PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [PDFNumber.of(3)]));
    lines.forEach((line) => {
      const text = pdfSafeText(line.text).trim();
      if (!text) return;
      const boxWidth = Math.max(1, Number(line.w) || 1) * scale;
      const boxHeight = Math.max(1, Number(line.h) || 1) * scale;
      const x = offsetX + (Number(line.x) || 0) * scale;
      const baseline = offsetY + drawHeight - ((Number(line.y) || 0) + (Number(line.h) || 0)) * scale
        + boxHeight * 0.18;
      let size = Math.max(3, boxHeight * 0.82);
      const naturalWidth = font.widthOfTextAtSize(text, size);
      if (naturalWidth > boxWidth) size = Math.max(2, size * (boxWidth / naturalWidth));
      try {
        page.drawText(text, { x, y: baseline, size, font, color: rgb(0, 0, 0) });
      } catch (error) {
        /* carácter no representable en la fuente estándar */
      }
    });
    page.pushOperators(PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [PDFNumber.of(0)]));
  }

  document.setTitle(String(payload.title || 'Imagen'));
  document.setProducer('ZeroPDF (zeronet75)');
  document.setCreator('ZeroPDF');
  return await document.save();
}

module.exports = {
  docxToHtml,
  buildDocx,
  buildImagePdf,
  readZip,
  writeZip
};
