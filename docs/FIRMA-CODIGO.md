# Firmar ZeroPDF gratis (SignPath Foundation)

Guía para que el instalador salga firmado sin pagar un certificado. La vía
gratuita es **SignPath Foundation**; al final se explica la alternativa de pago
(**Certum Open Source**, ~49 €/año).

---

## 1. Qué se consigue (y qué no)

| | |
|---|---|
| ✅ Firma Authenticode válida | Windows y SmartScreen reconocen el editor |
| ✅ Gratis | SignPath Foundation lo ofrece a proyectos open source |
| ✅ Sin token físico | La clave está en el HSM de SignPath; se firma desde GitHub Actions |
| ⚠️ El editor visible es **SignPath Foundation** | No aparece «zeronet75»: ellos certifican que el binario se compiló desde tu repositorio |
| ⚠️ No quita el aviso el primer día | La reputación se construye con descargas, aunque la de SignPath ya ayuda |

**Requisito duro:** el binario tiene que compilarse **dentro del flujo de GitHub
Actions** y desde un repositorio **público**. No vale subir el `.exe` que ya
tienes en `release\`.

---

## 2. Publicar el repositorio (paso previo obligatorio)

ZeroPDF todavía no es un repositorio git. Desde la carpeta del proyecto:

```powershell
cd "C:\Users\Portatil de Julia.DESKTOP-H8SCKBL\Documents\Proyecto predeterminado\zeropdf"

git init
git add .
git commit -m "ZeroPDF 1.0.0: visor y editor de PDF con 23 idiomas"

# Crea el repositorio vacío en GitHub (sin README ni licencia) y luego:
git remote add origin https://github.com/TUUSUARIO/zeropdf.git
git branch -M main
git push -u origin main
```

Comprobaciones antes de subir:

- `git status --ignored` no debe mostrar `node_modules/`, `dist/` ni `release/`
  (ya están en `.gitignore`).
- No debe haber tokens, contraseñas ni rutas personales en el código.
- El repositorio debe ser **público** y tener la `LICENSE` (MIT ya incluida).

---

## 3. Solicitar la adhesión a SignPath Foundation

1. Entra en <https://signpath.org/apply>.
2. Rellena el formulario con:
   - **Proyecto:** ZeroPDF
   - **Repositorio:** `https://github.com/TUUSUARIO/zeropdf`
   - **Licencia:** MIT
   - **Descripción:** visor y editor de PDF de escritorio para Windows, Electron,
     multiplataforma en la interfaz, 23 idiomas.
   - Tu correo y tu usuario de GitHub.
3. Aceptan proyectos reales y con actividad; la respuesta suele tardar **días**.

---

## 4. Configurar el proyecto en SignPath

Cuando te acepten, entra en <https://app.signpath.io> y crea:

1. **Proyecto** con slug `zeropdf`.
2. **Trusted Build System → GitHub.com**, y vincúlalo al proyecto.
3. Instala la **GitHub App de SignPath** (<https://github.com/apps/signpath>) en el
   repositorio; es lo que permite comprobar que el artefacto salió de tu CI.
4. **Artifact Configuration**: sube `.signpath/artifact-configuration.xml` del
   repositorio y márcala como **predeterminada** del proyecto.
5. **Signing policy** con slug `release-signing` (deja `test-signing` para pruebas).
6. **API token** de un usuario con permiso de *submitter* sobre esa política.
   Cópialo: solo se muestra una vez.

---

## 5. Secretos y variables en GitHub

En el repositorio: **Settings → Secrets and variables → Actions**.

| Tipo | Nombre | Valor |
|---|---|---|
| Secret | `SIGNPATH_API_TOKEN` | el token del paso anterior |
| Variable | `SIGNPATH_ORGANIZATION_ID` | ID de tu organización en SignPath |
| Variable | `SIGNPATH_PROJECT_SLUG` | `zeropdf` |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | `release-signing` |

El flujo ya está en `.github/workflows/firmar-release.yml`: compila, sube el
instalador, pide la firma, verifica, calcula el SHA-256 y publica la release.

---

## 6. Primer build firmado

```powershell
git tag v1.0.0
git push origin v1.0.0
```

En **Actions** verás la ejecución; al terminar, la release `v1.0.0` contendrá:

- `ZeroPDF-Setup.exe` (firmado)
- `SHA256SUMS.txt`

Para comprobarlo en local:

```powershell
Get-AuthenticodeSignature .\ZeroPDF-Setup.exe | Format-List
# SignerCertificate.Subject debe contener "SignPath Foundation"
```

### Mientras SignPath todavía no está configurado

El flujo funciona en los dos escenarios:

- Si **existe** `SIGNPATH_API_TOKEN`, firma con SignPath y publica el binario firmado.
- Si **no existe**, se salta la firma y publica el instalador sin firmar, con una
  nota en la release avisando de que SmartScreen puede aparecer.

Así puedes crear etiquetas y releases desde ya (`v1.0.0`); cuando configures el
token, la siguiente etiqueta (`v1.0.1`) saldrá ya firmada sin tocar nada más.

---

## 7. Firma local y huellas (sin certificado todavía)

El script `scripts/firmar.ps1` ya funciona para calcular y comprobar huellas:

```powershell
# Solo hash (lo puedes usar hoy mismo)
./scripts/firmar.ps1 -Ruta release\ZeroPDF-Setup.exe -SoloHash

# Verificar una firma existente
./scripts/firmar.ps1 -Ruta release\ZeroPDF-Setup.exe -SoloVerificar

# Firmar con un certificado del almacén o tarjeta virtual
./scripts/firmar.ps1 -Ruta release\ZeroPDF-Setup.exe -Huella 1A2B3C4D...

# Firmar con un .pfx (solo pruebas)
./scripts/firmar.ps1 -Ruta .\prueba.exe -Pfx .\prueba.pfx -Contrasena "1234"
```

Si dice «No se encontró signtool.exe», instala el **Windows SDK** con el
componente *Windows SDK Signing Tools for Desktop Apps*.

---

## 8. Alternativa de pago: Certum Open Source

Si prefieres que el editor sea tu nombre y no SignPath Foundation:

- **Certum Open Source Code Signing**: certificado para personas físicas, el
  nombre común incluye «Open Source Developer». Versión en la nube desde ~49 €/año
  (funciona con SimplySign, sin token USB).
- Requiere DNI y verificar que el proyecto es open source; se revoca si se usa
  para software comercial.
- Tras instalarlo, firma con:

```powershell
./scripts/firmar.ps1 -Ruta release\ZeroPDF-Setup.exe -Huella <huella del certificado>
```

---

## 9. Problemas típicos

| Síntoma | Causa |
|---|---|
| `401 Unauthorized` al enviar la firma | Token caducado o sin permiso *submitter* |
| «Artifact was not built by the workflow» | Se subió un binario de fuera del CI |
| La firma falla en runner propio | El programa OSS exige runners alojados por GitHub |
| `signtool` no aparece | Falta el Windows SDK (Signing Tools) |
| El `.exe` sigue con aviso | Normal al principio; SmartScreen aprende con descargas |

---

## 10. Nota sobre el ejecutable interior

Se firma el **instalador**. El `ZeroPDF.exe` que queda dentro de
`resources\app` sigue sin firmar: Windows solo muestra el aviso al ejecutar el
instalador descargado, así que no afecta a la experiencia normal. Si más adelante
quieres firmarlo también, hay que firmarlo **antes** de empaquetar y añadir un
paso al flujo.
