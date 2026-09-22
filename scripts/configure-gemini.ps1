[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectPath
$keyPointer = [IntPtr]::Zero
$plainKey = $null
$secureKey = $null
try {
    Write-Host 'Usa una clave de Google AI Studio de un proyecto en el nivel gratuito, sin facturacion.'
    Write-Host 'Se guardara como GEMINI_API_KEY en InsForge, no en archivos ni en la interfaz.'
    $listOutput = & npx -y '@insforge/cli' secrets list --json
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo acceder a InsForge. Comprueba el login y el proyecto vinculado.' }
    $secretList = ($listOutput -join "`n") | ConvertFrom-Json
    $existing = @($secretList.secrets | Where-Object { $_.key -eq 'GEMINI_API_KEY' }).Count -gt 0

    $secureKey = Read-Host 'Pega tu API key de Gemini (entrada oculta)' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ([string]::IsNullOrWhiteSpace($plainKey)) { throw 'No ingresaste ninguna clave.' }

    # Never print the secret or command output. The CLI receives it only at runtime.
    if ($existing) {
        & npx -y '@insforge/cli' secrets update GEMINI_API_KEY --value $plainKey --active true --json *> $null
    } else {
        & npx -y '@insforge/cli' secrets add GEMINI_API_KEY $plainKey --json *> $null
    }
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo guardar GEMINI_API_KEY. Revisa tu acceso al proyecto.' }
    $plainKey = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    $keyPointer = [IntPtr]::Zero
    $secureKey.Dispose()
    $secureKey = $null

    Write-Host 'Clave guardada. Actualizando las dos funciones para cargar el secreto...'
    & npx -y '@insforge/cli' functions deploy ingest --file './functions/ingest.ts'
    if ($LASTEXITCODE -ne 0) { throw 'Fallo el despliegue de ingest. La clave ya esta guardada; puedes volver a ejecutar el script.' }
    & npx -y '@insforge/cli' functions deploy ask --file './functions/ask.ts'
    if ($LASTEXITCODE -ne 0) { throw 'Fallo el despliegue de ask. La clave ya esta guardada; puedes volver a ejecutar el script.' }
    Write-Host 'Listo. Ejecuta: .\scripts\test-rag.ps1'
} finally {
    $plainKey = $null
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    if ($null -ne $secureKey) { $secureKey.Dispose() }
    Pop-Location
}
