'use strict';

/* =========================================================================
   ZeroPDF — visor y editor de PDF de escritorio
   Desarrollado por zeronet75 · Licencia MIT
   Renderizado: pdf.js (Apache 2.0) · Edición: pdf-lib (MIT)
   ========================================================================= */

const api = window.zeropdf;
const {
  PDFDocument, StandardFonts, rgb, degrees,
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  PDFName, PDFArray, PDFRef, PDFNumber, PDFRawStream, decodePDFRawStream,
  PDFOperator, PDFOperatorNames, PDFObjectCopier, PDFString,
  PDFHexString, PDFNull
} = PDFLib;

// pdf-lib.min.js minifica los nombres de las clases, así que constructor.name
// no sirve para distinguir los campos. Usamos instanceof.
function formFieldType(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'optionlist';
  const name = field && field.constructor && field.constructor.name;
  if (name === 'PDFTextField') return 'text';
  if (name === 'PDFCheckBox') return 'checkbox';
  if (name === 'PDFRadioGroup') return 'radio';
  if (name === 'PDFDropdown') return 'dropdown';
  if (name === 'PDFOptionList') return 'optionlist';
  return 'unknown';
}

/* ------------------------------ Estado ---------------------------------- */

const state = {
  docs: new Map(), // docId -> { doc, bytes, name }
  pages: [], // { id, docId, index, pageRef, width, height, rotation, anns[] }
  fileName: '',
  filePath: '',
  dirty: false,
  current: 0,
  scale: 1,
  fit: 'width',
  tool: 'select',
  style: {
    color: '#e11900',
    lineWidth: 2,
    fontSize: 14,
    opacity: 0.35
  },
  selectedAnn: null, // { pageIndex, id }
  undoStack: [],
  redoStack: [],
  search: { query: '', matches: [], index: -1 },
  formFields: [],
  formValues: {},
  formBlocked: '',
  metadata: { title: '', author: '', subject: '', keywords: '' },
  watermark: { text: '', on: false },
  pageNumbers: { on: false, position: 'bottom-center', format: 'Página {n} de {total}' },
  headerFooter: { header: '', footer: '' },
  generatedBookmarks: [],
  theme: 'dark',
  image: null, // { dataURL, width, height }
  docInfo: null
};

let pageEntries = [];
let observer = null;
let toastTimer = null;
let scrollRaf = null;
let resizeTimer = null;

/* ------------------------------ Utilidades ------------------------------ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uid() {
  return 'a' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function pdfSafeText(text) {
  const replacements = {
    '\u2018': "'",
    '\u2019': "'",
    '\u201C': '"',
    '\u201D': '"',
    '\u2013': '-',
    '\u2014': '-',
    '\u2026': '...',
    '\u00A0': ' '
  };
  return String(text)
    .replace(/\r/g, '')
    .replace(/[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0]/g, (char) => replacements[char] || char)
    .replace(/[^\x09\x0A\x20-\xFF]/g, '?');
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toast(message, ms = 3200) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

function getViewport(page, scale = state.scale) {
  const rotation = totalRotation(page);
  if (!page.pageRef) {
    // Página en blanco: no hay pageRef de pdf.js, así que construimos el
    // viewport con las mismas medidas y matriz que usa pdf.js al girar.
    const angle = ((page.rotation % 360) + 360) % 360;
    const swap = angle === 90 || angle === 270;
    const width = (swap ? page.height : page.width) * scale;
    const height = (swap ? page.width : page.height) * scale;
    let transform;
    if (angle === 90) transform = [0, scale, scale, 0, 0, 0];
    else if (angle === 180) transform = [-scale, 0, 0, scale, page.width * scale, 0];
    else if (angle === 270) transform = [0, -scale, -scale, 0, page.height * scale, page.width * scale];
    else transform = [scale, 0, 0, -scale, 0, page.height * scale];

    return {
      width,
      height,
      scale,
      rotation: angle,
      transform,
      convertToViewportPoint: (x, y) => transformPoint(transform, x, y),
      convertToPdfPoint: (x, y) => inverseTransformPoint(transform, x, y),
      convertToViewportRectangle: (rect) => transformRectangle(transform, rect)
    };
  }
  return page.pageRef.getViewport({ scale, rotation });
}

function transformPoint(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]
  ];
}

function inverseTransformPoint(matrix, x, y) {
  const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!det) return [x, y];
  const px = x - matrix[4];
  const py = y - matrix[5];
  return [
    (matrix[3] * px - matrix[2] * py) / det,
    (-matrix[1] * px + matrix[0] * py) / det
  ];
}

function transformRectangle(matrix, rect) {
  const p1 = transformPoint(matrix, rect[0], rect[1]);
  const p2 = transformPoint(matrix, rect[2], rect[3]);
  return [
    Math.min(p1[0], p2[0]),
    Math.min(p1[1], p2[1]),
    Math.max(p1[0], p2[0]),
    Math.max(p1[1], p2[1])
  ];
}

function basePageSize(page) {
  if (page.pageRef) {
    const viewport = page.pageRef.getViewport({ scale: 1, rotation: 0 });
    return { width: viewport.width, height: viewport.height };
  }
  return { width: page.width, height: page.height };
}

function totalRotation(page) {
  return ((((page.pageRef && page.pageRef.rotate) || 0) + page.rotation) % 360 + 360) % 360;
}

function currentPage() {
  return state.pages[state.current] || null;
}

function resetDocumentState() {
  state.docs.clear();
  state.pages = [];
  state.fileName = '';
  state.filePath = '';
  state.dirty = false;
  state.current = 0;
  state.selectedAnn = null;
  state.undoStack = [];
  state.redoStack = [];
  state.search = { query: '', matches: [], index: -1 };
  state.formFields = [];
  state.formValues = {};
  state.formBlocked = '';
  state.metadata = { title: '', author: '', subject: '', keywords: '' };
  state.watermark = { text: '', on: false };
  state.docInfo = null;
  state.image = null;
  $('#watermarkText').value = '';
  $('#watermarkOn').checked = false;
  ['#metaTitle', '#metaAuthor', '#metaSubject', '#metaKeywords'].forEach((selector) => {
    $(selector).value = '';
  });
  $('#searchInput').value = '';
  $('#searchCount').textContent = '';
  $('#searchbar').hidden = true;
  renderFormPanel();
  renderDocInfo();
  renderTextEditList();
}

async function confirmDiscard() {
  if (!state.dirty || !state.pages.length) return true;
  try {
    return Boolean(await api.confirmDiscard());
  } catch (error) {
    return true;
  }
}

function askPassword(message) {
  return new Promise((resolve) => {
    const modal = $('#passwordModal');
    const input = $('#passwordInput');
    const errorNode = $('#passwordError');
    $('#passwordMessage').textContent = message;
    errorNode.textContent = '';
    input.value = '';
    modal.hidden = false;
    input.focus();

    const cleanup = (value) => {
      modal.hidden = true;
      input.removeEventListener('keydown', onKey);
      $('#passwordOk').removeEventListener('click', onOk);
      $('#passwordCancel').removeEventListener('click', onCancel);
      resolve(value);
    };
    const onOk = () => {
      if (!input.value) {
        errorNode.textContent = 'Escribe la contraseña o pulsa Cancelar.';
        input.focus();
        return;
      }
      cleanup(input.value);
    };
    const onCancel = () => cleanup(null);
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onOk();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    input.addEventListener('keydown', onKey);
    $('#passwordOk').addEventListener('click', onOk);
    $('#passwordCancel').addEventListener('click', onCancel);
  });
}

/* --------------------------- Diálogo de texto ---------------------------- */

function askPrompt(options) {
  const settings = options || {};
  return new Promise((resolve) => {
    const modal = $('#promptModal');
    const input = $('#promptInput');
    const errorNode = $('#promptError');
    $('#promptTitle').textContent = settings.title || 'ZeroPDF';
    $('#promptMessage').textContent = settings.message || '';
    $('#promptOk').textContent = settings.okLabel || 'Aceptar';
    input.type = settings.password ? 'password' : 'text';
    input.placeholder = settings.placeholder || '';
    input.value = settings.value || '';
    input.hidden = Boolean(settings.hideInput);
    errorNode.textContent = '';
    modal.hidden = false;
    input.focus();
    input.select();

    const cleanup = (value) => {
      modal.hidden = true;
      input.removeEventListener('keydown', onKey);
      $('#promptOk').removeEventListener('click', onOk);
      $('#promptCancel').removeEventListener('click', onCancel);
      resolve(value);
    };
    const onOk = () => {
      const text = input.value;
      const error = settings.validate ? settings.validate(text) : null;
      if (error) {
        errorNode.textContent = error;
        input.focus();
        return;
      }
      cleanup(text);
    };
    const onCancel = () => cleanup(null);
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onOk();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    input.addEventListener('keydown', onKey);
    $('#promptOk').addEventListener('click', onOk);
    $('#promptCancel').addEventListener('click', onCancel);
  });
}

// Convierte "1-3,5" en [1,2,3,5] validando el rango del documento.
function parsePageRange(text, total) {
  const value = String(text || '').trim();
  if (!value) return [];
  const pages = [];
  for (const chunk of value.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (match) {
      const from = Number(match[1]);
      const to = Number(match[2]);
      if (!from || !to || from > to) return [];
      for (let page = from; page <= to; page += 1) {
        if (page < 1 || page > total) return [];
        pages.push(page);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) return [];
    const page = Number(part);
    if (page < 1 || page > total) return [];
    pages.push(page);
  }
  return pages;
}

/* -------------------------------- Iconos -------------------------------- */

const ICONS = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3"/><path d="M8 21v-7h8v7"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/></svg>',
  cursor: '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6.2 1.6L10 20z"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V6.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6v-3l2.5 2"/></svg>',
  highlight: '<svg viewBox="0 0 24 24"><path d="M4 20h6"/><path d="M8 16l7-7 4 4-7 7H8z"/><path d="M15 9l2-2a2 2 0 0 1 3 3l-2 2"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 5h14"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>',
  edittext: '<svg viewBox="0 0 24 24"><path d="M4 5h8"/><path d="M4 10h5"/><path d="M4 15h4"/><path d="M14.5 19.5l5-5-2.5-2.5-5 5v2.5z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M5 4h14v10l-5 5H5z"/><path d="M14 19v-5h5"/></svg>',
  rect: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M14 6l3 3"/></svg>',
  cover: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" fill="currentColor" fill-opacity="0.25"/><path d="M4 19L20 5"/></svg>',
  redact: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2" fill="currentColor"/><path d="M7 16l10-8" stroke="#e11900" stroke-width="2"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-8 8"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9h-9a6 6 0 0 0 0 12h3"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  merge: '<svg viewBox="0 0 24 24"><path d="M7 4v6a4 4 0 0 0 4 4h6"/><path d="M14 11l3 3-3 3"/><path d="M7 20v-6"/></svg>',
  rotate: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

function injectIcons() {
  $$('[data-icon]').forEach((node) => {
    const svg = ICONS[node.dataset.icon];
    if (!svg) return;
    if (node.classList.contains('ico') || node.classList.contains('icon-btn') || node.classList.contains('tool')) {
      node.innerHTML = svg;
    } else {
      node.insertAdjacentHTML('afterbegin', svg);
    }
  });
}

/* ------------------------------ Documento ------------------------------- */

async function openViaDialog() {
  if (!(await confirmDiscard())) return;
  try {
    const result = await api.openDialog();
    if (result) await loadPdf(result.data, result.name, result.path);
  } catch (error) {
    console.error(error);
    toast('No se pudo abrir el PDF: ' + error.message, 5200);
  }
}

async function openPdfSource(bytes) {
  let password = '';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const doc = await pdfjsLib.getDocument({
        data: bytes.slice(0),
        password: password || undefined,
        cMapUrl: '../node_modules/pdfjs-dist/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '../node_modules/pdfjs-dist/standard_fonts/',
        useSystemFonts: true,
        enableXfa: true
      }).promise;
      return { doc, password };
    } catch (error) {
      if (error && error.name === 'PasswordException') {
        const message = error.code === 2
          ? 'La contraseña no es correcta. Inténtalo de nuevo.'
          : 'Este PDF está protegido. Introduce la contraseña para abrirlo.';
        password = await askPassword(message);
        if (password === null) {
          const cancelled = new Error('Apertura cancelada.');
          cancelled.cancelled = true;
          throw cancelled;
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error('Demasiados intentos de contraseña.');
}

async function inspectPdfSource(bytes) {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    let xfa = false;
    try {
      const acroRef = doc.catalog.get(PDFName.of('AcroForm'));
      const acro = acroRef ? doc.context.lookup(acroRef) : null;
      xfa = Boolean(acro && acro.get && acro.get(PDFName.of('XFA')));
    } catch (error) {
      /* documento sin AcroForm */
    }
    return { encrypted: Boolean(doc.isEncrypted), xfa };
  } catch (error) {
    // Si pdf-lib no puede ni cargarlo, se abrirá en modo rasterizado.
    return { encrypted: true, xfa: false };
  }
}

async function loadPdf(data, name, filePath, options = {}) {
  const { append = false } = options;
  try {
    const bytes = new Uint8Array(data);
    const opened = await openPdfSource(bytes);
    const doc = opened.doc;
    const password = opened.password || '';
    const flags = await inspectPdfSource(bytes);

    const docId = uid();
    const record = {
      doc,
      bytes,
      name,
      numPages: doc.numPages,
      encrypted: flags.encrypted,
      xfa: flags.xfa,
      wasEncrypted: false
    };

    if (filePath && !append) {
      try {
        await api.addRecent(filePath);
      } catch (error) {
        /* sin lista de recientes */
      }
    }

    if (flags.encrypted) {
      try {
        const decrypted = await api.decryptPdf(bytes, password);
        if (decrypted && decrypted.ok && decrypted.data && decrypted.data.length) {
          const decryptedBytes = new Uint8Array(decrypted.data);
          const decryptedFlags = await inspectPdfSource(decryptedBytes);
          if (!decryptedFlags.encrypted) {
            record.bytes = decryptedBytes;
            record.encrypted = false;
            record.wasEncrypted = true;
            record.xfa = decryptedFlags.xfa || flags.xfa;
          }
        } else if (decrypted && decrypted.error) {
          console.warn('qpdf:', decrypted.error);
        }
      } catch (error) {
        console.warn('No se pudo descifrar el PDF con qpdf', error);
      }
    }

    if (append) {
      state.docs.set(docId, record);
    } else {
      resetDocumentState();
      state.docs = new Map([[docId, record]]);
      state.fileName = name || 'documento.pdf';
      state.filePath = filePath || '';
    }

    const pages = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const pageRef = await doc.getPage(i);
      const viewport = pageRef.getViewport({ scale: 1 });
      pages.push({
        id: uid(),
        docId,
        index: i - 1,
        pageRef,
        width: viewport.width,
        height: viewport.height,
        rotation: 0,
        anns: [],
        textItems: [],
        textEdits: []
      });
    }

    if (append) {
      state.pages.push(...pages);
    } else {
      state.pages = pages;
      if (pages.length) {
        const avail = Math.max(320, $('#viewer').clientWidth - 64);
        const maxWidth = Math.max(...pages.map((p) => p.width));
        state.scale = clamp(avail / maxWidth, 0.25, 3);
        state.fit = 'width';
      }
    }

    $('#emptyState').hidden = state.pages.length > 0;
    await rebuildThumbs();
    renderDocument({ keepPosition: append });
    if (!append) {
      await loadMetadata();
      await loadFormFields();
    } else {
      await loadAppendedFormFields(record);
    }
    updateUI();
    const encryptionNote = record.wasEncrypted
      ? tr(' (descifrado para edición)')
      : (record.encrypted ? tr(' (cifrado: se rasterizará al guardar)') : '');
    toast(append
      ? `${tr('Se añadieron {n} páginas', { n: doc.numPages })}${encryptionNote}`
      : `${tr('Abierto: {name}', { name: state.fileName })}${encryptionNote}`);
    return true;
  } catch (error) {
    if (error && error.cancelled) return false;
    console.error(error);
    toast('No se pudo abrir el PDF: ' + error.message, 5200);
    return false;
  }
}

async function loadMetadata() {
  const first = state.pages[0];
  if (!first) return;
  const rec = state.docs.get(first.docId);
  if (!rec) return;
  state.metadata = { title: '', author: '', subject: '', keywords: '' };
  ['#metaTitle', '#metaAuthor', '#metaSubject', '#metaKeywords'].forEach((selector) => {
    $(selector).value = '';
  });
  try {
    const meta = await rec.doc.getMetadata();
    const info = (meta && meta.info) || {};
    state.metadata = {
      title: info.Title || '',
      author: info.Author || '',
      subject: info.Subject || '',
      keywords: info.Keywords || ''
    };
    $('#metaTitle').value = state.metadata.title;
    $('#metaAuthor').value = state.metadata.author;
    $('#metaSubject').value = state.metadata.subject;
    $('#metaKeywords').value = state.metadata.keywords;
    state.docInfo = {
      pages: state.pages.length,
      size: rec.bytes.length,
      producer: info.Producer || '',
      creator: info.Creator || '',
      pdfVersion: info.PDFFormatVersion || ''
    };
  } catch (error) {
    state.docInfo = { pages: state.pages.length, size: rec.bytes.length };
  }
  renderDocInfo();
}

function renderDocInfo() {
  const info = state.docInfo;
  const node = $('#docInfo');
  if (!info) {
    node.textContent = 'Sin documento.';
    return;
  }
  const sizeKb = info.size ? Math.round(info.size / 1024) : 0;
  node.innerHTML = [
    `<div><strong>Páginas:</strong> ${state.pages.length}</div>`,
    `<div><strong>Tamaño original:</strong> ${sizeKb} KB</div>`,
    info.pdfVersion ? `<div><strong>Versión PDF:</strong> ${escapeHtml(info.pdfVersion)}</div>` : '',
    info.producer ? `<div><strong>Productor:</strong> ${escapeHtml(info.producer)}</div>` : '',
    info.creator ? `<div><strong>Creador:</strong> ${escapeHtml(info.creator)}</div>` : ''
  ].join('');
}

/* ------------------------------- Render --------------------------------- */

function renderDocument(options = {}) {
  const { keepPosition = true } = options;
  const viewer = $('#viewer');
  const previous = keepPosition ? capturePosition() : null;

  if (observer) {
    observer.disconnect();
    observer = null;
  }
  pageEntries.forEach((entry) => entry.el.remove());
  pageEntries = [];

  $('#emptyState').hidden = state.pages.length > 0;

  if (!state.pages.length) {
    updateUI();
    return;
  }

  state.pages.forEach((page, index) => {
    const viewport = getViewport(page);
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.pageIndex = String(index);
    el.style.width = viewport.width + 'px';
    el.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.className = 'pageCanvas';

    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'annLayer');

    el.append(canvas, textLayer, svg);
    viewer.append(el);

    const entry = { el, canvas, textLayer, svg, rendered: false, rendering: false, vp: viewport };
    pageEntries.push(entry);
  });

  observer = new IntersectionObserver((entries) => {
    entries.forEach((ioEntry) => {
      if (!ioEntry.isIntersecting) return;
      const index = Number(ioEntry.target.dataset.pageIndex);
      const entry = pageEntries[index];
      if (!entry || entry.rendered || entry.rendering) return;
      renderPage(index);
    });
  }, { root: viewer, rootMargin: '700px 0px' });

  pageEntries.forEach((entry) => observer.observe(entry.el));

  if (previous) restorePosition(previous);
  updateUI();
}

function capturePosition() {
  if (!pageEntries.length) return null;
  const viewerTop = $('#viewer').getBoundingClientRect().top;
  for (let i = 0; i < pageEntries.length; i += 1) {
    const rect = pageEntries[i].el.getBoundingClientRect();
    if (rect.bottom > viewerTop + 2) {
      return { index: i, offset: viewerTop - rect.top };
    }
  }
  return { index: 0, offset: 0 };
}

function restorePosition(position) {
  const entry = pageEntries[position.index];
  if (!entry) return;
  const viewerTop = $('#viewer').getBoundingClientRect().top;
  const rect = entry.el.getBoundingClientRect();
  $('#viewer').scrollTop += (viewerTop - rect.top) - position.offset;
}

async function renderPage(index) {
  const entry = pageEntries[index];
  const page = state.pages[index];
  if (!entry || !page) return;
  entry.rendering = true;

  const viewport = getViewport(page);
  entry.vp = viewport;
  const dpr = window.devicePixelRatio || 1;

  entry.el.style.width = viewport.width + 'px';
  entry.el.style.height = viewport.height + 'px';
  entry.canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  entry.canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  entry.canvas.style.width = viewport.width + 'px';
  entry.canvas.style.height = viewport.height + 'px';

  const ctx = entry.canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  if (page.pageRef) {
    try {
      await page.pageRef.render({ canvasContext: ctx, viewport }).promise;
    } catch (error) {
      console.warn('Error al renderizar la página', index, error);
    }
    loadPageLinks(page);
  }

  if (page.textEdits && page.textEdits.some((edit) => edit.ocr)) {
    try {
      cleanOcrText(entry.canvas, viewport, page.textEdits, dpr);
    } catch (error) {
      console.warn('No se pudo limpiar el texto OCR de la vista previa', error);
    }
  }

  entry.textLayer.innerHTML = '';
  entry.textLayer.style.width = viewport.width + 'px';
  entry.textLayer.style.height = viewport.height + 'px';
  entry.textLayer.style.setProperty('--scale-factor', String(viewport.scale));

  if (page.pageRef) {
    try {
      const textContent = await page.pageRef.getTextContent();
      page.textItems = extractTextItems(textContent, page);
      if (viewport.scale >= 0.45) {
        await pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: entry.textLayer,
          viewport,
          textDivs: []
        }).promise;
      }
    } catch (error) {
      console.warn('Capa de texto no disponible', error);
    }
  }

  drawAnnotations(entry, page, viewport);
  entry.rendered = true;
  entry.rendering = false;
}

/* ----------------------------- Anotaciones ------------------------------ */

const NS = 'http://www.w3.org/2000/svg';

function drawAnnotations(entry, page, viewport) {
  const svg = entry.svg;
  svg.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
  svg.setAttribute('width', String(viewport.width));
  svg.setAttribute('height', String(viewport.height));
  svg.innerHTML = '';

  const group = document.createElementNS(NS, 'g');
  if (viewport.transform) group.setAttribute('transform', `matrix(${viewport.transform.join(' ')})`);
  svg.appendChild(group);

  drawTextEdits(group, page, viewport);

  page.anns.forEach((ann) => {
    const node = buildAnnotationNode(ann, page, viewport);
    if (!node) return;
    node.setAttribute('data-ann', ann.id);
    if (state.selectedAnn && state.selectedAnn.pageIndex === state.pages.indexOf(page) && state.selectedAnn.id === ann.id) {
      node.classList.add('selected');
    }
    if (ann.type === 'text' || ann.type === 'note') {
      svg.appendChild(node);
    } else {
      group.appendChild(node);
    }
  });

  if (state.watermark.on && state.watermark.text.trim()) {
    // Misma posición, tamaño, giro y opacidad que en buildPdf().
    const base = basePageSize(page);
    const [tx, ty] = viewport.convertToViewportPoint(base.width * 0.16, base.height * 0.42);
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', String(tx));
    text.setAttribute('y', String(ty));
    text.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
    text.setAttribute('font-size', String(Math.min(64, base.width / 10) * viewport.scale));
    text.setAttribute('fill', '#737373');
    text.setAttribute('opacity', '0.14');
    text.setAttribute('transform', `rotate(${totalRotation(page) - 45} ${tx} ${ty})`);
    text.style.pointerEvents = 'none';
    text.textContent = state.watermark.text.trim();
    svg.appendChild(text);
  }

  drawCropMasks(entry, page, viewport);
}

// Sombreado de los márgenes recortados (solo vista previa; el recorte real se
// aplica al exportar con el CropBox).
function drawCropMasks(entry, page, viewport) {
  if (!page || !page.crop) return;
  const { width, height } = pdfPageSize(page);
  const crop = page.crop;
  const innerWidth = width - crop.left - crop.right;
  const innerHeight = height - crop.top - crop.bottom;
  if (innerWidth <= 1 || innerHeight <= 1) return;

  const group = document.createElementNS(NS, 'g');
  if (viewport.transform) group.setAttribute('transform', `matrix(${viewport.transform.join(' ')})`);
  const masks = [
    [0, height - crop.top, width, crop.top],
    [0, 0, width, crop.bottom],
    [0, crop.bottom, crop.left, innerHeight],
    [width - crop.right, crop.bottom, crop.right, innerHeight]
  ];
  masks.forEach(([x, y, w, h]) => {
    if (w <= 0 || h <= 0) return;
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('class', 'crop-mask');
    group.appendChild(rect);
  });
  entry.svg.appendChild(group);
}

function pdfPageSize(page) {
  if (page && page.pageRef && page.pageRef.view) {
    const view = page.pageRef.view;
    return { width: view[2] - view[0], height: view[3] - view[1] };
  }
  return { width: (page && page.width) || 595, height: (page && page.height) || 842 };
}

function buildAnnotationNode(ann, page, viewport) {
  const color = ann.color || '#e11900';
  const lineWidth = ann.lineWidth || 2;

  if (ann.type === 'highlight' || ann.type === 'cover' || ann.type === 'rect' || ann.type === 'redact') {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(ann.x));
    rect.setAttribute('y', String(ann.y));
    rect.setAttribute('width', String(ann.w));
    rect.setAttribute('height', String(ann.h));
    rect.setAttribute('fill', ann.type === 'cover' ? '#ffffff'
      : (ann.type === 'redact' ? '#000000' : color));
    rect.setAttribute('fill-opacity', ann.type === 'rect' ? 0
      : (ann.type === 'redact' ? 1 : (ann.opacity ?? 0.35)));
    if (ann.type === 'rect') {
      rect.setAttribute('stroke', color);
      rect.setAttribute('stroke-width', String(lineWidth));
      rect.setAttribute('vector-effect', 'non-scaling-stroke');
    }
    return rect;
  }

  if (ann.type === 'ellipse') {
    const ellipse = document.createElementNS(NS, 'ellipse');
    ellipse.setAttribute('cx', String(ann.x + ann.w / 2));
    ellipse.setAttribute('cy', String(ann.y + ann.h / 2));
    ellipse.setAttribute('rx', String(Math.abs(ann.w / 2)));
    ellipse.setAttribute('ry', String(Math.abs(ann.h / 2)));
    ellipse.setAttribute('fill', 'none');
    ellipse.setAttribute('stroke', color);
    ellipse.setAttribute('stroke-width', String(lineWidth));
    ellipse.setAttribute('vector-effect', 'non-scaling-stroke');
    return ellipse;
  }

  if (ann.type === 'ink') {
    const poly = document.createElementNS(NS, 'polyline');
    poly.setAttribute('points', ann.points.map((p) => `${p[0]},${p[1]}`).join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', String(lineWidth));
    poly.setAttribute('stroke-linecap', 'round');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('vector-effect', 'non-scaling-stroke');
    return poly;
  }

  if (ann.type === 'text' || ann.type === 'note') {
    const [sx, sy] = viewport.convertToViewportPoint(ann.x, ann.y);
    const angle = totalRotation(page);

    if (ann.type === 'note') {
      const box = document.createElementNS(NS, 'g');
      const rect = document.createElementNS(NS, 'rect');
      const [tx, ty] = viewport.convertToViewportPoint(ann.x, ann.y + ann.h);
      rect.setAttribute('x', String(tx));
      rect.setAttribute('y', String(ty));
      rect.setAttribute('width', String(ann.w * viewport.scale));
      rect.setAttribute('height', String(ann.h * viewport.scale));
      rect.setAttribute('fill', '#fff3a6');
      rect.setAttribute('stroke', '#d4b106');
      rect.setAttribute('stroke-width', '1');
      box.appendChild(rect);
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(tx + 6));
      label.setAttribute('y', String(ty + 15));
      label.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
      label.setAttribute('font-size', String(Math.max(9, (ann.fontSize || 11) * viewport.scale)));
      label.setAttribute('fill', '#4a3b00');
      label.textContent = ann.text.length > 34 ? ann.text.slice(0, 34) + '…' : ann.text;
      box.appendChild(label);
      return box;
    }

    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', String(sx));
    text.setAttribute('y', String(sy));
    text.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
    text.setAttribute('font-size', String((ann.fontSize || 14) * viewport.scale));
    text.setAttribute('fill', color);
    text.setAttribute('transform', `rotate(${angle} ${sx} ${sy})`);
    text.setAttribute('xml:space', 'preserve');
    const lines = String(ann.text).split('\n');
    lines.forEach((line, i) => {
      const tspan = document.createElementNS(NS, 'tspan');
      tspan.setAttribute('x', String(sx));
      tspan.setAttribute('dy', i === 0 ? '0' : String((ann.fontSize || 14) * 1.25 * viewport.scale));
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    return text;
  }

  if (ann.type === 'image' && ann.dataURL) {
    const image = document.createElementNS(NS, 'image');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(ann.w));
    image.setAttribute('height', String(ann.h));
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('href', ann.dataURL);
    image.setAttribute('transform', `translate(${ann.x} ${ann.y + ann.h}) scale(1 -1)`);
    return image;
  }

  return null;
}

/* --------------------------- Edición de texto --------------------------- */

const FAMILY_CSS = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace'
};

const FAMILY_FONTS = {
  helvetica: {
    normal: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique
  },
  times: {
    normal: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic
  },
  courier: {
    normal: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique
  }
};

const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');
const sampleCanvas = document.createElement('canvas');
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

function familyCss(family) {
  return FAMILY_CSS[family] || FAMILY_CSS.helvetica;
}

