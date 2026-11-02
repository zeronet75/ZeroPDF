# Difusión de ZeroPDF

Guía para dar visibilidad al proyecto. El objetivo no es hacer ruido, sino que
exista una **huella externa** verificable: descargas, menciones y actividad. Es lo
que mira el programa de firma de SignPath Foundation cuando vuelvas a solicitar.

## Antes de publicar en ningún sitio

- [ ] La release tiene notas claras y captura.
- [ ] El README se entiende en dos minutos y tiene una captura arriba.
- [ ] El instalador descarga sin errores y funciona en un equipo limpio.
- [ ] Sabes qué responder a «¿por qué otro visor de PDF?».
- [ ] Tienes el SHA-256 a mano para quien pregunte por seguridad.

## Orden recomendado

1. **AlternativeTo** (ficha permanente, sin prisa).
2. **Reddit** `r/opensource` (una sola vez).
3. **Hacker News** (Show HN) un martes o miércoles por la mañana, hora de EE. UU.
4. **r/software** y **r/windows** con una semana de diferencia.
5. Comunidad hispanohablante (Menéame, foros de software libre) más adelante.

No publiques el mismo texto en cinco sitios el mismo día: se nota y resta.

---

## 1. AlternativeTo

Crea la ficha en <https://alternativeto.net/manage/> como *app* de Windows,
licencia MIT, enlace a GitHub y a la release.

> **Descripción corta**: Lector y editor de PDF gratuito y de código abierto para
> Windows: anota, edita el texto original, rellena formularios, aplica OCR,
> protege con contraseña y convierte entre PDF y Word, con interfaz en 23 idiomas.

Alternativas a marcar como relacionadas: Adobe Acrobat, Foxit PDF Editor, PDF-XChange,
SumatraPDF (solo lector).

---

## 2. Reddit — r/opensource

**Título**

```
ZeroPDF – visor y editor de PDF open source (MIT) para Windows, con 23 idiomas
```

**Cuerpo**

```
I've been building ZeroPDF, a desktop PDF viewer/editor for Windows, released
under MIT. It's built with Electron, pdf.js and pdf-lib, and bundles qpdf for
encrypted files.

What it does:
- Read, annotate (highlight, notes, freehand, shapes)
- Edit the original text in place, keeping the document font, size and colour
- Fill AcroForm fields; flatten them when exporting
- OCR scanned pages with the Windows OCR engine, offline
- Password-protect (AES-256), extract pages, merge, crop, page numbers,
  header/footer, watermark, metadata
- PDF ↔ Word and image → PDF conversion
- UI translated into 23 languages (Spanish by default, Arabic with RTL layout)

It's Windows-only for now. No accounts, no telemetry, no network calls at runtime.

Downloads: https://github.com/zeronet75/ZeroPDF/releases
Source: https://github.com/zeronet75/ZeroPDF

The installer isn't code-signed yet (SignPath Foundation requires more public
traction), so SmartScreen may warn on first run. SHA-256 is published with each
release.

Happy to answer questions and take feature requests.
```

---

## 3. Hacker News — Show HN

**Título**

```
Show HN: ZeroPDF – open-source PDF editor for Windows with in-place text editing
```

**Primer comentario** (publícalo tú nada más crear el envío)

```
Author here. I built this because I wanted a PDF editor that could modify the
original text without rasterising the page, and that worked offline.

The interesting part is the text editing: it locates the text operators in the
content stream (including Form XObjects and rotated text), removes the original
glyphs and re-draws with the document's own font, compensating width with
horizontal scaling. If the font subset lacks the new characters, it falls back
to a standard font instead of corrupting the file.

Stack: Electron + pdf.js + pdf-lib, qpdf for encrypted files, Windows OCR for
scans. MIT licensed, no telemetry.

Known limits: Windows only, printing renders each page at 200 dpi, and the
converter for Word files is only as good as the installed Word/LibreOffice
(or the built-in engine if neither is present).

Feedback welcome, especially about PDFs that break the text editor.
```

---

## 4. Reddit — r/software y r/windows

Cambia el enfoque: allí interesa **qué resuelve**, no cómo está hecho.

```
[Free] ZeroPDF – visor y editor de PDF para Windows, sin cuentas ni suscripción

Busca un PDF que puedas editar de verdad, no solo anotar: ZeroPDF reescribe el
texto original conservando la fuente del documento, rellena formularios, hace
OCR de escaneos sin conexión y convierte entre PDF y Word. Interfaz en 23
idiomas.

Es gratis y de código abierto (MIT). Sin registro, sin telemetría, sin límites
de páginas ni marcas de agua.

Descarga: https://github.com/zeronet75/ZeroPDF/releases

Nota: el instalador aún no está firmado, así que SmartScreen puede avisar la
primera vez; la huella SHA-256 está publicada en la release.
```

---

## 5. Comunidad hispanohablante

- **Menéame**: enlace directo a la release con un titular informativo. Evita
  autovotarte ni pedir votos.
- Foros de software libre y de PDF: presenta el proyecto y pide pruebas con
  documentos problemáticos, no solo «descargadlo».

---

## Después de publicar

- Responde a **todos** los comentarios el primer día; es lo que decide si el
  hilo vive.
- Anota las sugerencias como issues (aunque no las implementes ya).
- Si alguien reporta un PDF que rompe el editor, pídelo (si no es confidencial) y
  úsalo como caso de prueba.
- Publica una nota en Ko-fi cuando saques versión, enlazando la release.

## Qué NO hacer

- Publicar el mismo texto en muchos subreddits a la vez.
- Pedir estrellas o votos explícitamente.
- Crear cuentas nuevas para comentar tu propio enlace.
- Discutir con quien diga que «ya existen otros visores»: responde con casos
  concretos (edición de texto, OCR offline, 23 idiomas).

## Cuándo volver a pedir la firma a SignPath

Cuando tengas, como mínimo:

- 50–100 estrellas y descargas sostenidas,
- alguna mención externa real (Reddit, HN, blog, vídeo),
- actividad continua durante 3–6 meses,

vuelve a enviar la solicitud en <https://signpath.org/apply>. Menciona en el
campo *Reputation* los enlaces concretos que hayas conseguido.
