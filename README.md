# ZeroPDF

Visor y editor de PDF de escritorio para Windows, original y ligero.
**Desarrollado por zeronet75 · Licencia MIT.**

ZeroPDF es una aplicación independiente inspirada en la disposición clásica de los
lectores de PDF (barra de herramientas, miniaturas, lienzo central y panel lateral).
No está afiliada, patrocinada ni respaldada por Adobe, y no utiliza sus logotipos,
iconos ni recursos.

## Funciones

- Lectura de PDF con desplazamiento continuo, miniaturas y zoom (25 %–500 %).
- **Idiomas**: 23 idiomas (español por defecto, inglés, alemán, francés, italiano,
  chino simplificado y tradicional, japonés, portugués de Brasil, ruso, árabe con
  interfaz de derecha a izquierda, coreano, neerlandés, polaco, turco, sueco, danés,
  noruego, ucraniano, hindi, vietnamita, tailandés e indonesio), con selector en el
  menú Ver → Idioma y también en el instalador. Toda la interfaz, los menús, los
  diálogos y los avisos están traducidos.
- **Índice de marcadores** navegable y **enlaces clicables** (URLs y saltos internos).
- **Tema claro u oscuro**, con la preferencia guardada.
- Búsqueda de texto en todo el documento.
- **Redacción real**: la herramienta «Redactar» borra el texto de la zona del flujo de
  contenido (no solo lo tapa) y dibuja un rectángulo negro.
- **Buscar y reemplazar** en todo el documento (Ctrl+H).
- **Firma dibujada a mano**, que se guarda para reutilizarla en otros documentos.
- **Generar marcadores** detectando los títulos por tamaño de letra.
- **Insertar páginas** de otro PDF en la posición que elijas.
- **Copiar texto** de la página (Ctrl+C) o de todo el documento al portapapeles.
- **Imprimir** (Ctrl+P) con el diálogo de Windows: impresora, rango de páginas,
  copias y orientación.
- **Edición del texto original**: con la herramienta «Editar texto» (o doble clic con
  Seleccionar) se abre un editor sobre la línea pulsada. ZeroPDF localiza los
  operadores de texto del PDF, **elimina los glifos originales del flujo de contenido**
  (incluido el texto dentro de Form XObjects y el texto girado o invertido) y escribe el
  texto nuevo **con la misma fuente, tamaño, color, negrita y cursiva del documento**:
  reutiliza la fuente original (TrueType, CFF, Type0/CID y Type3), ajustando el ancho
  con escalado horizontal para no invadir el texto vecino. En el editor se puede
  seleccionar un fragmento y aplicar **negrita** o **cursiva** solo a esa selección
  (el resto de la línea conserva su estilo). También se puede editar el párrafo
  completo con **Shift+clic** o **Shift+doble clic**.
- **OCR integrado** para PDF escaneados: reconoce el texto de la página con el motor
  OCR de Windows en cualquier orientación, borra el texto de la imagen conservando
  bordes y líneas, y lo convierte en texto editable y buscable.
- **PDF cifrados**: solicita la contraseña, los descifra con **qpdf** (incluido,
  Apache 2.0) y los edita como PDF real: texto, formularios, vectores, marcadores y
  adjuntos. Si qpdf no puede con un cifrado concreto, se exporta una copia rasterizada
  segura con una capa de texto invisible para selección y búsqueda.
- **Proteger con contraseña**: guarda una copia cifrada con AES-256.
- **Extraer páginas** a un PDF nuevo indicando el rango (por ejemplo `1-3,5`).
- **Archivos recientes** en el menú Archivo (últimos 10).
- **Formularios XFA**: se muestran y se exportan rasterizados.
- Anotaciones: resaltado de texto o rectangular, cuadros de texto, notas adhesivas,
  rectángulos, elipses, dibujo libre y cobertura con blanco.
- Inserción de imágenes o firmas (PNG/JPG) en cualquier página.
- Edición de páginas: girar 90°, mover (botones o **arrastrando las miniaturas**),
  eliminar, insertar página en blanco y combinar varios PDF. Al reestructurar se
  conserva el catálogo del documento base y se integran los formularios AcroForm,
  marcadores y adjuntos de todos los documentos combinados. Se limpian los campos,
  marcadores y enlaces que apuntaban a páginas eliminadas.
- **Recorte de márgenes** por página o para todo el documento (se aplica al exportar).
- **Numeración de páginas** configurable al exportar («Página X de Y», posición a elegir).
- **Encabezado y pie** con texto libre y variables `{n}`, `{total}`, `{title}` y `{date}`.
- **Exportar la página como imagen** PNG (con los cambios aplicados).
- **Comprimir** el PDF con qpdf y **aplanar formularios** para fijar los campos rellenados.
- Relleno de formularios AcroForm (texto, casillas, listas y botones de opción).
  Los formularios de los documentos combinados se integran y siguen siendo editables.
