# RAG con InsForge + Gemini Embeddings + Groq

InsForge conserva PostgreSQL/pgvector y las edge functions. Los embeddings llaman directamente a Gemini API; el enrutamiento conversacional y las respuestas llaman directamente a Groq. No se utiliza el Model Gateway de InsForge ni OpenRouter.

## Requisitos

- Windows con PowerShell 5.1 o posterior. Los scripts de operacion incluidos son PowerShell.
- [Node.js](https://nodejs.org/) 18.16 o posterior, con npm y `npx`.
- [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.x para comprobar y probar las edge functions.
- Una cuenta de InsForge con acceso al proyecto vinculado. El CLI se ejecuta bajo demanda mediante `npx -y @insforge/cli`, por lo que no requiere instalacion global.
- Claves de [Google AI Studio](https://aistudio.google.com/apikey) y [Groq](https://console.groq.com/keys) para configurar un backend nuevo.

Este proyecto no usa paquetes npm en tiempo de ejecucion: el servidor local se apoya solo en modulos nativos de Node.js. Las edge functions fijan `@insforge/sdk@1.5.2` en sus imports y `deno.lock` conserva sus dependencias transitivas. Por eso no corresponde crear un `requirements.txt` de Python; los requisitos reproducibles son `package-lock.json` y `deno.lock`.

## Instalacion

```powershell
git clone https://github.com/leonardopablo/Insforce-RAG.git
cd Insforce-RAG
npm ci
deno task check
```

`npm ci` valida el entorno Node aunque actualmente no haya dependencias externas. La primera ejecucion de `deno task check` descarga las dependencias fijadas en `deno.lock` y comprueba los tipos de las funciones.

## Levantar el proyecto

El servidor local necesita leer `RAG_API_KEY` del proyecto InsForge vinculado. Inicia sesion y vincula el proyecto una sola vez si esta copia aun no tiene esa configuracion:

```powershell
npx -y @insforge/cli login
npx -y @insforge/cli link
```

No agregues `.insforge/project.json` al repositorio: contiene configuracion privada y ya esta excluido por `.gitignore`.

Arranca la interfaz desde PowerShell:

```powershell
npm start
```

Abre **http://localhost:5173**. El inicio recupera `RAG_API_KEY` con tu sesión actual del CLI y la mantiene únicamente en memoria del servidor Node. No necesitas volver a ingresar la clave de Gemini. Detén el servidor con Ctrl+C. También puedes ejecutar `./scripts/start-ui.ps1 -Port 5174` si el puerto está ocupado.

- Escribe una pregunta y pulsa Enter; Shift+Enter añade una línea.
- Abre **Ver fuentes y citas** debajo de una respuesta para revisar documento, fragmento, similitud coseno y citas textuales. La similitud no es un porcentaje de certeza.
- Abre **Explorar cómo razonó el RAG** para ver las etapas y duraciones reales de la consulta, el top 5 recuperado y una representación 3D interactiva de sus ángulos coseno. Puedes arrastrar para rotar, usar la rueda para acercar o navegar con flechas y las teclas `+`/`-`.
- Usa el clip **Añadir documento** para cargar un `.txt` UTF-8 de hasta **10 MB**. El límite puede bajarse a 5 MB con `MAX_TXT_MB=5` antes de iniciar la UI.
- La UI calcula SHA-256 para evitar duplicados, divide el archivo en bloques de aproximadamente 100000 caracteres y muestra bloques y fragmentos confirmados. Si se interrumpe, conserva temporalmente el TXT en IndexedDB y continúa desde el último bloque confirmado al reabrir la página.
- Puedes detener una consulta, reintentar errores y crear, descargar o eliminar conversaciones. El historial se guarda en este navegador (hasta 30 conversaciones y los últimos 100 mensajes de cada una); eliminar un chat no elimina documentos de InsForge.
- Cada pregunta se envía de forma independiente al RAG. El historial visible no se envía al modelo como memoria conversacional.
- TRAZAI interpreta dinámicamente la intención de cada mensaje. Los saludos, agradecimientos y preguntas sobre el uso de la aplicación reciben una respuesta natural sin fuentes; cualquier solicitud factual o potencialmente relacionada con el contenido continúa por el RAG, incluso si comienza con un saludo.

La interfaz llama a `/api/ask`, `/api/ingest/start`, `/api/ingest/block` y `/api/ingest/complete` del servidor local. Este reenvía las solicitudes autenticadas a InsForge. Solo escucha en `127.0.0.1`, valida el origen y entrega una lista cerrada de archivos públicos. Las claves, `.env`, `.insforge`, las funciones y los scripts no son descargables. El antiguo servidor estático `serve` no ofrece esta conexión; utiliza `npm start`.

Para validar la conexión local sin llamadas reales a Gemini ni Groq: `npm test`. Las pruebas del backend siguen disponibles con `deno task test`.

- Embeddings: `gemini-embedding-2`, 1536 dimensiones. No mezclar con los vectores de OpenAI.
- Enrutamiento y respuestas: Groq `openai/gpt-oss-20b`, con JSON Schema estricto y razonamiento de esfuerzo bajo para respetar la cuota gratuita. No hay modelos alternativos ni reintentos automaticos.
- Ingesta: solo TXT UTF-8. Cada bloque se convierte en chunks de aproximadamente 500 tokens con overlap de 80 y los embeddings se solicitan en grupos de 20. Se estima con caracteres; no es un conteo exacto del tokenizer de Gemini.
- Reanudación: InsForge confirma cada grupo y cada bloque. El documento pasa de `processing` a `ready` únicamente cuando todos los bloques están completos. El TXT original no se guarda en InsForge; la copia local se elimina de IndexedDB al finalizar.
- Consulta: los 5 chunks mas similares; respuesta con fuentes, score de similitud coseno y citas verificadas contra el texto original.
- Traza didáctica: cada respuesta incluye tiempos compactos del pipeline y metadatos del top 5, sin enviar embeddings ni el contenido de fragmentos no citados. La vista 3D conserva el ángulo real entre cada candidato y la consulta; su distribución alrededor del eje es ilustrativa y no reproduce literalmente las 1536 dimensiones.
- Negativa: `no tengo esa información en mis documentos`, sin fuentes, si el contexto es insuficiente.
- Conversación: una primera llamada a Groq clasifica el mensaje como conversación social, ayuda, aclaración o consulta documental. Una salida inválida o dudosa se dirige al flujo documental; la vía conversacional no puede aportar datos de los documentos ni conocimientos externos.
- La tabla y el RPC son privados. Ambos endpoints requieren `x-rag-api-key`.

## Configurar las claves privadas

La aplicación necesita Gemini para embeddings y Groq para enrutamiento y respuestas. Las funciones desplegadas leen ambas claves desde los Secrets de InsForge; los scripts de configuracion las mantienen en memoria solo mientras las validan y las entregan al CLI.

### Gemini

1. Crea una clave en [Google AI Studio](https://aistudio.google.com/apikey), usando un proyecto en **Free tier sin facturacion activada**.
2. Abre PowerShell en esta carpeta y ejecuta:

```powershell
.\scripts\configure-gemini.ps1
```

Pega la clave cuando aparezca `Pega tu API key de Gemini (entrada oculta)`. El script la guarda como **`GEMINI_API_KEY` en los Secrets de InsForge** y vuelve a desplegar `ingest` y `ask` para que la carguen. No la compartas por chat. No la pongas en `script.js`, HTML, Git ni variables `VITE_*`.

Si PowerShell bloquea scripts, usa `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-gemini.ps1`. Esto cambia la politica solo para ese proceso.

`.env.example` es solo una referencia: editarlo no configura las funciones desplegadas. `API_KEY` y `INSFORGE_BASE_URL` los proporciona InsForge. `RAG_API_KEY` ya existe y protege tus endpoints; no es la clave de Google.

### Groq

1. Crea una clave en [Groq Console](https://console.groq.com/keys).
2. Desde esta carpeta ejecuta:

```powershell
.\scripts\configure-groq.ps1
```

El script solicita la clave con entrada oculta, comprueba el acceso a `openai/gpt-oss-20b`, la guarda como **`GROQ_API_KEY`** y despliega solamente `ask`. No elimina ni reemplaza `GEMINI_API_KEY` porque los embeddings existentes siguen dependiendo de Gemini.

## Prueba real despues de guardar la clave

```powershell
.\scripts\test-rag.ps1 -SkipIngest
```

El script lee la clave privada del endpoint desde InsForge sin mostrarla y hace dos preguntas sobre el corpus existente:

1. Horario de NubeClara: debe mencionar **09:00 a 18:00** y devolver fuentes.
2. Precio del plan premium: debe devolver la negativa exacta y `sources: []`.

Si el documento ficticio todavia no existe, ejecuta una sola vez `./scripts/test-rag.ps1` sin `-SkipIngest`. Cada ingesta agrega filas; no se borran documentos automaticamente. Si posteriormente agregas un documento con precios, adapta la pregunta negativa a un dato realmente ausente.

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

Los proveedores elegidos tienen nivel gratuito segun sus paginas oficiales consultadas al implementar. La disponibilidad, cuotas y condiciones dependen de Google, Groq y de cada cuenta. InsForge mantiene sus propios limites gratuitos de almacenamiento/ejecucion; esto no los elimina.

Cada mensaje realiza una llamada breve a Groq para interpretación. Las consultas documentales realizan además un embedding en Gemini y otra llamada a Groq para la respuesta fundamentada, por lo que consumen más solicitudes y pueden tardar más que un saludo.

**No se activo facturacion.** El codigo no puede detectar ni impedir cobros si configuras cuentas con facturacion habilitada. Al agotar cuota devuelve `429 GEMINI_QUOTA_EXCEEDED` o `429 GROQ_RATE_LIMITED`, sin cambiar de proveedor ni reintentar automaticamente. Verifica las cuotas en AI Studio y Groq Console; no se promete uso ilimitado.

Google recibe documentos y preguntas para generar embeddings. Groq recibe cada pregunta y, para consultas documentales, los cinco fragmentos recuperados. Groq indica que no retiene por defecto los datos de inferencia y ofrece Zero Data Retention, pero debes revisar y configurar tus propios controles. Usa los documentos ficticios de ejemplo, no datos personales, empresariales confidenciales ni secretos.

La proteccion actual es una clave privada compartida, utilizada exclusivamente por el servidor local. Para publicar la interfaz a otros usuarios se necesita autenticacion por usuario y limites por usuario.

El prompt estricto y las citas reducen respuestas sin respaldo, pero no garantizan ausencia absoluta de alucinaciones. Evalua tu propio corpus antes de usarlo en produccion.

## Desarrollo y comprobaciones

Ejecuta toda la verificacion local con:

```powershell
npm run verify
```

O ejecuta cada grupo por separado:

```powershell
npm test
deno task check
deno task test
```

Las pruebas locales simulan Gemini, Groq y la base de datos: no usan claves reales, no necesitan permiso de red y no consumen cuota de IA (la primera descarga de dependencias si necesita internet).

La migracion `20260916033634_use-gemini-rag.sql` conserva datos anteriores y restringe `match_documents` a vectores `gemini-embedding-2`. Si habia datos de otro modelo, vuelve a ingestarlos; la funcion no compara espacios de embeddings incompatibles.

Errores principales: `401 UNAUTHORIZED`, `400 INVALID_INPUT/INVALID_JSON`, `413 INPUT_TOO_LARGE`, errores `GEMINI_*` para embeddings y errores `GROQ_*` para enrutamiento/generacion. Los limites gratuitos conservan HTTP `429`; la falta temporal de capacidad conserva HTTP `503`. No se devuelven detalles sensibles del proveedor ni de la base de datos.

Referencias: [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings), [API de embeddings](https://ai.google.dev/api/embeddings), [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs), [limites de Groq](https://console.groq.com/docs/rate-limits) y [datos en GroqCloud](https://console.groq.com/docs/your-data).
