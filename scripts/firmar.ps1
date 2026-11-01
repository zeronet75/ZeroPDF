<#
.SYNOPSIS
    Firma ejecutables con Authenticode y calcula sus huellas SHA-256.

.DESCRIPTION
    Sirve para dos cosas:

    1. Firmar en local con un certificado propio (Certum, Sectigo, token USB,
       tarjeta virtual SimplySign, archivo .pfx...).
    2. Verificar y calcular la huella de un ejecutable ya firmado (por ejemplo,
       el que devuelve SignPath).

    Al firmar o al usar -SoloHash se escribe un archivo SHA256SUMS.txt junto al
    primer ejecutable, con el formato que entienden sha256sum y Windows:

        <hash>  <nombre del archivo>

.PARAMETER Ruta
    Uno o varios ejecutables.

.PARAMETER Huella
    Huella SHA-1 del certificado instalado en el almacén de Windows o en la
    tarjeta virtual (SimplySign). Es lo que se usa con token/HSM.

.PARAMETER Pfx
    Ruta a un archivo .pfx (solo para pruebas: un PFX con clave exportable no
    es válido para firmar software distribuido).

.PARAMETER Contrasena
    Contraseña del .pfx.

.PARAMETER MarcaTiempo
    Servidor de sellado de tiempo. Por defecto el de DigiCert.

.PARAMETER SoloVerificar
    No firma: solo comprueba la firma existente.

.PARAMETER SoloHash
    No firma ni verifica: solo calcula SHA-256.

.EXAMPLE
    ./scripts/firmar.ps1 -Ruta release\ZeroPDF-Setup.exe -SoloHash

.EXAMPLE
    ./scripts/firmar.ps1 -Ruta dist\ZeroPDF-win32-x64\ZeroPDF.exe -Huella 1A2B3C...

.EXAMPLE
    ./scripts/firmar.ps1 -Ruta release\ZeroPDF-Setup.exe -SoloVerificar
#>

[CmdletBinding(DefaultParameterSetName = 'Huella')]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Ruta,

    [Parameter(ParameterSetName = 'Huella')]
    [string]$Huella,

    [Parameter(ParameterSetName = 'Pfx')]
    [string]$Pfx,

    [Parameter(ParameterSetName = 'Pfx')]
    [string]$Contrasena,

    [Parameter(ParameterSetName = 'Verificar')]
    [switch]$SoloVerificar,

    [Parameter(ParameterSetName = 'Hash')]
    [switch]$SoloHash,

    [string]$MarcaTiempo = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

function Get-SignTool {
    $comando = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($comando) { return $comando.Source }

    $raices = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
        (Join-Path $env:ProgramFiles 'Windows Kits\10\bin'),
        (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\8.1\bin')
    )

    foreach ($raiz in $raices) {
        if (-not (Test-Path $raiz)) { continue }
        $encontrado = Get-ChildItem $raiz -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($encontrado) { return $encontrado }
    }

    throw 'No se encontró signtool.exe. Instala el Windows SDK (componente "Windows SDK Signing Tools").'
}

function Get-RutaExistente {
    param([string]$Valor)
    $resuelta = Resolve-Path -LiteralPath $Valor -ErrorAction SilentlyContinue
    if (-not $resuelta) { throw "No existe el archivo: $Valor" }
    return $resuelta.Path
}

$archivos = @()
foreach ($elemento in $Ruta) {
    $archivos += Get-RutaExistente $elemento
}

# --- Solo calcular huellas -------------------------------------------------
if ($SoloHash) {
    $lineas = foreach ($archivo in $archivos) {
        $hash = (Get-FileHash -LiteralPath $archivo -Algorithm SHA256).Hash.ToLowerInvariant()
        '{0}  {1}' -f $hash, (Split-Path $archivo -Leaf)
    }
    $destino = Join-Path (Split-Path $archivos[0] -Parent) 'SHA256SUMS.txt'
    $lineas | Set-Content -LiteralPath $destino -Encoding ascii
    $lineas | ForEach-Object { Write-Host $_ }
    Write-Host "Huellas guardadas en: $destino"
    return
}

$signtool = Get-SignTool

# --- Verificar -------------------------------------------------------------
if ($SoloVerificar) {
    $fallo = $false
    foreach ($archivo in $archivos) {
        Write-Host "Verificando $archivo"
        & $signtool verify /pa /v $archivo
        if ($LASTEXITCODE -ne 0) { $fallo = $true }
    }
    if ($fallo) { throw 'Alguna firma no es válida.' }
    return
}

# --- Firmar ----------------------------------------------------------------
if ($Pfx) {
    $Pfx = Get-RutaExistente $Pfx
} elseif (-not $Huella) {
    throw 'Indica -Huella (certificado del almacén) o -Pfx (archivo .pfx).'
}

foreach ($archivo in $archivos) {
    Write-Host "Firmando $archivo"

    $argumentos = @(
        'sign',
        '/fd', 'sha256',
        '/td', 'sha256',
        '/tr', $MarcaTiempo,
        '/v'
    )

    if ($Pfx) {
        $argumentos += @('/f', $Pfx)
        if ($Contrasena) { $argumentos += @('/p', $Contrasena) }
    } else {
        $argumentos += @('/sha1', $Huella)
    }

    $argumentos += $archivo

    & $signtool @argumentos
    if ($LASTEXITCODE -ne 0) { throw "signtool falló al firmar $archivo" }

    & $signtool verify /pa /v $archivo
    if ($LASTEXITCODE -ne 0) { throw "La firma de $archivo no verifica" }
}

# Huellas de los archivos firmados
$lineas = foreach ($archivo in $archivos) {
    $hash = (Get-FileHash -LiteralPath $archivo -Algorithm SHA256).Hash.ToLowerInvariant()
    '{0}  {1}' -f $hash, (Split-Path $archivo -Leaf)
}
$destino = Join-Path (Split-Path $archivos[0] -Parent) 'SHA256SUMS.txt'
$lineas | Set-Content -LiteralPath $destino -Encoding ascii
Write-Host "Huellas guardadas en: $destino"
