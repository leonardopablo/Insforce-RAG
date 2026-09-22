import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const FUNCTION_BASE = 'https://5a4bnskj.function2.insforge.app';
const BLOCK_CHARS = 100_000;
const configuredMaxMb = Number(process.env.MAX_TXT_MB || 10);
const MAX_TXT_MB = configuredMaxMb === 5 ? 5 : 10;
const ACTIONS = new Map([
  ['/api/ask', { slug: 'ask', limit: 40_000 }],
  ['/api/ingest/start', { slug: 'ingest-start', limit: 30_000 }],
  ['/api/ingest/block', { slug: 'ingest-block', limit: 700_000 }],
  ['/api/ingest/complete', { slug: 'ingest-complete', limit: 30_000 }],
]);
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/integration.css', ['integration.css', 'text/css; charset=utf-8']],
  ['/script.js', ['script.js', 'text/javascript; charset=utf-8']],
]);
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

// A loopback-only bridge: browser clients never receive the endpoint secret.
// Only these static assets and the allowlisted backend actions can be accessed.
export function createApp({ ragKey = process.env.RAG_API_KEY?.trim(), fetchImpl = fetch } = {}) {
  let inFlight = false;
  return http.createServer(async (req, res) => {
    const reply = (status, body) => {
      if (!res.destroyed) {
        res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      }
    };
    const expectedPort = req.socket.localPort;
    const host = req.headers.host;
    const validHosts = [`localhost:${expectedPort}`, `127.0.0.1:${expectedPort}`];
    if (!validHosts.includes(host)) return reply(403, { error: 'Host no permitido.' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
      return reply(403, { error: 'Origen no permitido.' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return reply(403, { error: 'Origen no permitido.' });
    const pathname = new URL(req.url, `http://${host}`).pathname;
    if (pathname === '/api/health' && req.method === 'GET') {
      return reply(200, {
        configured: Boolean(ragKey),
        maxTxtBytes: MAX_TXT_MB * 1024 * 1024,
        blockCharacters: BLOCK_CHARS,
      });
    }
    const asset = ASSETS.get(pathname);
    if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const data = await readFile(resolve(ROOT, asset[0]));
        res.writeHead(200, { ...securityHeaders, 'Content-Type': asset[1] });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch { reply(500, { error: 'No se pudo cargar la interfaz.' }); }
      return;
    }
    const action = ACTIONS.get(pathname);
    if (!action) return reply(404, { error: 'No encontrado.' });
    if (req.method !== 'POST') return reply(405, { error: 'Usa POST.' });
    if (!ragKey) return reply(503, { code: 'LOCAL_NOT_CONFIGURED', error: 'Inicia la interfaz con scripts/start-ui.ps1.' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      return reply(415, { error: 'Se requiere application/json.' });
    }
    const limit = action.limit;
    if (Number(req.headers['content-length']) > limit) return reply(413, { error: 'El contenido es demasiado grande.' });
    if (inFlight) return reply(429, { code: 'LOCAL_BUSY', error: 'Espera a que termine la solicitud actual.' });
    inFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > limit) { reply(413, { error: 'El contenido es demasiado grande.' }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reply(400, { error: 'JSON no válido.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'JSON no válido.' });
      const upstream = await fetchImpl(`${FUNCTION_BASE}/${action.slug}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rag-api-key': ragKey },
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      let result;
      try { result = await upstream.json(); }
      catch { return reply(502, { code: 'UPSTREAM_ERROR', error: 'El servicio devolvió una respuesta no válida.' }); }
      // Do not forward upstream headers, cookies or credentials.
      if (upstream.ok) reply(upstream.status, result);
      else reply(upstream.status, { code: result.code ?? 'UPSTREAM_ERROR', error: result.error ?? 'El servicio no pudo completar la solicitud.' });
    } catch {
      reply(controller.signal.aborted ? 504 : 502, {
        code: controller.signal.aborted ? 'LOCAL_TIMEOUT' : 'CONNECTION_ERROR',
        error: controller.signal.aborted ? 'La solicitud tardó demasiado. Inténtalo de nuevo.' : 'No se pudo conectar con InsForge. Comprueba tu conexión.',
      });
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      inFlight = false;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT no válido');
  const app = createApp();
  app.requestTimeout = 100_000;
  app.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `El puerto ${port} está ocupado. Detén el servidor anterior.` : 'No se pudo iniciar el servidor.');
    process.exitCode = 1;
  });
  app.listen(port, '127.0.0.1', () => console.log(`Insforce listo en http://localhost:${port}`));
}
