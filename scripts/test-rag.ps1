[CmdletBinding()]
param([switch]$SkipIngest)

$ErrorActionPreference = 'Stop'
$endpointBase = 'https://5a4bnskj.function2.insforge.app'
$projectPath = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectPath
$ragKey = $null
$secretOutput = $null
try {
    $secretOutput = & npx -y '@insforge/cli' secrets get RAG_API_KEY --json
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo leer RAG_API_KEY. Comprueba el login de InsForge.' }
    $ragKey = (($secretOutput -join "`n") | ConvertFrom-Json).value
    $secretOutput = $null
    if ([string]::IsNullOrWhiteSpace($ragKey)) { throw 'RAG_API_KEY no esta configurada.' }
    $headers = @{ 'x-rag-api-key' = $ragKey }

    function Invoke-RagJson([string]$Slug, [string]$Json) {
        try {
            Invoke-RestMethod -Uri "$endpointBase/$Slug" -Method Post -Headers $headers `
                -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Json)) -TimeoutSec 120
        } catch {
            $detail = $_.ErrorDetails.Message
            if ($detail -match 'GEMINI_API_KEY_NOT_CONFIGURED') {
                throw 'Falta GEMINI_API_KEY. Ejecuta primero .\scripts\configure-gemini.ps1'
            }
            if ($detail -match 'GEMINI_QUOTA_EXCEEDED') { throw 'Cuota gratuita de Gemini agotada. Espera al reinicio de la cuota.' }
            if ($detail -match 'GROQ_API_KEY_NOT_CONFIGURED') {
                throw 'Falta GROQ_API_KEY. Ejecuta primero .\scripts\configure-groq.ps1'
            }
            if ($detail -match 'GROQ_RATE_LIMITED') { throw 'Limite gratuito de Groq agotado. Espera al reinicio de la cuota.' }
            if ($detail -match 'GROQ_UNAVAILABLE') { throw 'Groq no tiene capacidad disponible. Intenta mas tarde.' }
            throw "La solicitud a $Slug fallo. Respuesta: $detail"
        }
    }

    if (-not $SkipIngest) {
        Write-Host '1. Ingestando el documento de ejemplo (tres parrafos)...'
        $sample = Get-Content -LiteralPath './examples/ingest-demo.json' -Encoding UTF8 -Raw
        $ingestResult = Invoke-RagJson 'ingest' $sample
        if ($ingestResult.chunksInserted -lt 1) { throw 'La ingesta no confirmo ningun chunk.' }
        $ingestResult | ConvertTo-Json -Depth 10
    }

    Write-Host '2. Pregunta cuya respuesta esta en el documento...'
    $known = Invoke-RagJson 'ask' (Get-Content -LiteralPath './examples/ask-known.json' -Encoding UTF8 -Raw)
    $known | ConvertTo-Json -Depth 10
    if ($known.answer -notmatch '09:00' -or $known.answer -notmatch '18:00' -or @($known.sources).Count -lt 1) {
        throw 'La respuesta conocida no paso la comprobacion de horario y fuentes.'
    }

    Write-Host '3. Pregunta que NO esta en el documento...'
    $unknown = Invoke-RagJson 'ask' (Get-Content -LiteralPath './examples/ask-unknown.json' -Encoding UTF8 -Raw)
    $unknown | ConvertTo-Json -Depth 10
    $expected = 'no tengo esa informaci' + [char]0x00F3 + 'n en mis documentos'
    if ($unknown.answer -cne $expected -or @($unknown.sources).Count -ne 0) {
        throw 'La pregunta fuera de contexto no produjo la negativa exacta sin fuentes.'
    }
    Write-Host 'OK: ingesta y ambas preguntas verificadas.'
} finally {
    $ragKey = $null
    $secretOutput = $null
    $headers = $null
    Pop-Location
}