- Marca de agua configurable.
- Edición de metadatos (título, autor, asunto, palabras clave).
- **Conversión PDF ↔ Word** desde el menú «Convertir»: de PDF a documento de
  Word (.docx) y de Word a PDF, intentando conservar el formato original.
- **Imagen a PDF** (JPG, PNG, BMP) desde el menú «Convertir», con OCR para que el
  texto de la imagen quede seleccionable y buscable.
- Exportación a una copia nueva con todas las anotaciones y cambios aplicados.
- **Recuperación automática**: cada minuto guarda una copia de trabajo y, si el
  programa se cierra de forma inesperada, ofrece recuperarla al volver a abrirlo.
- Deshacer/rehacer, atajos de teclado, arrastrar y soltar archivos y aviso de
  cambios sin guardar al cerrar, abrir otro documento o salir.

## Requisitos

- Windows 10/11 de 64 bits.
- Para ejecutar desde el código: Node.js 20 o superior.
- Para OCR: el paquete de idioma/OCR correspondiente instalado en Windows
  (Configuración → Hora e idioma → Idioma). El OCR funciona sin conexión.

## Uso desde el código

```powershell
cd zeropdf
npm install
npm start
```

Para generar el PDF de ejemplo:

```powershell
npm run sample
```

## Compilar una versión ejecutable

```powershell
npm run dist
```

Equivale a:

```powershell
npx @electron/packager . ZeroPDF --platform=win32 --arch=x64 --out=dist --overwrite --asar --icon=assets/icon.ico --extra-resource=vendor --ignore="^/vendor"
```

`--extra-resource=vendor` copia `vendor/qpdf` fuera de `app.asar` (en
`resources/vendor/qpdf`), porque un ejecutable auxiliar no puede lanzarse desde
dentro del archivo ASAR. `--ignore="^/vendor"` evita duplicarlo dentro del ASAR.

El ejecutable queda en `dist/ZeroPDF-win32-x64/ZeroPDF.exe`. En este equipo se ha
creado además un acceso directo en el escritorio (`ZeroPDF.lnk`) que apunta a él.

## Instalador para distribuir

```powershell
npm run installer
```

Genera `release/ZeroPDF-Setup.exe` (unos 127 MB) con estas características:

- Instalación **por usuario**, sin permisos de administrador (por defecto en
  `%LOCALAPPDATA%\Programs\ZeroPDF`), con opción de cambiar la carpeta.
- Crea accesos directos en el **escritorio** y en el **menú Inicio**.
- Aparece en **Configuración → Aplicaciones** y se desinstala desde ahí
  (`Uninstall ZeroPDF.exe`). La desinstalación conserva la configuración del usuario.

