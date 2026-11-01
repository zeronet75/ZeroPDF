'use strict';

/*
 * Genera los iconos de ZeroPDF a partir de assets/icon.svg:
 *   assets/icon.png    (512 x 512, para la ventana)
 *   assets/icon.ico    (16, 24, 32, 48, 64, 128 y 256, para el ejecutable)
 *
 * Uso: npx electron scripts/make-icon.js
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ASSETS = path.join(__dirname, '..', 'assets');
const SVG_PATH = path.join(ASSETS, 'icon.svg');
const PNG_PATH = path.join(ASSETS, 'icon.png');
const ICO_PATH = path.join(ASSETS, 'icon.ico');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIcoEntry(size, bitmap) {
  const rowBytes = size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + máscara)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(rowBytes * size, 20); // biSizeImage

  // Bitmap BGRA de arriba a abajo -> DIB de abajo a arriba.
  const pixels = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y += 1) {
    bitmap.copy(pixels, y * rowBytes, (size - 1 - y) * rowBytes, (size - y) * rowBytes);
  }

  // Máscara AND: 1 = transparente.
  const mask = Buffer.alloc(maskRowBytes * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = bitmap[((size - 1 - y) * size + x) * 4 + 3];
      if (alpha < 128) {
        const position = y * maskRowBytes + (x >> 3);
        mask[position] |= 0x80 >> (x & 7);
      }
    }
  }

  return Buffer.concat([header, pixels, mask]);
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo: icono
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;

  entries.forEach((entry, index) => {
    const size = entry.size;
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // colores de la paleta
    directory.writeUInt8(0, at + 3); // reservado
    directory.writeUInt16LE(1, at + 4); // planos
    directory.writeUInt16LE(32, at + 6); // bits por píxel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  const svgData = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img id="icon" src="${svgData}" width="1024" height="1024" style="display:block">
  </body></html>`;

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    transparent: true,
    webPreferences: { backgroundThrottling: false }
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = document.getElementById('icon');
    if (img.decode) await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 1024, 1024);
    ctx.drawImage(img, 0, 0, 1024, 1024);
    return canvas.toDataURL('image/png');
  })()`);

  const source = nativeImage.createFromDataURL(dataUrl);
  if (source.isEmpty()) throw new Error('No se pudo renderizar icon.svg');

  const png = source.resize({ width: 512, height: 512, quality: 'best' }).toPNG();
  fs.writeFileSync(PNG_PATH, png);

  const entries = ICO_SIZES.map((size) => {
    const bitmap = source.resize({ width: size, height: size, quality: 'best' }).toBitmap();
    if (bitmap.length !== size * size * 4) {
      throw new Error(`Bitmap inesperado para ${size} px: ${bitmap.length} bytes`);
    }
    return { size, data: buildIcoEntry(size, bitmap) };
  });
  fs.writeFileSync(ICO_PATH, buildIco(entries));

  console.log('Icono generado:', PNG_PATH);
  console.log('Icono generado:', ICO_PATH, `(${ICO_SIZES.join(', ')} px)`);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
