# RAG con InsForge + Gemini

InsForge conserva PostgreSQL/pgvector y las edge functions. La IA llama **directamente a Gemini API**, sin utilizar el Model Gateway de InsForge ni OpenRouter.

## Usar el chatbot desde la interfaz

Desde PowerShell, abre la carpeta del proyecto y ejecuta:

```powershell
cd D:\users\svc_soporteonsite\Desktop\Insforce-RAG
npm start
```

Abre **http://localhost:5173**. El inicio recupera `RAG_API_KEY` con tu sesión actual del CLI y la mantiene únicamente en memoria del servidor Node. No necesitas volver a ingresar la clave de Gemini. Detén el servidor con Ctrl+C. También puedes ejecutar `./scripts/start-ui.ps1 -Port 5174` si el puerto está ocupado.

- Escribe una pregunta y pulsa Enter; Shift+Enter añade una línea.
- Abre **Ver fuentes y citas** debajo de una respuesta para revisar documento, fragmento, similitud coseno y citas textuales. La similitud no es un porcentaje de certeza.
- Usa el clip **Añadir documento** para cargar un `.txt` UTF-8 de hasta **10 MB**. El límite puede bajarse a 5 MB con `MAX_TXT_MB=5` antes de iniciar la UI.
- La UI calcula SHA-256 para evitar duplicados, divide el archivo en bloques de aproximadamente 100000 caracteres y muestra bloques y fragmentos confirmados. Si se interrumpe, conserva temporalmente el TXT en IndexedDB y continúa desde el último bloque confirmado al reabrir la página.
- Puedes detener una consulta, reintentar errores y crear, descargar o eliminar conversaciones. El historial se guarda en este navegador (hasta 30 conversaciones y los últimos 100 mensajes de cada una); eliminar un chat no elimina documentos de InsForge.
- Cada pregunta se envía de forma independiente al RAG. El historial visible no se envía al modelo como memoria conversacional.
- TRAZAI interpreta dinámicamente la intención de cada mensaje. Los saludos, agradecimientos y preguntas sobre el uso de la aplicación reciben una respuesta natural sin fuentes; cualquier solicitud factual o potencialmente relacionada con el contenido continúa por el RAG, incluso si comienza con un saludo.

La interfaz llama a `/api/ask`, `/api/ingest/start`, `/api/ingest/block` y `/api/ingest/complete` del servidor local. Este reenvía las solicitudes autenticadas a InsForge. Solo escucha en `127.0.0.1`, valida el origen y entrega una lista cerrada de archivos públicos. Las claves, `.env`, `.insforge`, las funciones y los scripts no son descargables. El antiguo servidor estático `serve` no ofrece esta conexión; utiliza `npm start`.

Para validar la conexión local sin llamadas reales a Gemini: `npm test`. Las pruebas del backend siguen disponibles con `deno task test`.

- Embeddings: `gemini-embedding-2`, 1536 dimensiones. No mezclar con los vectores de OpenAI.
- Respuestas: `gemini-3.5-flash-lite`. No hay modelos alternativos ni reintentos automaticos que generen cargos. El anterior `gemini-2.5-flash-lite` fue retirado para usuarios nuevos por Google.
- Ingesta: solo TXT UTF-8. Cada bloque se convierte en chunks de aproximadamente 500 tokens con overlap de 80 y los embeddings se solicitan en grupos de 20. Se estima con caracteres; no es un conteo exacto del tokenizer de Gemini.
- Reanudación: InsForge confirma cada grupo y cada bloque. El documento pasa de `processing` a `ready` únicamente cuando todos los bloques están completos. El TXT original no se guarda en InsForge; la copia local se elimina de IndexedDB al finalizar.
- Consulta: los 5 chunks mas similares; respuesta con fuentes, score de similitud coseno y citas verificadas contra el texto original.
- Negativa: `no tengo esa información en mis documentos`, sin fuentes, si el contexto es insuficiente.
- Conversación: una primera llamada a Gemini clasifica el mensaje como conversación social, ayuda, aclaración o consulta documental. Una salida inválida o dudosa se dirige al flujo documental; la vía conversacional no puede aportar datos de los documentos ni conocimientos externos.
- La tabla y el RPC son privados. Ambos endpoints requieren `x-rag-api-key`.

## Donde poner tu clave de Gemini

