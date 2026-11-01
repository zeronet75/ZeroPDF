'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const convert = require('./convert');
// Diccionarios adicionales: deben cargarse antes de i18n para registrarse.
require('./src/i18n-langs');
require('./src/i18n-langs2');
require('./src/i18n-langs3');
require('./src/i18n-langs4');
require('./src/i18n-langs5');
require('./src/i18n-langs6');
require('./src/i18n-full1');
require('./src/i18n-full2');
require('./src/i18n-full3');
require('./src/i18n-full4');
require('./src/i18n-full5');
const i18n = require('./src/i18n');

const execFileAsync = promisify(execFile);

const APP_NAME = 'ZeroPDF';
const TEST_MODE = process.argv.some((arg) =>
  arg.startsWith('--smoke=') || arg.startsWith('--shot=') ||
  arg.startsWith('--convert=') ||
  arg === '--selftest' || arg === '--editor-demo' || arg === '--editor-commit'
);

let mainWindow = null;
let allowWindowClose = false;
let closePromptOpen = false;

function askDiscardChanges() {
  return dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: tr('Cambios sin guardar'),
    message: tr('El documento tiene cambios sin guardar.'),
    detail: tr('Si continúas, se perderán los cambios que no hayas guardado en una copia.'),
    buttons: [tr('Cancelar'), tr('Descartar cambios')],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }).then((result) => result.response === 1);
}

