[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$model = 'openai/gpt-oss-20b'
$keyPointer = [IntPtr]::Zero
$plainKey = $null
$secureKey = $null
$headers = $null
Push-Location -LiteralPath $projectPath
try {
    Write-Host 'Crea una clave gratuita en https://console.groq.com/keys'
    Write-Host 'Se guardara como GROQ_API_KEY en InsForge, no en archivos ni en la interfaz.'
    $listOutput = & npx -y '@insforge/cli' secrets list --json
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo acceder a InsForge. Comprueba el login y el proyecto vinculado.' }
    $secretList = ($listOutput -join "`n") | ConvertFrom-Json
    $existing = @($secretList.secrets | Where-Object { $_.key -eq 'GROQ_API_KEY' }).Count -gt 0

    $secureKey = Read-Host 'Pega tu API key de Groq (entrada oculta)' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ([string]::IsNullOrWhiteSpace($plainKey)) { throw 'No ingresaste ninguna clave.' }

    $headers = @{ Authorization = "Bearer $plainKey" }
    try {
        $catalog = Invoke-RestMethod -Uri 'https://api.groq.com/openai/v1/models' -Headers $headers -TimeoutSec 30
    } catch {
        throw 'Groq rechazo la clave o no respondio. Comprueba la clave en Groq Console.'
    }
    if (@($catalog.data | Where-Object { $_.id -eq $model }).Count -eq 0) {
        throw "La cuenta no tiene acceso al modelo $model."
    }
    $catalog = $null

    $validationBody = @{
        model = $model
        messages = @(@{ role = 'user'; content = 'Devuelve ok=true.' })
        temperature = 0
        max_completion_tokens = 64
        reasoning_effort = 'low'
        include_reasoning = $false
        response_format = @{
            type = 'json_schema'
            json_schema = @{
                name = 'key_validation'
                strict = $true
                schema = @{
                    type = 'object'
                    additionalProperties = $false
                    required = @('ok')
                    properties = @{ ok = @{ type = 'boolean' } }
                }
            }
        }
    } | ConvertTo-Json -Depth 10
    try {
        $validation = Invoke-RestMethod -Uri 'https://api.groq.com/openai/v1/chat/completions' `
            -Method Post -Headers $headers -ContentType 'application/json' `
            -Body ([Text.Encoding]::UTF8.GetBytes($validationBody)) -TimeoutSec 30
    } catch {
        throw "La clave existe, pero Groq no permitio una inferencia estructurada con $model."
    }
    if (@($validation.choices).Count -lt 1 -or [string]::IsNullOrWhiteSpace($validation.choices[0].message.content)) {
        throw 'Groq devolvio una validacion incompleta.'
    }
    $validation = $null
    $validationBody = $null
    $headers = $null

    if ($existing) {
        & npx -y '@insforge/cli' secrets update GROQ_API_KEY --value $plainKey --active true --json *> $null
    } else {
        & npx -y '@insforge/cli' secrets add GROQ_API_KEY $plainKey --json *> $null
    }
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo guardar GROQ_API_KEY. Revisa tu acceso al proyecto.' }
    $plainKey = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    $keyPointer = [IntPtr]::Zero
    $secureKey.Dispose()
    $secureKey = $null

    Write-Host 'Clave validada y guardada. Desplegando ask...'
    & npx -y '@insforge/cli' functions deploy ask --file './functions/ask.ts'
    if ($LASTEXITCODE -ne 0) { throw 'Fallo el despliegue de ask. La clave ya esta guardada; puedes volver a ejecutar el script.' }
    Write-Host 'Listo. Ejecuta: .\scripts\test-rag.ps1 -SkipIngest'
} finally {
    $catalog = $null
    $validation = $null
    $validationBody = $null
    $headers = $null
    $plainKey = $null
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    if ($null -ne $secureKey) { $secureKey.Dispose() }
    Pop-Location
}
