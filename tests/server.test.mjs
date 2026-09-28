import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server.mjs';

async function fixture(t, fetchImpl, ragKey = 'unit-test-secret') {
  const server = createApp({ ragKey, fetchImpl });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end('{}');
  });
}
test('only public assets are served; no project files or secrets are exposed', async (t) => {
  const base = await fixture(t, () => { throw new Error('Unexpected upstream call'); });
  for (const path of ['/', '/script.js', '/styles.css', '/integration.css']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert(!(await res.text()).includes('unit-test-secret'));
  }
  for (const path of ['/.env.local', '/.insforge/project.json', '/server.mjs', '/scripts/start-ui.ps1', '/api/secrets', '/%2e%2e/.env']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), {
    configured: true,
    maxTxtBytes: 10 * 1024 * 1024,
    blockCharacters: 100_000,
  });
});
test('cross-origin requests and untrusted hosts cannot access the bridge', async (t) => {
  const base = await fixture(t, () => { throw new Error('Must not forward'); });
  for (const headers of [{ origin: 'https://external.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await fetch(base + '/api/ask', { method: 'POST', headers, body: '{}' })).status, 403);
  }
  assert.equal(await rawStatus(base + '/api/ask', { Host: 'external.example' }), 403);
});
test('ask and resumable ingestion forward JSON with server-side credentials only', async (t) => {
  const calls = [];
  const trace = { version: 1, route: 'documents', totalMs: 12, steps: [], retrieval: [] };
  const base = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('ingest-start') ? { document: { id: 1 } } : url.endsWith('ask') ? { answer: 'Respuesta', sources: [], trace } : { status: 'ok' }, { status: url.endsWith('ingest-start') ? 201 : 200 });
  });
  for (const action of ['ask', 'ingest/start', 'ingest/block', 'ingest/complete']) {
    const res = await fetch(`${base}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Consulta', text: 'Texto', source: 'test' }) });
    assert.equal(res.status, action === 'ingest/start' ? 201 : 200);
    const responseText = await res.text();
    assert(!responseText.includes('unit-test-secret'));
    if (action === 'ask') assert.deepEqual(JSON.parse(responseText).trace, trace);
  }
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, 'https://5a4bnskj.function2.insforge.app/ask');
  assert.equal(calls[1].url, 'https://5a4bnskj.function2.insforge.app/ingest-start');
  assert.equal(calls[2].url, 'https://5a4bnskj.function2.insforge.app/ingest-block');
  assert.equal(calls[3].url, 'https://5a4bnskj.function2.insforge.app/ingest-complete');
  assert.equal(calls[0].options.headers['x-rag-api-key'], 'unit-test-secret');
  assert.equal(JSON.parse(calls[0].options.body).question, 'Consulta');
});
test('Groq failures pass through the bridge with only status and safe fields', async (t) => {
  const failures = [
    { status: 429, code: 'GROQ_RATE_LIMITED', error: 'Límite de Groq alcanzado.' },
    { status: 503, code: 'GROQ_UNAVAILABLE', error: 'Groq no está disponible.' },
    { status: 502, code: 'GROQ_INCOMPLETE_ANSWER', error: 'Groq no completó la respuesta.' },
  ];
  let call = 0;
  const base = await fixture(t, async () => {
    const failure = failures[call++];
    return Response.json({ ...failure, debug: 'private' }, {
      status: failure.status,
      headers: { 'set-cookie': 'private=1', 'x-provider-secret': 'private' },
    });
  });
  for (const failure of failures) {
    const res = await fetch(base + '/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, failure.status);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('x-provider-secret'), null);
    assert.deepEqual(await res.json(), { code: failure.code, error: failure.error });
  }
});
test('non-JSON gateway timeouts become actionable JSON', async (t) => {
  const base = await fixture(t, async () => new Response('<html>private gateway response</html>', {
    status: 504,
    headers: { 'Content-Type': 'text/html' },
  }));
  const res = await fetch(base + '/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), {
    code: 'GATEWAY_TIMEOUT',
    error: 'La consulta tardó demasiado en el servicio de IA. Inténtalo de nuevo.',
  });
});
test('invalid bodies are rejected without calling the provider', async (t) => {
  let calls = 0;
  const base = await fixture(t, () => { calls++; throw new Error('Unexpected'); });
  for (const [body, type, status] of [['{}', 'text/plain', 415], ['{', 'application/json', 400], ['null', 'application/json', 400], ['x'.repeat(40001), 'application/json', 413]]) {
    const res = await fetch(base + '/api/ask', { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal(res.status, status);
  }
  assert.equal(calls, 0);
});
test('missing configuration and connection errors are actionable', async (t) => {
  const base = await fixture(t, async () => { throw new Error('private diagnostic'); }, '');
  const res = await fetch(base + '/api/ask', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'LOCAL_NOT_CONFIGURED');
  const connected = await fixture(t, async () => { throw new Error('private diagnostic'); });
  const failed = await fetch(connected + '/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(failed.status, 502);
  assert(!(await failed.text()).includes('private diagnostic'));
});