function argValue(prefix) {
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

// Restos de conversiones anteriores (archivos temporales de maquetación).
function cleanupOldTempFiles() {
  const directory = app.getPath('temp');
  const limit = Date.now() - 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    return;
  }
  names.forEach((name) => {
    if (!/^zeropdf-(html|convert|word)-/.test(name)) return;
    const full = path.join(directory, name);
    try {
      if (fs.statSync(full).mtimeMs > limit) return;
      fs.rmSync(full, { recursive: true, force: true });
    } catch (error) {
      /* en uso o sin permisos */
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#1c2026',
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // La ventana se abre maximizada (ocupando el escritorio) desde el principio.
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('Preload error:', preloadPath, error && error.stack);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Render process gone:', JSON.stringify(details));
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    const details = level && typeof level === 'object' ? level : null;
    const severity = details ? details.level : level;
    const text = details ? details.message : message;
    if (severity === 'error' || severity === 3 || (event && event.level === 'error')) {
      console.error('Renderer:', text, details ? details.sourceId : '', details ? details.lineNumber : '');
    }
  });

  mainWindow.on('close', async (event) => {
    if (allowWindowClose || TEST_MODE) return;
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    try {
      let dirty = false;
      try {
        dirty = await Promise.race([
          mainWindow.webContents.executeJavaScript(
            'Boolean(window.__zeropdfIsDirty && window.__zeropdfIsDirty())', true
          ),
          new Promise((resolve) => setTimeout(() => resolve(false), 1500))
        ]);
      } catch (error) {
        dirty = false;
      }
      if (!dirty) {
        allowWindowClose = true;
        mainWindow.close();
        return;
      }
      if (await askDiscardChanges()) {
        allowWindowClose = true;
        mainWindow.close();
      }
    } finally {
      closePromptOpen = false;
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  buildMenu();
  runSmokeTest();
}

function send(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu', action);
  }
}

/* ---------------------------- Archivos recientes ------------------------- */

let appLanguage = 'es';

function languageFilePath() {
  return path.join(app.getPath('userData'), 'idioma.json');
}

function loadLanguage() {
  try {
    const data = JSON.parse(fs.readFileSync(languageFilePath(), 'utf8'));
    appLanguage = i18n.DICTIONARIES[data.language] ? data.language : 'es';
  } catch (error) {
    appLanguage = 'es';
  }
  i18n.setLanguage(appLanguage);
}

function saveLanguage() {
  try {
    fs.mkdirSync(path.dirname(languageFilePath()), { recursive: true });
    fs.writeFileSync(languageFilePath(), JSON.stringify({ language: appLanguage }, null, 2), 'utf8');
  } catch (error) {
    /* sin persistencia */
  }
}

function tr(text) {
  return i18n.t(text);
}

function changeLanguage(code) {
  appLanguage = i18n.DICTIONARIES[code] ? code : 'es';
  i18n.setLanguage(appLanguage);
  saveLanguage();
  buildMenu();
  send(`set-language:${appLanguage}`);
}

let recentFiles = [];

function recentFilesPath() {
  return path.join(app.getPath('userData'), 'recientes.json');
}

function loadRecentFiles() {
  try {
    const data = JSON.parse(fs.readFileSync(recentFilesPath(), 'utf8'));
    recentFiles = Array.isArray(data)
      ? data.filter((item) => typeof item === 'string' && fs.existsSync(item)).slice(0, 10)
      : [];
  } catch (error) {
    recentFiles = [];
  }
}

function saveRecentFiles() {
  try {
    fs.mkdirSync(path.dirname(recentFilesPath()), { recursive: true });
    fs.writeFileSync(recentFilesPath(), JSON.stringify(recentFiles, null, 2), 'utf8');
  } catch (error) {
    /* sin persistencia */
  }
}

function addRecentFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return;
  let resolved;
  try {
    resolved = path.resolve(filePath);
  } catch (error) {
    return;
  }
  if (!fs.existsSync(resolved)) return;
  recentFiles = [resolved]
    .concat(recentFiles.filter((item) => item.toLowerCase() !== resolved.toLowerCase()))
    .slice(0, 10);
  saveRecentFiles();
  buildMenu();
}

function clearRecentFiles() {
  recentFiles = [];
  saveRecentFiles();
  buildMenu();
}

function recentSubmenu() {
  if (!recentFiles.length) {
    return [{ label: '(vacío)', enabled: false }];
  }
  const items = recentFiles.map((file) => ({
    label: `${path.basename(file)}  —  ${path.dirname(file)}`,
    click: () => send(`open-recent:${file}`)
  }));
  items.push({ type: 'separator' });
  items.push({ label: 'Limpiar lista', click: () => clearRecentFiles() });
  return items;
}

function buildMenu() {
  i18n.setLanguage(appLanguage);
  const template = [
    {
      label: tr('Archivo'),
      submenu: [
        { label: tr('Abrir PDF…'), accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: tr('Abrir reciente'), submenu: recentSubmenu() },
        { type: 'separator' },
        { label: tr('Guardar copia…'), accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: tr('Imprimir…'), accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        { label: tr('Proteger con contraseña…'), click: () => send('protect') },
        { label: tr('Extraer páginas…'), click: () => send('extract-pages') },
        { label: tr('Exportar página como imagen…'), click: () => send('export-page-image') },
        { label: tr('Insertar páginas…'), click: () => send('insert-pages') },
        { type: 'separator' },
        { label: tr('Insertar firma…'), click: () => send('sign-use') },
        { label: tr('Dibujar firma…'), click: () => send('sign-now') },
        { type: 'separator' },
        { label: tr('Cerrar documento'), accelerator: 'CmdOrCtrl+W', click: () => send('close') },
        { type: 'separator' },
        { role: 'quit', label: tr('Salir') }
      ]
    },
    {
      label: tr('Editar'),
      submenu: [
        { label: tr('Deshacer'), accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: tr('Rehacer'), accelerator: 'CmdOrCtrl+Y', click: () => send('redo') },
        { type: 'separator' },
        { label: tr('Copiar texto de la página'), accelerator: 'CmdOrCtrl+C', click: () => send('copy-page-text') },
        { label: tr('Copiar todo el texto'), click: () => send('copy-all-text') },
        { type: 'separator' },
        { label: tr('Buscar y reemplazar…'), accelerator: 'CmdOrCtrl+H', click: () => send('search-replace') },
        { label: tr('Generar marcadores…'), click: () => send('bookmarks-generate') },
        { type: 'separator' },
        { label: tr('Eliminar anotación'), accelerator: 'Delete', click: () => send('delete-annotation') }
      ]
    },
    {
      label: tr('Ver'),
      submenu: [
        { label: tr('Ampliar'), accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: tr('Reducir'), accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: tr('Ajustar al ancho'), accelerator: 'CmdOrCtrl+0', click: () => send('fit-width') },
        { label: tr('Página siguiente'), accelerator: 'PageDown', click: () => send('next-page') },
        { label: tr('Página anterior'), accelerator: 'PageUp', click: () => send('prev-page') },
        { type: 'separator' },
        { label: tr('Cambiar tema (claro / oscuro)'), click: () => send('toggle-theme') },
        {
          label: tr('Idioma'),
          submenu: i18n.availableLanguages().map((language) => ({
            label: language.label,
            type: 'radio',
            checked: appLanguage === language.code,
            click: () => changeLanguage(language.code)
          }))
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: tr('Herramientas de desarrollo') }
      ]
    },
    {
      label: tr('Convertir'),
      submenu: [
        { label: tr('PDF a Word (.docx)…'), click: () => send('convert-pdf-to-docx') },
        { label: tr('Word (.docx) a PDF…'), click: () => send('convert-docx-to-pdf') },
        { type: 'separator' },
        { label: tr('Imagen (JPG, PNG, BMP) a PDF…'), click: () => send('convert-image-to-pdf') }
      ]
    },
    {
      label: tr('Ayuda'),
      submenu: [
        { label: `${tr('Acerca de ZeroPDF')}`, click: () => send('about') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('dialog:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Abrir PDF',
    filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const data = await fs.promises.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data) };
});

ipcMain.handle('file:read', async (_event, filePath) => {
  if (!TEST_MODE) throw new Error('La lectura directa de archivos solo está disponible en las pruebas.');
  if (typeof filePath !== 'string' || !filePath) throw new Error('Ruta no válida.');
  const data = await fs.promises.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data) };
});

ipcMain.handle('dialog:save', async (_event, suggestedName, bytes) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Guardar copia del PDF',
    defaultPath: suggestedName,
    filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };
  let filePath = result.filePath;
  if (!/\.pdf$/i.test(filePath)) filePath += '.pdf';
  await fs.promises.writeFile(filePath, Buffer.from(bytes));
  return { ok: true, path: filePath };
});

ipcMain.handle('dialog:confirm-discard', async () => askDiscardChanges());

function qpdfExecutable() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'qpdf', 'qpdf.exe') : null,
    path.join(__dirname, 'vendor', 'qpdf', 'qpdf.exe')
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