1. Crea una clave en [Google AI Studio](https://aistudio.google.com/apikey), usando un proyecto en **Free tier sin facturacion activada**.
2. Abre PowerShell en esta carpeta y ejecuta:

```powershell
cd D:\users\svc_soporteonsite\Desktop\Insforce-RAG
.\scripts\configure-gemini.ps1
```

Pega la clave cuando aparezca `Pega tu API key de Gemini (entrada oculta)`. El script la guarda como **`GEMINI_API_KEY` en los Secrets de InsForge** y vuelve a desplegar `ingest` y `ask` para que la carguen. No la compartas por chat. No la pongas en `script.js`, HTML, Git ni variables `VITE_*`.

Si PowerShell bloquea scripts, usa `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-gemini.ps1`. Esto cambia la politica solo para ese proceso.

`.env.example` es solo una referencia: editarlo no configura las funciones desplegadas. `API_KEY` y `INSFORGE_BASE_URL` los proporciona InsForge. `RAG_API_KEY` ya existe y protege tus endpoints; no es la clave de Google.

## Prueba real despues de guardar la clave

```powershell
.\scripts\test-rag.ps1
```

El script lee la clave privada del endpoint desde InsForge sin mostrarla, ingesta el documento ficticio de tres parrafos y hace dos preguntas:

1. Horario de NubeClara: debe mencionar **09:00 a 18:00** y devolver fuentes.
2. Precio del plan premium: debe devolver la negativa exacta y `sources: []`.

Cada ingesta agrega filas. Para repetir solo las preguntas sin duplicar el ejemplo: `./scripts/test-rag.ps1 -SkipIngest`. No se borran documentos automaticamente. Si posteriormente agregas un documento con precios, adapta la pregunta negativa a un dato realmente ausente.

## Endpoints y curl (PowerShell)

- `POST https://5a4bnskj.function2.insforge.app/ingest`
- `POST https://5a4bnskj.function2.insforge.app/ask`

Desde la carpeta del proyecto, recupera la clave del endpoint en memoria:

```powershell
$secret = npx -y @insforge/cli secrets get RAG_API_KEY --json | ConvertFrom-Json
$ragKey = $secret.value
$secret = $null

curl.exe --fail-with-body "https://5a4bnskj.function2.insforge.app/ingest" `
  -H "Content-Type: application/json" -H "x-rag-api-key: $ragKey" `
  --data-binary "@examples/ingest-demo.json"

curl.exe --fail-with-body "https://5a4bnskj.function2.insforge.app/ask" `
  -H "Content-Type: application/json" -H "x-rag-api-key: $ragKey" `
  --data-binary "@examples/ask-known.json"

curl.exe --fail-with-body "https://5a4bnskj.function2.insforge.app/ask" `
  -H "Content-Type: application/json" -H "x-rag-api-key: $ragKey" `
  --data-binary "@examples/ask-unknown.json"

$ragKey = $null
```

## Limites, costes y privacidad

Los modelos elegidos tienen nivel gratuito segun la [tarifa oficial de Gemini](https://ai.google.dev/gemini-api/docs/pricing) consultada al implementar. La disponibilidad, cuotas y condiciones dependen de Google y de tu cuenta. InsForge mantiene sus propios limites gratuitos de almacenamiento/ejecucion; esto no los elimina.

Cada mensaje realiza una llamada breve de interpretación. Las consultas documentales realizan además el embedding y la generación fundamentada, por lo que consumen más solicitudes y pueden tardar más que un saludo.

**No se activo facturacion.** El codigo no puede detectar ni impedir cobros si le das una clave de un proyecto de Google con facturacion habilitada. Usa un proyecto Free tier sin billing para probar sin cargos. Al agotar cuota devuelve `429 GEMINI_QUOTA_EXCEEDED`, sin cambiar de proveedor. Verifica las cuotas en AI Studio; no se promete uso ilimitado.

El nivel gratuito de Gemini puede utilizar contenido enviado para mejorar productos. Usa los documentos ficticios de ejemplo, no datos personales, empresariales confidenciales ni secretos.

La proteccion actual es una clave privada compartida, utilizada exclusivamente por el servidor local. Para publicar la interfaz a otros usuarios se necesita autenticacion por usuario y limites por usuario.

El prompt estricto y las citas reducen respuestas sin respaldo, pero no garantizan ausencia absoluta de alucinaciones. Evalua tu propio corpus antes de usarlo en produccion.

## Desarrollo y comprobaciones

Requisitos: Node/npm y Deno. Desde el proyecto:

```powershell
deno task check
deno task test
```

Las pruebas locales simulan Gemini y la base de datos: no usan claves reales, no necesitan permiso de red y no consumen cuota de IA (la primera descarga de dependencias si necesita internet).

La migracion `20260916033634_use-gemini-rag.sql` conserva datos anteriores y restringe `match_documents` a vectores `gemini-embedding-2`. Si habia datos de otro modelo, vuelve a ingestarlos; la funcion no compara espacios de embeddings incompatibles.

Errores principales: `401 UNAUTHORIZED`, `400 INVALID_INPUT/INVALID_JSON`, `413 INPUT_TOO_LARGE`, `503 GEMINI_API_KEY_NOT_CONFIGURED`, `429 GEMINI_QUOTA_EXCEEDED`, `502 GEMINI_REQUEST_REJECTED` o `504 GEMINI_TIMEOUT`. No se devuelven detalles sensibles del proveedor ni de la base de datos.

Referencias: [Embeddings](https://ai.google.dev/gemini-api/docs/embeddings), [API de embeddings](https://ai.google.dev/api/embeddings), [salida estructurada](https://ai.google.dev/gemini-api/docs/structured-output).