function measureTextWidth(text, family, bold, italic, size) {
  measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${familyCss(family)}`;
  return measureCtx.measureText(text).width;
}

function fitTextSize(measure, text, maxWidth, size) {
  if (!text || !maxWidth) return size;
  const width = measure(text, size);
  if (!width || width <= maxWidth * 1.02) return size;
  return Math.max(4.5, size * (maxWidth / width));
}

function detectFamily(fontFamily, fontName) {
  const name = String(fontName || '').toLowerCase();
  const generic = String(fontFamily || '').toLowerCase();
  if (/courier|mono/.test(name) || generic.includes('mono')) return 'courier';
  if (/times|serif/.test(name) && !/sans/.test(name)) return 'times';
  if (generic.includes('serif') && !generic.includes('sans')) return 'times';
  return 'helvetica';
}

// Muchos PDF no marcan /ForceBold en el descriptor: la única pista fiable del
// grosor es el nombre real de la fuente (Arial-BoldMT, SegoeUI-Semibold…).
const BOLD_NAME = /bold|black|heavy|semibold|semi-bold|demibold|demi-bold|extrabold|ultrabold/i;
const ITALIC_NAME = /italic|oblique|kursiv/i;

function fontDetails(page, item) {
  const fallback = { bold: false, italic: false, family: detectFamily('', '') };
  try {
    const common = page.pageRef && page.pageRef.commonObjs;
    if (common && common.has(item.fontName)) {
      const font = common.get(item.fontName);
      const name = `${(font && font.name) || ''} ${(font && font.fallbackName) || ''}`;
      return {
        bold: Boolean(font && font.bold) || BOLD_NAME.test(name),
        italic: Boolean(font && font.italic) || ITALIC_NAME.test(name),
        family: detectFamily(font && font.fallbackName, font && font.name)
      };
    }
  } catch (error) {
    /* fuente aún no resuelta */
  }
  return fallback;
}

function extractTextItems(textContent, page) {
  const styles = textContent.styles || {};
  const items = [];
  textContent.items.forEach((item, index) => {
    if (!item.str || !item.str.trim() || item.type) return;
    const t = item.transform || [1, 0, 0, 1, 0, 0];
    const style = styles[item.fontName] || {};
    const vertical = Boolean(style.vertical);
    const fontSize = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    const extent = vertical ? (item.height || 0) : (item.width || 0);
    let ux;
    let uy;
    if (vertical) {
      const length = Math.hypot(t[2], t[3]) || 1;
      ux = -t[2] / length;
      uy = -t[3] / length;
    } else {
      const length = Math.hypot(t[0], t[1]) || 1;
      ux = t[0] / length;
      uy = t[1] / length;
    }
    items.push({
      index,
      str: item.str,
      x: t[4],
      y: t[5],
      width: Math.max(1, extent || 1),
      fontSize,
      vertical,
      ux,
      uy,
      ascent: vertical ? 0.5 : (typeof style.ascent === 'number' && style.ascent > 0 ? style.ascent : 0.82),
      descent: vertical ? -0.5 : (typeof style.descent === 'number' && style.descent < 0 ? style.descent : -0.22),
      fontName: item.fontName,
      dir: item.dir || 'ltr',
      angle: Math.atan2(uy, ux)
    });
  });
  return items;
}

function orientedCorners(box) {
  const ux = box.ux ?? 1;
  const uy = box.uy ?? 0;
  const nx = -uy;
  const ny = ux;
  const fontSize = box.fontSize || 10;
  const ascent = box.ascent ?? 0.82;
  const descent = box.descent ?? -0.22;
  const x = box.x;
  const y = box.y;
  const width = box.width;
  return [
    [x + nx * descent * fontSize, y + ny * descent * fontSize],
    [x + ux * width + nx * descent * fontSize, y + uy * width + ny * descent * fontSize],
    [x + ux * width + nx * ascent * fontSize, y + uy * width + ny * ascent * fontSize],
    [x + nx * ascent * fontSize, y + ny * ascent * fontSize]
  ];
}

function orientedViewportRect(box, viewport) {
  const points = orientedCorners(box).map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

function textItemRect(item, viewport) {
  return orientedViewportRect({
    x: item.x,
    y: item.y,
    width: item.width,
    fontSize: item.fontSize,
    ascent: item.ascent,
    descent: item.descent,
    ux: item.ux,
    uy: item.uy
  }, viewport);
}

function findTextItem(index, event) {
  const page = state.pages[index];
  const entry = pageEntries[index];
  if (!page || !entry || !entry.vp || !page.textItems || !page.textItems.length) return null;
  const pageRect = entry.el.getBoundingClientRect();
  const px = event.clientX - pageRect.left;
  const py = event.clientY - pageRect.top;
  let best = null;
  page.textItems.forEach((item) => {
    const rect = textItemRect(item, entry.vp);
    if (px < rect.left - 2 || px > rect.left + rect.width + 2) return;
    if (py < rect.top - 1 || py > rect.top + rect.height + 1) return;
    if (!best || item.width * item.fontSize < best.width * best.fontSize) best = item;
  });
  return best;
}

/* -------------------- Agrupación de líneas y párrafos ------------------- */

function lineTolerance(item) {
  return Math.max(0.75, Math.min(item.fontSize || 10, 24) * 0.16);
}

function sameBaseline(a, b) {
  const aux = a.ux ?? 1;
  const auy = a.uy ?? 0;
  const bux = b.ux ?? 1;
  const buy = b.uy ?? 0;
  if (aux * bux + auy * buy < 0.999) return false;
  const nx = -auy;
  const ny = aux;
  const distance = Math.abs((b.x - a.x) * nx + (b.y - a.y) * ny);
  return distance <= Math.max(lineTolerance(a), lineTolerance(b));
}

function lineItemsFor(page, item) {
  if (!page || !item) return [];
  const ux = item.ux ?? 1;
  const uy = item.uy ?? 0;
  const projection = (entry) => entry.x * ux + entry.y * uy;
  const candidates = (page.textItems || [])
    .filter((other) => sameBaseline(other, item))
    .sort((a, b) => projection(a) - projection(b));
  if (!candidates.length) return [item];

  const groups = [];
  let current = [];
  candidates.forEach((other) => {
    if (!current.length) {
      current.push(other);
      return;
    }
    const previous = current[current.length - 1];
    const gap = projection(other) - projection(previous) - previous.width;
    const limit = Math.max(18, Math.min(previous.fontSize || 10, other.fontSize || 10) * 2.5);
    if (gap > limit) {
      groups.push(current);
      current = [other];
    } else {
      current.push(other);
    }
  });
  if (current.length) groups.push(current);
  return groups.find((group) => group.some((other) => other.index === item.index)) || [item];
}

function lineTextFrom(items) {
  let text = '';
  const ux = items[0] ? (items[0].ux ?? 1) : 1;
  const uy = items[0] ? (items[0].uy ?? 0) : 0;
  const projection = (entry) => entry.x * ux + entry.y * uy;
  items.forEach((item, index) => {
    if (index > 0) {
      const previous = items[index - 1];
      const gap = projection(item) - projection(previous) - previous.width;
      const needSpace = gap > Math.max(0.6, Math.min(previous.fontSize || 10, item.fontSize || 10) * 0.16);
      if (needSpace && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' ';
    }
    text += item.str;
  });
  return text;
}

function lineBoxFrom(items) {
  const first = items[0];
  const last = items[items.length - 1];
  const ux = first.ux ?? 1;
  const uy = first.uy ?? 0;
  const projection = (entry) => entry.x * ux + entry.y * uy;
  const start = projection(first);
  const end = projection(last) + last.width;
  const vertical = Boolean(first.vertical);
  return {
    x: first.x,
    y: first.y,
    width: Math.max(1, end - start),
    fontSize: first.fontSize || 10,
    ascent: first.ascent ?? (vertical ? 0.5 : 0.82),
    descent: first.descent ?? (vertical ? -0.5 : -0.22),
    ux,
    uy,
    vertical,
    angle: Math.atan2(uy, ux)
  };
}

function allTextLines(page) {
  const lines = [];
  (page.textItems || []).forEach((item) => {
    let line = lines.find((candidate) => sameBaseline(candidate.items[0], item));
    if (!line) {
      line = { items: [] };
      lines.push(line);
    }
    line.items.push(item);
  });
  return lines
    .map((line) => {
      const ux = line.items[0].ux ?? 1;
      const uy = line.items[0].uy ?? 0;
      line.items.sort((a, b) => (a.x * ux + a.y * uy) - (b.x * ux + b.y * uy));
      const box = lineBoxFrom(line.items);
      return { items: line.items, box, text: lineTextFrom(line.items) };
    })
    .sort((a, b) => b.box.y - a.box.y);
}

function paragraphLinesFor(page, item) {
  // La edición de párrafo se limita a texto horizontal; para texto girado o
  // vertical se edita la línea (la agrupación ya es correcta).
  if (Math.abs(item.uy ?? 0) > 0.02 || (item.ux ?? 1) < 0.98) {
    return [lineItemsFor(page, item)];
  }
  const lines = allTextLines(page);
  const index = lines.findIndex((line) => line.items.some((entry) => entry.index === item.index));
  if (index < 0) return [lineItemsFor(page, item)];

  const selected = [lines[index]];
  const maxLines = 12;
  const compatible = (base, candidate) => {
    const gap = Math.abs(base.box.y - candidate.box.y);
    const size = Math.max(base.box.fontSize, candidate.box.fontSize);
    if (gap < 0.4 || gap > size * 2.1) return false;
    const ratio = size / Math.max(1, Math.min(base.box.fontSize, candidate.box.fontSize));
    if (ratio > 1.45) return false;
    const leftDiff = Math.abs(candidate.box.x - base.box.x);
    const centerDiff = Math.abs(
      (candidate.box.x + candidate.box.width / 2) - (base.box.x + base.box.width / 2)
    );
    return leftDiff <= Math.max(8, size * 1.8) || centerDiff <= size * 2.4;
  };

  for (let i = index - 1; i >= 0 && selected.length < maxLines; i -= 1) {
    if (!compatible(selected[0], lines[i])) break;
    selected.unshift(lines[i]);
  }
  for (let i = index + 1; i < lines.length && selected.length < maxLines; i += 1) {
    if (!compatible(selected[selected.length - 1], lines[i])) break;
    selected.push(lines[i]);
  }
  return selected.map((line) => line.items);
}

function buildEditLines(page, item, paragraph) {
  const groups = paragraph ? paragraphLinesFor(page, item) : [lineItemsFor(page, item)];
  return groups
    .filter((items) => items && items.length)
    .map((items) => ({
      items,
      box: lineBoxFrom(items),
      text: lineTextFrom(items)
    }));
}

function editLineBoxes(edit) {
  if (edit && Array.isArray(edit.lines) && edit.lines.length) return edit.lines;
  return [{
    x: edit.x,
    y: edit.y,
    width: edit.width,
    fontSize: edit.fontSize,
    ascent: edit.ascent ?? 0.82,
    descent: edit.descent ?? -0.22,
    ux: edit.ux ?? 1,
    uy: edit.uy ?? 0,
    vertical: Boolean(edit.vertical),
    angle: edit.angle ?? 0
  }];
}

/* ------------------- Estilos por tramos dentro de una línea ----------------- */

// Devuelve, por cada línea del cambio, la lista de tramos con su estilo.
function editableRuns(edit) {
  const lines = [];
  const source = edit && Array.isArray(edit.runs) ? edit.runs : null;
  if (source) {
    source.forEach((line) => {
      const runs = [];
      (Array.isArray(line) ? line : []).forEach((run) => {
        const text = String((run && run.text) || '');
        if (!text) return;
        const bold = Boolean(run.bold);
        const italic = Boolean(run.italic);
        const last = runs[runs.length - 1];
        if (last && last.bold === bold && last.italic === italic) last.text += text;
        else runs.push({ text, bold, italic });
      });
      lines.push(runs);
    });
  }
  if (!lines.length) {
    const text = edit && typeof edit.text === 'string' ? edit.text : '';
    text.split('\n').forEach((line) => {
      lines.push(line
        ? [{ text: line, bold: Boolean(edit && edit.bold), italic: Boolean(edit && edit.italic) }]
        : []);
    });
  }
  return lines;
}

function lineRunsText(runs) {
  return runs.map((run) => run.text).join('');
}

function boxViewportRect(box, viewport) {
  return orientedViewportRect(box, viewport);
}

function unionRect(rects) {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

function sampleTextColors(entry, rect, pixelScale = null) {
  const fallback = { color: '#111111', bg: '#ffffff' };
  try {
    const canvas = entry.canvas;
    const dpr = pixelScale || window.devicePixelRatio || 1;
    const x = clamp(Math.floor(rect.left * dpr), 0, Math.max(0, canvas.width - 2));
    const y = clamp(Math.floor(rect.top * dpr), 0, Math.max(0, canvas.height - 2));
    const w = clamp(Math.ceil(rect.width * dpr), 1, canvas.width - x);
    const h = clamp(Math.ceil(rect.height * dpr), 1, canvas.height - y);
    if (w < 2 || h < 2) return fallback;

    sampleCanvas.width = w;
    sampleCanvas.height = h;
    sampleCtx.clearRect(0, 0, w, h);
    sampleCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    const data = sampleCtx.getImageData(0, 0, w, h).data;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 100) continue;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { count: 0, r: 0, g: 0, b: 0 };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      bucket.r += data[i];
      bucket.g += data[i + 1];
      bucket.b += data[i + 2];
    }
    if (!buckets.size) return fallback;

    const ordered = Array.from(buckets.entries()).sort((a, b) => b[1].count - a[1].count);
    const average = (bucket) => ({
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count)
    });
    const luminance = (color) => 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
    const toHex = (color) =>
      '#' + [color.r, color.g, color.b].map((v) => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('');

    const bgColor = average(ordered[0][1]);
    const bgLum = luminance(bgColor);
    let textColor = null;
    let bestCount = 0;
    ordered.forEach(([, bucket]) => {
      const color = average(bucket);
      if (Math.abs(luminance(color) - bgLum) < 48) return;
      if (bucket.count > bestCount) {
        bestCount = bucket.count;
        textColor = color;
      }
    });
    if (textColor === null) {
      let darkest = 999;
      ordered.forEach(([, bucket]) => {
        const color = average(bucket);
        const lum = luminance(color);
        if (lum < darkest) {
          darkest = lum;
          textColor = color;
        }
      });
    }

    return {
      color: textColor === null ? fallback.color : toHex(textColor),
      bg: toHex(bgColor)
    };
  } catch (error) {
    return fallback;
  }
}

function openTextEditor(pageEl, index, item, options = {}) {
  const entry = pageEntries[index];
  const page = state.pages[index];
  if (!entry || !page || !entry.vp) return;
  if (!item && !options.record) return;

  const existing = options.record || page.textEdits.find((edit) => {
    const indices = edit.itemIndices || (edit.itemIndex !== undefined ? [edit.itemIndex] : []);
    return indices.includes(item.index);
  });
  const paragraph = Boolean(options.paragraph || (existing && editLineBoxes(existing).length > 1));
  const editLines = existing
    ? editLineBoxes(existing).map((box) => ({ box, items: [], text: '' }))
    : buildEditLines(page, item, paragraph);
  if (!editLines.length) return;

  const boxes = editLines.map((line) => line.box);
  const originalText = existing ? existing.text : editLines.map((line) => line.text).join('\n');
  const firstBox = boxes[0];
  const lineRects = boxes.map((box) => boxViewportRect(box, entry.vp));
  const rect = unionRect(lineRects);
  const colors = existing ? { color: existing.color, bg: existing.bg } : sampleTextColors(entry, rect);
  const details = existing
    ? { family: existing.family, bold: existing.bold, italic: existing.italic }
    : fontDetails(page, (editLines[0].items && editLines[0].items[0]) || item);
  const scale = entry.vp.scale || state.scale;
  const cssSize = Math.max(9, (firstBox.fontSize || item.fontSize) * scale);

  const wrap = document.createElement('div');
  wrap.className = 'text-editor';
  wrap.style.left = Math.max(0, rect.left - 3) + 'px';
  wrap.style.top = Math.max(0, rect.top - 30) + 'px';
  wrap.style.width = Math.max(220, rect.width + 60) + 'px';

  const tools = document.createElement('div');
  tools.className = 'te-tools';

  if (paragraph) {
    const mode = document.createElement('span');
    mode.className = 'te-mode';
    mode.textContent = 'Párrafo';
    mode.title = 'Editando el párrafo completo';
    tools.appendChild(mode);
  }

  const familySelect = document.createElement('select');
  familySelect.className = 'te-family';
  [['helvetica', 'Helvetica'], ['times', 'Times'], ['courier', 'Courier']].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (value === details.family) option.selected = true;
    familySelect.appendChild(option);
  });

  const boldBtn = document.createElement('button');
  boldBtn.type = 'button';
  boldBtn.className = 'te-btn' + (details.bold ? ' on' : '');
  boldBtn.textContent = 'B';
  boldBtn.title = 'Negrita (con texto seleccionado, solo la selección)';

  const italicBtn = document.createElement('button');
  italicBtn.type = 'button';
  italicBtn.className = 'te-btn' + (details.italic ? ' on' : '');
  italicBtn.innerHTML = '<i>I</i>';
  italicBtn.title = 'Cursiva (con texto seleccionado, solo la selección)';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'te-btn te-del';
  deleteBtn.textContent = 'Borrar texto';
  deleteBtn.title = 'Quitar este texto del documento';

  tools.append(familySelect, boldBtn, italicBtn, deleteBtn);

  // Contenedor editable: permite aplicar negrita o cursiva solo a la selección.
  const input = document.createElement('div');
  input.className = 'te-input';
  input.contentEditable = 'true';
  input.spellcheck = false;

  const baseStyle = { bold: Boolean(details.bold), italic: Boolean(details.italic) };
  const initialRuns = existing
    ? editableRuns(existing)
    : originalText.split('\n').map((line) => (line
      ? [{ text: line, bold: baseStyle.bold, italic: baseStyle.italic }]
      : []));
  if (initialRuns.length !== boxes.length) {
    initialRuns.length = 0;
    originalText.split('\n').forEach((line) => {
      initialRuns.push(line ? [{ text: line, bold: baseStyle.bold, italic: baseStyle.italic }] : []);
    });
  }

  const baseCss = () => {
    input.style.fontFamily = familyCss(familySelect.value);
    input.style.fontWeight = baseStyle.bold ? 'bold' : 'normal';
    input.style.fontStyle = baseStyle.italic ? 'italic' : 'normal';
    input.style.fontSize = cssSize + 'px';
    input.style.color = colors.color;
    input.style.background = colors.bg;
    input.style.minHeight = Math.max(26, rect.height + 6) + 'px';
  };

  // Pinta los tramos respetando los saltos de línea del texto original.
  const renderRuns = (lines) => {
    input.textContent = '';
    lines.forEach((runs, lineIndex) => {
      if (lineIndex > 0) input.appendChild(document.createElement('br'));
      runs.forEach((run) => {
        const runBold = run.bold !== baseStyle.bold;
        const runItalic = run.italic !== baseStyle.italic;
        if (!runBold && !runItalic) {
          input.appendChild(document.createTextNode(run.text));
          return;
        }
        const span = document.createElement('span');
        if (runBold) span.style.fontWeight = run.bold ? 'bold' : 'normal';
        if (runItalic) span.style.fontStyle = run.italic ? 'italic' : 'normal';
        span.textContent = run.text;
        input.appendChild(span);
      });
    });
  };

  renderRuns(initialRuns);
  baseCss();

  const styleOfElement = (element) => {
    const computed = window.getComputedStyle(element);
    const weight = Number(computed.fontWeight);
    return {
      bold: computed.fontWeight === 'bold' || (Number.isFinite(weight) && weight >= 600),
      italic: computed.fontStyle === 'italic' || computed.fontStyle === 'oblique'
    };
  };

  // Reconstruye los tramos desde el DOM editable.
  const readRuns = () => {
    const lines = [[]];
    const pushText = (value, style) => {
      const parts = String(value).split('\n');
      parts.forEach((part, index) => {
        if (index > 0) lines.push([]);
        if (!part) return;
        const current = lines[lines.length - 1];
        const last = current[current.length - 1];
        if (last && last.bold === style.bold && last.italic === style.italic) last.text += part;
        else current.push({ text: part, bold: style.bold, italic: style.italic });
      });
    };
    const walk = (node, style, isRoot) => {
      if (node.nodeType === Node.TEXT_NODE) {
        pushText(node.nodeValue || '', style);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'BR') {
        lines.push([]);
        return;
      }
      const next = styleOfElement(node);
      const block = /^(DIV|P|LI)$/.test(node.tagName);
      if (block && !isRoot && lines[lines.length - 1].length) lines.push([]);
      node.childNodes.forEach((child) => walk(child, next, false));
    };
    walk(input, styleOfElement(input), true);
    return lines.map((line) => line.filter((run) => run.text));
  };

  const hasSelection = () => {
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.rangeCount
      && input.contains(selection.anchorNode));
  };

  const syncButtons = () => {
    const selected = hasSelection();
    const bold = selected ? document.queryCommandState('bold') : baseStyle.bold;
    const italic = selected ? document.queryCommandState('italic') : baseStyle.italic;
    boldBtn.classList.toggle('on', bold);
    italicBtn.classList.toggle('on', italic);
  };

  const toggleStyle = (command) => {
    if (hasSelection()) {
      document.execCommand(command);
    } else {
      // Sin selección: se aplica a toda la línea, como antes.
      const lines = readRuns();
      const bold = command === 'bold' ? !baseStyle.bold : baseStyle.bold;
      const italic = command === 'italic' ? !baseStyle.italic : baseStyle.italic;
      baseStyle.bold = bold;
      baseStyle.italic = italic;
      renderRuns(lines.map((line) => line.map((run) => ({ text: run.text, bold, italic }))));
      baseCss();
    }
    syncButtons();
  };

  // Los botones no deben cerrar el editor al pulsarlos.
  tools.addEventListener('mousedown', (event) => event.preventDefault());
  familySelect.addEventListener('change', baseCss);
  boldBtn.addEventListener('click', () => toggleStyle('bold'));
  italicBtn.addEventListener('click', () => toggleStyle('italic'));
  input.addEventListener('keyup', syncButtons);
  input.addEventListener('mouseup', syncButtons);
  document.addEventListener('selectionchange', syncButtons);

  wrap.append(tools, input);
  pageEl.appendChild(wrap);
  try {
    document.execCommand('styleWithCSS', false, false);
  } catch (error) {
    /* opcional */
  }
  input.focus();
  const range = document.createRange();
  range.selectNodeContents(input);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  syncButtons();

  let done = false;
  const finish = (remove) => {
    if (done) return;
    done = true;
    document.removeEventListener('selectionchange', syncButtons);
    const runs = remove ? [] : readRuns();
    const text = remove ? '' : runs.map((line) => lineRunsText(line)).join('\n');
    wrap.remove();
    const sameRuns = !remove && JSON.stringify(runs) === JSON.stringify(initialRuns);
    if (!remove && text === originalText && sameRuns) {
      renderTextEditList();
      return;
    }

    // Volvemos a muestrear: la página puede haberse redibujado mientras el
    // editor estaba abierto y el color de fondo habría cambiado.
    let finalColors = colors;
    try {
      const fresh = sampleTextColors(entry, unionRect(boxes.map((box) => boxViewportRect(box, entry.vp))));
      const isFallback = fresh.bg === '#ffffff' && fresh.color === '#111111';
      if (!isFallback || colors.bg === '#ffffff') finalColors = fresh;
    } catch (error) {
      /* conservamos los colores iniciales */
    }

    pushUndo();
    applyTextEdit(index, item, {
      text,
      runs,
      family: familySelect.value,
      bold: baseStyle.bold,
      italic: baseStyle.italic,
      color: finalColors.color,
      bg: finalColors.bg,
      originalStyle: existing ? (existing.originalStyle || details) : details
    }, {
      id: existing ? existing.id : null,
      paragraph,
      lines: editLines.map((line) => line.box),
      itemIndices: existing
        ? (existing.itemIndices || [])
        : editLines.flatMap((line) => line.items.map((entryItem) => entryItem.index))
    });
    redrawPage(index);
    renderAnnList();
    renderTextEditList();
    markDirty();
  };

  deleteBtn.addEventListener('click', () => finish(true));
  input.addEventListener('blur', () => setTimeout(() => finish(false), 120));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      done = true;
      document.removeEventListener('selectionchange', syncButtons);
      wrap.remove();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      finish(false);
    }
  });
}

function applyTextEdit(index, item, values, options = {}) {
  const page = state.pages[index];
  if (!page) return;
  let lines = options.lines;
  let itemIndices = options.itemIndices;
  let original = values.original || '';
  if (!lines || !lines.length) {
    const built = buildEditLines(page, item, Boolean(options.paragraph));
    lines = built.map((entry) => entry.box);
    itemIndices = built.flatMap((entry) => entry.items.map((other) => other.index));
    original = built.map((entry) => entry.text).join('\n');
  }
  if (!lines.length) return;

  const first = lines[0];
  const record = {
    id: uid(),
    itemIndices: Array.from(new Set(itemIndices || [])),
    original,
    lines: lines.map((line) => ({ ...line })),
    x: first.x,
    y: first.y,
    width: first.width,
    fontSize: first.fontSize,
    ascent: first.ascent,
    descent: first.descent,
    ux: first.ux ?? 1,
    uy: first.uy ?? 0,
    vertical: Boolean(first.vertical),
    angle: first.angle ?? 0,
    text: values.text,
    family: values.family,
    bold: values.bold,
    italic: values.italic,
    color: values.color,
    bg: values.bg,
    runs: Array.isArray(values.runs)
      ? values.runs.map((line) => (Array.isArray(line)
        ? line.map((run) => ({ text: String(run.text || ''), bold: Boolean(run.bold), italic: Boolean(run.italic) }))
        : []))
      : null,
    originalStyle: values.originalStyle || null
  };

  const at = page.textEdits.findIndex((edit) => {
    if (options.id && edit.id === options.id) return true;
    const indices = edit.itemIndices || (edit.itemIndex !== undefined ? [edit.itemIndex] : []);
    return indices.some((indexValue) => record.itemIndices.includes(indexValue));
  });
  if (at >= 0) {
    const previous = page.textEdits[at];
    record.id = previous.id;
    if (previous.ocr) {
      record.ocr = true;
      record.ocrPdfBox = previous.ocrPdfBox;
    }
    page.textEdits[at] = record;
  } else {
    page.textEdits.push(record);
  }
  const what = lines.length > 1 ? tr('Párrafo') : tr('Texto');
  if (!options.silent) {
    toast(values.text ? tr('{what} modificado. Guarda una copia para aplicarlo.', { what }) : tr('Texto eliminado.'), 3600);
  }
}

function drawTextEdits(group, page, viewport) {
  if (!page.textEdits || !page.textEdits.length) return;
  page.textEdits.forEach((edit) => {
    const lines = editLineBoxes(edit);
    const pad = Math.max(0.7, (lines[0].fontSize || 10) * 0.08);

    // En la vista previa siempre se cubre el texto original: el lienzo de
    // pdf.js lo sigue mostrando aunque la exportación lo elimine de verdad.
    // Las líneas OCR ya se han borrado del propio lienzo.
    if (!edit.ocr) {
      lines.forEach((line) => {
        const box = {
          ...line,
          x: line.x - (line.ux ?? 1) * pad,
          y: line.y - (line.uy ?? 0) * pad,
          width: line.width + pad * 2,
          ascent: (line.ascent ?? 0.82) + pad / (line.fontSize || 10),
          descent: (line.descent ?? -0.22) - pad / (line.fontSize || 10)
        };
        const points = orientedCorners(box).map(([x, y]) => `${x},${y}`).join(' ');
        const cover = document.createElementNS(NS, 'polygon');
        cover.setAttribute('points', points);
        cover.setAttribute('fill', edit.bg || '#ffffff');
        cover.setAttribute('data-textedit', edit.id);
        group.appendChild(cover);
      });
    }

    if (!edit.text) return;

    const output = editableRuns(edit);
    const lastLine = lines[lines.length - 1];
    const lineHeight = (lastLine.fontSize || 10) * 1.25;
    const normalX = -(lastLine.uy ?? 0);
    const normalY = lastLine.ux ?? 1;

    output.forEach((runs, index) => {
      let box;
      if (index < lines.length) {
        box = lines[index];
      } else {
        box = {
          x: lastLine.x - normalX * (index - lines.length + 1) * lineHeight,
          y: lastLine.y - normalY * (index - lines.length + 1) * lineHeight,
          width: lastLine.width,
          fontSize: lastLine.fontSize,
          ascent: lastLine.ascent,
          descent: lastLine.descent,
          ux: lastLine.ux ?? 1,
          uy: lastLine.uy ?? 0
        };
      }
      if (!runs.length) return;
      const lineText = lineRunsText(runs);
      const size = fitTextSize(
        (value, at) => measureTextWidth(value, edit.family, edit.bold, edit.italic, at),
        lineText,
        box.width,
        box.fontSize
      );

      const text = document.createElementNS(NS, 'text');
      const angle = (Math.atan2(box.uy ?? 0, box.ux ?? 1) * 180) / Math.PI;
      text.setAttribute('transform', `translate(${box.x} ${box.y}) rotate(${angle}) scale(1 -1)`);
      text.setAttribute('x', '0');
      text.setAttribute('y', '0');
      text.setAttribute('font-family', familyCss(edit.family));
      text.setAttribute('font-size', String(size));
      text.setAttribute('font-weight', edit.bold ? 'bold' : 'normal');
      text.setAttribute('font-style', edit.italic ? 'italic' : 'normal');
      text.setAttribute('fill', edit.color || '#111111');
      text.setAttribute('data-textedit', edit.id);
      text.setAttribute('xml:space', 'preserve');
      runs.forEach((run) => {
        const tspan = document.createElementNS(NS, 'tspan');
        tspan.setAttribute('font-weight', run.bold ? 'bold' : 'normal');
        tspan.setAttribute('font-style', run.italic ? 'italic' : 'normal');
        tspan.textContent = run.text;
        text.appendChild(tspan);
      });
      group.appendChild(text);
    });
  });
}

function renderTextEditList() {
  const list = $('#textEditList');
  if (!list) return;
  const page = currentPage();
  list.innerHTML = '';
  if (!page || !page.textEdits.length) {
    list.innerHTML = '<p class="muted small-text">Sin cambios de texto en esta página.</p>';
    return;
  }
  page.textEdits.forEach((edit) => {
    const item = document.createElement('div');
    item.className = 'ann-item';

    const swatch = document.createElement('span');
    swatch.className = 'ann-swatch';
    swatch.style.background = edit.color || '#111111';

    const label = document.createElement('span');
    label.className = 'ann-label';
    label.textContent = edit.text
      ? edit.text.replace(/\n/g, ' ').slice(0, 32)
      : '(texto eliminado)';

    const revert = document.createElement('button');
    revert.className = 'ann-del';
    revert.innerHTML = ICONS.undo;
    revert.title = 'Restaurar el texto original';
    revert.addEventListener('click', (event) => {
      event.stopPropagation();
      revertTextEdit(state.current, edit.id);
    });

    item.append(swatch, label, revert);
    item.addEventListener('click', () => {
      const entry = pageEntries[state.current];
      if (!entry) return;
      const firstIndex = edit.itemIndices && edit.itemIndices.length
        ? edit.itemIndices[0]
        : edit.itemIndex;
      const original = firstIndex !== undefined
        ? page.textItems.find((entryItem) => entryItem.index === firstIndex)
        : null;
      if (original) {
        openTextEditor(entry.el, state.current, original);
      } else {
        openTextEditor(entry.el, state.current, null, { record: edit });
      }
    });
    list.appendChild(item);
  });
}

function revertTextEdit(index, id) {
  const page = state.pages[index];
  if (!page) return;
  const at = page.textEdits.findIndex((edit) => edit.id === id);
  if (at < 0) return;
  const wasOcr = Boolean(page.textEdits[at].ocr);
  pushUndo();
  page.textEdits.splice(at, 1);
  if (wasOcr) {
    renderPage(index).catch((error) => console.warn('No se pudo refrescar la página OCR', error));
  } else {
    redrawPage(index);
  }
  renderTextEditList();
  markDirty();
  toast('Texto original restaurado');
}

/* ------------------- Eliminación real del texto original ---------------- */

const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

function translateMatrix(matrix, x, y) {
  const result = matrix.slice();
  result[4] = matrix[0] * x + matrix[2] * y + matrix[4];
  result[5] = matrix[1] * x + matrix[3] * y + matrix[5];
  return result;
}

function matrixPoint(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]
  ];
}

function bytesToLatin1(bytes) {
  let text = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return text;
}

function latin1ToBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/* ------------------- Reutilización de la fuente original ---------------- */

// Nombres de glifo que aparecen en /Differences. Las letras acentuadas se
// generan combinando la letra base con el signo diacrítico.
const GLYPH_UNICODE = (() => {
  const map = {
    space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$',
    percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(',
    parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
    period: '.', slash: '/', colon: ':', semicolon: ';', less: '<',
    equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
    backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
    grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9',
    quoteleft: '\u2018', quoteright: '\u2019', quotedblleft: '\u201C',
    quotedblright: '\u201D', quotesinglbase: '\u201A', quotedblbase: '\u201E',
    guillemotleft: '\u00AB', guillemotright: '\u00BB',
    guilsinglleft: '\u2039', guilsinglright: '\u203A',
    endash: '\u2013', emdash: '\u2014', bullet: '\u2022',
    ellipsis: '\u2026', dagger: '\u2020', daggerdbl: '\u2021',
    trademark: '\u2122', copyright: '\u00A9', registered: '\u00AE',
    degree: '\u00B0', section: '\u00A7', paragraph: '\u00B6',
    periodcentered: '\u00B7', exclamdown: '\u00A1', questiondown: '\u00BF',
    cent: '\u00A2', sterling: '\u00A3', yen: '\u00A5', Euro: '\u20AC',
    florin: '\u0192', fraction: '\u2044', perthousand: '\u2030',
    minus: '\u2212', multiply: '\u00D7', divide: '\u00F7', plusminus: '\u00B1',
    mu: '\u00B5', nbspace: '\u00A0', logicalnot: '\u00AC', brokenbar: '\u00A6',
    AE: '\u00C6', ae: '\u00E6', OE: '\u0152', oe: '\u0153',
    Oslash: '\u00D8', oslash: '\u00F8', germandbls: '\u00DF',
    dotlessi: '\u0131', Lslash: '\u0141', lslash: '\u0142',
    fi: '\uFB01', fl: '\uFB02', ff: '\uFB00', ffi: '\uFB03', ffl: '\uFB04',
    ordfeminine: '\u00AA', ordmasculine: '\u00BA',
    notequal: '\u2260', lessequal: '\u2264', greaterequal: '\u2265',
    infinity: '\u221E', summation: '\u2211', product: '\u220F',
    radical: '\u221A', integral: '\u222B', approxequal: '\u2248'
  };
  for (let i = 0; i < 26; i += 1) {
    map[String.fromCharCode(65 + i)] = String.fromCharCode(65 + i);
    map[String.fromCharCode(97 + i)] = String.fromCharCode(97 + i);
  }
  const marks = {
    acute: '\u0301', grave: '\u0300', circumflex: '\u0302', tilde: '\u0303',
    dieresis: '\u0308', ring: '\u030A', cedilla: '\u0327', caron: '\u030C',
    breve: '\u0306', macron: '\u0304', ogonek: '\u0328',
    dotaccent: '\u0307', hungarumlaut: '\u030B'
  };
  const bases = 'AEIOUYCLNRSTZaeiouyclnrstzg';
  Object.keys(marks).forEach((mark) => {
    for (const base of bases) {
      const composed = (base + marks[mark]).normalize('NFC');
      if (composed.length === 1 && !map[base + mark]) map[base + mark] = composed;
    }
  });
  return map;
})();

const SINGLE_BYTE_ENCODINGS = {
  WinAnsiEncoding: 'windows-1252',
  MacRomanEncoding: 'macintosh'
};

// Devuelve un mapa carácter -> código para las codificaciones simples.
function singleByteEncodingMap(name) {
  const map = new Map();
  if (!name) {
    // StandardEncoding: ASCII imprimible con las dos comillas tipográficas.
    for (let code = 0x20; code <= 0x7e; code += 1) {
      map.set(String.fromCharCode(code), code);
    }
    map.delete("'");
    map.delete('`');
    map.set('\u2019', 0x27);
    map.set('\u2018', 0x60);
    return map;
  }
  const label = SINGLE_BYTE_ENCODINGS[name];
  if (!label) return null;
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch (error) {
    return null;
  }
  for (let code = 0x20; code <= 0xff; code += 1) {
    let char;
    try {
      char = decoder.decode(new Uint8Array([code]));
    } catch (error) {
      continue;
    }
    if (!char || char.length !== 1) continue;
    const value = char.charCodeAt(0);
    if (value < 0x20 || (value >= 0x7f && value < 0xa0)) continue;
    if (!map.has(char)) map.set(char, code);
  }
  return map;
}

