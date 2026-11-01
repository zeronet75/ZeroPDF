'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

async function main() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const dark = rgb(0.11, 0.13, 0.17);
  const accent = rgb(0.88, 0.1, 0.0);
  const muted = rgb(0.45, 0.48, 0.53);

  // Página 1: portada
  const cover = doc.addPage([595.28, 841.89]);
  cover.drawRectangle({ x: 0, y: 600, width: 595.28, height: 241.89, color: dark });
  cover.drawText('ZeroPDF', { x: 48, y: 760, size: 40, font: bold, color: rgb(1, 1, 1) });
  cover.drawText('Documento de ejemplo', { x: 48, y: 720, size: 18, font, color: rgb(0.85, 0.87, 0.9) });
  cover.drawText('Generado por zeronet75', { x: 48, y: 640, size: 12, font, color: rgb(0.7, 0.73, 0.78) });

  cover.drawText('Este archivo sirve para probar el visor, las anotaciones,', { x: 48, y: 540, size: 13, font, color: dark });
  cover.drawText('la búsqueda de texto, los formularios y la exportación.', { x: 48, y: 520, size: 13, font, color: dark });

  cover.drawText('Funciones de prueba', { x: 48, y: 470, size: 16, font: bold, color: accent });
  const features = [
    'Resaltar texto y dibujar formas',
    'Añadir notas y cuadros de texto',
    'Insertar imágenes y firmas',
    'Girar, mover y eliminar páginas',
    'Combinar varios PDF',
    'Rellenar formularios',
    'Marca de agua y metadatos'
  ];
  features.forEach((feature, index) => {
    cover.drawText('• ' + feature, { x: 56, y: 440 - index * 22, size: 12, font, color: dark });
  });

  cover.drawText('ZeroPDF · zeronet75', { x: 48, y: 60, size: 10, font, color: muted });
  cover.drawText('Página 1', { x: 500, y: 60, size: 10, font, color: muted });

  // Página 2: texto y formulario
  const page2 = doc.addPage([595.28, 841.89]);
  page2.drawText('Formulario de ejemplo', { x: 48, y: 780, size: 22, font: bold, color: dark });
  page2.drawText('Rellena los campos desde el panel «Formulario» y guarda una copia.', {
    x: 48, y: 750, size: 11, font, color: muted
  });

  const form = doc.getForm();

  const nameField = form.createTextField('nombre');
  nameField.setText('Escribe tu nombre');
  nameField.addToPage(page2, { x: 48, y: 690, width: 320, height: 26, borderWidth: 1 });

  const emailField = form.createTextField('correo');
  emailField.setText('correo@ejemplo.com');
  emailField.addToPage(page2, { x: 48, y: 630, width: 320, height: 26, borderWidth: 1 });

  const accept = form.createCheckBox('acepto');
  accept.addToPage(page2, { x: 48, y: 590, width: 16, height: 16 });

  page2.drawText('Acepto los términos de uso', { x: 74, y: 594, size: 11, font, color: dark });
  page2.drawText('Nombre:', { x: 48, y: 722, size: 11, font, color: dark });
  page2.drawText('Correo:', { x: 48, y: 662, size: 11, font, color: dark });

  page2.drawText('Texto de prueba para buscar:', { x: 48, y: 520, size: 12, font: bold, color: dark });
  page2.drawText('El rápido zorro marrón salta sobre el perro perezoso.', {
    x: 48, y: 496, size: 12, font, color: dark
  });
  page2.drawText('ZeroPDF permite buscar coincidencias en todo el documento.', {
    x: 48, y: 474, size: 12, font, color: dark
  });

  page2.drawText('Página 2', { x: 500, y: 60, size: 10, font, color: muted });

  // Página 3: tabla
  const page3 = doc.addPage([595.28, 841.89]);
  page3.drawText('Tabla de ejemplo', { x: 48, y: 780, size: 22, font: bold, color: dark });

  const rows = [
    ['Herramienta', 'Atajo', 'Uso'],
    ['Abrir', 'Ctrl+O', 'Cargar un PDF'],
    ['Guardar copia', 'Ctrl+S', 'Exportar con cambios'],
    ['Buscar', 'Ctrl+F', 'Encontrar texto'],
    ['Deshacer', 'Ctrl+Z', 'Revertir cambios'],
    ['Ajustar', 'Ctrl+0', 'Ajustar al ancho']
  ];

  const startY = 730;
  rows.forEach((row, rowIndex) => {
    const y = startY - rowIndex * 32;
    if (rowIndex === 0) {
      page3.drawRectangle({ x: 48, y: y - 6, width: 500, height: 28, color: rgb(0.92, 0.93, 0.95) });
    }
    row.forEach((cell, cellIndex) => {
      page3.drawText(cell, {
        x: 58 + cellIndex * 170,
        y,
        size: 11,
        font: rowIndex === 0 ? bold : font,
        color: dark
      });
    });
    page3.drawLine({ start: { x: 48, y: y - 12 }, end: { x: 548, y: y - 12 }, thickness: 0.6, color: rgb(0.8, 0.82, 0.86) });
  });

  page3.drawText('Página 3', { x: 500, y: 60, size: 10, font, color: muted });

  const bytes = await doc.save();
  const target = path.join(__dirname, '..', 'sample.pdf');
  fs.writeFileSync(target, bytes);
  console.log('Muestra creada:', target, `(${Math.round(bytes.length / 1024)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
