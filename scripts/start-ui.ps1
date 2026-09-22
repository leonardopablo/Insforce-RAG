[CmdletBinding()]
param([int]$Port = 5173)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$previousKey = $env:RAG_API_KEY
$previousPort = $env:PORT
Push-Location -LiteralPath $projectPath
try {
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Puerto no valido.' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Instala Node.js 18 o posterior.' }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "El puerto $Port esta ocupado. Deten el servidor anterior o usa -Port 5174."
    }
    if ([string]::IsNullOrWhiteSpace($env:RAG_API_KEY)) {
        Write-Host 'Conectando con tu proyecto InsForge...'
        $rawSecret = & npx -y '@insforge/cli' secrets get RAG_API_KEY --json
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo acceder a InsForge. Comprueba el login y el proyecto vinculado.' }
        $env:RAG_API_KEY = (($rawSecret -join "`n") | ConvertFrom-Json).value
        $rawSecret = $null
    }
    if ([string]::IsNullOrWhiteSpace($env:RAG_API_KEY)) { throw 'Falta RAG_API_KEY en los secretos de InsForge.' }
    $env:PORT = [string]$Port
    Write-Host 'La clave se mantiene en el servidor. Pulsa Ctrl+C para detenerlo.'
    & node './server.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'El servidor termino con un error.' }
} finally {
    $rawSecret = $null
    $env:RAG_API_KEY = $previousKey
    $env:PORT = $previousPort
    $previousKey = $null
    Pop-Location
}