function hexToPdfString(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  if (hex.length % 4 === 2) {
    out += String.fromCharCode(parseInt(hex.slice(-2), 16));
  }
  return out;
}

// Interpreta los bloques bfchar/bfrange de un CMap ToUnicode.
function parseToUnicodeCmap(text) {
  const map = new Map();
  if (!text) return map;
  let match;
  const charBlocks = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((match = charBlocks.exec(text))) {
    const pairs = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let pair;
    while ((pair = pairs.exec(match[1]))) {
      map.set(parseInt(pair[1], 16), hexToPdfString(pair[2]));
    }
  }
  const rangeBlocks = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = rangeBlocks.exec(text))) {
    const ranges = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let range;
    while ((range = ranges.exec(match[1]))) {
      const low = parseInt(range[1], 16);
      const high = parseInt(range[2], 16);
      if (high < low || high - low > 0xffff) continue;
      if (range[3]) {
        const base = range[3];
        const prefix = hexToPdfString(base.slice(0, Math.max(0, base.length - 4)));
        const start = base.length >= 4 ? parseInt(base.slice(-4), 16) : 0;
        for (let code = low; code <= high; code += 1) {
          map.set(code, prefix + String.fromCharCode(start + (code - low)));
        }
      } else if (range[4]) {
        const items = range[4].match(/<([0-9A-Fa-f]+)>/g) || [];
        items.forEach((raw, index) => {
          const code = low + index;
          if (code <= high) map.set(code, hexToPdfString(raw.slice(1, -1)));
        });
      }
    }
  }
  return map;
}

function pdfDictionaryOf(doc, value) {
  if (!value) return null;
  const object = doc.context.lookup(value);
  return object && typeof object.get === 'function' ? object : null;
}

function pdfNameValue(doc, value) {
  if (!value) return '';
  const object = doc.context.lookup(value);
  if (object && typeof object.asString === 'function') {
    return String(object.asString()).replace(/^\//, '');
  }
  return String(object || '').replace(/^\//, '');
}

function pdfNumberValue(doc, value, fallback) {
  if (value === undefined || value === null) return fallback;
  const object = doc.context.lookup(value);
  if (object && typeof object.asNumber === 'function') {
    const number = object.asNumber();
    return Number.isFinite(number) ? number : fallback;
  }
  return fallback;
}

function readCidWidths(doc, descendant) {
  const widths = new Map();
  const defaultWidth = pdfNumberValue(doc, descendant.get(PDFName.of('DW')), 1000);
  const array = doc.context.lookup(descendant.get(PDFName.of('W')));
  if (!(array instanceof PDFArray)) return { widths, defaultWidth, listed: false };
  let index = 0;
  while (index < array.size()) {
    const first = pdfNumberValue(doc, array.get(index), null);
    if (first === null) {
      index += 1;
      continue;
    }
    const next = doc.context.lookup(array.get(index + 1));
    if (next instanceof PDFArray) {
      for (let i = 0; i < next.size(); i += 1) {
        widths.set(first + i, pdfNumberValue(doc, next.get(i), defaultWidth));
      }
      index += 2;
    } else {
      const last = pdfNumberValue(doc, array.get(index + 1), first);
      const width = pdfNumberValue(doc, array.get(index + 2), defaultWidth);
      for (let cid = first; cid <= last && cid - first < 0xffff; cid += 1) {
        widths.set(cid, width);
      }
      index += 3;
    }
  }
  return { widths, defaultWidth, listed: true };
}

function readSimpleWidths(doc, font) {
  const array = doc.context.lookup(font.get(PDFName.of('Widths')));
  if (!(array instanceof PDFArray)) return null;
  const first = pdfNumberValue(doc, font.get(PDFName.of('FirstChar')), 0);
  const widths = new Map();
  for (let i = 0; i < array.size(); i += 1) {
    widths.set(first + i, pdfNumberValue(doc, array.get(i), 0));
  }
  return widths;
}

// Tablas de un TrueType/OpenType incrustado.
function readTrueTypeTables(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > bytes.length) break;
    tables.set(view.getUint32(record), {
      offset: view.getUint32(record + 8),
      length: view.getUint32(record + 12)
    });
  }
  return { view, tables, length: bytes.length };
}

// Un subconjunto puede conservar el recuento de glifos pero dejar vacíos los
// que no usa; la longitud en 'loca'/'glyf' indica si el contorno existe.
function readTrueTypeGlyphTable(bytes) {
  if (!bytes || bytes.length < 12) return null;
  try {
    const { view, tables, length } = readTrueTypeTables(bytes);
    const maxp = tables.get(0x6d617870);
    const head = tables.get(0x68656164);
    const loca = tables.get(0x6c6f6361);
    const glyf = tables.get(0x676c7966);
    if (!maxp || !head || !loca || !glyf) return null;
    const numGlyphs = view.getUint16(maxp.offset + 4);
    const longFormat = view.getInt16(head.offset + 50) === 1;
    const step = longFormat ? 4 : 2;
    const offsetOf = (gid) => {
      const at = loca.offset + gid * step;
      if (at + step > length) return -1;
      return longFormat ? view.getUint32(at) : view.getUint16(at) * 2;
    };
    return {
      numGlyphs,
      empty(gid) {
        if (!Number.isFinite(gid) || gid < 0 || gid >= numGlyphs) return true;
        const start = offsetOf(gid);
        const end = offsetOf(gid + 1);
        if (start < 0 || end < 0) return true;
        return end <= start;
      }
    };
  } catch (error) {
    return null;
  }
}

// Algunos PDF traen un ToUnicode que cubre toda la fuente aunque el programa
// incrustado solo contenga los glifos usados. Sin esta comprobación se
// escribirían códigos que se renderizan en blanco.
function createCidGlyphChecker(doc, descendant) {
  try {
    if (pdfNameValue(doc, descendant.get(PDFName.of('Subtype'))) !== 'CIDFontType2') return null;
    const descriptor = pdfDictionaryOf(doc, descendant.get(PDFName.of('FontDescriptor')));
    if (!descriptor) return null;
    const file = doc.context.lookup(descriptor.get(PDFName.of('FontFile2')));
    if (!file) return null;
    const glyphs = readTrueTypeGlyphTable(decodePDFRawStream(file).decode());
    if (!glyphs) return null;

    const map = doc.context.lookup(descendant.get(PDFName.of('CIDToGIDMap')));
    let gidOf = (cid) => cid;
    if (map instanceof PDFRawStream) {
      const table = decodePDFRawStream(map).decode();
      gidOf = (cid) => {
        const offset = cid * 2;
        return offset + 1 < table.length ? (table[offset] << 8) | table[offset + 1] : 0;
      };
    }
    return (cid, char) => {
      const gid = gidOf(cid);
      if (gid <= 0 || gid >= glyphs.numGlyphs) return false;
      // Espacios y caracteres sin contorno por naturaleza.
      if (/^\s$/.test(char)) return true;
      return !glyphs.empty(gid);
    };
  } catch (error) {
    return null;
  }
}

function makeWidthEstimator(baseName) {
  const family = detectFamily(baseName, baseName);
  const bold = /bold|black|heavy|semibold/i.test(baseName);
  const italic = /italic|oblique/i.test(baseName);
  return (text) => measureTextWidth(text, family, bold, italic, 1000);
}