ipcMain.handle('pdf:decrypt', async (_event, bytes, password) => {
  const executable = qpdfExecutable();
  if (!executable) {
    return { ok: false, error: 'qpdf no está disponible en esta instalación.' };
  }
  const workDir = path.join(app.getPath('temp'), `zeropdf-decrypt-${process.pid}-${Date.now()}`);
  const inputPath = path.join(workDir, 'entrada.pdf');
  const outputPath = path.join(workDir, 'salida.pdf');
  const passwordPath = path.join(workDir, 'password.txt');
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(inputPath, Buffer.from(bytes));
    const args = ['--decrypt', '--warning-exit-0'];
    if (password) {
      fs.writeFileSync(passwordPath, password, 'utf8');
      args.push(`--password-file=${passwordPath}`);
    }
    args.push(inputPath, outputPath);
    await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024
    });
    const output = await fs.promises.readFile(outputPath);
    return { ok: true, data: new Uint8Array(output) };
  } catch (error) {
    const detail = error && (error.stderr || error.message);
    return { ok: false, error: String(detail || 'No se pudo descifrar el PDF.').trim() };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
});

/* ---------------------- Proteger y extraer páginas ----------------------- */

// Ejecuta qpdf sobre los bytes recibidos y devuelve el PDF resultante.
async function runQpdfOnBytes(prefix, bytes, buildArgs) {
  const executable = qpdfExecutable();
  if (!executable) {
    return { ok: false, error: 'qpdf no está disponible en esta instalación.' };
  }
  const workDir = path.join(app.getPath('temp'), `zeropdf-${prefix}-${process.pid}-${Date.now()}`);
  const inputPath = path.join(workDir, 'entrada.pdf');
  const outputPath = path.join(workDir, 'salida.pdf');
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(inputPath, Buffer.from(bytes));
    const args = buildArgs(inputPath, outputPath);
    await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024
    });
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: 'qpdf no generó el archivo de salida.' };
    }
    const output = await fs.promises.readFile(outputPath);
    return { ok: true, data: new Uint8Array(output) };
  } catch (error) {
    const detail = error && (error.stderr || error.message);
    return { ok: false, error: String(detail || 'qpdf no pudo procesar el PDF.').trim() };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

ipcMain.handle('pdf:encrypt', async (_event, bytes, password) => {
  const secret = String(password || '');
  if (secret.length < 1) {
    return { ok: false, error: 'La contraseña no puede estar vacía.' };
  }
  return await runQpdfOnBytes('protect', bytes, (input, output) => [
    '--encrypt',
    `--user-password=${secret}`,
    `--owner-password=${secret}`,
    '--bits=256',
    '--',
    input,
    output
  ]);
});

ipcMain.handle('pdf:extract-pages', async (_event, bytes, range) => {
  const pages = String(range || '').trim();
  if (!/^[0-9,\-\s]+$/.test(pages)) {
    return { ok: false, error: 'Rango de páginas no válido.' };
  }
  return await runQpdfOnBytes('extract', bytes, (input, output) => [
    '--empty',
    '--pages', input, pages.replace(/\s+/g, ''),
    '--',
    output
  ]);
});

/* ------------------------------- Portapapeles ---------------------------- */

ipcMain.handle('app:add-recent', async (_event, filePath) => {
  addRecentFile(filePath);
  return true;
});

ipcMain.handle('app:copy-text', async (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('app:get-language', async () => appLanguage);

ipcMain.handle('app:set-language', async (_event, code) => {
  changeLanguage(code);
  return appLanguage;
});

ipcMain.handle('app:open-url', async (_event, url) => {
  const value = String(url || '');
  if (/^https?:\/\//i.test(value)) shell.openExternal(value);
  return true;
});

ipcMain.handle('pdf:compress', async (_event, bytes) => {
  return await runQpdfOnBytes('compress', bytes, (input, output) => [
    '--object-streams=generate',
    '--recompress-flate',
    '--compression-level=9',
    input,
    output
  ]);
});

/* --------------------- Recuperación de cambios sin guardar ---------------- */

function recoveryDirectory() {
  return path.join(app.getPath('userData'), 'recuperacion');
}

ipcMain.handle('recovery:save', async (_event, bytes, name) => {
  const directory = recoveryDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, 'documento.pdf'), Buffer.from(bytes));
  await fs.promises.writeFile(
    path.join(directory, 'datos.json'),
    JSON.stringify({ name: String(name || 'documento.pdf'), date: Date.now() }, null, 2),
    'utf8'
  );
  return true;
});

ipcMain.handle('recovery:clear', async () => {
  await fs.promises.rm(recoveryDirectory(), { recursive: true, force: true });
  return true;
});

ipcMain.handle('recovery:read', async () => {
  const file = path.join(recoveryDirectory(), 'documento.pdf');
  if (!fs.existsSync(file)) return null;
  let name = 'documento.pdf';
  try {
    name = JSON.parse(fs.readFileSync(path.join(recoveryDirectory(), 'datos.json'), 'utf8')).name || name;
  } catch (error) {
    /* sin metadatos */
  }
  const data = await fs.promises.readFile(file);
  return { name, data: new Uint8Array(data) };
});

async function offerRecovery() {
  if (TEST_MODE) return;
  const file = path.join(recoveryDirectory(), 'documento.pdf');
  if (!fs.existsSync(file)) return;
  let name = 'documento.pdf';
  try {
    name = JSON.parse(fs.readFileSync(path.join(recoveryDirectory(), 'datos.json'), 'utf8')).name || name;
  } catch (error) {
    /* sin metadatos */
  }
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: tr('Recuperar documento'),
    message: tr('Hay cambios sin guardar de la sesión anterior.'),
    detail: `${name}\n${tr('¿Quieres recuperarlos?')}`,
    buttons: [tr('Descartar'), tr('Recuperar')],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  });
  if (answer.response === 1) {
    send('open-recovery');
  } else {
    fs.rmSync(recoveryDirectory(), { recursive: true, force: true });
  }
}

