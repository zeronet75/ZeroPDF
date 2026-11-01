'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zeropdf', {
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  saveDialog: (name, bytes) => ipcRenderer.invoke('dialog:save', name, bytes),
  confirmDiscard: () => ipcRenderer.invoke('dialog:confirm-discard'),
  decryptPdf: (bytes, password) => ipcRenderer.invoke('pdf:decrypt', bytes, password),
  encryptPdf: (bytes, password) => ipcRenderer.invoke('pdf:encrypt', bytes, password),
  extractPages: (bytes, range) => ipcRenderer.invoke('pdf:extract-pages', bytes, range),
  addRecent: (filePath) => ipcRenderer.invoke('app:add-recent', filePath),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  openPath: (filePath) => ipcRenderer.invoke('file:open-path', filePath),
  getLanguage: () => ipcRenderer.invoke('app:get-language'),
  setLanguage: (code) => ipcRenderer.invoke('app:set-language', code),
  openUrl: (url) => ipcRenderer.invoke('app:open-url', url),
  compressPdf: (bytes) => ipcRenderer.invoke('pdf:compress', bytes),
  saveImage: (bytes, name) => ipcRenderer.invoke('file:save-image', bytes, name),
  saveRecovery: (bytes, name) => ipcRenderer.invoke('recovery:save', bytes, name),
  clearRecovery: () => ipcRenderer.invoke('recovery:clear'),
  readRecovery: () => ipcRenderer.invoke('recovery:read'),
  printPages: (payload) => ipcRenderer.invoke('print:pages', payload),
  convertPdfToDocx: () => ipcRenderer.invoke('convert:pdf-to-docx'),
  convertDocxToPdf: () => ipcRenderer.invoke('convert:docx-to-pdf'),
  docxToPdfBuiltin: () => ipcRenderer.invoke('convert:docx-to-pdf-builtin'),
  saveDocx: (model, name) => ipcRenderer.invoke('convert:save-docx', model, name),
  openImageDialog: () => ipcRenderer.invoke('dialog:open-image'),
  saveImagePdf: (payload) => ipcRenderer.invoke('convert:image-to-pdf', payload),
  conversionEngines: () => ipcRenderer.invoke('convert:engines'),
  ocrPage: (bytes) => ipcRenderer.invoke('ocr:page', bytes),
  onMenu: (callback) => {
    ipcRenderer.on('menu', (_event, action) => callback(action));
  }
});