// Raíz del nombre de familia, sin subconjunto ni modificadores de estilo:
// "ABCDEE+Arial-BoldMT" y "ArialMT" comparten raíz.
function fontFamilyRoot(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^[a-z]{6}\+/, '')
    .replace(/italic|oblique|bold|black|heavy|semibold|demibold|regular|roman|book|medium|light|narrow|condensed|psmt|std|mt|ps/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const SIBLING_FONTS = new WeakMap();

// Busca en la misma página una fuente de la misma familia con el estilo pedido
// (por ejemplo Arial-BoldMT junto a ArialMT) para escribir un tramo en negrita
// conservando la tipografía del documento.
function findSiblingFont(doc, resources, originalName, style) {
  if (!resources || !originalName) return null;
  let cache = SIBLING_FONTS.get(resources);
  if (!cache) {
    cache = new Map();
    SIBLING_FONTS.set(resources, cache);
  }
  const key = `${originalName}|${style.bold ? 1 : 0}|${style.italic ? 1 : 0}`;
  if (cache.has(key)) return cache.get(key);

  let found = null;
  try {
    const fonts = pdfDictionaryOf(doc, resources.get(PDFName.of('Font')));
    const original = fonts ? pdfDictionaryOf(doc, fonts.get(PDFName.of(originalName))) : null;
    const root = original
      ? fontFamilyRoot(pdfNameValue(doc, original.get(PDFName.of('BaseFont'))))
      : '';
    if (fonts && root) {
      for (const [key2] of fonts.entries()) {
        const name = key2.toString().replace(/^\//, '');
        const font = pdfDictionaryOf(doc, fonts.get(key2));
        if (!font) continue;
        const base = pdfNameValue(doc, font.get(PDFName.of('BaseFont')));
        if (fontFamilyRoot(base) !== root) continue;
        const bold = BOLD_NAME.test(base);
        const italic = ITALIC_NAME.test(base);
        if (bold !== Boolean(style.bold) || italic !== Boolean(style.italic)) continue;
        if (name === originalName) {
          found = name;
          break;
        }
        if (!found) found = name;
      }
    }
  } catch (error) {
    found = null;
  }
  cache.set(key, found);
  return found;
}

// Crea (y memoiza) un codificador que traduce texto Unicode a los códigos que
// entiende la fuente original del PDF. La caché va por diccionario de fuente,
// que pdf-lib reutiliza entre páginas.
const FONT_ENCODERS = new WeakMap();

function textEncoderFor(doc, resources, fontName) {
  if (!resources || !fontName || typeof resources.get !== 'function') return null;
  const fonts = pdfDictionaryOf(doc, resources.get(PDFName.of('Font')));
  if (!fonts) return null;
  const font = pdfDictionaryOf(doc, fonts.get(PDFName.of(fontName)));
  if (!font) return null;
  if (FONT_ENCODERS.has(font)) return FONT_ENCODERS.get(font);

  let encoder = null;
  try {
    encoder = buildTextEncoder(doc, font);
  } catch (error) {
    encoder = null;
  }
  FONT_ENCODERS.set(font, encoder);
  return encoder;
}

function buildTextEncoder(doc, font) {
  let forward = new Map();
  const toUnicode = font.get(PDFName.of('ToUnicode'));
  if (toUnicode) {
    const stream = doc.context.lookup(toUnicode);
    if (stream) {
      try {
        forward = parseToUnicodeCmap(bytesToLatin1(decodePDFRawStream(stream).decode()));
      } catch (error) {
        forward = new Map();
      }
    }
  }

  const subtype = pdfNameValue(doc, font.get(PDFName.of('Subtype')));
  const baseName = pdfNameValue(doc, font.get(PDFName.of('BaseFont')));
  const estimate = makeWidthEstimator(baseName);

  if (subtype === 'Type0') {
    const descendants = doc.context.lookup(font.get(PDFName.of('DescendantFonts')));
    const descendant = descendants instanceof PDFArray
      ? pdfDictionaryOf(doc, descendants.get(0))
      : null;
    if (!descendant) return null;
    const { widths, defaultWidth, listed } = readCidWidths(doc, descendant);
    const encoding = pdfNameValue(doc, font.get(PDFName.of('Encoding')));
    const direct = /UCS2|UTF16/i.test(encoding);
    const hasGlyph = createCidGlyphChecker(doc, descendant);
    const reverse = new Map();
    forward.forEach((text, code) => {
      if (text.length !== 1) return;
      if (listed && !widths.has(code)) return;
      if (hasGlyph && !hasGlyph(code, text)) return;
      if (!reverse.has(text)) reverse.set(text, code);
    });
    if (!reverse.size && !direct) return null;
    return {
      composite: true,
      direct,
      reverse,
      widthOfCode: (code) => (widths.has(code) ? widths.get(code) : defaultWidth),
      measurable: direct || reverse.size > 0,
      estimate
    };
  }

  const encodingValue = font.get(PDFName.of('Encoding'));
  const encodingDict = pdfDictionaryOf(doc, encodingValue);
  let baseEncoding = '';
  let differences = null;
  if (encodingDict) {
    baseEncoding = pdfNameValue(doc, encodingDict.get(PDFName.of('BaseEncoding')));
    differences = doc.context.lookup(encodingDict.get(PDFName.of('Differences')));
  } else {
    baseEncoding = pdfNameValue(doc, encodingValue);
  }
  // Las fuentes Type3 no tienen /Encoding fiable para reconstruir texto: solo
  // se reescriben cuando el PDF incluye un ToUnicode que las identifique.
  const type3 = subtype === 'Type3';
  let map = type3 ? null : singleByteEncodingMap(baseEncoding || '');
  if (!type3 && !map) return null;

  if (!type3 && differences instanceof PDFArray) {
    let code = 0;
    for (let i = 0; i < differences.size(); i += 1) {
      const item = doc.context.lookup(differences.get(i));
      if (item instanceof PDFNumber) {
        code = item.asNumber();
        continue;
      }
      if (!item || typeof item.asString !== 'function') continue;
      // Un código con /Differences deja de usar el glifo de la codificación base.
      map.forEach((value, char) => {
        if (value === code) map.delete(char);
      });
      const glyph = String(item.asString()).replace(/^\//, '');
      const unicode = GLYPH_UNICODE[glyph];
      if (unicode && code >= 0 && code <= 0xff) map.set(unicode, code);
      code += 1;
    }
  }

  const widths = readSimpleWidths(doc, font);
  const widthScale = type3 ? type3WidthScale(doc, font) : 1;
  const reverse = new Map();
  if (forward.size) {
    forward.forEach((text, code) => {
      if (text.length !== 1 || code > 0xff) return;
      if (widths && widths.has(code) && !(widths.get(code) > 0)) return;
      if (!reverse.has(text)) reverse.set(text, code);
    });
  } else if (map) {
    map.forEach((code, char) => {
      if (!widths || !widths.has(code) || widths.get(code) > 0) reverse.set(char, code);
    });
  }
  if (!reverse.size) return null;
  return {
    composite: false,
    direct: false,
    reverse,
    widthOfCode: (code) => {
      if (!widths || !widths.has(code)) return null;
      return widths.get(code) * widthScale;
    },
    measurable: Boolean(widths),
    estimate
  };
}

// Los avances de las fuentes Type3 están en el espacio de glifo definido por
// /FontMatrix; lo normal es 0.001, igual que el resto de fuentes.
function type3WidthScale(doc, font) {
  const matrix = doc.context.lookup(font.get(PDFName.of('FontMatrix')));
  if (!(matrix instanceof PDFArray) || matrix.size() < 1) return 1;
  const value = pdfNumberValue(doc, matrix.get(0), 0.001);
  return value > 0 ? value * 1000 : 1;
}

// Equivalentes habituales cuando la fuente no tiene el carácter exacto.
const CHARACTER_FALLBACKS = {
  ' ': ['\u00A0'],
  '\u00A0': [' '],
  '\u2018': ["'", '\u2019'],
  '\u2019': ["'", '\u2018'],
  '\u201A': [','],
  '\u201C': ['"', '\u201D'],
  '\u201D': ['"', '\u201C'],
  '\u201E': ['"'],
  '\u2013': ['-', '\u2014'],
  '\u2014': ['-', '\u2013'],
  '\u2212': ['-'],
  '\u2026': ['...'],
  '\u00AD': ['']
};

function resolveCharacters(encoder, text) {
  const resolved = [];
  for (const char of String(text)) {
    if (encoder.direct || encoder.reverse.has(char)) {
      resolved.push(char);
      continue;
    }
    const alternatives = CHARACTER_FALLBACKS[char];
    if (!alternatives) return null;
    let picked = null;
    for (const alternative of alternatives) {
      const chars = Array.from(alternative);
      if (chars.every((value) => encoder.direct || encoder.reverse.has(value))) {
        picked = chars;
        break;
      }
    }
    if (!picked) return null;
    picked.forEach((value) => resolved.push(value));
  }
  return resolved;
}

// Texto Unicode -> cadena hexadecimal PDF en la codificación de la fuente.
function encodeWithFont(encoder, text) {
  const characters = resolveCharacters(encoder, text);
  if (!characters) return null;
  let hex = '';
  let units = 0;
  let measurable = encoder.measurable;
  for (const char of characters) {
    const code = encoder.direct ? char.codePointAt(0) : encoder.reverse.get(char);
    if (code === undefined || code === null) return null;
    if (encoder.composite) {
      if (code > 0xffff) return null;
      hex += code.toString(16).padStart(4, '0');
    } else {
      if (code > 0xff) return null;
      hex += code.toString(16).padStart(2, '0');
    }
    const width = encoder.widthOfCode(code);
    if (measurable) {
      if (width === null || width === undefined) measurable = false;
      else units += width;
    }
  }
  return { hex: hex.toUpperCase(), units: measurable ? units : null };
}

function collectReplacements(node, out) {
  if (!node) return;
  node.replacements.forEach((replacement) => {
    if (!replacement.editId) return;
    if (!out.has(replacement.editId)) out.set(replacement.editId, []);
    out.get(replacement.editId).push(replacement);
  });
  node.forms.forEach((form) => collectReplacements(form.node, out));
}

function editKeepsOriginalStyle(edit) {
  const original = edit && edit.originalStyle;
  if (!original) return true;
  if (edit.family !== original.family) return false;
  if (Boolean(edit.bold) !== Boolean(original.bold)) return false;
  if (Boolean(edit.italic) !== Boolean(original.italic)) return false;
  return true;
}

// Intenta escribir el texto nuevo reutilizando los operadores y la fuente que
// ya existían en la página. Devuelve el conjunto de líneas resueltas así.
function prepareNativeReplacements(doc, root, edits, analysis, complete) {
  const native = new Map();
  if (!doc || !root || !edits.length) return native;
  const byEdit = new Map();
  collectReplacements(root, byEdit);

  edits.forEach((edit) => {
    if (!complete.has(edit.id)) return;
    if (edit.ocr || !edit.text) return;
    if (!editKeepsOriginalStyle(edit)) return;
    const boxes = editLineBoxes(edit);
    const runsPerLine = editableRuns(edit);
    if (!boxes.length || runsPerLine.length !== boxes.length) return;

    const replacements = byEdit.get(edit.id) || [];
    if (!replacements.length) return;
    // Varios operadores pueden dibujar la misma línea: el texto nuevo va al primero.
    const first = new Map();
    replacements.forEach((replacement) => {
      if (!first.has(replacement.lineIndex)) first.set(replacement.lineIndex, replacement);
    });
    if (first.size !== boxes.length) return;

    const plan = [];
    for (let index = 0; index < boxes.length; index += 1) {
      const replacement = first.get(index);
      const runs = runsPerLine[index] || [];
      if (!runs.length) {
        plan.push({ replacement, runs: [], units: 0 });
        continue;
      }
      // Los operadores ' y " mueven la línea antes de mostrar el texto: con
      // varios tramos habría que reescribir demasiado, así que se dibuja aparte.
      if (runs.length > 1 && (replacement.operator === "'" || replacement.operator === '"')) return;

      const encodedRuns = [];
      let units = 0;
      let measurable = true;
      for (const run of runs) {
        if (!run.text) continue;
        const fontName = findSiblingFont(doc, replacement.resources, replacement.fontName, run);
        if (!fontName) return;
        const encoder = textEncoderFor(doc, replacement.resources, fontName);
        const encoded = encoder ? encodeWithFont(encoder, run.text) : null;
        if (!encoded) return;
        const runUnits = encoded.units !== null
          ? encoded.units
          : (encoder.estimate ? encoder.estimate(run.text) : null);
        if (runUnits === null || runUnits === undefined) measurable = false;
        else units += runUnits;
        encodedRuns.push({ hex: encoded.hex, fontName });
      }
      if (!encodedRuns.length) {
        plan.push({ replacement, runs: [], units: 0 });
        continue;
      }
      plan.push({
        replacement,
        runs: encodedRuns,
        units: measurable ? units : null
      });
    }

    // Ajuste horizontal por línea para no invadir el texto vecino.
    let tooLong = false;
    plan.forEach((item) => {
      item.tz = null;
      const { replacement, units } = item;
      if (units === null || units === undefined || !replacement.targetWidth || !replacement.fontSize) return;
      const natural = (units / 1000) * replacement.fontSize * replacement.matrixScale;
      if (natural > replacement.targetWidth * 1.02) {
        const needed = (replacement.targetWidth / natural) * 100;
        if (needed < 45) {
          tooLong = true;
          return;
        }
        item.tz = needed;
      }
    });
    if (tooLong) return;

    plan.forEach(({ replacement, runs, tz }) => {
      replacement.text = buildNativeRunSequence(replacement, runs);
      replacement.nativeTz = tz;
      replacement.restoreTz = tz ? (replacement.hScale || 100) : null;
    });
    native.set(edit.id, new Set(boxes.map((_, index) => index)));
  });

  return native;
}

// Compone la secuencia de operadores que sustituye a la cadena original. Con un
// solo tramo y la misma fuente se mantiene la forma simple (una cadena); con
// varios tramos se emite un Tj por tramo y se deja al operador original una
// cadena vacía, restaurando la fuente de la línea al final.
function buildNativeRunSequence(replacement, runs) {
  if (!runs || !runs.length) {
    return replacement.kind === 'array' ? '[]' : '()';
  }
  const original = replacement.fontName;
  if (runs.length === 1 && runs[0].fontName === original) {
    return replacement.kind === 'array' ? `[<${runs[0].hex}>]` : `<${runs[0].hex}>`;
  }
  const size = Number(replacement.fontSize) || 10;
  const sizeText = Number.isInteger(size) ? String(size) : size.toFixed(2);
  let sequence = '';
  runs.forEach((run, index) => {
    const active = index === 0 ? original : runs[index - 1].fontName;
    if (active !== run.fontName) sequence += `/${run.fontName} ${sizeText} Tf `;
    sequence += `<${run.hex}> Tj `;
  });
  if (runs[runs.length - 1].fontName !== original) {
    sequence += `/${original} ${sizeText} Tf `;
  }
  sequence += replacement.kind === 'array' ? '[]' : '()';
  return sequence;
}

function tokenizeContentStream(source) {
  const tokens = [];
  let index = 0;
  const length = source.length;
  const isWhite = (char) => char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\0';
  const isDelimiter = (char) => '()<>[]{}/%'.includes(char);

  function skipSpace() {
    while (index < length) {
      if (isWhite(source[index])) {
        index += 1;
      } else if (source[index] === '%') {
        while (index < length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      } else {
        break;
      }
    }
  }

  function readLiteralString() {
    const start = index;
    index += 1;
    let depth = 1;
    while (index < length && depth > 0) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    return { type: 'string', raw: source.slice(start, index), start, end: index };
  }

  function readHexString() {
    const start = index;
    index += 1;
    while (index < length && source[index] !== '>') index += 1;
    if (index < length) index += 1;
    return { type: 'string', raw: source.slice(start, index), start, end: index };
  }

  function readName() {
    const start = index;
    index += 1;
    while (index < length && !isWhite(source[index]) && !isDelimiter(source[index])) index += 1;
    return { type: 'name', raw: source.slice(start, index), start, end: index };
  }

  function readArray() {
    const start = index;
    index += 1;
    const items = [];
    while (index < length) {
      skipSpace();
      if (index >= length) break;
      if (source[index] === ']') {
        index += 1;
        break;
      }
      const token = readValue();
      if (token) items.push(token);
    }
    return { type: 'array', items, raw: source.slice(start, index), start, end: index };
  }

  function readDictionary() {
    const start = index;
    index += 2;
    const items = [];
    while (index < length) {
      skipSpace();
      if (index >= length) break;
      if (source[index] === '>' && source[index + 1] === '>') {
        index += 2;
        break;
      }
      const token = readValue();
      if (token) items.push(token);
    }
    return { type: 'dict', items, raw: source.slice(start, index), start, end: index };
  }

  function readWord() {
    const start = index;
    while (index < length && !isWhite(source[index]) && !isDelimiter(source[index])) index += 1;
    return source.slice(start, index);
  }

  function readValue() {
    skipSpace();
    if (index >= length) return null;
    const char = source[index];
    if (char === '(') return readLiteralString();
    if (char === '<') {
      if (source[index + 1] === '<') return readDictionary();
      return readHexString();
    }
    if (char === '[') return readArray();
    if (char === '/') return readName();
    if (char === ']' || char === '>') {
      const start = index;
      index += 1;
      return { type: 'delimiter', raw: char, start, end: index };
    }
    const start = index;
    const word = readWord();
    if (!word) {
      index += 1;
      return null;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word)) {
      return { type: 'number', value: parseFloat(word), raw: word, start, end: index };
    }
    return { type: 'operator', raw: word, start, end: index };
  }

  while (index < length) {
    skipSpace();
    if (index >= length) break;

    // Las imágenes en línea llevan bytes binarios: se copian sin analizarlas.
    if (source.startsWith('BI', index) && (index + 2 >= length || isWhite(source[index + 2]) || isDelimiter(source[index + 2]))) {
      const start = index;
      const id = source.indexOf('ID', index + 2);
      if (id < 0) {
        index += 2;
        continue;
      }
      const endPattern = /\sEI(?=\s|$)/g;
      endPattern.lastIndex = id + 2;
      const match = endPattern.exec(source);
      if (!match) {
        tokens.push({ type: 'inline', raw: source.slice(start), start, end: length });
        index = length;
        break;
      }
      index = match.index + match[0].length;
      tokens.push({ type: 'inline', raw: source.slice(start, index), start, end: index });
      continue;
    }

    const token = readValue();
    if (token) tokens.push(token);
  }
  return tokens;
}

function lastTokenOfType(operands, type) {
  for (let i = operands.length - 1; i >= 0; i -= 1) {
    if (operands[i].type === type) return operands[i];
  }
  return null;
}

function lastNumbers(operands, count) {
  const numbers = [];
  for (let i = operands.length - 1; i >= 0 && numbers.length < count; i -= 1) {
    if (operands[i].type === 'number') numbers.unshift(operands[i].value);
  }
  return numbers;
}

function stripTextLinesFromContent(content, targets, expectedLines) {
  const tokens = tokenizeContentStream(content);
  const replacements = [];
  const matches = new Map();

  let ctm = IDENTITY_MATRIX.slice();
  let stack = [];
  let textMatrix = IDENTITY_MATRIX.slice();
  let lineMatrix = IDENTITY_MATRIX.slice();
  let leading = 0;
  let rise = 0;
  let fontSize = 0;
  let fontName = null;
  let hScale = 100;
  let operands = [];

  const show = (operand, isArray, operatorToken) => {
    if (!operand) return;
    const effective = multiplyMatrix(ctm, textMatrix);
    const origin = matrixPoint(effective, 0, rise);
    const dir1Length = Math.hypot(effective[0], effective[1]) || 1;
    const dir2Length = Math.hypot(effective[2], effective[3]) || 1;
    const dir1x = effective[0] / dir1Length;
    const dir1y = effective[1] / dir1Length;
    const dir2x = effective[2] / dir2Length;
    const dir2y = effective[3] / dir2Length;
    for (const target of targets) {
      const ux = target.ux ?? 1;
      const uy = target.uy ?? 0;
      const dx = origin[0] - target.x;
      const dy = origin[1] - target.y;
      const along = dx * ux + dy * uy;
      const perpendicular = Math.abs(dx * -uy + dy * ux);
      const tolerance = Math.max(0.9, Math.min(fontSize || target.fontSize, target.fontSize) * 0.18);
      const margin = target.fontSize * 0.35;
      if (along < -margin || along > target.width + margin) continue;
      if (perpendicular > tolerance) continue;
      const dot1 = Math.abs(dir1x * ux + dir1y * uy);
      const dot2 = Math.abs(dir2x * ux + dir2y * uy);
      if (dot1 < 0.99 && dot2 < 0.99) continue;
      replacements.push({
        start: operand.start,
        end: operand.end,
        text: isArray ? '[]' : '()',
        editId: target.editId,
        lineIndex: target.lineIndex
      });
      if (!matches.has(target.editId)) matches.set(target.editId, new Set());
      matches.get(target.editId).add(target.lineIndex);
      break;
    }
  };

  for (const token of tokens) {
    if (token.type !== 'operator') {
      operands.push(token);
      continue;
    }
    const operator = token.raw;
    if (operator === 'q') {
      stack.push(ctm.slice());
    } else if (operator === 'Q') {
      ctm = stack.pop() || IDENTITY_MATRIX.slice();
    } else if (operator === 'cm') {
      const values = lastNumbers(operands, 6);
      if (values.length === 6) ctm = multiplyMatrix(ctm, values);
    } else if (operator === 'BT') {
      textMatrix = IDENTITY_MATRIX.slice();
      lineMatrix = IDENTITY_MATRIX.slice();
    } else if (operator === 'Tf') {
      const values = lastNumbers(operands, 1);
      if (values.length) fontSize = values[0];
      const nameToken = lastTokenOfType(operands, 'name');
      if (nameToken) fontName = nameToken.raw.replace(/^\//, '');
    } else if (operator === 'Tz') {
      const values = lastNumbers(operands, 1);
      if (values.length) hScale = values[0] || 100;
    } else if (operator === 'TL') {
      const values = lastNumbers(operands, 1);
      if (values.length) leading = values[0];
    } else if (operator === 'Tm') {
      const values = lastNumbers(operands, 6);
      if (values.length === 6) {
        textMatrix = values.slice();
        lineMatrix = values.slice();
      }
    } else if (operator === 'Td' || operator === 'TD') {
      const values = lastNumbers(operands, 2);
      if (values.length === 2) {
        if (operator === 'TD') leading = -values[1];
        lineMatrix = translateMatrix(lineMatrix, values[0], values[1]);
        textMatrix = lineMatrix.slice();
      }
    } else if (operator === 'T*') {
      lineMatrix = translateMatrix(lineMatrix, 0, -leading);
      textMatrix = lineMatrix.slice();
    } else if (operator === 'Ts') {
      const values = lastNumbers(operands, 1);
      if (values.length) rise = values[0];
    } else if (operator === 'Tj' || operator === "'" || operator === '"') {
      if (operator === "'" || operator === '"') {
        lineMatrix = translateMatrix(lineMatrix, 0, -leading);
        textMatrix = lineMatrix.slice();
      }
      show(lastTokenOfType(operands, 'string'), false, token);
    } else if (operator === 'TJ') {
      show(lastTokenOfType(operands, 'array'), true, token);
    }
    operands = [];
  }

  const complete = new Set();
  matches.forEach((lineIndexes, editId) => {
    if (lineIndexes.size === (expectedLines.get(editId) || 0)) complete.add(editId);
  });

  const finalReplacements = replacements.filter((replacement) => complete.has(replacement.editId));
  if (!finalReplacements.length) return { content, removed: new Set() };

  let output = content;
  finalReplacements
    .slice()
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
    });
  return { content: output, removed: complete };
}

function lookupPdfDict(doc, value) {
  if (!value) return null;
  const object = doc.context.lookup(value);
  return object && typeof object.get === 'function' ? object : null;
}

function decodePdfStreamContent(stream) {
  if (!stream) return null;
  try {
    return bytesToLatin1(decodePDFRawStream(stream).decode());
  } catch (error) {
    if (stream.contents) return bytesToLatin1(stream.contents);
    return null;
  }
}

function readFormMatrix(doc, dict) {
  const value = dict.get(PDFName.of('Matrix'));
  const array = value ? doc.context.lookup(value) : null;
  if (!(array instanceof PDFArray) || array.size() < 6) return IDENTITY_MATRIX.slice();
  const numbers = [];
  for (let i = 0; i < 6; i += 1) {
    const object = doc.context.lookup(array.get(i));
    numbers.push(object instanceof PDFNumber ? object.asNumber() : Number(object));
  }
  return numbers.every(Number.isFinite) ? numbers : IDENTITY_MATRIX.slice();
}

function resolveFormXObject(doc, resources, name) {
  if (!resources) return null;
  const xobjects = lookupPdfDict(doc, resources.get(PDFName.of('XObject')));
  if (!xobjects) return null;
  const ref = xobjects.get(PDFName.of(name));
  if (!ref) return null;
  const stream = doc.context.lookup(ref);
  if (!stream || typeof stream.dict?.get !== 'function') return null;
  const subtype = doc.context.lookup(stream.dict.get(PDFName.of('Subtype')));
  if (!subtype || subtype.toString() !== '/Form') return null;
  return { ref: ref instanceof PDFRef ? ref : null, stream };
}

function cloneFormStream(doc, stream, content, resources) {
  const dict = doc.context.obj({});
  stream.dict.entries().forEach(([key, value]) => {
    const name = key.toString();
    if (name === '/Length' || name === '/Filter' || name === '/DecodeParms') return;
    dict.set(key, value);
  });
  if (resources) dict.set(PDFName.of('Resources'), resources);
  return doc.context.register(PDFRawStream.of(dict, latin1ToBytes(content)));
}

function cloneResourcesWithXObjects(doc, resources, updates) {
  const clone = doc.context.obj({});
  if (resources) resources.entries().forEach(([key, value]) => clone.set(key, value));
  if (updates && updates.size) {
    const original = resources ? lookupPdfDict(doc, resources.get(PDFName.of('XObject'))) : null;
    const xobjects = doc.context.obj({});
    if (original) original.entries().forEach(([key, value]) => xobjects.set(key, value));
    updates.forEach((ref, name) => xobjects.set(PDFName.of(name), ref));
    clone.set(PDFName.of('XObject'), xobjects);
  }
  return clone;
}

function uniqueXObjectName(doc, resources, analysis) {
  const xobjects = resources ? lookupPdfDict(doc, resources.get(PDFName.of('XObject'))) : null;
  let name;
  do {
    name = `ZV${analysis.counter++}`;
  } while (xobjects && xobjects.get(PDFName.of(name)));
  return name;
}

function analyzeContentTree(doc, content, resources, ctmStart, analysis, depth) {
  const tokens = tokenizeContentStream(content);
  const node = {
    content,
    resources,
    replacements: [],
    forms: []
  };

  let ctm = ctmStart.slice();
  let stack = [];
  let textMatrix = IDENTITY_MATRIX.slice();
  let lineMatrix = IDENTITY_MATRIX.slice();
  let leading = 0;
  let rise = 0;
  let fontSize = 0;
  let fontName = null;
  let hScale = 100;
  let operands = [];

  const show = (operand, isArray, operatorToken) => {
    if (!operand) return;
    const effective = multiplyMatrix(ctm, textMatrix);
    const origin = matrixPoint(effective, 0, rise);
    const dir1Length = Math.hypot(effective[0], effective[1]) || 1;
    const dir2Length = Math.hypot(effective[2], effective[3]) || 1;
    const dir1x = effective[0] / dir1Length;
    const dir1y = effective[1] / dir1Length;
    const dir2x = effective[2] / dir2Length;
    const dir2y = effective[3] / dir2Length;
    for (const target of analysis.targets) {
      const ux = target.ux ?? 1;
      const uy = target.uy ?? 0;
      const dx = origin[0] - target.x;
      const dy = origin[1] - target.y;
      const along = dx * ux + dy * uy;
      const perpendicular = Math.abs(dx * -uy + dy * ux);
      const tolerance = Math.max(0.9, Math.min(fontSize || target.fontSize, target.fontSize) * 0.18);
      const margin = target.fontSize * 0.35;
      if (along < -margin || along > target.width + margin) continue;
      if (perpendicular > tolerance) continue;
      const dot1 = Math.abs(dir1x * ux + dir1y * uy);
      const dot2 = Math.abs(dir2x * ux + dir2y * uy);
      if (dot1 < 0.99 && dot2 < 0.99) continue;
      node.replacements.push({
        start: operand.start,
        end: operand.end,
        operatorEnd: operatorToken ? operatorToken.end : operand.end,
        operator: operatorToken ? operatorToken.raw : '',
        kind: isArray ? 'array' : 'string',
        text: isArray ? '[]' : '()',
        editId: target.editId,
        lineIndex: target.lineIndex,
        targetWidth: target.width,
        matrixScale: Math.hypot(effective[0], effective[1]) || 1,
        resources,
        fontName,
        fontSize,
        hScale,
        nativeTz: null,
        restoreTz: null
      });
      if (!analysis.matches.has(target.editId)) analysis.matches.set(target.editId, new Set());
      analysis.matches.get(target.editId).add(target.lineIndex);
      break;
    }
  };

  for (const token of tokens) {
    if (token.type !== 'operator') {
      operands.push(token);
      continue;
    }
    const operator = token.raw;
    if (operator === 'q') {
      stack.push(ctm.slice());
    } else if (operator === 'Q') {
      ctm = stack.pop() || IDENTITY_MATRIX.slice();
    } else if (operator === 'cm') {
      const values = lastNumbers(operands, 6);
      if (values.length === 6) ctm = multiplyMatrix(ctm, values);
    } else if (operator === 'BT') {
      textMatrix = IDENTITY_MATRIX.slice();
      lineMatrix = IDENTITY_MATRIX.slice();
    } else if (operator === 'Tf') {
      const values = lastNumbers(operands, 1);
      if (values.length) fontSize = values[0];
      const nameToken = lastTokenOfType(operands, 'name');
      if (nameToken) fontName = nameToken.raw.replace(/^\//, '');
    } else if (operator === 'Tz') {
      const values = lastNumbers(operands, 1);
      if (values.length) hScale = values[0] || 100;
    } else if (operator === 'TL') {
      const values = lastNumbers(operands, 1);
      if (values.length) leading = values[0];
    } else if (operator === 'Tm') {
      const values = lastNumbers(operands, 6);
      if (values.length === 6) {
        textMatrix = values.slice();
        lineMatrix = values.slice();
      }
    } else if (operator === 'Td' || operator === 'TD') {
      const values = lastNumbers(operands, 2);
      if (values.length === 2) {
        if (operator === 'TD') leading = -values[1];
        lineMatrix = translateMatrix(lineMatrix, values[0], values[1]);
        textMatrix = lineMatrix.slice();
      }
    } else if (operator === 'T*') {
      lineMatrix = translateMatrix(lineMatrix, 0, -leading);
      textMatrix = lineMatrix.slice();
    } else if (operator === 'Ts') {
      const values = lastNumbers(operands, 1);
      if (values.length) rise = values[0];
    } else if (operator === 'Tj' || operator === "'" || operator === '"') {
      if (operator === "'" || operator === '"') {
        lineMatrix = translateMatrix(lineMatrix, 0, -leading);
        textMatrix = lineMatrix.slice();
      }
      show(lastTokenOfType(operands, 'string'), false, token);
    } else if (operator === 'TJ') {
      show(lastTokenOfType(operands, 'array'), true, token);
    } else if (operator === 'Do') {
      const nameToken = lastTokenOfType(operands, 'name');
      if (!nameToken) {
        operands = [];
        continue;
      }
      const name = nameToken.raw.replace(/^\//, '');
      const xobject = resolveFormXObject(doc, resources, name);
      if (!xobject || depth >= 8) {
        operands = [];
        continue;
      }
      const key = xobject.ref ? xobject.ref.toString() : `direct-${analysis.formCounter++}`;
      if (analysis.visited.has(key)) {
        operands = [];
        continue;
      }
      const formContent = decodePdfStreamContent(xobject.stream);
      if (formContent === null) {
        operands = [];
        continue;
      }
      const formResources = lookupPdfDict(doc, xobject.stream.dict.get(PDFName.of('Resources'))) || resources;
      const matrix = readFormMatrix(doc, xobject.stream.dict);
      analysis.visited.add(key);
      const child = analyzeContentTree(doc, formContent, formResources, multiplyMatrix(ctm, matrix), analysis, depth + 1);
      analysis.visited.delete(key);
      node.forms.push({
        name,
        nameToken,
        resources: formResources,
        stream: xobject.stream,
        node: child
      });
    }
    operands = [];
  }

  return node;
}

function commitContentTree(doc, node, complete, analysis) {
  const replacements = node.replacements.filter((replacement) => !replacement.editId || complete.has(replacement.editId));
  const updates = new Map();

  node.forms.forEach((form) => {
    const child = commitContentTree(doc, form.node, complete, analysis);
    if (!child.modified) return;
    const newName = uniqueXObjectName(doc, node.resources, analysis);
    let resources = form.resources;
    if (child.updates.size) {
      resources = cloneResourcesWithXObjects(doc, form.resources, child.updates);
    }
    const ref = cloneFormStream(doc, form.stream, child.content, resources);
    updates.set(newName, ref);
    replacements.push({
      start: form.nameToken.start,
      end: form.nameToken.end,
      text: '/' + newName
    });
  });

  let content = node.content;
  if (replacements.length) {
    const operations = [];
    replacements.forEach((replacement) => {
      operations.push({ start: replacement.start, end: replacement.end, text: replacement.text });
      if (replacement.nativeTz) {
        // El texto se ha escrito con la fuente original: se ajusta el ancho con
        // Tz y se restaura el valor anterior en cuanto termina el operador.
        operations.push({
          start: replacement.start,
          end: replacement.start,
          text: `${replacement.nativeTz.toFixed(2)} Tz `
        });
        operations.push({
          start: replacement.operatorEnd,
          end: replacement.operatorEnd,
          text: ` ${Number(replacement.restoreTz || 100).toFixed(2)} Tz`
        });
      }
    });
    operations
      .sort((a, b) => (b.start - a.start) || (b.end - a.end))
      .forEach((operation) => {
        content = content.slice(0, operation.start) + operation.text + content.slice(operation.end);
      });
  }

  return {
    modified: replacements.length > 0,
    content,
    updates
  };
}


function readPageContent(doc, page) {
  if (!doc || !page) return null;
  let contents;
  try {
    contents = page.node.Contents();
  } catch (error) {
    return null;
  }
  if (!contents) return null;
  const object = doc.context.lookup(contents);
  const streams = [];
  if (object instanceof PDFArray) {
    for (let i = 0; i < object.size(); i += 1) streams.push(doc.context.lookup(object.get(i)));
  } else {
    streams.push(object);
  }
  const parts = [];
  for (const stream of streams) {
    if (!stream) continue;
    try {
      parts.push(bytesToLatin1(decodePDFRawStream(stream).decode()));
    } catch (error) {
      return null;
    }
  }
  return parts.join('\n');
}

function writePageContent(doc, page, content) {
  const stream = PDFRawStream.of(doc.context.obj({}), latin1ToBytes(content));
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  // pdf-lib cachea el flujo de contenido; hay que invalidarlo para que las
  // siguientes operaciones (texto, imágenes) no escriban en el flujo antiguo.
  page.contentStream = undefined;
  page.contentStreamRef = undefined;
}

function removeOriginalText(doc, page, edits, statePage) {
  const empty = { removed: new Set(), native: new Map() };
  if (!doc || !page || !edits.length) return empty;
  if (doc.isEncrypted) return empty;
  if (typeof decodePDFRawStream !== 'function' || !PDFRawStream || !PDFName || !PDFArray) {
    return empty;
  }

  const content = readPageContent(doc, page);
  if (content === null) return empty;

  const targets = [];
  const expected = new Map();
  edits.forEach((edit) => {
    const lines = editLineBoxes(edit);
    if (!lines.length) return;
    expected.set(edit.id, lines.length);
    lines.forEach((line, lineIndex) => {
      targets.push({
        editId: edit.id,
        lineIndex,
        x: line.x,
        y: line.y,
        width: line.width,
        ux: line.ux ?? 1,
        uy: line.uy ?? 0,
        fontSize: line.fontSize
      });
    });
  });
  if (!targets.length) return empty;

  let pageResources = null;
  try {
    pageResources = page.node.Resources();
  } catch (error) {
    pageResources = null;
  }

  const analysis = {
    targets,
    matches: new Map(),
    counter: 0,
    formCounter: 0,
    visited: new Set()
  };
  const root = analyzeContentTree(doc, content, pageResources, IDENTITY_MATRIX.slice(), analysis, 0);

  const complete = new Set();
  analysis.matches.forEach((lineIndexes, editId) => {
    if (lineIndexes.size === (expected.get(editId) || 0)) complete.add(editId);
  });
  if (!complete.size) return empty;

  // Se intenta primero reescribir el texto con la fuente y los operadores
  // originales; las líneas que no se pueden codificar se dibujan después.
  const native = prepareNativeReplacements(doc, root, edits, analysis, complete);

  const committed = commitContentTree(doc, root, complete, analysis);
  if (!committed.modified) return empty;

  try {
    if (committed.content !== content) writePageContent(doc, page, committed.content);
    if (committed.updates.size) {
      const resources = cloneResourcesWithXObjects(doc, pageResources, committed.updates);
      page.node.set(PDFName.of('Resources'), resources);
    }
  } catch (error) {
    console.warn('No se pudo reescribir el contenido de la página', error);
    return empty;
  }
  return { removed: complete, native };
}

// Zonas de redacción: se usan como "ediciones vacías" para borrar del flujo de
// contenido el texto que cae dentro del rectángulo.
function redactionEditsFor(page) {
  const redactions = (page.anns || []).filter((ann) => ann.type === 'redact');
  if (!redactions.length) return [];
  const items = page.textItems || [];
  const result = [];
  redactions.forEach((ann) => {
    const x0 = Math.min(ann.x, ann.x + ann.w);
    const x1 = Math.max(ann.x, ann.x + ann.w);
    const y0 = Math.min(ann.y, ann.y + ann.h);
    const y1 = Math.max(ann.y, ann.y + ann.h);
    items.forEach((item) => {
      const size = item.fontSize || 10;
      const ascent = (item.ascent ?? 0.82) * size;
      const descent = (item.descent ?? -0.22) * size;
      const ux = item.ux ?? 1;
      const left = Math.min(item.x, item.x + ux * item.width);
      const right = Math.max(item.x, item.x + ux * item.width);
      const bottom = Math.min(item.y + descent, item.y + ascent);
      const top = Math.max(item.y + descent, item.y + ascent);
      if (right < x0 || left > x1 || top < y0 || bottom > y1) return;
      result.push({
        id: `redact-${ann.id}-${item.index}`,
        text: '',
        lines: [{
          x: item.x,
          y: item.y,
          width: Math.max(1, item.width),
          fontSize: size,
          ascent: item.ascent ?? 0.82,
          descent: item.descent ?? -0.22,
          ux,
          uy: item.uy ?? 0,
          angle: item.angle ?? 0,
          vertical: Boolean(item.vertical)
        }]
      });
    });
  });
  return result;
}

async function applyTextEditsOnPdf(out, outPage, page, fontCache) {
  const edits = page.textEdits || [];
  const redactions = (page.anns || []).filter((ann) => ann.type === 'redact');
  if (redactions.length && (!page.textItems || !page.textItems.length) && page.pageRef) {
    try {
      page.textItems = extractTextItems(await page.pageRef.getTextContent(), page);
    } catch (error) {
      /* página sin texto */
    }
  }
  const redactionEdits = redactionEditsFor(page);
  if (!edits.length && !redactionEdits.length) return;
  const removal = removeOriginalText(out, outPage, edits.concat(redactionEdits), page);
  const removed = removal.removed;
  const native = removal.native;

  for (const edit of edits) {
    const lines = editLineBoxes(edit);
    const pad = Math.max(0.7, (lines[0].fontSize || 10) * 0.08);
    const merged = native.get(edit.id) || null;

    // Si el texto original se ha eliminado del flujo de contenido, no hace
    // falta taparlo; si no, se mantiene el parche de fondo como reserva.
    // En páginas OCR la imagen ya se ha limpiado antes de llegar aquí.
    if (!removed.has(edit.id) && !(edit.ocr && page.ocrRasterized)) {
      lines.forEach((line) => {
        const fontSize = line.fontSize || 10;
        const ux = line.ux ?? 1;
        const uy = line.uy ?? 0;
        const nx = -uy;
        const ny = ux;
        const descent = line.descent ?? -0.22;
        const ascent = line.ascent ?? 0.82;
        const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
        outPage.drawRectangle({
          x: line.x + nx * descent * fontSize - ux * pad,
          y: line.y + ny * descent * fontSize - uy * pad,
          width: line.width + pad * 2,
          height: (ascent - descent) * fontSize + pad * 2,
          rotate: degrees(angle),
          color: hexToRgb(edit.bg || '#ffffff')
        });
      });
    }
    if (!edit.text) continue;

    const output = editableRuns(edit);
    const lastLine = lines[lines.length - 1];
    const lineHeight = (lastLine.fontSize || 10) * 1.25;
    const normalX = -(lastLine.uy ?? 0);
    const normalY = lastLine.ux ?? 1;

    for (let index = 0; index < output.length; index += 1) {
      // Esta línea ya se ha reescrito con la fuente original del documento.
      if (merged && merged.has(index)) continue;
      let box;
      if (index < lines.length) {
        box = lines[index];
      } else {
        box = {
          x: lastLine.x - normalX * (index - lines.length + 1) * lineHeight,
          y: lastLine.y - normalY * (index - lines.length + 1) * lineHeight,
          width: lastLine.width,
          fontSize: lastLine.fontSize,
          ascent: lastLine.ascent,
          descent: lastLine.descent,
          ux: lastLine.ux ?? 1,
          uy: lastLine.uy ?? 0
        };
      }
      const runs = output[index]
        .map((run) => ({ ...run, text: pdfSafeText(run.text) }))
        .filter((run) => run.text);
      if (!runs.length) continue;

      // Si algún tramo no cabe, se reduce el tamaño de toda la línea por igual.
      const measure = (size) => runs.reduce(
        (total, run) => total + measureTextWidth(run.text, edit.family, run.bold, run.italic, size), 0);
      let size = box.fontSize || 12;
      const wanted = measure(size);
      if (box.width && wanted > box.width * 1.02) {
        size = Math.max(4.5, size * (box.width / wanted));
      }

      const angle = (Math.atan2(box.uy ?? 0, box.ux ?? 1) * 180) / Math.PI;
      const ux = box.ux ?? 1;
      const uy = box.uy ?? 0;
      let cursor = 0;
      for (const run of runs) {
        const font = await getPdfFont(out, fontCache, edit.family, run.bold, run.italic);
        outPage.drawText(run.text, {
          x: box.x + ux * cursor,
          y: box.y + uy * cursor,
          size,
          font,
          rotate: degrees(angle),
          color: hexToRgb(edit.color || '#111111')
        });
        cursor += font.widthOfTextAtSize(run.text, size);
      }
    }
  }
}

async function getPdfFont(out, cache, family, bold, italic) {
  const key = `${family}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
  if (cache.has(key)) return cache.get(key);
  const set = FAMILY_FONTS[family] || FAMILY_FONTS.helvetica;
  const name = bold && italic ? set.boldItalic : bold ? set.bold : italic ? set.italic : set.normal;
  const font = await out.embedFont(name);
  cache.set(key, font);
  return font;
}

/* ------------------------------- Herramientas --------------------------- */

const TOOL_HINTS = {
  select: 'Haz clic en una anotación para seleccionarla y arrástrala para moverla.',
  hand: 'Arrastra para desplazarte por el documento.',
  highlight: 'Selecciona texto para resaltarlo, o arrastra para crear un resaltado rectangular.',
  textedit: 'Haz clic en una línea para modificar su contenido. Shift+clic (o Shift+doble clic con Seleccionar) edita el párrafo completo.',
  text: 'Haz clic en la página para escribir un texto.',
  note: 'Haz clic en la página para colocar una nota adhesiva.',
  rect: 'Arrastra para dibujar un rectángulo.',
  ellipse: 'Arrastra para dibujar una elipse.',
  ink: 'Mantén pulsado y dibuja libremente.',
  cover: 'Arrastra para cubrir una zona con blanco.',
  image: 'Haz clic para colocar la imagen elegida.'
};

function setTool(tool) {
  state.tool = tool;
  document.body.className = 'tool-' + tool;
  $$('.tool').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  $('#toolHint').textContent = TOOL_HINTS[tool] || '';
  if (tool === 'highlight' && state.style.color.toLowerCase() === '#e11900') {
    setColor('#ffd400');
  }
  if (tool === 'image' && !state.image) {
    $('#imageInput').click();
  }
}

function setColor(value) {
  state.style.color = value;
  $('#styleColor').value = value;
  $('#panelColor').value = value;
}

function syncStyleFromInputs() {
  state.style.color = $('#styleColor').value;
  state.style.lineWidth = clamp(Number($('#styleWidth').value) || 2, 1, 24);
  state.style.fontSize = clamp(Number($('#styleFont').value) || 14, 6, 96);
  $('#panelColor').value = state.style.color;
  $('#panelWidth').value = state.style.lineWidth;
  $('#panelFont').value = state.style.fontSize;
}

/* ------------------------------- Interacción ---------------------------- */

function pageIndexFromEvent(event) {
  const pageEl = event.target.closest('.page');
  if (!pageEl) return -1;
  return Number(pageEl.dataset.pageIndex);
}

function eventToPdf(event, pageEl, entry) {
  const rect = pageEl.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return { point: entry.vp.convertToPdfPoint(x, y), screen: { x, y } };
}

  async function onPointerDown(event) {
  if (event.button !== 0) return;
  const index = pageIndexFromEvent(event);
  if (index < 0) return;
  const page = state.pages[index];
  const entry = pageEntries[index];
  if (!page || !entry || !entry.vp) return;

  if (state.current !== index) {
    state.current = index;
    updateUI();
  }

  const textEditNode = event.target.closest('[data-textedit]');
  if (textEditNode && (state.tool === 'select' || state.tool === 'textedit')) {
    const edit = page.textEdits.find((entryValue) => entryValue.id === textEditNode.getAttribute('data-textedit'));
    if (edit) {
      event.preventDefault();
      openTextEditor(entry.el, index, null, { record: edit });
      return;
    }
  }

  // Enlaces del PDF (URLs y destinos internos): se activan con Seleccionar o Mano.
  if ((state.tool === 'select' || state.tool === 'hand') && page.links && page.links.length) {
    const pageEl = event.target.closest('.page');
    if (pageEl) {
      const { point } = eventToPdf(event, pageEl, entry);
      const link = linkAt(page, point);
      if (link) {
        event.preventDefault();
        activateLink(link, page);
        return;
      }
    }
  }

  if (state.tool === 'select') {
    const annNode = event.target.closest('[data-ann]');
    if (annNode) {
      const id = annNode.getAttribute('data-ann');
      state.selectedAnn = { pageIndex: index, id };
      const ann = page.anns.find((a) => a.id === id);
      if (ann) startMove(event, index, ann, entry);
      redrawPage(index);
      renderAnnList();
      renderSelectedInfo();
    } else {
      state.selectedAnn = null;
      redrawPage(index);
      renderAnnList();
      renderSelectedInfo();
    }
    return;
  }

  if (state.tool === 'hand') return;

  const pageEl = event.target.closest('.page');

  if (state.tool === 'textedit') {
    event.preventDefault();
    let item = findTextItem(index, event);
    if (!item && page.pageRef) {
      try {
        const textContent = await page.pageRef.getTextContent();
        page.textItems = extractTextItems(textContent, page);
        item = findTextItem(index, event);
      } catch (error) {
        console.warn('No se pudo leer el texto de la página', error);
      }
    }
    if (!item) {
      toast(page.textItems.length
        ? 'Haz clic sobre una línea de texto para editarla.'
        : 'Esta página no contiene texto seleccionable (PDF escaneado). Usa «Texto» para añadir texto o «Cubrir» para tapar zonas.');
      return;
    }
    openTextEditor(pageEl, index, item, { paragraph: event.shiftKey });
    return;
  }

  const { point, screen } = eventToPdf(event, pageEl, entry);

  if (state.tool === 'text' || state.tool === 'note') {
    openInlineEditor(pageEl, index, point, screen, state.tool === 'note');
    return;
  }

  if (state.tool === 'image') {
    if (!state.image) {
      $('#imageInput').click();
      return;
    }
    addImageAnnotation(index, point);
    return;
  }

  if (['rect', 'ellipse', 'cover', 'redact', 'highlight', 'ink'].includes(state.tool)) {
    startDraw(event, index, entry, point);
  }
}

function startDraw(event, index, entry, startPoint) {
  const pageEl = pageEntries[index].el;
  const svg = pageEntries[index].svg;
  const viewport = entry.vp;
  const isInk = state.tool === 'ink';
  const preview = document.createElementNS(NS, isInk ? 'polyline' : 'rect');

  if (isInk) {
    preview.setAttribute('fill', 'none');
    preview.setAttribute('stroke', state.style.color);
    preview.setAttribute('stroke-width', String(state.style.lineWidth));
    preview.setAttribute('stroke-linecap', 'round');
    preview.setAttribute('stroke-linejoin', 'round');
    preview.setAttribute('vector-effect', 'non-scaling-stroke');
  } else {
    preview.setAttribute('fill', state.tool === 'cover' ? '#ffffff'
      : (state.tool === 'redact' ? '#000000' : state.style.color));
    preview.setAttribute('fill-opacity', state.tool === 'rect' ? '0'
      : (state.tool === 'redact' ? '0.55' : '0.3'));
    preview.setAttribute('stroke', state.style.color);
    preview.setAttribute('stroke-width', String(state.style.lineWidth));
    preview.setAttribute('vector-effect', 'non-scaling-stroke');
  }
  svg.appendChild(preview);

  const inkPoints = [[startPoint[0], startPoint[1]]];
  let last = startPoint;
  let moved = false;

  const toPdf = (evt) => {
    const rect = pageEl.getBoundingClientRect();
    return viewport.convertToPdfPoint(evt.clientX - rect.left, evt.clientY - rect.top);
  };

  const onMove = (evt) => {
    const point = toPdf(evt);
    last = point;
    const dx = point[0] - startPoint[0];
    const dy = point[1] - startPoint[1];
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;

    if (isInk) {
      inkPoints.push([point[0], point[1]]);
      preview.setAttribute('points', inkPoints.map((p) => p.join(',')).join(' '));
    } else {
      preview.setAttribute('x', String(Math.min(startPoint[0], point[0])));
      preview.setAttribute('y', String(Math.min(startPoint[1], point[1])));
      preview.setAttribute('width', String(Math.abs(dx)));
      preview.setAttribute('height', String(Math.abs(dy)));
    }
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    preview.remove();
    const page = state.pages[index];

    // Resaltado de texto: si hay selección, se convierte en anotaciones.
    // Primero intentamos usar la selección real de texto; si no hay, se
    // crea un resaltado rectangular con el arrastre.
    if (state.tool === 'highlight' && highlightSelection(index)) {
      renderAnnList();
      markDirty();
      return;
    }

    if (!moved) return;

    if (isInk) {
      if (inkPoints.length < 2) return;
      pushUndo();
      page.anns.push({
        id: uid(),
        type: 'ink',
        points: inkPoints,
        color: state.style.color,
        lineWidth: state.style.lineWidth
      });
    } else {
      const ann = {
        id: uid(),
        type: state.tool === 'highlight' ? 'highlight' : state.tool,
        x: Math.min(startPoint[0], last[0]),
        y: Math.min(startPoint[1], last[1]),
        w: Math.abs(last[0] - startPoint[0]),
        h: Math.abs(last[1] - startPoint[1]),
        color: state.tool === 'cover' ? '#ffffff' : (state.tool === 'redact' ? '#000000' : state.style.color),
        lineWidth: state.style.lineWidth,
        opacity: state.style.opacity
      };
      if (ann.w < 2 || ann.h < 2) return;
      pushUndo();
      page.anns.push(ann);
    }
    redrawPage(index);
    renderAnnList();
    markDirty();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function highlightSelection(index) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const entry = pageEntries[index];
  if (!entry || !entry.vp) return false;
  const pageRect = entry.el.getBoundingClientRect();
  const range = selection.getRangeAt(0);
  const clientRects = Array.from(range.getClientRects());
  const rects = [];

  clientRects.forEach((rect) => {
    const left = Math.max(rect.left, pageRect.left);
    const top = Math.max(rect.top, pageRect.top);
    const right = Math.min(rect.right, pageRect.right);
    const bottom = Math.min(rect.bottom, pageRect.bottom);
    if (right - left < 2 || bottom - top < 2) return;
    const [x1, y1] = entry.vp.convertToPdfPoint(left - pageRect.left, top - pageRect.top);
    const [x2, y2] = entry.vp.convertToPdfPoint(right - pageRect.left, bottom - pageRect.top);
    rects.push({
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1)
    });
  });

  if (!rects.length) return false;
  pushUndo();
  const page = state.pages[index];
  rects.forEach((rect) => {
    page.anns.push({
      id: uid(),
      type: 'highlight',
      ...rect,
      color: state.style.color,
      lineWidth: 1,
      opacity: state.style.opacity
    });
  });
  selection.removeAllRanges();
  redrawPage(index);
  return true;
}

function startMove(event, index, ann, entry) {
  const pageEl = pageEntries[index].el;
  const viewport = entry.vp;
  const rect = pageEl.getBoundingClientRect();
  const startX = event.clientX - rect.left;
  const startY = event.clientY - rect.top;
  const startPdf = viewport.convertToPdfPoint(startX, startY);
  const original = JSON.parse(JSON.stringify(ann));
  let changed = false;

  const onMove = (evt) => {
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    const point = viewport.convertToPdfPoint(x, y);
    const dx = point[0] - startPdf[0];
    const dy = point[1] - startPdf[1];
    if (!changed && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
      pushUndo();
      changed = true;
    }
    if (!changed) return;
    if (ann.type === 'ink') {
      ann.points = original.points.map((p) => [p[0] + dx, p[1] + dy]);
    } else {
      ann.x = original.x + dx;
      ann.y = original.y + dy;
    }
    redrawPage(index);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (changed) markDirty();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function openInlineEditor(pageEl, index, point, screen, isNote) {
  const page = state.pages[index];
  const textarea = document.createElement('textarea');
  textarea.className = 'inline-editor';
  const fontSize = state.style.fontSize * (pageEntries[index].vp.scale || state.scale);
  textarea.style.left = Math.max(0, screen.x) + 'px';
  textarea.style.top = Math.max(0, screen.y - fontSize) + 'px';
  textarea.style.fontSize = Math.max(11, fontSize) + 'px';
  textarea.style.width = (isNote ? 190 : 240) + 'px';
  textarea.placeholder = isNote ? 'Nota…' : 'Texto…';
  pageEl.appendChild(textarea);
  textarea.focus();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const value = textarea.value.trim();
    textarea.remove();
    if (!value) return;
    pushUndo();
    if (isNote) {
      page.anns.push({
        id: uid(),
        type: 'note',
        x: point[0],
        y: point[1] - 60,
        w: 170,
        h: 60,
        text: value,
        color: '#d4b106',
        fontSize: 11,
        lineWidth: 1
      });
    } else {
      page.anns.push({
        id: uid(),
        type: 'text',
        x: point[0],
        y: point[1],
        text: value,
        color: state.style.color,
        fontSize: state.style.fontSize,
        lineWidth: state.style.lineWidth
      });
    }
    redrawPage(index);
    renderAnnList();
    markDirty();
  };

  textarea.addEventListener('blur', commit);
  textarea.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') {
      evt.preventDefault();
      textarea.value = '';
      textarea.blur();
    } else if (evt.key === 'Enter' && !evt.shiftKey) {
      evt.preventDefault();
      textarea.blur();
    }
  });
}

function addImageAnnotation(index, point) {
  const page = state.pages[index];
  const image = state.image;
  if (!image) return;
  pushUndo();
  const maxWidth = Math.min(180, page.width * 0.5);
  const ratio = image.height / image.width || 1;
  const w = maxWidth;
  const h = w * ratio;
  page.anns.push({
    id: uid(),
    type: 'image',
    x: point[0] - w / 2,
    y: point[1] - h / 2,
    w,
    h,
    dataURL: image.dataURL,
    color: state.style.color,
    lineWidth: 0
  });
  redrawPage(index);
  renderAnnList();
  markDirty();
  toast('Imagen añadida. Puedes moverla con la herramienta Seleccionar.');
}

function redrawPage(index) {
  const entry = pageEntries[index];
  const page = state.pages[index];
  if (!entry || !page || !entry.vp) return;
  drawAnnotations(entry, page, entry.vp);
}

/* ------------------------------- Miniaturas ----------------------------- */

let thumbObserver = null;
let thumbDragIndex = -1;

async function rebuildThumbs() {
  const container = $('#thumbs');
  container.innerHTML = '';
  if (thumbObserver) thumbObserver.disconnect();

  if (!state.pages.length) {
    return;
  }

  thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((ioEntry) => {
      if (!ioEntry.isIntersecting) return;
      const item = ioEntry.target;
      thumbObserver.unobserve(item);
      renderThumb(item);
    });
  }, { root: container, rootMargin: '400px 0px' });

  state.pages.forEach((page, index) => {
    const item = document.createElement('div');
    item.className = 'thumb';
    item.dataset.index = String(index);
    item.draggable = true;

    item.addEventListener('dragstart', (event) => {
      thumbDragIndex = index;
      item.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', String(index)); } catch (error) { /* algunos sistemas lo bloquean */ }
      }
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      thumbDragIndex = -1;
    });
    item.addEventListener('dragover', (event) => {
      if (thumbDragIndex < 0) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('drop-target');
      const from = thumbDragIndex;
      thumbDragIndex = -1;
      if (from >= 0) movePageTo(from, index);
    });

    const canvas = document.createElement('canvas');
    canvas.dataset.thumb = '1';

    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = String(index + 1);

    const tools = document.createElement('div');
    tools.className = 'thumb-tools';
    tools.innerHTML = [
      `<button data-thumb-action="up" title="Subir página">${ICONS.up}</button>`,
      `<button data-thumb-action="down" title="Bajar página">${ICONS.down}</button>`,
      `<button data-thumb-action="rotate" title="Girar 90°">${ICONS.rotate}</button>`,
      `<button data-thumb-action="delete" title="Eliminar página">${ICONS.trash}</button>`
    ].join('');

    item.append(canvas, num, tools);
    container.appendChild(item);
    thumbObserver.observe(item);
  });

  markCurrentThumb();
}

async function renderThumb(item) {
  const index = Number(item.dataset.index);
  const page = state.pages[index];
  if (!page) return;
  const canvas = item.querySelector('canvas');
  const base = getViewport(page, 1);
  const width = 158;
  const scale = width / base.width;
  const viewport = getViewport(page, scale);
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  if (page.pageRef) {
    try {
      await page.pageRef.render({ canvasContext: ctx, viewport }).promise;
    } catch (error) {
      console.warn('Miniatura no disponible', index, error);
    }
  }
}

function markCurrentThumb() {
  $$('.thumb').forEach((item) => {
    item.classList.toggle('current', Number(item.dataset.index) === state.current);
  });
}

/* ------------------------------- Página --------------------------------- */

function updateCurrentFromScroll() {
  if (!pageEntries.length) return;
  const viewer = $('#viewer');
  const viewerRect = viewer.getBoundingClientRect();
  const targetY = viewerRect.top + viewerRect.height * 0.32;
  let index = 0;
  for (let i = 0; i < pageEntries.length; i += 1) {
    const rect = pageEntries[i].el.getBoundingClientRect();
    if (rect.top <= targetY && rect.bottom > targetY) {
      index = i;
      break;
    }
    if (rect.top > targetY) {
      index = Math.max(0, i - 1);
      break;
    }
  }
  if (index !== state.current) {
    state.current = index;
    updateUI();
  }
}

function scrollToPage(index, smooth = true) {
  const target = clamp(index, 0, state.pages.length - 1);
  const entry = pageEntries[target];
  if (!entry) return;
  const viewer = $('#viewer');
  const vr = viewer.getBoundingClientRect();
  const pr = entry.el.getBoundingClientRect();
  const top = viewer.scrollTop + (pr.top - vr.top) - 18;
  viewer.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  state.current = target;
  updateUI();
}

function zoomBy(factor) {
  state.scale = clamp(state.scale * factor, 0.25, 5);
  state.fit = 'none';
  renderDocument();
  updateZoomUI();
}

function setZoom(value) {
  state.scale = clamp(value, 0.25, 5);
  state.fit = 'none';
  renderDocument();
  updateZoomUI();
}

function fitWidth(render = true) {
  if (!state.pages.length) return;
  const viewer = $('#viewer');
  const avail = Math.max(260, viewer.clientWidth - 64);
  const maxWidth = Math.max(...state.pages.map((p) => getViewport(p, 1).width));
  state.scale = clamp(avail / maxWidth, 0.25, 3.5);
  state.fit = 'width';
  if (render) {
    renderDocument();
    updateZoomUI();
  }
}

/* --------------------------- Operaciones de página ---------------------- */

function pushUndo() {
  state.undoStack.push(snapshotPages());
  if (state.undoStack.length > 60) state.undoStack.shift();
  state.redoStack = [];
}

function snapshotPages() {
  return state.pages.map((page) => ({
    ...page,
    anns: page.anns.map((ann) => ({
      ...ann,
      points: ann.points ? ann.points.map((p) => [p[0], p[1]]) : undefined
    })),
    textEdits: (page.textEdits || []).map((edit) => ({
      ...edit,
      itemIndices: edit.itemIndices ? edit.itemIndices.slice() : undefined,
      lines: edit.lines ? edit.lines.map((line) => ({ ...line })) : undefined,
      runs: edit.runs ? edit.runs.map((line) => line.map((run) => ({ ...run }))) : undefined
    }))
  }));
}

function restoreSnapshot(snapshot) {
  state.pages = snapshot.map((page) => ({
    ...page,
    anns: page.anns.map((ann) => ({
      ...ann,
      points: ann.points ? ann.points.map((p) => [p[0], p[1]]) : undefined
    })),
    textEdits: (page.textEdits || []).map((edit) => ({
      ...edit,
      itemIndices: edit.itemIndices ? edit.itemIndices.slice() : undefined,
      lines: edit.lines ? edit.lines.map((line) => ({ ...line })) : undefined,
      runs: edit.runs ? edit.runs.map((line) => line.map((run) => ({ ...run }))) : undefined
    }))
  }));
  state.selectedAnn = null;
  state.current = clamp(state.current, 0, Math.max(0, state.pages.length - 1));
  renderDocument();
  rebuildThumbs();
  renderAnnList();
  renderTextEditList();
  renderSelectedInfo();
  updateUI();
}

function undo() {
  if (!state.undoStack.length) return;
  const previous = state.undoStack.pop();
  state.redoStack.push(snapshotPages());
  restoreSnapshot(previous);
  toast('Deshecho');
}

function redo() {
  if (!state.redoStack.length) return;
  const next = state.redoStack.pop();
  state.undoStack.push(snapshotPages());
  restoreSnapshot(next);
  toast('Rehecho');
}

function rotateCurrentPage() {
  const page = currentPage();
  if (!page) return;
  pushUndo();
  page.rotation = (page.rotation + 90) % 360;
  renderDocument();
  rebuildThumbs();
  markDirty();
}

function deletePage(index) {
  if (state.pages.length <= 1) {
    toast('El documento debe conservar al menos una página.');
    return;
  }
  pushUndo();
  state.pages.splice(index, 1);
  state.current = clamp(state.current, 0, state.pages.length - 1);
  renderDocument({ keepPosition: false });
  rebuildThumbs();
  renderAnnList();
  markDirty();
}

function movePage(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.pages.length) return;
  pushUndo();
  const [page] = state.pages.splice(index, 1);
  state.pages.splice(target, 0, page);
  state.current = target;
  renderDocument({ keepPosition: false });
  rebuildThumbs();
  markDirty();
}

function insertBlankPage() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  const reference = currentPage();
  const size = reference ? basePageSize(reference) : { width: 595.28, height: 841.89 };
  pushUndo();
  const page = {
    id: uid(),
    docId: null,
    index: -1,
    pageRef: null,
    width: size.width,
    height: size.height,
    rotation: 0,
    anns: [],
    textItems: [],
    textEdits: []
  };
  state.pages.splice(state.current + 1, 0, page);
  state.current += 1;
  renderDocument({ keepPosition: false });
  rebuildThumbs();
  scrollToPage(state.current, false);
  markDirty();
}

async function mergePdf() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  try {
    const result = await api.openDialog();
    if (!result) return;
    const ok = await loadPdf(result.data, result.name, result.path, { append: true });
    if (ok) markDirty();
  } catch (error) {
    console.error(error);
    toast('No se pudo combinar el PDF: ' + error.message, 5200);
  }
}

async function ocrCurrentPage() {
  return await ocrPageAt(state.current);
}

async function ocrPageAt(index) {
  const page = state.pages[index];
  const entry = pageEntries[index];
  if (!page || !entry || !page.pageRef) {
    toast('No hay una página válida para aplicar OCR.');
    return;
  }
  if ((page.textEdits || []).some((edit) => edit.ocr)) {
    toast('Esta página ya tiene texto OCR. Edítalo desde la pestaña «Notas».');
    return;
  }
  if (!page.textItems.length) {
    try {
      const textContent = await page.pageRef.getTextContent();
      page.textItems = extractTextItems(textContent, page);
    } catch (error) {
      /* sin capa de texto */
    }
  }
  if (page.textItems.length) {
    toast('Esta página ya tiene texto seleccionable; no es necesario aplicar OCR.');
    return;
  }

  toast('Reconociendo texto con el OCR de Windows…', 120000);
  try {
    const scale = 2;
    const viewport = page.pageRef.getViewport({ scale, rotation: totalRotation(page) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.pageRef.render({ canvasContext: context, viewport }).promise;

    const png = dataUrlToBytes(canvas.toDataURL('image/png'));
    const result = await api.ocrPage(png);
    const lines = (result && result.lines) || [];
    if (!lines.length) {
      toast('No se reconoció texto en esta página.');
      return;
    }

    pushUndo();
    const records = [];
    lines.forEach((line) => {
      const text = String(line.text || '').trim();
      if (!text) return;
      const topLeft = viewport.convertToPdfPoint(line.x, line.y);
      const topRight = viewport.convertToPdfPoint(line.x + line.w, line.y);
      const bottomLeft = viewport.convertToPdfPoint(line.x, line.y + line.h);
      const bottomRight = viewport.convertToPdfPoint(line.x + line.w, line.y + line.h);

      const widthVector = [topRight[0] - topLeft[0], topRight[1] - topLeft[1]];
      const downVector = [bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]];
      const widthLength = Math.hypot(widthVector[0], widthVector[1]) || 1;
      const heightLength = Math.hypot(downVector[0], downVector[1]) || 1;
      const ux = widthVector[0] / widthLength;
      const uy = widthVector[1] / widthLength;
      const downX = downVector[0] / heightLength;
      const downY = downVector[1] / heightLength;
      const fontSize = Math.max(5, heightLength * 1.25);
      const baselineX = topLeft[0] + downX * heightLength * 0.8;
      const baselineY = topLeft[1] + downY * heightLength * 0.8;
      const colors = sampleTextColors({ canvas }, {
        left: line.x,
        top: line.y,
        width: line.w,
        height: line.h
      }, 1);

      const corners = [topLeft, topRight, bottomRight, bottomLeft];
      const xs = corners.map((point) => point[0]);
      const ys = corners.map((point) => point[1]);
      records.push({
        id: uid(),
        itemIndices: [],
        original: '',
        lines: [{
          x: baselineX,
          y: baselineY,
          width: widthLength,
          fontSize,
          ascent: 0.82,
          descent: -0.22,
          ux,
          uy,
          angle: Math.atan2(uy, ux),
          vertical: false
        }],
        ocrPdfBox: {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys)
        },
        ocrCorners: corners,
        x: baselineX,
        y: baselineY,
        width: widthLength,
        fontSize,
        ascent: 0.82,
        descent: -0.22,
        ux,
        uy,
        angle: Math.atan2(uy, ux),
        text,
        family: 'helvetica',
        bold: false,
        italic: false,
        color: colors.color,
        bg: colors.bg,
        ocr: true
      });
    });
    if (!records.length) {
      toast('No se reconoció texto en esta página.');
      return;
    }
    page.textEdits.push(...records);
    await renderPage(index);
    renderAnnList();
    renderTextEditList();
    markDirty();
    toast(`OCR completado: ${records.length} líneas editables.`, 5200);
  } catch (error) {
    console.error(error);
    toast('No se pudo aplicar OCR: ' + error.message, 6000);
  }
}

/* -------------------------------- Búsqueda ------------------------------ */

function toggleSearch(force) {
  const bar = $('#searchbar');
  const show = typeof force === 'boolean' ? force : bar.hidden;
  bar.hidden = !show;
  if (show) {
    $('#searchInput').focus();
    $('#searchInput').select();
  } else {
    state.search = { query: '', matches: [], index: -1 };
    $('#searchCount').textContent = '';
  }
}

let searchTimer = null;

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 320);
}

async function runSearch() {
  const query = $('#searchInput').value.trim();
  if (!query || !state.pages.length) {
    state.search = { query: '', matches: [], index: -1 };
    $('#searchCount').textContent = '';
    return;
  }
  const matches = [];
  const needle = query.toLowerCase();
  for (let i = 0; i < state.pages.length; i += 1) {
    const page = state.pages[i];
    if (page.pageRef) {
      try {
        const textContent = await page.pageRef.getTextContent();
        const text = textContent.items.map((item) => item.str).join(' ');
        const haystack = text.toLowerCase();
        let at = haystack.indexOf(needle);
        while (at !== -1) {
          matches.push({
            page: i,
            snippet: text.slice(Math.max(0, at - 45), at + query.length + 45).trim()
          });
          at = haystack.indexOf(needle, at + needle.length);
          if (matches.length > 500) break;
        }
      } catch (error) {
        console.warn('Búsqueda: página no legible', i, error);
      }
    }
    (page.textEdits || []).forEach((edit) => {
      const text = String(edit.text || '');
      if (!text) return;
      const haystack = text.toLowerCase();
      let at = haystack.indexOf(needle);
      while (at !== -1) {
        matches.push({
          page: i,
          snippet: text.slice(Math.max(0, at - 45), at + query.length + 45).replace(/\n/g, ' ').trim()
        });
        at = haystack.indexOf(needle, at + needle.length);
        if (matches.length > 500) return;
      }
    });
    if (matches.length > 500) break;
  }
  state.search = { query, matches, index: matches.length ? 0 : -1 };
  $('#searchCount').textContent = matches.length ? `1 / ${matches.length}` : 'Sin resultados';
  if (matches.length) scrollToPage(matches[0].page);
}

function nextMatch(direction) {
  const { matches } = state.search;
  if (!matches.length) return;
  state.search.index = (state.search.index + direction + matches.length) % matches.length;
  $('#searchCount').textContent = `${state.search.index + 1} / ${matches.length}`;
  scrollToPage(matches[state.search.index].page);
}

/* ------------------------------- Formulario ----------------------------- */

function readFormFieldsFromDocument(doc) {
  return doc.getForm().getFields().map((field) => {
    const name = field.getName();
    const type = formFieldType(field);
    let value = '';
    let options = [];
    try {
      if (type === 'text') value = field.getText() || '';
      else if (type === 'checkbox') value = field.isChecked();
      else if (type === 'radio') {
        value = field.getSelected() || '';
        options = field.getOptions();
      } else if (type === 'dropdown') {
        value = (field.getSelected() || [])[0] || '';
        options = field.getOptions();
      } else if (type === 'optionlist') {
        value = (field.getSelected() || []).join(', ');
        options = field.getOptions();
      }
    } catch (error) {
      /* campo no legible */
    }
    return { name, type, value, options };
  });
}

async function loadAppendedFormFields(record) {
  if (!record || record.encrypted || record.xfa) return;
  try {
    const doc = await PDFDocument.load(record.bytes, { ignoreEncryption: true });
    const fields = readFormFieldsFromDocument(doc);
    let added = false;
    fields.forEach((field) => {
      if (state.formFields.some((existing) => existing.name === field.name)) return;
      state.formFields.push(field);
      if (state.formValues[field.name] === undefined) state.formValues[field.name] = field.value;
      added = true;
    });
    if (added) renderFormPanel();
  } catch (error) {
    console.warn('Formulario combinado no disponible', error);
  }
}

async function loadFormFields() {
  state.formFields = [];
  state.formValues = {};
  state.formBlocked = '';
  const first = state.pages[0];
  if (!first) {
    renderFormPanel();
    return;
  }
  const rec = state.docs.get(first.docId);
  if (!rec) return;
  if (rec.encrypted || rec.xfa) {
    state.formBlocked = rec.xfa
      ? 'Formulario XFA: se puede ver y exportar rasterizado, pero no editar sus campos.'
      : 'Documento cifrado: sus campos no se pueden editar; se exportará rasterizado.';
    renderFormPanel();
    return;
  }
  try {
    const doc = await PDFDocument.load(rec.bytes, { ignoreEncryption: true });
    const fields = readFormFieldsFromDocument(doc);
    state.formFields = fields;
    fields.forEach((field) => {
      state.formValues[field.name] = field.value;
    });
  } catch (error) {
    console.warn('Formulario no disponible', error);
  }
  renderFormPanel();
}

function renderFormPanel() {
  const container = $('#formFields');
  container.innerHTML = '';
  if (!state.formFields.length) {
    container.innerHTML = state.formBlocked
      ? `<p class="form-empty">${escapeHtml(state.formBlocked)}</p>`
      : '<p class="form-empty">Este documento no tiene campos de formulario.</p>';
    return;
  }
  state.formFields.forEach((field) => {
    const label = document.createElement('label');
    label.className = 'field';
    label.textContent = field.name;

    if (field.type === 'checkbox') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(field.value);
      input.addEventListener('change', () => {
        state.formValues[field.name] = input.checked;
        markDirty();
      });
      label.appendChild(input);
    } else if (field.type === 'radio' || field.type === 'dropdown') {
      const select = document.createElement('select');
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '—';
      select.appendChild(empty);
      (field.options || []).forEach((option) => {
        const opt = document.createElement('option');
        opt.value = option;
        opt.textContent = option;
        if (option === field.value) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        state.formValues[field.name] = select.value;
        markDirty();
      });
      label.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = field.value || '';
      input.addEventListener('input', () => {
        state.formValues[field.name] = input.value;
        markDirty();
      });
      label.appendChild(input);
    }
    container.appendChild(label);
  });
}

/* -------------------------------- Guardar ------------------------------- */

async function saveCopy() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  try {
    toast('Preparando el PDF…', 1500);
    const bytes = await buildPdf();
    const base = (state.fileName || 'documento.pdf').replace(/\.pdf$/i, '');
    const result = await api.saveDialog(`${base}-editado.pdf`, bytes);
    if (result.ok) {
      state.dirty = false;
      updateUI();
      await clearRecovery();
      toast('Guardado en: ' + result.path, 5200);
    }
  } catch (error) {
    console.error(error);
    toast('No se pudo guardar: ' + error.message, 6000);
  }
}

/* ------------------------- Imprimir, cifrar, extraer --------------------- */

async function printDocument() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  const total = state.pages.length;
  if (total > 120) {
    toast('El documento es muy grande para imprimir desde aquí (máximo 120 páginas).', 7000);
    return;
  }
  toast('Preparando la impresión…', 600000);
  try {
    const bytes = await buildPdf();
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const pages = [];
    let firstSize = null;
    const scale = 200 / 72;
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const rotation = ((page.rotate % 360) + 360) % 360;
      const viewport = page.getViewport({ scale, rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const box = page.view;
      const sideways = rotation === 90 || rotation === 270;
      const width = sideways ? box[3] - box[1] : box[2] - box[0];
      const height = sideways ? box[2] - box[0] : box[3] - box[1];
      if (!firstSize) firstSize = { width, height };
      pages.push(canvas.toDataURL('image/png'));
    }
    try { doc.destroy(); } catch (error) { /* ya cerrado */ }

    const result = await api.printPages({
      pages,
      width: firstSize ? firstSize.width : 595.28,
      height: firstSize ? firstSize.height : 841.89,
      name: state.fileName
    });
    if (result && result.cancelled) {
      toast('Impresión cancelada.');
    } else if (result && result.ok) {
      toast('Documento enviado a la impresora.', 5200);
    } else {
      toast((result && result.error) || 'No se pudo imprimir.', 6000);
    }
  } catch (error) {
    console.error(error);
    toast('No se pudo imprimir: ' + error.message, 6000);
  }
}

async function protectDocument() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  const password = await askPrompt({
    title: 'Proteger con contraseña',
    message: 'Se guardará una copia cifrada con AES-256. Necesitarás esta contraseña para abrirla.',
    password: true,
    okLabel: 'Cifrar',
    placeholder: 'Contraseña',
    validate: (text) => (String(text).length >= 4 ? null : 'Usa al menos 4 caracteres.')
  });
  if (password === null) return;

  toast('Cifrando el documento…', 600000);
  try {
    const bytes = await buildPdf();
    const result = await api.encryptPdf(bytes, password);
    if (!result || !result.ok) {
      toast((result && result.error) || 'No se pudo cifrar el PDF.', 7000);
      return;
    }
    const base = (state.fileName || 'documento.pdf').replace(/\.pdf$/i, '');
    const saved = await api.saveDialog(`${base}-protegido.pdf`, new Uint8Array(result.data));
    if (saved && saved.ok) {
      toast('Copia protegida guardada en: ' + saved.path, 6500);
    }
  } catch (error) {
    console.error(error);
    toast('No se pudo cifrar: ' + error.message, 6000);
  }
}

async function extractPages() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  const total = state.pages.length;
  const range = await askPrompt({
    title: 'Extraer páginas',
    message: `Indica las páginas que quieres extraer (de 1 a ${total}). Ejemplo: 1-3,5`,
    value: '1',
    okLabel: 'Extraer',
    validate: (text) => (parsePageRange(text, total).length ? null : `Rango no válido para un documento de ${total} página(s).`)
  });
  if (range === null) return;

  const pages = parsePageRange(range, total);
  const normalized = pages.join(',');
  toast('Extrayendo páginas…', 600000);
  try {
    const bytes = await buildPdf();
    const result = await api.extractPages(bytes, normalized);
    if (!result || !result.ok) {
      toast((result && result.error) || 'No se pudieron extraer las páginas.', 7000);
      return;
    }
    const base = (state.fileName || 'documento.pdf').replace(/\.pdf$/i, '');
    const saved = await api.saveDialog(`${base}-paginas.pdf`, new Uint8Array(result.data));
    if (saved && saved.ok) {
      toast(`${pages.length} página(s) guardadas en: ${saved.path}`, 6500);
    }
  } catch (error) {
    console.error(error);
    toast('No se pudieron extraer las páginas: ' + error.message, 6000);
  }
}

/* ------------------------------- Copiar texto ---------------------------- */

async function pageTextItems(page) {
  if (page.textItems && page.textItems.length) return page.textItems;
  if (!page.pageRef) return [];
  try {
    const content = await page.pageRef.getTextContent();
    page.textItems = extractTextItems(content, page);
  } catch (error) {
    return [];
  }
  return page.textItems;
}

function plainTextOfPage(page, items) {
  if (!items.length) return '';
  const lines = groupItemsIntoLines(items.map((item) => ({
    ...item,
    ...fontDetails(page, item)
  })));
  return lines
    .map((line) => lineToRuns(line, '#111111').map((run) => run.text).join(''))
    .filter((line) => line.trim())
    .join('\n');
}

async function copyText(scope) {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  const pages = scope === 'all' ? state.pages : [state.pages[state.current]].filter(Boolean);
  const parts = [];
  for (const page of pages) {
    const items = await pageTextItems(page);
    const text = plainTextOfPage(page, items);
    if (text) parts.push(text);
  }
  const text = parts.join('\n\n').trim();
  if (!text) {
    toast('Este documento no tiene texto seleccionable.');
    return;
  }
  try {
    await api.copyText(text);
    toast(scope === 'all' ? 'Texto del documento copiado.' : 'Texto de la página copiado.');
  } catch (error) {
    toast('No se pudo copiar el texto.', 5000);
  }
}

// Ctrl+C: si hay un campo de texto enfocado, se deja el copiado normal.
function isTypingTarget() {
  const element = document.activeElement;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable;
}

async function openRecentFile(filePath) {
  if (!(await confirmDiscard())) return;
  try {
    const result = await api.openPath(filePath);
    if (result) await loadPdf(result.data, result.name, result.path);
  } catch (error) {
    toast('No se pudo abrir el archivo reciente: ' + error.message, 6000);
  }
}

/* -------------------------------- Idioma --------------------------------- */

const i18n = window.ZeroPDFI18n;
let currentLanguage = 'es';
let i18nFrame = null;

function tr(text, vars) {
  return i18n.t(text, vars);
}

function applyLanguage(code, options = {}) {
  const settings = options || {};
  currentLanguage = i18n.setLanguage(code || 'es');
  try {
    localStorage.setItem('zeropdf-lang', currentLanguage);
  } catch (error) {
    /* sin persistencia */
  }
  document.documentElement.lang = currentLanguage === 'zhTW' ? 'zh-TW' : currentLanguage;
  if (settings.translate !== false) {
    i18n.translateElement(document.body);
  }
  if (settings.notify !== false) {
    try {
      api.setLanguage(currentLanguage);
    } catch (error) {
      /* sin proceso principal */
    }
  }
}

// Traduce solo los nodos nuevos: la interfaz se redibuja a menudo y no
// conviene recorrer todo el árbol en cada cambio.
function watchTranslations() {
  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver((mutations) => {
    if (currentLanguage === 'es') return;
    if (i18nFrame) return;
    i18nFrame = requestAnimationFrame(() => {
      i18nFrame = null;
      mutations.forEach((mutation) => {
        if (mutation.type === 'characterData') {
          const parent = mutation.target.parentElement;
          if (parent) i18n.translateElement(parent);
          return;
        }
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) i18n.translateElement(node);
          else if (node.nodeType === 3 && node.parentElement) i18n.translateElement(node.parentElement);
        });
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

/* -------------------------------- Tema ----------------------------------- */

function applyTheme(theme) {
  const light = theme === 'light';
  document.body.classList.toggle('theme-light', light);
  state.theme = light ? 'light' : 'dark';
  try {
    localStorage.setItem('zeropdf-theme', state.theme);
  } catch (error) {
    /* sin persistencia */
  }
}

function toggleTheme() {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
  toast(state.theme === 'light' ? 'Tema claro.' : 'Tema oscuro.');
}

/* -------------------------------- Índice --------------------------------- */

let outlineRenderToken = 0;

async function renderOutline() {
  const list = $('#outlineList');
  if (!list) return;
  const token = ++outlineRenderToken;
  list.innerHTML = '';
  if (!state.pages.length) {
    list.innerHTML = '<p class="outline-empty">Sin documento.</p>';
    return;
  }
  let count = 0;
  for (const [docId, record] of state.docs) {
    let outline = null;
    try {
      outline = await record.doc.getOutline();
    } catch (error) {
      outline = null;
    }
    // Otra llamada más reciente ha reiniciado la lista: se descarta esta.
    if (token !== outlineRenderToken) return;
    if (!outline || !outline.length) continue;
    const walk = (items, level) => {
      items.forEach((entry) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'outline-item';
        button.dataset.level = String(Math.min(4, level));
        button.textContent = entry.title || '(sin título)';
        button.addEventListener('click', () => gotoOutlineDest(docId, entry.dest));
        list.appendChild(button);
        count += 1;
        if (entry.items && entry.items.length) walk(entry.items, level + 1);
      });
    };
    walk(outline, 0);
  }
  if (!count) {
    list.innerHTML = '<p class="outline-empty">Este documento no tiene marcadores.</p>';
  }
}

async function gotoOutlineDest(docId, dest) {
  const record = state.docs.get(docId);
  if (!record || !dest) return;
  try {
    let target = dest;
    if (typeof target === 'string') target = await record.doc.getDestination(target);
    if (!Array.isArray(target) || !target.length) return;
    const pageIndex = await record.doc.getPageIndex(target[0]);
    const index = state.pages.findIndex((page) => page.docId === docId && page.index === pageIndex);
    if (index >= 0) scrollToPage(index);
  } catch (error) {
    /* destino no válido */
  }
}

/* -------------------------------- Enlaces -------------------------------- */

async function loadPageLinks(page) {
  if (!page || !page.pageRef || page.links) return;
  page.links = [];
  try {
    const annotations = await page.pageRef.getAnnotations();
    page.links = annotations
      .filter((ann) => ann.subtype === 'Link' && Array.isArray(ann.rect))
      .map((ann) => ({
        rect: [
          Math.min(ann.rect[0], ann.rect[2]),
          Math.min(ann.rect[1], ann.rect[3]),
          Math.max(ann.rect[0], ann.rect[2]),
          Math.max(ann.rect[1], ann.rect[3])
        ],
        url: ann.url || ann.unsafeUrl || null,
        dest: ann.dest || null
      }))
      .filter((link) => link.url || link.dest);
  } catch (error) {
    page.links = [];
  }
}

function linkAt(page, point) {
  if (!page || !page.links || !page.links.length) return null;
  return page.links.find((link) => point[0] >= link.rect[0] && point[0] <= link.rect[2]
    && point[1] >= link.rect[1] && point[1] <= link.rect[3]) || null;
}

function activateLink(link, page) {
  if (!link) return;
  if (link.url) {
    api.openUrl(link.url);
    return;
  }
  if (link.dest && page.docId) gotoOutlineDest(page.docId, link.dest);
}

/* ------------------------------- Recorte --------------------------------- */

function cropMarginsFromPanel() {
  const value = (selector) => Math.max(0, Number($(selector).value) || 0);
  const toPt = (mm) => (mm / 25.4) * 72;
  return {
    top: toPt(value('#cropTop')),
    bottom: toPt(value('#cropBottom')),
    left: toPt(value('#cropLeft')),
    right: toPt(value('#cropRight'))
  };
}

function applyCrop(scope) {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  const crop = cropMarginsFromPanel();
  if (!crop.top && !crop.bottom && !crop.left && !crop.right) {
    toast('Indica al menos un margen en milímetros.');
    return;
  }
  const targets = scope === 'all' ? state.pages : [state.pages[state.current]];
  let applied = 0;
  pushUndo();
  targets.forEach((page) => {
    if (!page) return;
    const { width, height } = pdfPageSize(page);
    const usableWidth = width - crop.left - crop.right;
    const usableHeight = height - crop.top - crop.bottom;
    if (usableWidth < 30 || usableHeight < 30) return;
    page.crop = { ...crop };
    applied += 1;
  });
  if (!applied) {
    toast('El recorte deja la página sin superficie.', 5200);
    return;
  }
  state.pages.forEach((page, index) => redrawPage(index));
  markDirty();
  toast(applied === 1 ? tr('Recorte aplicado a la página.') : tr('Recorte aplicado a {n} páginas.', { n: applied }));
}

function clearCrop() {
  const targets = state.pages.filter((page) => page.crop);
  if (!targets.length) {
    toast('No hay recortes aplicados.');
    return;
  }
  pushUndo();
  state.pages.forEach((page) => { delete page.crop; });
  state.pages.forEach((page, index) => redrawPage(index));
  markDirty();
  toast('Recorte eliminado.');
}

/* --------------------------- Mover páginas ------------------------------- */

function movePageTo(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.pages.length || to >= state.pages.length) return;
  pushUndo();
  const [page] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, page);
  state.current = to;
  renderDocument({ keepPosition: false });
  rebuildThumbs();
  markDirty();
}

/* --------------------------- Recuperación automática --------------------- */

let recoveryTimer = null;
let recoveryBusy = false;

function startRecoveryTimer() {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(async () => {
    if (recoveryBusy || !state.dirty || !state.pages.length) return;
    recoveryBusy = true;
    try {
      const bytes = await buildPdf();
      await api.saveRecovery(bytes, state.fileName || 'documento.pdf');
    } catch (error) {
      /* se reintenta en el siguiente ciclo */
    } finally {
      recoveryBusy = false;
    }
  }, 60000);
}

async function clearRecovery() {
  try {
    await api.clearRecovery();
  } catch (error) {
    /* sin copia previa */
  }
}

/* --------------------------- Comprimir / aplanar -------------------------- */

async function compressPdf() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  toast('Optimizando el PDF…', 600000);
  try {
    const bytes = await buildPdf();
    const result = await api.compressPdf(bytes);
    if (!result || !result.ok) {
      toast((result && result.error) || 'No se pudo comprimir el PDF.', 7000);
      return;
    }
    const data = new Uint8Array(result.data);
    const base = (state.fileName || 'documento.pdf').replace(/\.pdf$/i, '');
    const saved = await api.saveDialog(`${base}-optimizado.pdf`, data);
    if (saved && saved.ok) {
      const before = bytes.length / 1024;
      const after = data.length / 1024;
      const saving = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      toast(`Guardado (${Math.round(before)} KB → ${Math.round(after)} KB, ${saving}% menos).`, 7000);
    }
  } catch (error) {
    toast('No se pudo comprimir: ' + error.message, 6000);
  }
}

async function exportPageImage() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  const page = state.pages[state.current];
  const entry = pageEntries[state.current];
  if (!page || !entry || !entry.vp) {
    toast('No hay una página válida.');
    return;
  }
  toast('Generando la imagen…', 600000);
  try {
    // Se exporta el PDF completo (con cambios) y se rasteriza la página actual.
    const bytes = await buildPdf();
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const target = await doc.getPage(state.current + 1);
    const viewport = target.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await target.render({ canvasContext: context, viewport }).promise;
    try { doc.destroy(); } catch (error) { /* ya cerrado */ }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No se pudo crear la imagen.');
    const buffer = await blob.arrayBuffer();
    const base = (state.fileName || 'documento.pdf').replace(/\.pdf$/i, '');
    const result = await api.saveImage(new Uint8Array(buffer), `${base}-pagina-${state.current + 1}.png`);
    if (result && result.ok) toast('Imagen guardada en: ' + result.path, 6000);
    else if (result && !result.cancelled) toast(result.error || 'No se pudo guardar la imagen.', 6000);
  } catch (error) {
    toast('No se pudo exportar la página: ' + error.message, 6000);
  }
}

async function ocrAllPages() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  if (ocrRunning) {
    toast('El OCR ya está en marcha.');
    return;
  }
  ocrRunning = true;
  const total = state.pages.length;
  let done = 0;
  try {
    for (let index = 0; index < total; index += 1) {
      const page = state.pages[index];
      if (!page || !page.pageRef) continue;
      if ((page.textEdits || []).some((edit) => edit.ocr)) continue;
      let items = page.textItems || [];
      if (!items.length) {
        try {
          items = extractTextItems(await page.pageRef.getTextContent(), page);
          page.textItems = items;
        } catch (error) {
          items = [];
        }
      }
      if (items.length) continue;
      toast(tr('OCR: página {n} de {total}…', { n: index + 1, total }), 600000);
      await ocrPageAt(index);
      done += 1;
    }
    toast(done
      ? tr('OCR terminado en {n} página(s).', { n: done })
      : tr('No hay páginas escaneadas que reconocer.'), 6000);
    if (done) markDirty();
  } catch (error) {
    toast('No se pudo completar el OCR: ' + error.message, 6000);
  } finally {
    ocrRunning = false;
  }
}

async function insertPagesFromPdf() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  try {
    const result = await api.openDialog();
    if (!result) return;
    const before = state.pages.length;
    const ok = await loadPdf(result.data, result.name, result.path, { append: true });
    if (!ok) return;
    const added = state.pages.length - before;
    if (!added) {
      toast('El PDF no contiene páginas.');
      return;
    }
    const position = await askPrompt({
      title: 'Insertar páginas',
      message: tr('Se añadirán {n} página(s) de «{name}». ¿Después de qué página quieres insertarlas? (0 = al principio)', { n: added, name: result.name }),
      value: String(state.current + 1),
      okLabel: 'Insertar',
      validate: (text) => (/^\d+$/.test(String(text).trim()) && Number(text) >= 0 && Number(text) <= before
        ? null
        : tr('Escribe un número entre 0 y {max}.', { max: before }))
    });
    if (position === null) {
      // Se descartan las páginas añadidas al final.
      state.pages.splice(before, added);
      renderDocument({ keepPosition: true });
      rebuildThumbs();
      updateUI();
      return;
    }
    const target = Number(position);
    pushUndo();
    const inserted = state.pages.splice(before, added);
    state.pages.splice(target, 0, ...inserted);
    state.current = target;
    renderDocument({ keepPosition: false });
    rebuildThumbs();
    markDirty();
    toast(tr('{n} página(s) insertadas.', { n: added }));
  } catch (error) {
    console.error(error);
    toast('No se pudieron insertar las páginas: ' + error.message, 6000);
  }
}

let ocrRunning = false;

async function flattenForms() {  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  if (!state.formFields.length) {
    toast('Este documento no tiene campos de formulario.');
    return;
  }
  toast('Aplanando el formulario…', 600000);
  try {
    const bytes = await buildPdf({ flatten: true });
    const base = (state.fileName || 'documento.pdf').replace(/\.pdf$/i, '');
    const saved = await api.saveDialog(`${base}-aplanado.pdf`, bytes);
    if (saved && saved.ok) toast('Formulario aplanado y guardado en: ' + saved.path, 6500);
  } catch (error) {
    toast('No se pudo aplanar el formulario: ' + error.message, 6000);
  }
}

async function openRecovery() {
  try {
    const recovered = await api.readRecovery();
    if (!recovered) return;
    await loadPdf(recovered.data, recovered.name || 'documento.pdf', '');
    state.dirty = true;
    updateUI();
    toast('Documento recuperado. Guárdalo con Ctrl+S.', 7000);
  } catch (error) {
    toast('No se pudo recuperar el documento: ' + error.message, 6000);
  }
}

/* ------------------------- Firma dibujada a mano ------------------------- */

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo cargar la imagen.'));
    image.src = source;
  });
}

function drawSignature(forceNew) {
  return new Promise((resolve) => {
    if (!forceNew) {
      let saved = null;
      try {
        saved = localStorage.getItem('zeropdf-signature');
      } catch (error) {
        saved = null;
      }
      if (saved) {
        resolve(saved);
        return;
      }
    }
    const modal = $('#signModal');
    const canvas = $('#signCanvas');
    const context = canvas.getContext('2d');
    const errorNode = $('#signError');
    let drawing = false;
    let painted = false;

    const reset = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineWidth = 3;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = '#111111';
      painted = false;
      errorNode.textContent = '';
    };
    reset();

    const pointFrom = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [
        ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height
      ];
    };
    const onDown = (event) => {
      drawing = true;
      painted = true;
      const point = pointFrom(event);
      context.beginPath();
      context.moveTo(point[0], point[1]);
      event.preventDefault();
    };
    const onMove = (event) => {
      if (!drawing) return;
      const point = pointFrom(event);
      context.lineTo(point[0], point[1]);
      context.stroke();
      event.preventDefault();
    };
    const onUp = () => { drawing = false; };

    const cleanup = (value) => {
      modal.hidden = true;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      $('#signClear').removeEventListener('click', onClear);
      $('#signCancel').removeEventListener('click', onCancel);
      $('#signUse').removeEventListener('click', onUse);
      resolve(value);
    };
    const onClear = () => reset();
    const onCancel = () => cleanup(null);
    const onUse = () => {
      if (!painted) {
        errorNode.textContent = 'Dibuja la firma antes de continuar.';
        return;
      }
      cleanup(canvas.toDataURL('image/png'));
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    $('#signClear').addEventListener('click', onClear);
    $('#signCancel').addEventListener('click', onCancel);
    $('#signUse').addEventListener('click', onUse);
    modal.hidden = false;
  });
}

async function insertSignature(forceNew) {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  try {
    const dataURL = await drawSignature(Boolean(forceNew));
    if (!dataURL) return;
    try {
      localStorage.setItem('zeropdf-signature', dataURL);
    } catch (error) {
      /* sin persistencia */
    }
    const image = await loadImageElement(dataURL);
    const width = 220;
    const ratio = image.naturalWidth ? image.naturalHeight / image.naturalWidth : 0.35;
    state.image = { dataURL, width, height: Math.max(20, width * ratio) };
    setTool('image');
    toast('Firma lista: haz clic en la página para colocarla.');
  } catch (error) {
    toast('No se pudo preparar la firma: ' + error.message, 6000);
  }
}

/* --------------------------- Buscar y reemplazar ------------------------- */

async function applySearchReplace(find, replacement) {
  let changes = 0;
  pushUndo();
  for (let index = 0; index < state.pages.length; index += 1) {
    const page = state.pages[index];
    const items = await pageTextItems(page);
    if (!items.length) continue;
    const seen = new Set();
    for (const item of items) {
      const built = buildEditLines(page, item, false);
      if (!built.length) continue;
      const key = built[0].items.map((other) => other.index).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const lineText = built.map((line) => line.text).join('\n');
      if (!lineText.includes(find)) continue;
      const newText = lineText.split(find).join(replacement);
      let colors = { color: '#111111', bg: '#ffffff' };
      const entry = pageEntries[index];
      if (entry && entry.vp) {
        try {
          colors = sampleTextColors(entry, boxViewportRect(built[0].box, entry.vp));
        } catch (error) {
          /* colores por defecto */
        }
      }
      const details = fontDetails(page, built[0].items[0] || item);
      applyTextEdit(index, item, {
        text: newText,
        family: details.family,
        bold: details.bold,
        italic: details.italic,
        color: colors.color,
        bg: colors.bg,
        originalStyle: details
      }, {
        silent: true,
        lines: built.map((line) => line.box),
        itemIndices: built.flatMap((line) => line.items.map((other) => other.index))
      });
      changes += 1;
    }
    redrawPage(index);
  }
  if (changes) {
    markDirty();
    renderTextEditList();
  }
  return changes;
}

async function searchReplace() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  const find = await askPrompt({
    title: 'Buscar y reemplazar',
    message: 'Texto que quieres buscar en todo el documento.',
    value: '',
    okLabel: 'Buscar',
    validate: (text) => (text ? null : 'Escribe el texto a buscar.')
  });
  if (find === null) return;
  const replacement = await askPrompt({
    title: 'Buscar y reemplazar',
    message: tr('Sustituir «{find}» por (déjalo vacío para borrarlo):', { find }),
    value: '',
    okLabel: 'Reemplazar'
  });
  if (replacement === null) return;

  toast('Reemplazando…', 600000);
  const changes = await applySearchReplace(find, replacement);
  if (changes) {
    toast(tr('{n} línea(s) modificadas.', { n: changes }), 5200);
  } else {
    toast(tr('No se encontró «{find}».', { find }), 5200);
  }
}

/* ---------------------- Marcadores desde los títulos --------------------- */

async function detectBookmarks() {
  const sizes = [];
  const lines = [];
  for (let index = 0; index < state.pages.length; index += 1) {
    const page = state.pages[index];
    const items = await pageTextItems(page);
    if (!items.length) continue;
    const grouped = groupItemsIntoLines(items.map((item) => ({ ...item, ...fontDetails(page, item) })));
    grouped.forEach((line) => {
      const runs = lineToRuns(line, '#111111');
      const text = runs.map((run) => run.text).join('').trim();
      if (!text || text.length > 140) return;
      const boldLength = runs.filter((run) => run.bold)
        .reduce((total, run) => total + run.text.trim().length, 0);
      sizes.push(line.fontSize);
      lines.push({
        text,
        pageIndex: index,
        size: line.fontSize,
        bold: text.length > 0 && boldLength >= text.length * 0.6,
        width: line.endX - line.startX
      });
    });
  }
  if (!lines.length) return [];

  // Tamaño más repetido = cuerpo del texto.
  const counts = new Map();
  sizes.forEach((size) => counts.set(size, (counts.get(size) || 0) + 1));
  let body = 10;
  let best = 0;
  counts.forEach((count, size) => {
    if (count > best) {
      best = count;
      body = size;
    }
  });

  // Un título suele ser: más grande que el cuerpo, o negrita del mismo tamaño,
  // o una línea corta en mayúsculas que no acaba en punto.
  const isHeading = (line) => {
    if (line.size >= body * 1.22) return true;
    if (line.bold && line.size >= body * 1.02) return true;
    const shortCaps = line.text.length <= 70
      && line.text === line.text.toUpperCase()
      && /[A-ZÁÉÍÓÚÑÜ]/.test(line.text)
      && !/[.;]$/.test(line.text);
    return shortCaps && line.size >= body * 1.02;
  };

  let headings = lines.filter(isHeading);
  if (!headings.length) {
    // Sin pistas de estilo: se usa la primera línea con texto de cada página.
    const seenPages = new Set();
    headings = lines.filter((line) => {
      if (seenPages.has(line.pageIndex)) return false;
      seenPages.add(line.pageIndex);
      return true;
    }).slice(0, 60);
  }

  const unique = Array.from(new Set(headings.map((line) => Math.round(line.size * 10) / 10)))
    .sort((a, b) => b - a);
  return headings.map((line) => ({
    title: line.text,
    pageIndex: line.pageIndex,
    level: Math.max(0, unique.indexOf(Math.round(line.size * 10) / 10))
  }));
}

async function generateBookmarks() {
  if (!state.pages.length) {
    toast('Abre un PDF primero.');
    return;
  }
  toast('Buscando títulos…', 600000);
  try {
    const entries = await detectBookmarks();
    if (!entries.length) {
      toast('No se han detectado títulos.', 5200);
      return;
    }
    state.generatedBookmarks = entries;
    const answer = await askPrompt({
      title: 'Generar marcadores',
      message: tr('Se han detectado {n} título(s). Se añadirán al guardar una copia.\nVista previa: {preview}', {
        n: entries.length,
        preview: entries.slice(0, 3).map((entry) => entry.title).join(' · ')
      }),
      value: '',
      okLabel: 'Guardar copia',
      hideInput: true
    });
    if (answer === null) return;
    const bytes = await buildPdf({ bookmarks: true });
    const base = (state.fileName || 'documento.pdf').replace(/\.pdf$/i, '');
    const saved = await api.saveDialog(`${base}-con-indice.pdf`, bytes);
    if (saved && saved.ok) toast(tr('Guardado con {n} marcadores: {path}', { n: entries.length, path: saved.path }), 7000);
  } catch (error) {
    toast('No se pudieron generar los marcadores: ' + error.message, 6000);
  }
}

// Escribe un índice plano (/Outlines) con los títulos detectados.
function writeOutlines(out, outPages, entries) {
  try {
    if (!entries.length) return;
    if (out.catalog.get(PDFName.of('Outlines'))) return; // no se pisan los existentes
    const context = out.context;
    const rootRef = context.nextRef();
    const items = entries
      .filter((entry) => outPages[entry.pageIndex])
      .map((entry) => ({ entry, ref: context.nextRef() }));
    if (!items.length) return;

    const root = context.obj({
      Type: PDFName.of('Outlines'),
      First: items[0].ref,
      Last: items[items.length - 1].ref,
      Count: PDFNumber.of(items.length)
    });
    items.forEach((item, index) => {
      const page = outPages[item.entry.pageIndex];
      const dict = context.obj({
        Title: PDFHexString.fromText(String(item.entry.title || '')),
        Parent: rootRef,
        Dest: context.obj([
          page.ref,
          PDFName.of('XYZ'),
          PDFNumber.of(0),
          PDFNumber.of(page.getHeight()),
          PDFNull
        ])
      });
      if (index > 0) dict.set(PDFName.of('Prev'), items[index - 1].ref);
      if (index < items.length - 1) dict.set(PDFName.of('Next'), items[index + 1].ref);
      context.assign(item.ref, dict);
    });
    context.assign(rootRef, root);
    out.catalog.set(PDFName.of('Outlines'), rootRef);
  } catch (error) {
    console.warn('No se pudieron escribir los marcadores', error);
  }
}

function documentCanBeSavedInPlace() {
  if (!state.pages.length) return false;
  const first = state.pages[0];
  if (!first.docId || !first.pageRef) return false;
  const record = state.docs.get(first.docId);
  if (!record || record.encrypted || record.xfa) return false;
  if (state.pages.length !== record.numPages) return false;
  return state.pages.every((page, index) =>
    Boolean(page.pageRef) && page.docId === first.docId && page.index === index
  );
}

function applyFormValuesToDocument(doc, values, options = {}) {
  const onlyRefs = options.onlyRefs || null;
  const font = options.font || null;
  let form;
  let changed = false;
  try {
    form = doc.getForm();
  } catch (error) {
    return false;
  }
  form.getFields().forEach((field) => {
    const name = field.getName();
    if (!Object.prototype.hasOwnProperty.call(values, name)) return;
    const value = values[name];
    const type = formFieldType(field);
    try {
      if (type === 'text') {
        if (font && onlyRefs && onlyRefs.has(field.ref.toString())) {
          try {
            field.setFont(font);
          } catch (error) {
            /* fuente original del campo */
          }
        }
        field.setText(String(value ?? ''));
      } else if (type === 'checkbox') {
        if (value) field.check();
        else field.uncheck();
      } else if (type === 'radio' || type === 'dropdown') {
        if (value) field.select(String(value));
        else field.clear();
      } else if (type === 'optionlist') {
        const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
          .map((entry) => String(entry).trim())
          .filter(Boolean);
        if (list.length) field.select(list);
        else field.clear();
      } else {
        return;
      }
      changed = true;
    } catch (error) {
      console.warn('No se pudo aplicar el campo', name, error.message);
    }
  });
  if (changed) {
    try {
      form.updateFieldAppearances();
    } catch (error) {
      /* fuente del campo no disponible */
    }
  }
  return changed;
}

function pruneOrphanFormFields(doc) {
  let acroForm;
  try {
    acroForm = doc.catalog.get(PDFName.of('AcroForm'));
  } catch (error) {
    return;
  }
  if (!acroForm) return;
  let form;
  try {
    form = doc.getForm();
  } catch (error) {
    return;
  }
  const validPages = new Set(doc.getPages().map((page) => page.ref.toString()));
  form.getFields().slice().forEach((field) => {
    let widgets = [];
    try {
      widgets = field.acroField.getWidgets();
    } catch (error) {
      return;
    }
    if (!widgets.length) return;
    const alive = widgets.some((widget) => {
      const pageRef = widget.P();
      return Boolean(pageRef) && validPages.has(pageRef.toString());
    });
    if (!alive) {
      try {
        // Se usa la API de bajo nivel: removeField() de alto nivel intenta
        // localizar la página del widget y falla si esa página ya no existe.
        form.acroForm.removeField(field.acroField);
      } catch (error) {
        console.warn('No se pudo retirar el campo huérfano', field.getName(), error.message);
      }
    }
  });
}

function destinationPageRef(doc, dict) {
  if (!dict || typeof dict.get !== 'function') return undefined;
  let destination = dict.get(PDFName.of('Dest'));
  if (!destination) {
    const actionRef = dict.get(PDFName.of('A'));
    const action = actionRef ? doc.context.lookup(actionRef) : null;
    if (action && typeof action.get === 'function') destination = action.get(PDFName.of('D'));
  }
  if (!destination) return undefined;
  const array = doc.context.lookup(destination);
  if (!(array instanceof PDFArray) || !array.size()) return undefined;
  const first = array.get(0);
  return first instanceof PDFRef ? first : undefined;
}

function pruneBrokenOutlines(doc) {
  const validPages = new Set(doc.getPages().map((page) => page.ref.toString()));
  let outlinesRef;
  try {
    outlinesRef = doc.catalog.get(PDFName.of('Outlines'));
  } catch (error) {
    return;
  }
  if (!outlinesRef) return;
  const root = doc.context.lookup(outlinesRef);
  if (!root || typeof root.get !== 'function') return;

  const removeItem = (parent, item) => {
    const nextRef = item.get(PDFName.of('Next'));
    const prevRef = item.get(PDFName.of('Prev'));
    if (prevRef) {
      const prev = doc.context.lookup(prevRef);
      if (prev) {
        if (nextRef) prev.set(PDFName.of('Next'), nextRef);
        else prev.delete(PDFName.of('Next'));
      }
    } else if (nextRef) {
      parent.set(PDFName.of('First'), nextRef);
    } else {
      parent.delete(PDFName.of('First'));
    }
    if (nextRef) {
      const next = doc.context.lookup(nextRef);
      if (next) {
        if (prevRef) next.set(PDFName.of('Prev'), prevRef);
        else next.delete(PDFName.of('Prev'));
      }
    } else if (prevRef) {
      parent.set(PDFName.of('Last'), prevRef);
    } else {
      parent.delete(PDFName.of('Last'));
    }
  };

  const walk = (parent) => {
    let ref = parent.get(PDFName.of('First'));
    while (ref) {
      const item = doc.context.lookup(ref);
      if (!item || typeof item.get !== 'function') break;
      const nextRef = item.get(PDFName.of('Next'));
      const pageRef = destinationPageRef(doc, item);
      if (pageRef && !validPages.has(pageRef.toString())) {
        removeItem(parent, item);
      } else if (item.get(PDFName.of('First'))) {
        walk(item);
      }
      ref = nextRef;
    }
  };

  walk(root);
  if (!root.get(PDFName.of('First'))) {
    try {
      doc.catalog.delete(PDFName.of('Outlines'));
    } catch (error) {
      /* sin marcadores */
    }
  }
}

function pruneBrokenLinks(doc) {
  const validPages = new Set(doc.getPages().map((page) => page.ref.toString()));
  doc.getPages().forEach((page) => {
    let annotations;
    try {
      annotations = page.node.Annots();
    } catch (error) {
      return;
    }
    if (!annotations) return;
    if (!(annotations instanceof PDFArray)) return;
    for (let i = annotations.size() - 1; i >= 0; i -= 1) {
      const ref = annotations.get(i);
      const dict = doc.context.lookup(ref);
      if (!dict || typeof dict.get !== 'function') continue;
      const subtype = dict.get(PDFName.of('Subtype'));
      if (!subtype || subtype.toString() !== '/Link') continue;
      const pageRef = destinationPageRef(doc, dict);
      if (pageRef && !validPages.has(pageRef.toString())) annotations.remove(i);
    }
  });
}

function ocrPdfBox(edit) {
  if (edit && edit.ocrPdfBox) return edit.ocrPdfBox;
  const line = editLineBoxes(edit)[0];
  const descent = line.descent ?? -0.22;
  const ascent = line.ascent ?? 0.82;
  return {
    x: line.x,
    y: line.y + descent * line.fontSize,
    width: line.width,
    height: (ascent - descent) * line.fontSize
  };
}

function cleanOcrText(canvas, viewport, edits, pixelRatio = 1) {
  const list = (edits || []).filter((edit) => edit && edit.ocr);
  if (!list.length) return;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let imageData;
  try {
    imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  } catch (error) {
    return;
  }
  const data = imageData.data;
  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  list.forEach((edit) => {
    let left;
    let top;
    let right;
    let bottom;
    if (Array.isArray(edit.ocrCorners) && edit.ocrCorners.length === 4) {
      const points = edit.ocrCorners.map(([x, y]) => viewport.convertToViewportPoint(x, y));
      const xs = points.map((point) => point[0] * pixelRatio);
      const ys = points.map((point) => point[1] * pixelRatio);
      left = Math.min(...xs);
      top = Math.min(...ys);
      right = Math.max(...xs);
      bottom = Math.max(...ys);
    } else {
      const box = ocrPdfBox(edit);
      if (!box || box.width <= 0 || box.height <= 0) return;
      const a = viewport.convertToViewportPoint(box.x, box.y);
      const b = viewport.convertToViewportPoint(box.x + box.width, box.y + box.height);
      left = Math.min(a[0], b[0]) * pixelRatio;
      top = Math.min(a[1], b[1]) * pixelRatio;
      right = Math.max(a[0], b[0]) * pixelRatio;
      bottom = Math.max(a[1], b[1]) * pixelRatio;
    }
    const boxHeight = Math.max(1, bottom - top);
    const padX = Math.max(1, Math.round(boxHeight * 0.05));
    const padTop = Math.max(0, Math.round(boxHeight * 0.15));
    const padBottom = Math.max(2, Math.round(boxHeight * 0.35));
    const x0 = clamp(Math.floor(left - padX), 0, canvasWidth - 1);
    const y0 = clamp(Math.floor(top - padTop), 0, canvasHeight - 1);
    const x1 = clamp(Math.ceil(right + padX), 1, canvasWidth);
    const y1 = clamp(Math.ceil(bottom + padBottom), 1, canvasHeight);
    const width = x1 - x0;
    const height = y1 - y0;
    if (width < 2 || height < 2) return;

    // Color de fondo dominante en la zona de la línea.
    const buckets = new Map();
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = (y * canvasWidth + x) * 4;
        const key = ((data[index] >> 4) << 8) | ((data[index + 1] >> 4) << 4) | (data[index + 2] >> 4);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { count: 0, r: 0, g: 0, b: 0 };
          buckets.set(key, bucket);
        }
        bucket.count += 1;
        bucket.r += data[index];
        bucket.g += data[index + 1];
        bucket.b += data[index + 2];
      }
    }
    let background = null;
    let best = 0;
    buckets.forEach((bucket) => {
      if (bucket.count > best) {
        best = bucket.count;
        background = {
          r: Math.round(bucket.r / bucket.count),
          g: Math.round(bucket.g / bucket.count),
          b: Math.round(bucket.b / bucket.count)
        };
      }
    });
    if (!background) return;

    // Se detectan líneas horizontales largas (bordes de campos, subrayados)
    // para no borrarlas al limpiar el texto. No se preservan columnas: los
    // tallos de las letras también son verticales y dejarían restos.
    const ink = new Uint8Array(width * height);
    const rowInk = new Uint16Array(height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = ((y0 + y) * canvasWidth + (x0 + x)) * 4;
        const distance =
          Math.abs(data[index] - background.r) +
          Math.abs(data[index + 1] - background.g) +
          Math.abs(data[index + 2] - background.b);
        if (distance > 40) {
          ink[y * width + x] = 1;
          rowInk[y] += 1;
        }
      }
    }
    const keepRow = new Uint8Array(height);
    for (let y = 0; y < height; y += 1) {
      if (rowInk[y] > width * 0.75) keepRow[y] = 1;
    }

    // 1) Se rellena la caja exacta del texto con el fondo: así desaparecen
    //    también los bordes antialiasados de los glifos.
    const exactX0 = clamp(Math.floor(left), 0, canvasWidth - 1);
    const exactY0 = clamp(Math.floor(top), 0, canvasHeight - 1);
    const exactX1 = clamp(Math.ceil(right), 1, canvasWidth);
    const exactY1 = clamp(Math.ceil(bottom), 1, canvasHeight);
    for (let y = exactY0; y < exactY1; y += 1) {
      if (keepRow[y - y0]) continue;
      for (let x = exactX0; x < exactX1; x += 1) {
        const index = (y * canvasWidth + x) * 4;
        data[index] = background.r;
        data[index + 1] = background.g;
        data[index + 2] = background.b;
        data[index + 3] = 255;
      }
    }

    // 2) En el margen ampliado se eliminan los restos de tinta (descendentes,
    //    antialias) sin tocar las líneas horizontales largas.
    for (let y = 0; y < height; y += 1) {
      if (keepRow[y]) continue;
      for (let x = 0; x < width; x += 1) {
        if (!ink[y * width + x]) continue;
        const index = ((y0 + y) * canvasWidth + (x0 + x)) * 4;
        data[index] = background.r;
        data[index + 1] = background.g;
        data[index + 2] = background.b;
        data[index + 3] = 255;
      }
    }
  });

  context.putImageData(imageData, 0, 0);
}

async function replacePageWithRenderedImage(doc, page, rendered) {
  const image = await doc.embedPng(rendered.bytes);
  page.contentStream = undefined;
  page.contentStreamRef = undefined;
  const empty = PDFRawStream.of(doc.context.obj({}), new Uint8Array(0));
  page.node.set(PDFName.of('Contents'), doc.context.register(empty));
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: rendered.width,
    height: rendered.height
  });
  const size = page.getSize();
  if (Math.abs(size.width - rendered.width) > 0.5 || Math.abs(size.height - rendered.height) > 0.5) {
    page.setSize(rendered.width, rendered.height);
  }
}

async function rasterizeOcrPage(doc, page, statePage) {
  const edits = (statePage.textEdits || []).filter((edit) => edit.ocr);
  if (!edits.length) return false;
  const rendered = await renderPageToPng(statePage, 2, edits, 0);
  if (!rendered) return false;
  await replacePageWithRenderedImage(doc, page, rendered);
  return true;
}

async function renderPageToPng(page, scale = 2, cleanEdits = null, rotation = null, blackouts = null) {
  if (!page || !page.pageRef) return null;
  const viewport = page.pageRef.getViewport(rotation === null ? { scale } : { scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.pageRef.render({ canvasContext: context, viewport }).promise;
  if (cleanEdits && cleanEdits.length) cleanOcrText(canvas, viewport, cleanEdits, 1);
  if (blackouts && blackouts.length) {
    // Redacción sobre imagen: se tapan los píxeles para que el contenido
    // original desaparezca del archivo, no solo de la vista.
    blackouts.forEach((rect) => {
      const corners = [
        viewport.convertToViewportPoint(rect.x, rect.y),
        viewport.convertToViewportPoint(rect.x + rect.w, rect.y),
        viewport.convertToViewportPoint(rect.x, rect.y + rect.h),
        viewport.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h)
      ];
      const xs = corners.map((point) => point[0]);
      const ys = corners.map((point) => point[1]);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      context.fillStyle = '#000000';
      context.fillRect(left, top, Math.max(1, Math.max(...xs) - left), Math.max(1, Math.max(...ys) - top));
    });
  }
  return {
    bytes: dataUrlToBytes(canvas.toDataURL('image/png')),
    width: viewport.width / scale,
    height: viewport.height / scale
  };
}

function preparePageForCopy(pageNode) {
  if (!pageNode) return;
  try {
    pageNode.normalize();
  } catch (error) {
    console.warn('No se pudo normalizar una página', error);
  }
  ['MediaBox', 'CropBox', 'Rotate'].forEach((name) => {
    const key = PDFName.of(name);
    try {
      if (pageNode.get(key)) return;
      const inherited = pageNode.getInheritableAttribute(key);
      if (inherited) pageNode.set(key, inherited);
    } catch (error) {
      /* atributo no heredado */
    }
  });
}

function addInvisibleTextLayer(out, outPage, page, font) {
  if (!page.flattened || !page.textItems || !page.textItems.length) return;
  try {
    outPage.pushOperators(
      PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [PDFNumber.of(3)])
    );
    for (const item of page.textItems) {
      const text = pdfSafeText(item.str);
      if (!text.trim()) continue;
      try {
        outPage.drawText(text, {
          x: item.x,
          y: item.y,
          size: item.fontSize || 10,
          font,
          rotate: degrees(((item.angle || 0) * 180) / Math.PI),
          color: rgb(0, 0, 0)
        });
      } catch (error) {
        /* carácter no representable en la fuente estándar */
      }
    }
    outPage.pushOperators(
      PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [PDFNumber.of(0)])
    );
  } catch (error) {
    console.warn('No se pudo añadir la capa de texto invisible', error);
  }
}

function resetPageLabels(doc) {
  try {
    doc.catalog.delete(PDFName.of('PageLabels'));
  } catch (error) {
    /* sin etiquetas de página */
  }
}

function collectCopiedWidgetFields(doc, page, fields) {
  let annotations;
  try {
    annotations = page.node.Annots();
  } catch (error) {
    return;
  }
  if (!(annotations instanceof PDFArray)) return;
  for (let i = 0; i < annotations.size(); i += 1) {
    const ref = annotations.get(i);
    if (!(ref instanceof PDFRef)) continue;
    const widget = doc.context.lookup(ref);
    if (!widget || typeof widget.get !== 'function') continue;
    const subtype = doc.context.lookup(widget.get(PDFName.of('Subtype')));
    if (!subtype || subtype.toString() !== '/Widget') continue;
    let fieldRef = widget.get(PDFName.of('Parent'));
    if (!(fieldRef instanceof PDFRef)) fieldRef = ref;
    let field = doc.context.lookup(fieldRef);
    while (field) {
      const parent = field.get(PDFName.of('Parent'));
      if (!(parent instanceof PDFRef)) break;
      const parentField = doc.context.lookup(parent);
      if (!parentField) break;
      fieldRef = parent;
      field = parentField;
    }
    if (!field || !field.get(PDFName.of('T'))) continue;
    try {
      widget.set(PDFName.of('P'), page.ref);
    } catch (error) {
      /* widget sin página asignable */
    }
    fields.set(fieldRef.toString(), fieldRef);
  }
}

function mergeAcroFormFields(doc, fields) {
  if (!fields.size) return;
  let acroRef = doc.catalog.get(PDFName.of('AcroForm'));
  let acro = acroRef ? doc.context.lookup(acroRef) : null;
  if (!acro) {
    acro = doc.context.obj({ Fields: [] });
    acroRef = doc.context.register(acro);
    doc.catalog.set(PDFName.of('AcroForm'), acroRef);
  }
  let entries = acro.get(PDFName.of('Fields'));
  entries = entries ? doc.context.lookup(entries) : null;
  if (!(entries instanceof PDFArray)) {
    entries = doc.context.obj([]);
    acro.set(PDFName.of('Fields'), entries);
  }
  const existing = new Set();
  for (let i = 0; i < entries.size(); i += 1) {
    const value = entries.get(i);
    if (value instanceof PDFRef) existing.add(value.toString());
  }
  fields.forEach((ref, key) => {
    if (!existing.has(key)) entries.push(ref);
  });
}


function ensureOutlineRoot(doc) {
  let ref = doc.catalog.get(PDFName.of('Outlines'));
  let dict = ref ? doc.context.lookup(ref) : null;
  if (!dict) {
    dict = doc.context.obj({ Type: 'Outlines' });
    ref = doc.context.register(dict);
    doc.catalog.set(PDFName.of('Outlines'), ref);
  } else if (!(ref instanceof PDFRef)) {
    ref = doc.context.register(dict);
    doc.catalog.set(PDFName.of('Outlines'), ref);
  }
  if (!dict.get(PDFName.of('Type'))) dict.set(PDFName.of('Type'), PDFName.of('Outlines'));
  return { ref, dict };
}

function remapOutlineDestination(out, source, value, pageMap, copier) {
  const destination = source.context.lookup(value);
  if (!(destination instanceof PDFArray) || !destination.size()) return null;
  const first = destination.get(0);
  if (!(first instanceof PDFRef)) return null;
  const mapped = pageMap.get(first.toString());
  if (!mapped) return null;
  const array = out.context.obj([]);
  array.push(mapped);
  for (let i = 1; i < destination.size(); i += 1) {
    const object = source.context.lookup(destination.get(i));
    if (object === undefined) continue;
    array.push(copier.copy(object));
  }
  return array;
}

function copyOutlineAction(out, source, actionValue, pageMap, copier) {
  const action = source.context.lookup(actionValue);
  if (!action || typeof action.get !== 'function') return null;
  const dict = out.context.obj({});
  const subtype = action.get(PDFName.of('S'));
  if (subtype) dict.set(PDFName.of('S'), copier.copy(subtype));
  const destination = action.get(PDFName.of('D'));
  if (destination) {
    const remapped = remapOutlineDestination(out, source, destination, pageMap, copier);
    if (remapped) dict.set(PDFName.of('D'), remapped);
  }
  ['URI', 'IsMap'].forEach((key) => {
    const object = action.get(PDFName.of(key));
    if (object) dict.set(PDFName.of(key), copier.copy(object));
  });
  return dict;
}

function copyOutlineItem(out, source, itemRef, parentRef, pageMap, copier, depth) {
  if (depth > 16) return null;
  const item = source.context.lookup(itemRef);
  if (!item || typeof item.get !== 'function') return null;
  const dict = out.context.obj({});
  ['Title', 'C', 'F'].forEach((key) => {
    const value = item.get(PDFName.of(key));
    if (value) dict.set(PDFName.of(key), copier.copy(value));
  });
  const destination = item.get(PDFName.of('Dest'));
  if (destination) {
    const remapped = remapOutlineDestination(out, source, destination, pageMap, copier);
    if (remapped) dict.set(PDFName.of('Dest'), remapped);
  }
  const action = item.get(PDFName.of('A'));
  if (action) {
    const copiedAction = copyOutlineAction(out, source, action, pageMap, copier);
    if (copiedAction) dict.set(PDFName.of('A'), copiedAction);
  }
  const outRef = out.context.register(dict);
  dict.set(PDFName.of('Parent'), parentRef);

  let childRef = item.get(PDFName.of('First'));
  let firstChild = null;
  let lastChild = null;
  let childCount = 0;
  while (childRef) {
    const child = source.context.lookup(childRef);
    const next = child ? child.get(PDFName.of('Next')) : null;
    const copied = copyOutlineItem(out, source, childRef, outRef, pageMap, copier, depth + 1);
    if (copied) {
      if (!firstChild) {
        firstChild = copied;
      } else {
        lastChild.dict.set(PDFName.of('Next'), copied.ref);
        copied.dict.set(PDFName.of('Prev'), lastChild.ref);
      }
      lastChild = copied;
      childCount += 1;
    }
    childRef = next;
  }
  if (firstChild) {
    dict.set(PDFName.of('First'), firstChild.ref);
    dict.set(PDFName.of('Last'), lastChild.ref);
    dict.set(PDFName.of('Count'), PDFNumber.of(childCount));
  }
  return { ref: outRef, dict };
}

function mergeSourceOutlines(out, source, pageMap) {
  const outlinesValue = source.catalog.get(PDFName.of('Outlines'));
  const sourceRoot = outlinesValue ? source.context.lookup(outlinesValue) : null;
  if (!sourceRoot || typeof sourceRoot.get !== 'function') return;
  let itemRef = sourceRoot.get(PDFName.of('First'));
  if (!itemRef) return;

  const { ref: rootRef, dict: root } = ensureOutlineRoot(out);
  const copier = PDFObjectCopier.for(source.context, out.context);
  let firstNew = null;
  let lastNew = null;
  let newCount = 0;

  while (itemRef) {
    const item = source.context.lookup(itemRef);
    if (!item) break;
    const next = item.get(PDFName.of('Next'));
    const copied = copyOutlineItem(out, source, itemRef, rootRef, pageMap, copier, 0);
    if (copied) {
      if (!firstNew) {
        firstNew = copied;
      } else {
        lastNew.dict.set(PDFName.of('Next'), copied.ref);
        copied.dict.set(PDFName.of('Prev'), lastNew.ref);
      }
      lastNew = copied;
      newCount += 1;
    }
    itemRef = next;
  }
  if (!firstNew) return;

  const existingLast = root.get(PDFName.of('Last'));
  if (existingLast instanceof PDFRef) {
    const lastDict = out.context.lookup(existingLast);
    if (lastDict) {
      lastDict.set(PDFName.of('Next'), firstNew.ref);
      firstNew.dict.set(PDFName.of('Prev'), existingLast);
    }
    root.set(PDFName.of('Last'), lastNew.ref);
  } else {
    root.set(PDFName.of('First'), firstNew.ref);
    root.set(PDFName.of('Last'), lastNew.ref);
  }
  const countValue = root.get(PDFName.of('Count'));
  const currentCount = countValue instanceof PDFNumber ? countValue.asNumber() : 0;
  root.set(PDFName.of('Count'), PDFNumber.of(currentCount + newCount));
}


function nameTreeKeyText(key) {
  try {
    if (key && typeof key.decodeText === 'function') return key.decodeText();
  } catch (error) {
    /* clave no textual */
  }
  return String(key || '');
}

function collectEmbeddedFiles(doc, node, output) {
  if (!node || typeof node.get !== 'function') return;
  const names = node.get(PDFName.of('Names'));
  const namesArray = names ? doc.context.lookup(names) : null;
  if (namesArray instanceof PDFArray) {
    for (let i = 0; i + 1 < namesArray.size(); i += 2) {
      const key = doc.context.lookup(namesArray.get(i));
      const value = namesArray.get(i + 1);
      if (!key || !value) continue;
      output.push({ name: nameTreeKeyText(key), value });
    }
  }
  const kids = node.get(PDFName.of('Kids'));
  const kidsArray = kids ? doc.context.lookup(kids) : null;
  if (kidsArray instanceof PDFArray) {
    for (let i = 0; i < kidsArray.size(); i += 1) {
      collectEmbeddedFiles(doc, doc.context.lookup(kidsArray.get(i)), output);
    }
  }
}

function mergeAttachments(out, sources) {
  const baseEntries = [];
  let baseNames = null;
  let baseEmbedded = null;
  try {
    const namesValue = out.catalog.get(PDFName.of('Names'));
    baseNames = namesValue ? out.context.lookup(namesValue) : null;
    if (baseNames) {
      const embeddedValue = baseNames.get(PDFName.of('EmbeddedFiles'));
      baseEmbedded = embeddedValue ? out.context.lookup(embeddedValue) : null;
      if (baseEmbedded) collectEmbeddedFiles(out, baseEmbedded, baseEntries);
    }
  } catch (error) {
    baseEntries.length = 0;
  }

  const usedNames = new Set(baseEntries.map((entry) => entry.name));
  const merged = baseEntries.map((entry) => ({
    name: entry.name,
    value: entry.value
  }));

  sources.forEach((source) => {
    try {
      const namesValue = source.catalog.get(PDFName.of('Names'));
      const names = namesValue ? source.context.lookup(namesValue) : null;
      if (!names) return;
      const embeddedValue = names.get(PDFName.of('EmbeddedFiles'));
      const embedded = embeddedValue ? source.context.lookup(embeddedValue) : null;
      if (!embedded) return;
      const entries = [];
      collectEmbeddedFiles(source, embedded, entries);
      const copier = PDFObjectCopier.for(source.context, out.context);
      entries.forEach((entry) => {
        let name = entry.name || 'adjunto';
        if (usedNames.has(name)) {
          let suffix = 2;
          while (usedNames.has(`${name} (${suffix})`)) suffix += 1;
          name = `${name} (${suffix})`;
        }
        usedNames.add(name);
        merged.push({ name, value: copier.copy(source.context.lookup(entry.value)) });
      });
    } catch (error) {
      console.warn('No se pudieron combinar los adjuntos', error);
    }
  });

  if (!merged.length) return;
  merged.sort((a, b) => a.name.localeCompare(b.name));
  const array = out.context.obj([]);
  merged.forEach((entry) => {
    array.push(PDFString.of(entry.name));
    array.push(entry.value instanceof PDFRef ? entry.value : out.context.register(entry.value));
  });
  const root = out.context.obj({ Names: array });
  const rootRef = out.context.register(root);

  if (!baseNames) {
    baseNames = out.context.obj({});
    out.catalog.set(PDFName.of('Names'), out.context.register(baseNames));
  }
  baseNames.set(PDFName.of('EmbeddedFiles'), rootRef);
}


async function buildPdf(options = {}) {
  let mergedFieldRefs = new Map();
  const inPlace = documentCanBeSavedInPlace();
  let out;
  let outPages;
  const sources = new Map();
  const sourcePageMaps = new Map();

  if (inPlace) {
    // Se edita una copia del PDF original: así se conserva el diccionario
    // AcroForm y los formularios siguen siendo rellenables al guardar.
    const record = state.docs.get(state.pages[0].docId);
    if (!record) throw new Error('El documento original ya no está disponible.');
    out = await PDFDocument.load(record.bytes, { ignoreEncryption: true });
    outPages = out.getPages();
  } else {
    // Se usa como base el documento de la primera página con contenido para
    // conservar su catálogo: AcroForm, marcadores, adjuntos, etiquetas, etc.
    const firstWithDocument = state.pages.find((page) => page.docId);
    const baseId = firstWithDocument ? firstWithDocument.docId : null;
    const baseRecord = baseId ? state.docs.get(baseId) : null;
    const baseUsable = Boolean(baseRecord && !baseRecord.encrypted && !baseRecord.xfa);
    out = baseUsable
      ? await PDFDocument.load(baseRecord.bytes, { ignoreEncryption: true })
      : await PDFDocument.create();

    const basePages = baseUsable ? out.getPages().slice() : [];
    outPages = [];

    // pdf-lib no materializa los atributos heredados (Resources, MediaBox,
    // Rotate...) al sacar una página de su árbol. Se normalizan antes de
    // reordenarlas para que no pierdan recursos ni tamaño.
    basePages.forEach((page) => preparePageForCopy(page.node));

    for (const page of state.pages) {
      const record = page.docId ? state.docs.get(page.docId) : null;
      const mustFlatten = Boolean(record && (record.encrypted || record.xfa));
      const redactOnImage = !mustFlatten && await redactionNeedsRaster(page);

      if (mustFlatten || redactOnImage) {
        // PDF cifrado o XFA: pdf-lib no puede copiar/descifrar el contenido de
        // forma segura, así que la página se rasteriza y se inserta como imagen.
        // Se rasteriza sin rotación y se conserva /Rotate en la página para que
        // las anotaciones (en coordenadas PDF sin girar) sigan cuadrando.
        if (!page.textItems.length && page.pageRef) {
          try {
            page.textItems = extractTextItems(await page.pageRef.getTextContent(), page);
          } catch (error) {
            /* página sin capa de texto */
          }
        }
        const rendered = await renderPageToPng(page, 2, null, 0, redactOnImage
          ? (page.anns || []).filter((ann) => ann.type === 'redact')
          : null);
        if (!rendered) throw new Error('No se pudo rasterizar una página cifrada o XFA.');
        const image = await out.embedPng(rendered.bytes);
        const outPage = out.addPage([rendered.width, rendered.height]);
        outPage.drawImage(image, { x: 0, y: 0, width: rendered.width, height: rendered.height });
        page.flattened = true;
        outPages.push(outPage);
        continue;
      }
      page.flattened = false;

      if (!page.pageRef) {
        outPages.push(out.addPage([page.width, page.height]));
        continue;
      }
      if (baseUsable && page.docId === baseId) {
        const basePage = basePages[page.index];
        if (!basePage) throw new Error('No se encontró una página del documento base.');
        outPages.push(basePage);
        continue;
      }
      let source = sources.get(page.docId);
      if (!source) {
        const sourceRecord = state.docs.get(page.docId);
        if (!sourceRecord) throw new Error('Falta el documento de origen de una página.');
        source = await PDFDocument.load(sourceRecord.bytes, { ignoreEncryption: true });
        // pdf-lib no copia /AcroForm al copiar páginas; se aplican los valores
        // antes de copiar para que al menos queden visibles en la copia.
        if (state.formFields.length) applyFormValuesToDocument(source, state.formValues);
        sources.set(page.docId, source);
      }
      try {
        preparePageForCopy(source.getPage(page.index).node);
      } catch (error) {
        console.warn('No se pudo preparar la página de origen', error);
      }
      const [copied] = await out.copyPages(source, [page.index]);
      collectCopiedWidgetFields(out, copied, mergedFieldRefs);
      let pageMap = sourcePageMaps.get(page.docId);
      if (!pageMap) {
        pageMap = new Map();
        sourcePageMaps.set(page.docId, pageMap);
      }
      try {
        pageMap.set(source.getPage(page.index).ref.toString(), copied.ref);
      } catch (error) {
        /* página no mapeable */
      }
      outPages.push(copied);
    }

    // Reordenar/eliminar/insertar sin destruir los objetos de página ni el
    // catálogo del documento base.
    for (let i = out.getPageCount() - 1; i >= 0; i -= 1) out.removePage(i);
    outPages.forEach((page, index) => out.insertPage(index, page));
    mergeAcroFormFields(out, mergedFieldRefs);
    sources.forEach((sourceDoc, docId) => {
      const pageMap = sourcePageMaps.get(docId);
      if (pageMap && pageMap.size) mergeSourceOutlines(out, sourceDoc, pageMap);
    });
    mergeAttachments(out, sources);
    pruneOrphanFormFields(out);
    pruneBrokenOutlines(out);
    pruneBrokenLinks(out);
    resetPageLabels(out);
  }

  const font = await out.embedFont(StandardFonts.Helvetica);
  const imageCache = new Map();
  const fontCache = new Map();

  for (let i = 0; i < state.pages.length; i += 1) {
    const page = state.pages[i];
    const outPage = outPages[i];
    if (!outPage) continue;
    const sourceRotation = page.flattened && page.pageRef ? (page.pageRef.rotate || 0) : 0;
    const extraRotation = sourceRotation + page.rotation;
    if (extraRotation) {
      const current = outPage.getRotation().angle || 0;
      outPage.setRotation(degrees(((current + extraRotation) % 360 + 360) % 360));
    }
    page.ocrRasterized = false;
    if ((page.textEdits || []).some((edit) => edit.ocr)) {
      try {
        page.ocrRasterized = await rasterizeOcrPage(out, outPage, page);
      } catch (error) {
        console.warn('No se pudo limpiar la página OCR al exportar', error);
      }
    }
    await applyTextEditsOnPdf(out, outPage, page, fontCache);
    if (page.flattened) addInvisibleTextLayer(out, outPage, page, font);
    for (const ann of page.anns) {
      await drawAnnotationOnPdf(out, outPage, ann, font, imageCache);
    }
  }

  if (state.formFields.length) {
    applyFormValuesToDocument(out, state.formValues, { font, onlyRefs: mergedFieldRefs });
  }

  if (state.watermark.on && state.watermark.text.trim()) {
    const text = pdfSafeText(state.watermark.text.trim());
    outPages.forEach((outPage) => {
      const { width, height } = outPage.getSize();
      outPage.drawText(text, {
        x: width * 0.16,
        y: height * 0.42,
        size: Math.min(64, width / 10),
        font,
        color: rgb(0.45, 0.45, 0.45),
        opacity: 0.14,
        rotate: degrees(45)
      });
    });
  }

  // Recorte de márgenes: se aplica como CropBox en el PDF exportado.
  state.pages.forEach((page, index) => {
    const outPage = outPages[index];
    if (!outPage || !page.crop) return;
    try {
      const media = outPage.getMediaBox();
      const x = media.x + page.crop.left;
      const y = media.y + page.crop.bottom;
      const width = media.width - page.crop.left - page.crop.right;
      const height = media.height - page.crop.top - page.crop.bottom;
      if (width > 20 && height > 20) outPage.setCropBox(x, y, width, height);
    } catch (error) {
      /* página sin caja válida */
    }
  });

  // Numeración de páginas.
  if (state.pageNumbers && state.pageNumbers.on) {
    const format = state.pageNumbers.format || 'Página {n} de {total}';
    const position = state.pageNumbers.position || 'bottom-center';
    const total = outPages.length;
    outPages.forEach((outPage, index) => {
      const label = format
        .replace(/\{n\}/g, String(index + 1))
        .replace(/\{total\}/g, String(total));
      if (!label.trim()) return;
      const size = 9;
      // Se usa el área visible (CropBox) para que el número no quede fuera
      // cuando la página tiene márgenes recortados.
      let box;
      try {
        box = outPage.getCropBox();
      } catch (error) {
        box = outPage.getMediaBox();
      }
      const textWidth = font.widthOfTextAtSize(label, size);
      let x = box.x + (box.width - textWidth) / 2;
      let y = box.y + 16;
      if (position === 'bottom-right') x = box.x + box.width - textWidth - 24;
      else if (position === 'bottom-left') x = box.x + 24;
      else if (position === 'top-right') { x = box.x + box.width - textWidth - 24; y = box.y + box.height - 24; }
      outPage.drawText(label, { x, y, size, font, color: rgb(0.28, 0.31, 0.35) });
    });
  }

  // Encabezado y pie de página con texto libre.
  const headerText = (state.headerFooter && state.headerFooter.header) || '';
  const footerText = (state.headerFooter && state.headerFooter.footer) || '';
  if (headerText.trim() || footerText.trim()) {
    const total = outPages.length;
    const today = new Date().toLocaleDateString('es-ES');
    const fill = (template, index) => template
      .replace(/\{n\}/g, String(index + 1))
      .replace(/\{total\}/g, String(total))
      .replace(/\{title\}/g, state.metadata.title || state.fileName || '')
      .replace(/\{date\}/g, today);
    outPages.forEach((outPage, index) => {
      let box;
      try {
        box = outPage.getCropBox();
      } catch (error) {
        box = outPage.getMediaBox();
      }
      const size = 8.5;
      const drawLine = (template, top) => {
        const label = fill(template, index).trim();
        if (!label) return;
        const textWidth = font.widthOfTextAtSize(label, size);
        outPage.drawText(label, {
          x: box.x + (box.width - textWidth) / 2,
          y: top ? box.y + box.height - size - 10 : box.y + size + 10,
          size,
          font,
          color: rgb(0.35, 0.38, 0.42)
        });
      };
      drawLine(headerText, true);
      drawLine(footerText, false);
    });
  }

  // Marcadores generados a partir de los títulos.
  if (options && options.bookmarks && state.generatedBookmarks.length) {
    writeOutlines(out, outPages, state.generatedBookmarks);
  }

  // Aplanado de formularios (opcional).
  if (options && options.flatten) {
    try {
      out.getForm().flatten();
      // pdf-lib deja en /Annots las referencias a los campos eliminados: son
      // objetos que ya no existen y algunos visores avisan de ellos.
      out.getPages().forEach((outPage) => {
        const annotsRef = outPage.node.get(PDFName.of('Annots'));
        if (!annotsRef) return;
        const annots = out.context.lookup(annotsRef);
        if (!(annots instanceof PDFArray)) return;
        const keep = [];
        for (let i = 0; i < annots.size(); i += 1) {
          const item = annots.get(i);
          if (out.context.lookup(item) !== undefined) keep.push(item);
        }
        if (keep.length) {
          const clean = out.context.obj([]);
          keep.forEach((item) => clean.push(item));
          outPage.node.set(PDFName.of('Annots'), clean);
        } else {
          outPage.node.delete(PDFName.of('Annots'));
        }
      });
      if (!out.getForm().getFields().length) {
        try { out.catalog.delete(PDFName.of('AcroForm')); } catch (error) { /* sin catálogo */ }
      }
    } catch (error) {
      console.warn('No se pudo aplanar el formulario', error);
    }
  }

  out.setTitle(state.metadata.title || '');
  out.setAuthor(state.metadata.author || '');
  out.setSubject(state.metadata.subject || '');
  out.setKeywords(state.metadata.keywords
    ? state.metadata.keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean)
    : []);
  out.setProducer('ZeroPDF (zeronet75)');
  out.setCreator('ZeroPDF');
  out.setModificationDate(new Date());

  return await out.save();
}

async function drawAnnotationOnPdf(out, outPage, ann, font, imageCache) {
  const color = hexToRgb(ann.color || '#e11900');
  const opacity = ann.opacity ?? 0.35;

  if (ann.type === 'highlight') {
    outPage.drawRectangle({ x: ann.x, y: ann.y, width: ann.w, height: ann.h, color, opacity });
  } else if (ann.type === 'cover') {
    outPage.drawRectangle({ x: ann.x, y: ann.y, width: ann.w, height: ann.h, color: rgb(1, 1, 1) });
  } else if (ann.type === 'redact') {
    outPage.drawRectangle({ x: ann.x, y: ann.y, width: ann.w, height: ann.h, color: rgb(0, 0, 0) });
  } else if (ann.type === 'rect') {
    outPage.drawRectangle({
      x: ann.x,
      y: ann.y,
      width: ann.w,
      height: ann.h,
      borderColor: color,
      borderWidth: ann.lineWidth || 2
    });
  } else if (ann.type === 'ellipse') {
    outPage.drawEllipse({
      x: ann.x + ann.w / 2,
      y: ann.y + ann.h / 2,
      xScale: Math.abs(ann.w / 2),
      yScale: Math.abs(ann.h / 2),
      borderColor: color,
      borderWidth: ann.lineWidth || 2
    });
  } else if (ann.type === 'ink') {
    const points = ann.points || [];
    for (let i = 1; i < points.length; i += 1) {
      outPage.drawLine({
        start: { x: points[i - 1][0], y: points[i - 1][1] },
        end: { x: points[i][0], y: points[i][1] },
        thickness: ann.lineWidth || 2,
        color
      });
    }
  } else if (ann.type === 'text') {
    drawMultilineText(outPage, pdfSafeText(ann.text), ann.x, ann.y, ann.fontSize || 14, font, color);
  } else if (ann.type === 'note') {
    outPage.drawRectangle({
      x: ann.x,
      y: ann.y,
      width: ann.w || 170,
      height: ann.h || 60,
      color: rgb(1, 0.95, 0.65),
      borderColor: rgb(0.83, 0.69, 0.04),
      borderWidth: 1
    });
    drawMultilineText(
      outPage,
      pdfSafeText(ann.text),
      ann.x + 6,
      ann.y + (ann.h || 60) - 16,
      ann.fontSize || 11,
      font,
      rgb(0.29, 0.23, 0)
    );
  } else if (ann.type === 'image' && ann.dataURL) {
    let image = imageCache.get(ann.dataURL);
    if (!image) {
      const bytes = dataUrlToBytes(ann.dataURL);
      image = /^data:image\/jpe?g/i.test(ann.dataURL)
        ? await out.embedJpg(bytes)
        : await out.embedPng(bytes);
      imageCache.set(ann.dataURL, image);
    }
    outPage.drawImage(image, { x: ann.x, y: ann.y, width: ann.w, height: ann.h });
  }
}

function drawMultilineText(page, text, x, y, size, font, color) {
  const lines = String(text).split('\n');
  const lineHeight = size * 1.25;
  lines.forEach((line, index) => {
    if (!line) return;
    page.drawText(line, {
      x,
      y: y - index * lineHeight,
      size,
      font,
      color
    });
  });
}

/* ---------------------------------- UI ---------------------------------- */

function updateUI() {
  const total = state.pages.length;
  const pageNumber = total ? state.current + 1 : 0;

  updateDirtyTitle();
  $('#statusFile').textContent = state.fileName || 'Sin documento';
  $('#statusPage').textContent = total ? `${pageNumber} / ${total}` : '— / —';
  $('#pageTotal').textContent = `/ ${total}`;
  $('#pageInput').max = String(Math.max(1, total));
  if (document.activeElement !== $('#pageInput')) {
    $('#pageInput').value = String(Math.max(1, pageNumber));
  }
  updateZoomUI();
  markCurrentThumb();
  renderAnnList();
  renderTextEditList();
  renderSelectedInfo();
  renderDocInfo();
  $('#emptyState').hidden = total > 0;
}

function updateZoomUI() {
  const percent = Math.round(state.scale * 100) + '%';
  $('#zoomLabel').textContent = percent;
  $('#statusZoom').textContent = percent;
}

function renderAnnList() {
  const list = $('#annList');
  const page = currentPage();
  list.innerHTML = '';
  if (!page || !page.anns.length) {
    list.innerHTML = '<p class="muted small-text">Sin anotaciones en esta página.</p>';
    return;
  }
  const names = {
    highlight: 'Resaltado',
    text: 'Texto',
    note: 'Nota',
    rect: 'Rectángulo',
    ellipse: 'Elipse',
    ink: 'Dibujo',
    cover: 'Cubrir',
    image: 'Imagen'
  };
  page.anns.forEach((ann) => {
    const item = document.createElement('div');
    item.className = 'ann-item';
    if (state.selectedAnn && state.selectedAnn.pageIndex === state.current && state.selectedAnn.id === ann.id) {
      item.classList.add('selected');
    }
    const swatch = document.createElement('span');
    swatch.className = 'ann-swatch';
    swatch.style.background = ann.type === 'cover' ? '#ffffff' : (ann.color || '#e11900');
    const label = document.createElement('span');
    label.className = 'ann-label';
    label.textContent = (names[ann.type] || ann.type) + (ann.text ? ': ' + ann.text.slice(0, 26) : '');
    const del = document.createElement('button');
    del.className = 'ann-del';
    del.innerHTML = ICONS.trash;
    del.title = 'Eliminar';
    del.addEventListener('click', (evt) => {
      evt.stopPropagation();
      removeAnnotation(state.current, ann.id);
    });
    item.append(swatch, label, del);
    item.addEventListener('click', () => {
      state.selectedAnn = { pageIndex: state.current, id: ann.id };
      redrawPage(state.current);
      renderAnnList();
      renderSelectedInfo();
    });
    list.appendChild(item);
  });
}

function renderSelectedInfo() {
  const node = $('#selectedInfo');
  if (!state.selectedAnn) {
    node.textContent = 'Ninguna';
    return;
  }
  const page = state.pages[state.selectedAnn.pageIndex];
  const ann = page && page.anns.find((a) => a.id === state.selectedAnn.id);
  if (!ann) {
    node.textContent = 'Ninguna';
    return;
  }
  const names = {
    highlight: 'Resaltado',
    text: 'Texto',
    note: 'Nota',
    rect: 'Rectángulo',
    ellipse: 'Elipse',
    ink: 'Dibujo',
    cover: 'Cubrir',
    image: 'Imagen'
  };
  node.textContent = `${names[ann.type] || ann.type} en la página ${state.selectedAnn.pageIndex + 1}`;
}

function removeAnnotation(pageIndex, id) {
  const page = state.pages[pageIndex];
  if (!page) return;
  const at = page.anns.findIndex((a) => a.id === id);
  if (at < 0) return;
  pushUndo();
  page.anns.splice(at, 1);
  if (state.selectedAnn && state.selectedAnn.id === id) state.selectedAnn = null;
  redrawPage(pageIndex);
  renderAnnList();
  renderSelectedInfo();
  markDirty();
}

function markDirty() {
  state.dirty = true;
  updateDirtyTitle();
}

function updateDirtyTitle() {
  const name = state.fileName || 'Sin documento';
  $('#docTitle').textContent = state.pages.length && state.dirty ? name + ' •' : name;
}

/* ------------------------------- Acciones ------------------------------- */

async function closeDocument() {
  if (!(await confirmDiscard())) return;
  resetDocumentState();
  renderDocument({ keepPosition: false });
  rebuildThumbs();
  updateUI();
  await clearRecovery();
  toast('Documento cerrado.');
}

/* ------------------------ Conversión PDF <-> Word ------------------------ */

let conversionRunning = false;

// Agrupa los fragmentos de texto de una página en líneas.
function groupItemsIntoLines(items) {
  const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  sorted.forEach((item) => {
    const tolerance = Math.max(2, (item.fontSize || 10) * 0.55);
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance
      && Math.abs((candidate.fontSize || 10) - (item.fontSize || 10)) <= 4);
    if (line) {
      line.items.push(item);
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    } else {
      lines.push({ y: item.y, items: [item], fontSize: item.fontSize || 10 });
    }
  });
  lines.forEach((line) => {
    line.items.sort((a, b) => a.x - b.x);
    line.startX = Math.min(...line.items.map((item) => item.x));
    line.endX = Math.max(...line.items.map((item) => item.x + item.width));
    line.fontSize = Math.max(...line.items.map((item) => item.fontSize || 10));
    line.top = Math.max(...line.items.map((item) => item.y + (item.ascent ?? 0.82) * (item.fontSize || 10)));
    line.bottom = Math.min(...line.items.map((item) => item.y + (item.descent ?? -0.22) * (item.fontSize || 10)));
  });
  return lines.sort((a, b) => b.y - a.y);
}

// Convierte un fragmento de pdf.js en tramos con estilo y color.
function lineToRuns(line, color) {
  const runs = [];
  let previous = null;
  line.items.forEach((item) => {
    const text = String(item.str || '').replace(/\u00a0/g, ' ');
    if (!text) return;
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      if (gap > (item.fontSize || 10) * 0.22) {
        const last = runs[runs.length - 1];
        if (last && last.bold === item.bold && last.italic === item.italic) last.text += ' ';
        else runs.push({ text: ' ', bold: item.bold, italic: item.italic, color, size: item.fontSize, family: item.family });
      }
    }
    const last = runs[runs.length - 1];
    if (last && last.bold === item.bold && last.italic === item.italic
      && last.family === item.family && Math.abs(last.size - item.fontSize) < 0.6) {
      last.text += text;
    } else {
      runs.push({ text, bold: item.bold, italic: item.italic, color, size: item.fontSize, family: item.family });
    }
    previous = item;
  });
  return runs;
}

async function extractPdfModel(doc, title) {
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const items = extractTextItems(content, page).map((item) => ({
      ...item,
      ...fontDetails({ pageRef: page }, item)
    }));
    if (!items.length) {
      pages.push({ width: 595, height: 842, blocks: [] });
      continue;
    }

    const viewport = page.getViewport({ scale: 1.4 });
    let canvas = null;
    try {
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
    } catch (error) {
      canvas = null;
    }

    const lines = groupItemsIntoLines(items);
    lines.forEach((line) => {
      let color = '#111111';
      let background = '#ffffff';
      if (canvas) {
        try {
          const first = viewport.convertToViewportPoint(line.startX, (line.top + line.bottom) / 2);
          const second = viewport.convertToViewportPoint(line.endX, (line.top + line.bottom) / 2);
          const left = Math.min(first[0], second[0]);
          const top = Math.min(first[1], second[1]);
          const rect = {
            left,
            top,
            width: Math.max(1, Math.abs(second[0] - first[0])),
            height: Math.max(1, Math.abs(second[1] - first[1]) + line.fontSize)
          };
          const sampled = sampleTextColors({ canvas }, rect, 1);
          if (sampled && sampled.color) color = sampled.color;
          if (sampled && sampled.bg) background = sampled.bg;
        } catch (error) {
          /* color por defecto */
        }
      }
      line.color = color;
      line.background = background;
      line.runs = lineToRuns(line, color);
    });

    const pageWidth = page.view[2] - page.view[0];
    const pageHeight = page.view[3] - page.view[1];
    const pageLeft = Math.min(...lines.map((line) => line.startX));
    const pageRight = Math.max(...lines.map((line) => line.endX));

    const blocks = [];
    lines.forEach((line) => {
      if (!line.runs.length) return;
      const text = lineRunsText(line.runs);
      const startsItem = /^\s*([•▪◦‣·\-–—*]|\d{1,2}[.)])\s/.test(text);
      const current = blocks[blocks.length - 1];
      const gap = current ? current.bottom - line.top : 0;
      const baselineGap = current ? current.prevY - line.y : 0;
      const sameSize = current
        ? Math.abs(current.lineHeight - line.fontSize) <= Math.max(2, current.lineHeight * 0.35)
        : false;
      const shifted = current ? Math.abs(line.startX - current.startX) : 0;
      const textWidth = Math.max(1, pageRight - pageLeft);
      const previousFull = current
        ? current.endX >= pageLeft + textWidth * 0.82
        : false;
      const canMerge = Boolean(current) && !startsItem && sameSize && previousFull
        && baselineGap > 0 && baselineGap <= line.fontSize * 1.7
        && gap < line.fontSize * 0.9
        && shifted <= Math.max(6, line.fontSize * 1.6);
      if (canMerge) {
        const lastRun = current.runs[current.runs.length - 1];
        current.runs.push({
          text: ' ',
          bold: Boolean(lastRun && lastRun.bold),
          italic: Boolean(lastRun && lastRun.italic),
          color: (lastRun && lastRun.color) || '#111111',
          size: line.fontSize,
          family: (lastRun && lastRun.family) || 'helvetica'
        });
        current.runs.push(...line.runs);
        current.bottom = line.bottom;
        current.endX = Math.max(current.endX, line.endX);
        current.prevY = line.y;
        return;
      }
      blocks.push({
        startX: line.startX,
        endX: line.endX,
        top: line.top,
        bottom: line.bottom,
        prevY: line.y,
        lineHeight: line.fontSize,
        background: line.background || '#ffffff',
        runs: line.runs.slice()
      });
    });

    // Espaciado y alineación.
    const result = blocks.map((block, index) => {
      const next = blocks[index + 1];
      const leftGap = block.startX - pageLeft;
      const rightGap = pageRight - block.endX;
      let align = 'left';
      if (Math.abs(leftGap - rightGap) <= 8 && leftGap > 6) align = 'center';
      else if (rightGap <= 3 && leftGap > 8) align = 'right';
      const spaceBefore = index === 0 ? 0 : Math.max(0, Math.min(32, (blocks[index - 1].bottom - block.top)));
      const spaceAfter = next ? Math.max(0, Math.min(32, (block.bottom - next.top))) : 0;
      return {
        align,
        spaceBefore: Math.round(spaceBefore * 0.9),
        spaceAfter: Math.round(spaceAfter * 0.9),
        lineHeight: 1.15,
        background: block.background || '#ffffff',
        runs: block.runs.map((run) => ({
          text: run.text,
          bold: Boolean(run.bold),
          italic: Boolean(run.italic),
          color: run.color || '#111111',
          size: run.size || 11,
          family: run.family || 'helvetica'
        }))
      };
    });

    pages.push({ width: pageWidth, height: pageHeight, blocks: result });
  }
  return { title: title || 'Documento', pages };
}

async function convertPdfToWordBuiltin() {
  const picked = await api.openDialog();
  if (!picked) return { cancelled: true };
  toast('Analizando el PDF…', 600000);
  const opened = await openPdfSource(new Uint8Array(picked.data));
  try {
    const model = await extractPdfModel(opened.doc, picked.name.replace(/\.pdf$/i, ''));
    toast('Generando el documento de Word…', 600000);
    return await api.saveDocx(model, picked.name);
  } finally {
    try { opened.doc.destroy(); } catch (error) { /* ya cerrado */ }
  }
}

async function convertImageToPdf() {
  const picked = await api.openImageDialog();
  if (!picked) return { cancelled: true };

  toast('Preparando la imagen…', 600000);
  const type = /\.png$/i.test(picked.name) ? 'image/png'
    : /\.bmp$/i.test(picked.name) ? 'image/bmp'
      : 'image/jpeg';
  const blob = new Blob([new Uint8Array(picked.data)], { type });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('No se pudo abrir la imagen.'));
      element.src = url;
    });

    // Se limita el lado mayor para que el OCR y el PDF no crezcan sin control.
    let width = image.naturalWidth || image.width;
    let height = image.naturalHeight || image.height;
    const factor = Math.min(1, 3500 / Math.max(width, height));
    width = Math.max(1, Math.round(width * factor));
    height = Math.max(1, Math.round(height * factor));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const png = dataUrlToBytes(canvas.toDataURL('image/png'));

    toast('Reconociendo el texto de la imagen…', 600000);
    let lines = [];
    try {
      const result = await api.ocrPage(png);
      lines = (result && result.lines) || [];
    } catch (error) {
      lines = [];
    }

    toast('Generando el PDF…', 600000);
    return await api.saveImagePdf({
      name: picked.name,
      png,
      width,
      height,
      lines
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function convertDocument(kind) {
  if (conversionRunning) {
    toast('Ya hay una conversión en curso.');
    return;
  }
  const toWord = kind === 'pdf2docx';
  const isImage = kind === 'image2pdf';
  conversionRunning = true;
  toast(isImage ? 'Convirtiendo la imagen a PDF…'
    : (toWord ? 'Convirtiendo PDF a Word…' : 'Convirtiendo Word a PDF…'), 600000);
  try {
    let result;
    if (isImage) {
      result = await convertImageToPdf();
    } else {
      let engines = null;
      try {
        engines = await api.conversionEngines();
      } catch (error) {
        engines = null;
      }
      const external = Boolean(engines && (engines.word || engines.libre));
      if (toWord) {
        result = external ? await api.convertPdfToDocx() : await convertPdfToWordBuiltin();
      } else {
        result = external ? await api.convertDocxToPdf() : await api.docxToPdfBuiltin();
      }
      // Si el conversor externo falla (Word roto, documento raro), se reintenta
      // con el motor propio.
      if (external && result && !result.ok && !result.cancelled) {
        toast('El conversor externo no pudo con el documento; usando el motor propio…', 5000);
        result = toWord ? await convertPdfToWordBuiltin() : await api.docxToPdfBuiltin();
      }
    }
    if (!result || result.cancelled) {
      toast('Conversión cancelada.');
      return;
    }
    if (!result.ok) {
      toast(result.error || 'No se pudo convertir el documento.', 8000);
      return;
    }
    const detail = isImage && result.lines
      ? ` (${result.lines} líneas de texto reconocidas)`
      : '';
    toast(`Convertido con ${result.engine}: ${result.outputPath}${detail}`, 9000);
  } catch (error) {
    toast('No se pudo convertir: ' + ((error && error.message) || error), 8000);
  } finally {
    conversionRunning = false;
  }
}

function handleAction(action) {
  if (typeof action === 'string' && action.startsWith('open-recent:')) {
    openRecentFile(action.slice('open-recent:'.length));
    return;
  }
  if (typeof action === 'string' && action.startsWith('set-language:')) {
    applyLanguage(action.slice('set-language:'.length), { notify: false });
    return;
  }
  switch (action) {
    case 'open': openViaDialog(); break;
    case 'save': saveCopy(); break;
    case 'print': printDocument(); break;
    case 'protect': protectDocument(); break;
    case 'extract-pages': extractPages(); break;
    case 'copy-page-text': if (!isTypingTarget()) copyText('page'); break;
    case 'copy-all-text': if (!isTypingTarget()) copyText('all'); break;
    case 'about': $('#aboutModal').hidden = false; break;
    case 'close-about': $('#aboutModal').hidden = true; break;
    case 'search-toggle': toggleSearch(); break;
    case 'search-next': nextMatch(1); break;
    case 'search-prev': nextMatch(-1); break;
    case 'search-close': toggleSearch(false); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'delete-annotation':
      if (state.selectedAnn) removeAnnotation(state.selectedAnn.pageIndex, state.selectedAnn.id);
      break;
    case 'zoom-in': zoomBy(1.2); break;
    case 'zoom-out': zoomBy(1 / 1.2); break;
    case 'zoom-reset': setZoom(1); break;
    case 'fit-width': fitWidth(); break;
    case 'prev-page': scrollToPage(state.current - 1); break;
    case 'next-page': scrollToPage(state.current + 1); break;
    case 'rotate-page': rotateCurrentPage(); break;
    case 'insert-page': insertBlankPage(); break;
    case 'merge-pdf': mergePdf(); break;
    case 'ocr-page': ocrCurrentPage(); break;
    case 'convert-pdf-to-docx': convertDocument('pdf2docx'); break;
    case 'convert-docx-to-pdf': convertDocument('docx2pdf'); break;
    case 'convert-image-to-pdf': convertDocument('image2pdf'); break;
    case 'toggle-theme': toggleTheme(); break;
    case 'crop-page': applyCrop('page'); break;
    case 'crop-all': applyCrop('all'); break;
    case 'crop-clear': clearCrop(); break;
    case 'compress-pdf': compressPdf(); break;
    case 'export-page-image': exportPageImage(); break;
    case 'insert-pages': insertPagesFromPdf(); break;
    case 'ocr-all': ocrAllPages(); break;
    case 'sign-now': insertSignature(true); break;
    case 'sign-use': insertSignature(false); break;
    case 'search-replace': searchReplace(); break;
    case 'bookmarks-generate': generateBookmarks(); break;
    case 'flatten-forms': flattenForms(); break;
    case 'open-recovery': openRecovery(); break;
    case 'close':
      closeDocument();
      break;
    default: break;
  }
}

/* --------------------------------- Init --------------------------------- */

function init() {
  injectIcons();

  // pdf.worker.js se carga en la propia página (ver index.html), de modo que
  // pdf.js usa su manejador en el hilo principal. Así se evita crear Blobs de
  // gran tamaño y el worker funciona igual dentro de app.asar.
  if (window.pdfjsWorker && window.pdfjsWorker.WorkerMessageHandler) {
    console.log('ZeroPDF: pdf.js en modo hilo principal');
  } else {
    console.warn('ZeroPDF: no se pudo cargar pdf.worker.js');
  }

  document.addEventListener('click', (event) => {
    const thumbAction = event.target.closest('[data-thumb-action]');
    if (thumbAction) {
      event.stopPropagation();
      const thumb = thumbAction.closest('.thumb');
      const index = Number(thumb.dataset.index);
      const action = thumbAction.dataset.thumbAction;
      if (action === 'up') movePage(index, -1);
      else if (action === 'down') movePage(index, 1);
      else if (action === 'rotate') {
        state.current = index;
        rotateCurrentPage();
      } else if (action === 'delete') deletePage(index);
      return;
    }

    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      handleAction(actionEl.dataset.action);
      return;
    }

    const toolEl = event.target.closest('[data-tool]');
    if (toolEl) {
      setTool(toolEl.dataset.tool);
      return;
    }

    const tab = event.target.closest('.tab');
    if (tab) {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-pane').forEach((pane) => {
        pane.classList.toggle('active', pane.dataset.pane === tab.dataset.tab);
      });
      if (tab.dataset.tab === 'outline') renderOutline();
      return;
    }

    const thumb = event.target.closest('.thumb');
    if (thumb) {
      scrollToPage(Number(thumb.dataset.index));
    }
  });

  $('#viewer').addEventListener('pointerdown', onPointerDown);

  $('#viewer').addEventListener('dblclick', (event) => {
    if (state.tool !== 'select') return;
    const index = pageIndexFromEvent(event);
    if (index < 0) return;
    const item = findTextItem(index, event);
    if (!item) return;
    event.preventDefault();
    const entry = pageEntries[index];
    if (entry) openTextEditor(entry.el, index, item, { paragraph: event.shiftKey });
  });

  $('#viewer').addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      updateCurrentFromScroll();
    });
  });

  $('#styleColor').addEventListener('input', (e) => {
    state.style.color = e.target.value;
    $('#panelColor').value = e.target.value;
  });
  $('#panelColor').addEventListener('input', (e) => {
    state.style.color = e.target.value;
    $('#styleColor').value = e.target.value;
  });
  $('#styleWidth').addEventListener('input', () => syncStyleFromInputs());
  $('#panelWidth').addEventListener('input', () => syncStyleFromInputs());
  $('#styleFont').addEventListener('input', () => syncStyleFromInputs());
  $('#panelFont').addEventListener('input', () => syncStyleFromInputs());
  $('#panelOpacity').addEventListener('input', (e) => {
    state.style.opacity = clamp(Number(e.target.value) / 100, 0.05, 1);
  });

  $('#pageInput').addEventListener('change', (e) => {
    scrollToPage(Number(e.target.value) - 1);
  });
  $('#pageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      scrollToPage(Number(e.target.value) - 1);
      $('#pageInput').blur();
    }
  });

  $('#searchInput').addEventListener('input', scheduleSearch);
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = $('#searchInput').value.trim();
      if (e.shiftKey) { nextMatch(-1); return; }
      if (query && query === state.search.query && state.search.matches.length) nextMatch(1);
      else runSearch();
    } else if (e.key === 'Escape') {
      toggleSearch(false);
    }
  });

  ['#metaTitle', '#metaAuthor', '#metaSubject', '#metaKeywords'].forEach((selector) => {
    $(selector).addEventListener('input', () => {
      state.metadata = {
        title: $('#metaTitle').value,
        author: $('#metaAuthor').value,
        subject: $('#metaSubject').value,
        keywords: $('#metaKeywords').value
      };
      markDirty();
    });
  });

  $('#watermarkText').addEventListener('input', () => {
    state.watermark.text = $('#watermarkText').value;
    state.pages.forEach((page, index) => redrawPage(index));
    markDirty();
  });
  $('#watermarkOn').addEventListener('change', () => {
    state.watermark.on = $('#watermarkOn').checked;
    state.pages.forEach((page, index) => redrawPage(index));
    markDirty();
  });

  $('#imageInput').addEventListener('change', () => {
    const file = $('#imageInput').files && $('#imageInput').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        state.image = { dataURL: reader.result, width: img.naturalWidth, height: img.naturalHeight };
        toast('Imagen lista: haz clic en la página para colocarla.');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    $('#imageInput').value = '';
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const ctrl = event.ctrlKey || event.metaKey;

    if (ctrl && event.key.toLowerCase() === 'o') { event.preventDefault(); openViaDialog(); return; }
    if (ctrl && event.key.toLowerCase() === 's') { event.preventDefault(); saveCopy(); return; }
    if (ctrl && event.key.toLowerCase() === 'z') {
      if (typing) return;
      event.preventDefault();
      undo();
      return;
    }
    if (ctrl && event.key.toLowerCase() === 'y') {
      if (typing) return;
      event.preventDefault();
      redo();
      return;
    }
    if (ctrl && event.key.toLowerCase() === 'f') { event.preventDefault(); toggleSearch(true); return; }
    if (ctrl && (event.key === '=' || event.key === '+')) { event.preventDefault(); zoomBy(1.2); return; }
    if (ctrl && event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2); return; }
    if (ctrl && event.key === '0') { event.preventDefault(); fitWidth(); return; }

    if (typing) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (state.selectedAnn) {
        event.preventDefault();
        removeAnnotation(state.selectedAnn.pageIndex, state.selectedAnn.id);
      }
      return;
    }
    if (event.key === 'Escape') {
      state.selectedAnn = null;
      state.pages.forEach((page, index) => redrawPage(index));
      renderAnnList();
      renderSelectedInfo();
      $('#aboutModal').hidden = true;
      return;
    }
    if (event.key === 'v' || event.key === 'V') setTool('select');
    if (event.key === 'h' || event.key === 'H') setTool('hand');
    if (event.key === 'e' || event.key === 'E') setTool('textedit');
    if (event.key === 'PageDown') { event.preventDefault(); scrollToPage(state.current + 1); }
    if (event.key === 'PageUp') { event.preventDefault(); scrollToPage(state.current - 1); }
  });

  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) {
      toast('Solo se admiten archivos PDF.');
      return;
    }
    if (!(await confirmDiscard())) return;
    const buffer = await file.arrayBuffer();
    await loadPdf(new Uint8Array(buffer), file.name, '');
  });

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.fit === 'width') fitWidth();
    }, 200);
  });

  api.onMenu((action) => handleAction(action));

  // Tema guardado y recuperación automática.
  let savedTheme = 'dark';
  try {
    savedTheme = localStorage.getItem('zeropdf-theme') || 'dark';
  } catch (error) {
    savedTheme = 'dark';
  }
  applyTheme(savedTheme);

  // Idioma: manda el guardado por el proceso principal; si no, el del navegador.
  (async () => {
    let language = 'es';
    try {
      const stored = localStorage.getItem('zeropdf-lang');
      if (stored) language = stored;
    } catch (error) {
      /* sin almacenamiento */
    }
    try {
      const fromMain = await api.getLanguage();
      if (fromMain) language = fromMain;
    } catch (error) {
      /* sin proceso principal */
    }
    applyLanguage(language, { notify: false });
    watchTranslations();
  })();

  startRecoveryTimer();

  $('#pageNumbersOn').addEventListener('change', (event) => {
    state.pageNumbers.on = event.target.checked;
    markDirty();
  });
  $('#pageNumbersPosition').addEventListener('change', (event) => {
    state.pageNumbers.position = event.target.value;
  });
  $('#pageNumbersFormat').addEventListener('input', (event) => {
    state.pageNumbers.format = event.target.value;
  });
  $('#headerText').addEventListener('input', (event) => {
    state.headerFooter.header = event.target.value;
    markDirty();
  });
  $('#footerText').addEventListener('input', (event) => {
    state.headerFooter.footer = event.target.value;
    markDirty();
  });

  // Estado expuesto al proceso principal para avisar de cambios sin guardar.
  window.__zeropdfIsDirty = () => Boolean(state.dirty && state.pages.length);
  // Hooks de diagnóstico usados por las pruebas automáticas.
  window.__zeropdfOcr = () => ocrCurrentPage();
  window.__zeropdfStatus = () => ({
    pages: state.pages.length,
    textItems: state.pages[0] ? state.pages[0].textItems.length : -1,
    textEdits: state.pages[0] ? state.pages[0].textEdits.length : -1,
    firstEdit: state.pages[0] && state.pages[0].textEdits[0] ? state.pages[0].textEdits[0].text : null,
    docs: Array.from(state.docs.values()).map((record) => ({
      encrypted: record.encrypted,
      wasEncrypted: record.wasEncrypted,
      xfa: record.xfa
    })),
    formFields: state.formFields.map((field) => field.name)
  });

  // Hook para la prueba automática de humo.
  window.__smokeOpen = async (filePath) => {
    const result = await api.readFile(filePath);
    await loadPdf(result.data, result.name, result.path);
  };

  updateUI();
}

window.addEventListener('DOMContentLoaded', init);