ipcMain.handle('file:open-path', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) throw new Error('Ruta no válida.');
  const data = await fs.promises.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data) };
});

ipcMain.handle('file:save-image', async (_event, bytes, suggestedName) => {
  const owner = findMainWindow();
  const base = String(suggestedName || 'pagina.png');
  const extension = /\.jpe?g$/i.test(base) ? 'jpg' : 'png';
  const save = await dialog.showSaveDialog(owner, {
    title: tr('Guardar imagen'),
    defaultPath: path.join(app.getPath('documents'), base),
    filters: extension === 'jpg'
      ? [{ name: 'Imagen JPEG', extensions: ['jpg', 'jpeg'] }]
      : [{ name: 'Imagen PNG', extensions: ['png'] }]
  });
  if (save.canceled || !save.filePath) return { cancelled: true };
  try {
    await fs.promises.writeFile(save.filePath, Buffer.from(bytes));
    return { ok: true, path: save.filePath };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).trim() };
  }
});

/* --------------------------------- Imprimir ------------------------------ */

ipcMain.handle('print:pages', async (_event, payload) => {
  const pages = Array.isArray(payload && payload.pages) ? payload.pages.filter(Boolean) : [];
  if (!pages.length) return { ok: false, error: 'No hay páginas que imprimir.' };
  const width = Number(payload.width) || 595.28;
  const height = Number(payload.height) || 841.89;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${width.toFixed(2)}pt ${height.toFixed(2)}pt; margin: 0 }
    html, body { margin: 0; padding: 0; background: #fff }
    .page {
      width: ${width.toFixed(2)}pt;
      height: ${height.toFixed(2)}pt;
      page-break-after: always;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .page:last-child { page-break-after: auto }
    .page img { width: 100%; height: 100%; object-fit: contain }
  </style></head><body>${pages.map((png) => `<div class="page"><img src="${png}"></div>`).join('')}</body></html>`;

  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: { sandbox: true, contextIsolation: true }
  });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await window.webContents.executeJavaScript(
      'Promise.all(Array.from(document.images).map((img) => (img.complete ? true : new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; }))))'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const outcome = await new Promise((resolve) => {
      window.webContents.print({
        silent: false,
        printBackground: true,
        preferCSSPageSize: true,
        margins: { marginType: 'none' }
      }, (success, reason) => resolve({ success, reason }));
    });
    if (outcome.success) return { ok: true };
    const cancelled = /cancel/i.test(String(outcome.reason || ''));
    return cancelled ? { ok: true, cancelled: true } : { ok: false, error: String(outcome.reason || 'No se pudo imprimir.') };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).trim() };
  } finally {
    try { window.destroy(); } catch (error) { /* ya cerrada */ }
  }
});


function runOcr(pngBytes) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('El OCR integrado solo está disponible en Windows.'));
  }
  const stamp = `${process.pid}-${Date.now()}`;
  const tempPng = path.join(app.getPath('temp'), `zeropdf-ocr-${stamp}.png`);
  const tempScript = path.join(app.getPath('temp'), `zeropdf-ocr-${stamp}.ps1`);
  try {
    fs.writeFileSync(tempPng, Buffer.from(pngBytes));
    fs.writeFileSync(tempScript, fs.readFileSync(path.join(__dirname, 'scripts', 'ocr.ps1')));
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempScript, '-Path', tempPng],
      { windowsHide: true, timeout: 120000, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        fs.unlink(tempPng, () => {});
        fs.unlink(tempScript, () => {});
        if (error) {
          reject(new Error(String(stderr || error.message).trim()));
          return;
        }
        try {
          const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
          const parsed = text ? JSON.parse(text) : [];
          resolve({ lines: Array.isArray(parsed) ? parsed : [parsed] });
        } catch (parseError) {
          reject(new Error('Respuesta OCR no válida: ' + parseError.message));
        }
      }
    );
  });
}

ipcMain.handle('ocr:page', async (_event, bytes) => runOcr(bytes));

/* --------------------- Conversión PDF <-> Word --------------------------- */

// Word expone automatización COM; es la vía que mejor conserva el formato
// (tablas, estilos, imágenes) en ambos sentidos. LibreOffice se usa si no hay
// Word instalado.
const WORD_SCRIPT = `param([string]$Mode, [string]$InputPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$word = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $doc = $word.Documents.Open($InputPath, $false, $true, $false)
  if ($Mode -eq 'pdf2docx') {
    $doc.SaveAs2($OutputPath, 16)
  } else {
    $doc.SaveAs2($OutputPath, 17)
  }
  $doc.Close(0)
  Write-Output 'OK'
} catch {
  Write-Output ('ERR:' + $_.Exception.Message)
  exit 1
} finally {
  if ($word) {
    try { $word.Quit(0) } catch { }
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch { }
  }
}
`;

function libreOfficeExecutable() {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

let conversionEngines = null;

// Los scripts se envían codificados (-EncodedCommand): evita depender de
// archivos .ps1 temporales, que en algunos equipos no son accesibles.
function encodePowerShell(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function detectConversionEngines() {
  if (conversionEngines) return conversionEngines;
  let word = false;
  if (process.platform === 'win32') {
    // No basta con que Word esté registrado: se comprueba que arranque de
    // verdad (si un complemento lo cierra, COM falla).
    const command = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      '  $w = New-Object -ComObject Word.Application',
      '  $w.Visible = $false',
      '  $null = $w.Version',
      '  $w.Quit()',
      "  Write-Output 'WORD_OK'",
      '} catch {',
      "  Write-Output ('WORD_FAIL ' + $_.Exception.Message)",
      '}'
    ].join('\n');
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodePowerShell(command)
      ], { windowsHide: true, timeout: 60000 });
      word = /WORD_OK/.test(String(stdout || ''));
    } catch (error) {
      word = false;
    }
  }
  conversionEngines = { word, libre: Boolean(libreOfficeExecutable()) };
  return conversionEngines;
}

async function runWordConversion(mode, inputPath, outputPath) {
  const format = mode === 'pdf2docx' ? 16 : 17; // Word: docx / PDF
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$word = $null',
    'try {',
    '  $word = New-Object -ComObject Word.Application',
    '  $word.Visible = $false',
    '  $word.DisplayAlerts = 0',
    '  $word.AutomationSecurity = 3',
    `  $doc = $word.Documents.Open(${psQuote(inputPath)}, $false, $true, $false)`,
    `  $doc.SaveAs2(${psQuote(outputPath)}, ${format})`,
    '  $doc.Close(0)',
    "  Write-Output 'OK'",
    '} catch {',
    "  Write-Output ('ERR:' + $_.Exception.Message)",
    '  exit 1',
    '} finally {',
    '  if ($word) {',
    '    try { $word.Quit() } catch { }',
    '    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch { }',
    '  }',
    '}'
  ].join('\n');

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodePowerShell(command)
  ], { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });

  if (!/OK/.test(String(stdout || ''))) {
    const detail = String(stdout || '').replace(/^ERR:/m, '').trim();
    throw new Error(detail || 'Word no completó la conversión.');
  }
}

async function runLibreOfficeConversion(mode, inputPath, outputPath) {
  const executable = libreOfficeExecutable();
  if (!executable) throw new Error('LibreOffice no está instalado.');
  const outputDir = path.dirname(outputPath);
  const filter = mode === 'pdf2docx' ? 'docx:MS Word 2007 XML' : 'pdf';
  await execFileAsync(executable, [
    '--headless', '--norestore', '--convert-to', filter, '--outdir', outputDir, inputPath
  ], { windowsHide: true, timeout: 10 * 60 * 1000 });

  const extension = mode === 'pdf2docx' ? '.docx' : '.pdf';
  const produced = path.join(outputDir, path.basename(inputPath, path.extname(inputPath)) + extension);
  if (produced === outputPath) {
    if (!fs.existsSync(outputPath)) throw new Error('LibreOffice no generó el archivo.');
    return;
  }
  if (!fs.existsSync(produced)) throw new Error('LibreOffice no generó el archivo.');
  await fs.promises.rename(produced, outputPath);
}

// Word no abre PDF cifrados: si qpdf puede descifrarlo sin contraseña, se
// convierte una copia temporal.
async function prepareConversionSource(inputPath) {
  const executable = qpdfExecutable();
  if (!executable) return { path: inputPath, cleanup: null };
  const tempPath = path.join(app.getPath('temp'), `zeropdf-convert-${process.pid}-${Date.now()}.pdf`);
  try {
    await execFileAsync(executable, ['--decrypt', '--warning-exit-0', inputPath, tempPath], {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 20 * 1024 * 1024
    });
    if (fs.existsSync(tempPath)) return { path: tempPath, cleanup: tempPath };
  } catch (error) {
    /* PDF protegido con contraseña: se intenta con el original */
  }
  return { path: inputPath, cleanup: null };
}

async function convertDocument(mode, inputPath, outputPath) {
  if (!fs.existsSync(inputPath)) return { ok: false, error: 'No se encuentra el archivo de origen.' };
  const engines = await detectConversionEngines();
  if (!engines.word && !engines.libre) {
    return {
      ok: false,
      error: 'Para convertir documentos hace falta Microsoft Word o LibreOffice instalados.'
    };
  }
  const source = mode === 'pdf2docx'
    ? await prepareConversionSource(inputPath)
    : { path: inputPath, cleanup: null };
  try {
    let engine = '';
    if (engines.word) {
      engine = 'Microsoft Word';
      await runWordConversion(mode, source.path, outputPath);
    } else {
      engine = 'LibreOffice';
      await runLibreOfficeConversion(mode, source.path, outputPath);
    }
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: `${engine} no generó ningún archivo.` };
    }
    return { ok: true, engine, outputPath };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).trim() };
  } finally {
    if (source.cleanup) await fs.promises.rm(source.cleanup, { force: true }).catch(() => {});
  }
}

async function askAndConvert(mode) {
  const toDocx = mode === 'pdf2docx';
  const open = await dialog.showOpenDialog(mainWindow, {
    title: toDocx ? 'Convertir PDF a Word' : 'Convertir Word a PDF',
    filters: [toDocx
      ? { name: 'Documentos PDF', extensions: ['pdf'] }
      : { name: 'Documentos de Word', extensions: ['docx', 'doc'] }],
    properties: ['openFile']
  });
  if (open.canceled || !open.filePaths.length) return { cancelled: true };
  const inputPath = open.filePaths[0];
  const base = path.basename(inputPath, path.extname(inputPath));
  const save = await dialog.showSaveDialog(mainWindow, {
    title: toDocx ? 'Guardar como documento de Word' : 'Guardar como PDF',
    defaultPath: path.join(path.dirname(inputPath), base + (toDocx ? '.docx' : '.pdf')),
    filters: [toDocx
      ? { name: 'Documento de Word', extensions: ['docx'] }
      : { name: 'Documento PDF', extensions: ['pdf'] }]
  });
  if (save.canceled || !save.filePath) return { cancelled: true };
  return await convertDocument(mode, inputPath, save.filePath);
}

ipcMain.handle('convert:pdf-to-docx', async () => askAndConvert('pdf2docx'));
ipcMain.handle('convert:docx-to-pdf', async () => askAndConvert('docx2pdf'));
ipcMain.handle('convert:engines', async () => detectConversionEngines());

/* -------------------- Motor propio (sin Word/LibreOffice) ---------------- */

function findMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

async function renderHtmlToPdf(html, page, outputPath) {
  // Se carga como data: URL para no dejar archivos bloqueados por Chromium.
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: true }
  });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    try {
      await window.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    } catch (error) {
      /* sin fuentes que esperar */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    // El tamaño y los márgenes van en el CSS (@page) con preferCSSPageSize:
    // la API de tamaño personalizado en micras falla en esta versión.
    const buffer = await window.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    });
    await fs.promises.writeFile(outputPath, buffer);
  } finally {
    try { window.destroy(); } catch (error) { /* ya cerrada */ }
  }
}

ipcMain.handle('convert:docx-to-pdf-builtin', async () => {
  const owner = findMainWindow();
  const open = await dialog.showOpenDialog(owner, {
    title: 'Convertir Word a PDF',
    filters: [{ name: 'Documentos de Word', extensions: ['docx'] }],
    properties: ['openFile']
  });
  if (open.canceled || !open.filePaths.length) return { cancelled: true };
  const inputPath = open.filePaths[0];
  const base = path.basename(inputPath, path.extname(inputPath));
  const save = await dialog.showSaveDialog(owner, {
    title: 'Guardar como PDF',
    defaultPath: path.join(path.dirname(inputPath), `${base}.pdf`),
    filters: [{ name: 'Documento PDF', extensions: ['pdf'] }]
  });
  if (save.canceled || !save.filePath) return { cancelled: true };

  try {
    const buffer = await fs.promises.readFile(inputPath);
    const { html, page } = convert.docxToHtml(buffer);
    await renderHtmlToPdf(html, page, save.filePath);
    return { ok: true, outputPath: save.filePath, engine: 'ZeroPDF' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).trim() };
  }
});

ipcMain.handle('convert:save-docx', async (_event, model, suggestedName) => {
  const owner = findMainWindow();
  const base = String(suggestedName || 'documento.pdf').replace(/\.pdf$/i, '');
  const save = await dialog.showSaveDialog(owner, {
    title: 'Guardar como documento de Word',
    defaultPath: path.join(app.getPath('documents'), `${base}.docx`),
    filters: [{ name: 'Documento de Word', extensions: ['docx'] }]
  });
  if (save.canceled || !save.filePath) return { cancelled: true };
  try {
    const buffer = convert.buildDocx(model);
    await fs.promises.writeFile(save.filePath, buffer);
    return { ok: true, outputPath: save.filePath, engine: 'ZeroPDF' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).trim() };
  }
});

/* ------------------------- Imagen -> PDF (con OCR) ----------------------- */

// Coloca la imagen en una página A4 y añade el texto del OCR como capa
// invisible (modo de renderizado 3): se puede seleccionar y buscar, pero no
// se ve sobre la imagen. La implementación vive en convert.js para poder
// probarla fuera de Electron.
async function buildImagePdf(payload) {
  return await convert.buildImagePdf(payload);
}

ipcMain.handle('dialog:open-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Abrir imagen',
    filters: [{ name: 'Imágenes (JPG, PNG, BMP)', extensions: ['jpg', 'jpeg', 'png', 'bmp'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const data = await fs.promises.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data) };
});

ipcMain.handle('convert:image-to-pdf', async (_event, payload) => {
  const owner = findMainWindow();
  const base = String((payload && payload.name) || 'imagen').replace(/\.[^.]+$/, '');
  const save = await dialog.showSaveDialog(owner, {
    title: 'Guardar imagen como PDF',
    defaultPath: path.join(app.getPath('documents'), `${base}.pdf`),
    filters: [{ name: 'Documento PDF', extensions: ['pdf'] }]
  });
  if (save.canceled || !save.filePath) return { cancelled: true };
  try {
    const bytes = await buildImagePdf({ ...payload, title: base });
    await fs.promises.writeFile(save.filePath, bytes);
    return {
      ok: true,
      outputPath: save.filePath,
      engine: 'ZeroPDF',
      lines: Array.isArray(payload && payload.lines) ? payload.lines.length : 0
    };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).trim() };
  }
});

function runSmokeTest() {
  const smokeFile = argValue('--smoke=');
  const shotFile = argValue('--shot=');
  if (!smokeFile) return;

  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      await mainWindow.webContents.executeJavaScript(
        `window.__smokeOpen(${JSON.stringify(path.resolve(smokeFile))})`
      );
    } catch (error) {
      console.error('Smoke open failed:', error);
    }

    if (process.argv.includes('--editor-demo')) {
      try {
        await mainWindow.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 80 && !state.pages[0].textItems.length; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          setTool('textedit');
          const item = state.pages[0].textItems.find((entry) => entry.str.includes('Documento de ejemplo'));
          if (item) openTextEditor(pageEntries[0].el, 0, item);
          if (${process.argv.includes('--editor-commit') ? 'true' : 'false'}) {
            const input = document.querySelector('.te-input');
            if (input) {
              input.value = 'Documento modificado en ZeroPDF';
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            }
            const notesTab = document.querySelector('.tab[data-tab="anns"]');
            if (notesTab) notesTab.click();
          }
          return Boolean(item);
        })()`);
      } catch (error) {
        console.error('Editor demo failed:', error);
      }
    }

    if (process.argv.includes('--selftest')) {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          const page = state.pages[0];
          const page2 = state.pages[1];
          page.anns.push({ id: 'test-hl', type: 'highlight', x: 90, y: 380, w: 240, h: 18, color: '#ffd400', opacity: 0.35, lineWidth: 1 });
          page.anns.push({ id: 'test-text', type: 'text', x: 90, y: 340, text: 'Prueba ZeroPDF', color: '#e11900', fontSize: 16, lineWidth: 2 });
          page.anns.push({ id: 'test-rect', type: 'rect', x: 90, y: 290, w: 180, h: 30, color: '#1e6eff', lineWidth: 2 });
          page.anns.push({ id: 'test-ink', type: 'ink', points: [[90, 250], [120, 235], [150, 260]], color: '#00a86b', lineWidth: 3 });
          page2.anns.push({ id: 'test-note', type: 'note', x: 300, y: 300, w: 170, h: 60, text: 'Nota de prueba', color: '#d4b106', fontSize: 11, lineWidth: 1 });
          const canvas = document.createElement('canvas');
          canvas.width = 60; canvas.height = 30;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#e11900'; ctx.fillRect(0, 0, 60, 30);
          ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('Z', 24, 20);
          page2.anns.push({ id: 'test-img', type: 'image', x: 300, y: 200, w: 90, h: 45, dataURL: canvas.toDataURL('image/png'), color: '#e11900', lineWidth: 0 });
          state.metadata = { title: 'Prueba ZeroPDF', author: 'zeronet75', subject: 'Selftest', keywords: 'zeropdf, prueba' };
          state.watermark = { text: 'BORRADOR', on: true };
          redrawPage(0);
          redrawPage(1);

          // --- Edición de texto original ---
          for (let i = 0; i < 60 && !page.textItems.length; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const entry0 = pageEntries[0];
          const target = page.textItems.find((item) => item.str.includes('Documento de ejemplo'));
          const doomed = page.textItems.find((item) => item.str.includes('Generado por'));
          let sampled = null;
          if (target && entry0 && entry0.vp) {
            sampled = sampleTextColors(entry0, textItemRect(target, entry0.vp));
            applyTextEdit(0, target, {
              text: 'Documento editado por zeronet75',
              family: 'helvetica',
              bold: false,
              italic: false,
              color: sampled.color,
              bg: sampled.bg
            });
          }
          if (doomed) {
            const doomedRect = textItemRect(doomed, entry0.vp);
            const doomedColors = sampleTextColors(entry0, doomedRect);
            applyTextEdit(0, doomed, {
              text: '',
              family: 'helvetica',
              bold: false,
              italic: false,
              color: doomedColors.color,
              bg: doomedColors.bg
            });
          }
          redrawPage(0);
          const overlay = document.querySelectorAll('[data-textedit]').length;

          const bytes = await buildPdf();
          const checkDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
          const checkPage = await checkDoc.getPage(1);
          const checkText = (await checkPage.getTextContent()).items.map((item) => item.str).join(' ');
          document.querySelector('#searchInput').value = 'zorro';
          await runSearch();
          return {
            pages: state.pages.length,
            annotations: page.anns.length + page2.anns.length,
            textEdits: page.textEdits.length,
            overlayNodes: overlay,
            sampledColor: sampled && sampled.color,
            sampledBg: sampled && sampled.bg,
            targetFound: Boolean(target),
            newTextInPdf: checkText.includes('Documento editado por zeronet75'),
            size: bytes.length,
            formFields: state.formFields.length,
            searchMatches: state.search.matches.length,
            bytes: Array.from(bytes)
          };
        })()`);
        const outputPath = path.resolve('selftest.pdf');
        fs.writeFileSync(outputPath, Buffer.from(result.bytes));
        delete result.bytes;
        result.file = outputPath;
        console.log('SELFTEST:', JSON.stringify(result));
      } catch (error) {
        console.error('Selftest failed:', error);
      }
    }

    if (!shotFile) {
      if (process.argv.includes('--selftest')) app.quit();
      return;
    }
    setTimeout(async () => {
      try {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.resolve(shotFile), image.toPNG());
        console.log('Screenshot written:', path.resolve(shotFile));
      } catch (error) {
        console.error('Screenshot failed:', error);
      } finally {
        app.quit();
      }
    }, 8000);
  });
}

app.whenReady().then(async () => {
  cleanupOldTempFiles();
  loadLanguage();
  loadRecentFiles();
  const convertMode = argValue('--convert=');
  if (convertMode) {
    const input = argValue('--input=');
    const output = argValue('--output=');
    let result;
    if (convertMode === 'docx2pdf-builtin') {
      try {
        const buffer = await fs.promises.readFile(input);
        const { html, page } = convert.docxToHtml(buffer);
        await renderHtmlToPdf(html, page, output);
        result = { ok: true, engine: 'ZeroPDF', outputPath: output };
      } catch (error) {
        result = { ok: false, error: String((error && error.message) || error) };
      }
    } else {
      result = await convertDocument(convertMode, input, output);
    }
    process.stdout.write(`CONVERT:${JSON.stringify(result)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    app.quit();
    return;
  }
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => { offerRecovery().catch(() => {}); }, 800);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