El instalador lo construye [electron-builder](https://www.electron.build/) con la
configuración `build` de `package.json`; `vendor/qpdf` va como recurso externo, igual
que en la versión portable.

Nota: el ejecutable no está firmado digitalmente, así que Windows SmartScreen puede
avisar la primera vez; hay que pulsar *Más información → Ejecutar de todas formas*.

### Firmar el instalador (gratis)

Hay dos formas:

- **SignPath Foundation** (gratis para proyectos open source): el instalador se
  compila y se firma desde GitHub Actions. El editor visible será «SignPath
  Foundation».
- **Certum Open Source** (de pago, ~49 €/año): el certificado va a tu nombre y se
  firma en local con `scripts/firmar.ps1`.

La guía completa, paso a paso, está en [`docs/FIRMA-CODIGO.md`](docs/FIRMA-CODIGO.md).
La configuración ya está preparada en `.github/workflows/firmar-release.yml`,
`.signpath/artifact-configuration.xml` y `scripts/firmar.ps1`.

Para calcular la huella del instalador (útil para publicarla junto a la descarga):

```powershell
./scripts/firmar.ps1 -Ruta release\ZeroPDF-Setup.exe -SoloHash
```

El icono de la aplicación está en `assets/icon.svg` (fuente), `assets/icon.png`
(favicon y ventana fuera de Windows) y `assets/icon.ico` (ventana y ejecutable en
Windows). Para regenerarlos tras editar el SVG:

```powershell
npm run icon
```

Nota técnica: `pdf.worker.js` se carga en la propia página y pdf.js trabaja en el
hilo principal. Así se evita crear `Blob` de gran tamaño dentro de `app.asar`,
que provocaba el cierre del proceso de renderizado en la versión empaquetada.

## Convertir entre PDF y Word

El menú **Convertir** ofrece:

- **PDF a Word (.docx)**: pide el PDF y guarda un documento de Word editable.
- **Word (.docx) a PDF**: pide el documento y guarda un PDF con el mismo aspecto.
- **Imagen (JPG, PNG, BMP) a PDF**: convierte una foto o un escaneo en un PDF A4.
  Si la imagen contiene texto, se reconoce con el OCR de Windows y se añade como
  **capa de texto invisible**: el PDF se ve igual que la imagen, pero el texto se
  puede seleccionar, buscar y copiar.

ZeroPDF usa primero **Microsoft Word** (automatización COM) y, si no está
disponible, **LibreOffice**; ambos conservan el formato casi por completo. Si no
hay ninguno instalado (o Word no puede arrancar), se usa el **motor propio**, que
no necesita nada externo:

- *Word a PDF*: lee el DOCX y lo maqueta con el motor del sistema. Conserva
  fuente, tamaño, color, negrita, cursiva, subrayado, alineación, sangrías,
  espaciado, listas numeradas y con viñetas, tablas, imágenes, fondos de párrafo,
  saltos de página y el tamaño y márgenes de página del original.
- *PDF a Word*: reconstruye el texto con sus estilos (negrita, cursiva, color,
  tamaño), lo agrupa en párrafos y páginas, y mantiene la alineación y el fondo de
  las cabeceras. El texto queda editable en Word.

## Atajos

| Acción | Atajo |
| --- | --- |
| Abrir PDF | Ctrl+O |
| Guardar copia | Ctrl+S |
| Imprimir | Ctrl+P |
| Copiar texto de la página | Ctrl+C |
| Buscar | Ctrl+F |
| Editar texto | E |
| Editar párrafo completo | Shift+clic / Shift+doble clic |
| Deshacer / Rehacer | Ctrl+Z / Ctrl+Y |
| Ampliar / Reducir | Ctrl++ / Ctrl+- |
| Ajustar al ancho | Ctrl+0 |
| Página siguiente / anterior | Av Pág / Re Pág |
| Eliminar anotación seleccionada | Supr |
| Herramienta seleccionar / mano | V / H |

## Estructura

```
zeropdf/
  main.js              Proceso principal de Electron y menús
  preload.js           Puente seguro (IPC) con el renderizador
  src/index.html       Interfaz
  src/styles.css       Estilos
  src/app.js           Visor, anotaciones, edición y exportación
  convert.js           Motor propio de conversión PDF <-> Word
  assets/icon.svg      Fuente del icono (documento + Z + pluma)
  assets/icon.png      Icono de la ventana
  assets/icon.ico      Icono del ejecutable (16–256 px)
  scripts/make-sample.js  Generador del PDF de ejemplo
  scripts/make-icon.js    Generador de icon.png e icon.ico
  scripts/ocr.ps1         OCR local con el motor de Windows
  vendor/qpdf/            qpdf 12.4.2 (Apache 2.0) para descifrar PDF
```

## Tecnología

- [Electron](https://www.electronjs.org/) — aplicación de escritorio.
- [pdf.js](https://mozilla.github.io/pdf.js/) (Apache 2.0) — renderizado de PDF.
- [pdf-lib](https://pdf-lib.js.org/) (MIT) — edición y exportación de PDF.
- **qpdf 12.4.2** (Apache 2.0) — descifrado de PDF con contraseña.
- **OCR de Windows** (`Windows.Media.Ocr`) — reconocimiento local sin dependencias
  externas ni conexión a Internet.

## Limitaciones conocidas

- El texto dentro de Form XObjects compartidos se elimina clonando el XObject para
  cada aparición; ya no queda oculto bajo un parche. El texto vertical CJK conserva su
  orientación y fuente cuando el documento las incluye; si no, se dibuja con una
  sustitución horizontal.
- El OCR usa el motor y los idiomas instalados en Windows. La precisión depende de la
  calidad del escaneo; las líneas reconocidas se pueden corregir a mano. La página
  escaneada se convierte en imagen limpia al exportar, por lo que deja de ser vectorial.
- Los PDF cifrados se descifran con qpdf y se editan como PDF real; la copia guardada
  queda sin cifrar. Si qpdf no puede con un cifrado concreto, se exporta rasterizado
  con una capa de texto invisible para conservar selección y búsqueda.
- Los formularios XFA se exportan rasterizados para no corromper el archivo: se pueden
  ver, anotar y editar visualmente, pero sus campos no se convierten en AcroForm
  interactivos.
- Al combinar varios PDF se conservan e integran los formularios AcroForm, marcadores y
  adjuntos de todos los documentos. Los formularios combinados se añaden al AcroForm
  resultante y siguen siendo rellenables. Los marcadores y enlaces que apuntan a
  páginas eliminadas se retiran.
- Las etiquetas de página (PageLabels) se restablecen al reestructurar para evitar
  numeraciones obsoletas. Los destinos con nombre que no se pueden remapear se
  conservan solo como título de marcador.
- **Conversión**: con Word o LibreOffice la fidelidad es alta. Con el motor propio,
  Word a PDF conserva el formato del documento; PDF a Word recompone el texto en
  párrafos editables, así que la posición exacta de cada línea, las imágenes y las
  tablas complejas del PDF no se trasladan, y los encabezados, pies de página y
  notas al pie del DOCX no se incluyen al imprimir.
- **Imagen a PDF**: se genera una página A4 con la imagen ajustada y centrada. El
  texto OCR solo existe si el OCR de Windows reconoce la imagen; la capa invisible
  usa una fuente estándar, por lo que los caracteres fuera de Latin-1 se sustituyen
  y no se buscan bien.
- **Impresión**: se imprime una imagen de cada página a 200 ppp (hasta 120 páginas)
  usando el diálogo de Windows, que gestiona impresora, rango y copias. El tamaño de
  página del PDF se traslada al papel; si el documento mezcla tamaños, se usa el de la
  primera página.
- **Redacción**: en páginas con texto se borran los glifos del flujo de contenido; en
  páginas escaneadas (imagen, con o sin OCR propio) la página se rasteriza y se
  ennegrecen los píxeles de la zona, de modo que el contenido original desaparece del
  archivo. Si una misma zona combina texto real e imagen de fondo, el texto se elimina
  y la imagen se conserva bajo el recuadro negro.
- **Marcadores generados**: se detectan por tamaño de letra, por negrita o por líneas
  cortas en mayúsculas; si no se reconoce ninguno se usa la primera línea de cada
  página. Solo se escriben si el PDF no tiene ya un índice.
- **Recorte**: el recorte se muestra sombreado en pantalla y se aplica como *CropBox*
  al exportar; no elimina contenido, solo cambia el área visible.
- **Comprimir** recompime los flujos internos con qpdf. En PDF ya optimizados la
  reducción puede ser mínima o nula, porque las imágenes no se vuelven a codificar.
- **Copiar texto**: copia el texto de la página actual o del documento completo en
  orden de lectura. No hay selección con el ratón sobre el lienzo.
- Las fuentes estándar de pdf.js pueden no estar disponibles para PDFs que las
  referencian sin incrustarlas; el texto se muestra con una fuente de reserva. Es un
  efecto solo de visualización: la exportación conserva la fuente del documento.
- El texto nuevo se escribe con la fuente original siempre que el PDF la conserve:
  se reutilizan la fuente y los operadores existentes, sin reincrustar nada, por lo
  que se mantienen la negrita, la cursiva y el color. Si el documento usa un
  subconjunto de la fuente (lo habitual en PDF de Word, LaTeX o impresoras) y el
  texto nuevo incluye caracteres que ese subconjunto no tiene, o si el texto es mucho
  más largo que el original, la línea se dibuja con Helvetica, Times o Courier
  manteniendo el grosor y la cursiva detectados, para no corromper el archivo. Las
  fuentes sin ToUnicode ni codificación reconocible tampoco se pueden reutilizar.
- ZeroPDF comprueba el contorno real de cada glifo en las fuentes TrueType
  incrustadas antes de reutilizarlas: si el subconjunto no contiene el carácter, no
  se escribe (evita dejar huecos en blanco). La negrita y la cursiva se detectan por
  el nombre real de la fuente y por el descriptor del PDF.
- Al aplicar negrita o cursiva a una parte de la línea, cada tramo se escribe con la
  fuente del documento que tenga ese estilo (por ejemplo `Arial-BoldMT` junto a
  `ArialMT`). Si el PDF no incluye ninguna fuente con ese estilo, la línea completa se
  redibuja con la familia estándar en su variante negrita o cursiva.
- Al reescribir una línea con la fuente original se pierden los ajustes de kerning
  del `TJ` original; el ancho se compensa con escalado horizontal (`Tz`), que puede
  condensar ligeramente el texto si es más largo que el original.

## Créditos

Creado por **zeronet75**.

Incluye **qpdf 12.4.2** (© qpdf authors, Apache License 2.0); su licencia está en
`vendor/qpdf/LICENSE.txt`. El binario se distribuye sin modificaciones.
