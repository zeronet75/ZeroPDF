# Cómo contribuir a ZeroPDF

¡Gracias por querer ayudar! Este documento explica lo necesario para enviar
cambios sin fricción.

## Antes de empezar

- Abre un **issue** antes de un cambio grande (nueva función, refactor). Para
  arreglos pequeños (erratas, un fallo concreto) puedes ir directo al PR.
- Revisa los issues abiertos y las etiquetas `bug`, `mejora` y `documentación`.
- No hace falta que pidas permiso para hacer un *fork*: la licencia MIT lo
  permite.

## Entorno

- **Windows 10/11 de 64 bits** (el programa está pensado para Windows).
- **Node.js 20 o superior**.
- Para el OCR: paquete de idioma/OCR instalado en Windows.

```powershell
git clone https://github.com/zeronet75/ZeroPDF.git
cd ZeroPDF
npm install
npm start          # abre la aplicación en modo desarrollo
npm run sample     # regenera sample.pdf
```

Para comprobar que todo funciona antes de enviar nada:

```powershell
npm run dist       # empaqueta en dist\
npm run installer  # genera release\ZeroPDF-Setup.exe
.\dist\ZeroPDF-win32-x64\ZeroPDF.exe --smoke=sample.pdf --selftest
```

La autoprueba debe terminar con una línea `SELFTEST: {...}` sin errores.

## Estilo

- **Comentarios y mensajes en español**, como el resto del código.
- JavaScript estándar del proyecto: funciones cortas, nombres descriptivos, sin
  dependencias nuevas si se puede resolver con lo que ya hay.
- Antes de añadir una dependencia, explica en el issue por qué hace falta.
- Respeta el formato existente (2 espacios, comillas simples).

## Textos de la interfaz e idiomas

ZeroPDF usa el **español como idioma de origen**: las claves del diccionario son
el texto en español.

Si añades un texto nuevo a la interfaz:

1. Escríbelo en español en `src/index.html` o `src/app.js`.
2. Añade la traducción a los cinco idiomas base en `src/i18n.js`.
3. Añade la clave a los diccionarios de `src/i18n-langs*.js` e
   `src/i18n-full*.js` (los 23 idiomas).

Si no puedes traducir a todos los idiomas, envía el cambio con el español y el
inglés y dilo en el PR: alguien lo completará.

## Pull requests

1. Haz un *fork* y crea una rama descriptiva: `arreglo-cursor-ocr`,
   `funcion-firmar-lote`.
2. Un commit por cambio lógico, con mensaje en español y en imperativo
   («Corrige…», «Añade…»).
3. Rellena la plantilla del PR: qué cambia, cómo probarlo y capturas si afecta a
   la interfaz.
4. El flujo de CI debe pasar (compilación del instalador).
5. Si tocas la interfaz, añade una captura antes/después.

## Qué se acepta

- Correcciones de fallos, mejoras de rendimiento y de accesibilidad.
- Traducciones y correcciones de idioma.
- Documentación y ejemplos.
- Funciones nuevas que encajen con el enfoque del proyecto (visor/editor ligero,
  sin cuentas ni telemetría).

## Qué se evita

- Añadir telemetría, analítica o conexiones de red no solicitadas.
- Dependencias pesadas para algo que se puede hacer con pdf.js o pdf-lib.
- Cambios de licencia o de modelo de distribución sin hablarlo antes.

## Código de conducta

Al participar aceptas el [código de conducta](CODE_OF_CONDUCT.md).
