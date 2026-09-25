import { strict as assert } from "node:assert";
import ingest, { splitIntoChunks, validEmbedding } from "../functions/ingest.ts";
import ask, { conversationRoute, groundedResult, NO_INFORMATION } from "../functions/ask.ts";

const vector = [1, ...Array(1535).fill(0)];
const match = {
  id: 1,
  content: "El soporte atiende de lunes a viernes de 09:00 a 18:00.",
  source: "manual",
  chunk_index: 0,
  score: 0.85,
};
const supported = {
  answered: true,
  answer: "De lunes a viernes, de 09:00 a 18:00.",
  citations: [{ chunk: 1, quote: "de lunes a viernes de 09:00 a 18:00" }],
};
const request = (body: unknown, key = "test-private-key") =>
  new Request("https://test.local", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-rag-api-key": key },
    body: JSON.stringify(body),
  });
type Call = { url: string; body: any; headers: Headers };

async function withMock(
  run: (calls: Call[]) => Promise<void>,
  options: {
    noKey?: boolean;
    quota?: boolean;
    badVector?: boolean;
    noMatches?: boolean;
    databaseError?: boolean;
    answer?: unknown;
    route?: unknown;
    finishReason?: string;
    upstreamStatus?: number;
  } = {},
) {
  const savedFetch = globalThis.fetch;
  const names = ["RAG_API_KEY", "GEMINI_API_KEY", "INSFORGE_BASE_URL", "API_KEY"];
  const previous = names.map((name) => Deno.env.get(name));
  Deno.env.set("RAG_API_KEY", "test-private-key");
  Deno.env.set("INSFORGE_BASE_URL", "https://backend.example.test");
  Deno.env.set("API_KEY", "test-admin-key");
  if (options.noKey) Deno.env.delete("GEMINI_API_KEY");
  else Deno.env.set("GEMINI_API_KEY", "test-gemini-key");
  const calls: Call[] = [];
  let generation = 0;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const bodyText = typeof init?.body === "string"
      ? init.body
      : input instanceof Request
      ? await input.text()
      : "{}";
    const body = JSON.parse(bodyText);
    calls.push({
      url,
      body,
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : {})),
    });
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      if (options.quota || options.upstreamStatus) {
        return Response.json({ secret: "upstream-detail-never-return" }, {
          status: options.upstreamStatus ?? 429,
        });
      }
      const values = options.badVector ? [1, 2] : vector;
      if (url.endsWith(":batchEmbedContents")) {
        return Response.json({ embeddings: body.requests.map(() => ({ values })) });
      }
      if (url.endsWith(":embedContent")) return Response.json({ embedding: { values } });
      if (url.endsWith(":generateContent")) {
        const answer = generation++ === 0
          ? options.route ?? { route: "documents", answer: "" }
          : options.answer ?? supported;
        return Response.json({
          candidates: [{
            finishReason: options.finishReason ?? "STOP",
            content: { parts: [{ text: JSON.stringify(answer) }] },
          }],
        });
      }
    }
    if (url.startsWith("https://backend.example.test/")) {
      if (options.databaseError) {
        return Response.json({ message: "private-database-error", code: "42501" }, { status: 403 });
      }
      if (url.includes("/rpc/match_documents")) return Response.json(options.noMatches ? [] : [match]);
      if (url.includes("/documents")) return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected mock URL: ${url}`);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = savedFetch;
    names.forEach((name, index) =>
      previous[index] === undefined ? Deno.env.delete(name) : Deno.env.set(name, previous[index]!)
    );
  }
}

Deno.test("chunker: bounds, overlap, unicode and no loss of content", () => {
  const text = Array.from({ length: 240 }, (_, i) => `Parrafo ${i}: texto con datos 🦙 y varios espacios. `)
    .join("");
  const chunks = splitIntoChunks(text);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => Array.from(chunk).length <= 2000));
  assert(chunks.every((chunk) => !chunk.includes("\uFFFD")));
  let coveredEnd = 0;
  for (let i = 0; i < chunks.length; i++) {
    const start = text.indexOf(chunks[i], i ? Math.max(0, coveredEnd - 400) : 0);
    assert(start >= 0 && start <= coveredEnd);
    if (i) assert(coveredEnd - start >= 300);
    coveredEnd = start + chunks[i].length;
  }
  assert.equal(coveredEnd, text.trimEnd().length);
  assert.deepEqual(splitIntoChunks("  "), []);
  assert.equal(splitIntoChunks("a".repeat(4000)).length, 3);
});
Deno.test("embedding validation rejects wrong dimensions, NaN and zero vectors", () => {
  assert(validEmbedding(vector));
  assert(!validEmbedding([1]));
  assert(!validEmbedding(Array(1536).fill(0)));
  assert(!validEmbedding([NaN, ...vector.slice(1)]));
});

for (const [name, handler] of [["ingest", ingest], ["ask", ask]] as const) {
  Deno.test(`${name}: preflight and method guard`, async () => {
    assert.equal((await handler(new Request("https://test.local", { method: "OPTIONS" }))).status, 204);
    assert.equal((await handler(new Request("https://test.local"))).status, 405);
  });
  Deno.test(`${name}: missing/wrong authorization makes no external call`, () =>
    withMock(async (calls) => {
      assert.equal((await handler(request({}, ""))).status, 401);
      assert.equal((await handler(request({}, "wrong"))).status, 401);
      assert.equal(calls.length, 0);
    }));
  Deno.test(`${name}: invalid JSON and payloads rejected before Gemini`, () =>
    withMock(async (calls) => {
      for (const body of [null, [], {}, { text: 3, question: 4 }, { text: " ", question: " " }]) {
        assert.equal((await handler(request(body))).status, 400);
      }
      const invalid = new Request("https://test.local", {
        method: "POST",
        headers: { "x-rag-api-key": "test-private-key" },
        body: "{",
      });
      assert.equal((await handler(invalid)).status, 400);
      assert.equal(calls.length, 0);
    }));
  Deno.test(`${name}: clear missing Gemini secret`, () =>
    withMock(async (calls) => {
      const response = await handler(request({ text: "documento", question: "pregunta" }));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "GEMINI_API_KEY_NOT_CONFIGURED");
      assert.equal(calls.length, 0);
    }, { noKey: true }));
  Deno.test(`${name}: quota never triggers a retry or paid fallback`, () =>
    withMock(async (calls) => {
      const response = await handler(request({ text: "documento", question: "pregunta" }));
      assert.equal(response.status, 429);
      const body = await response.json();
      assert.equal(body.code, "GEMINI_QUOTA_EXCEEDED");
      assert(!JSON.stringify(body).includes("upstream-detail"));
      assert.equal(calls.length, 1);
    }, { quota: true }));
  Deno.test(`${name}: malformed embeddings never reach the database`, () =>
    withMock(async (calls) => {
      const response = await handler(request({ text: "documento", question: "pregunta" }));
      assert.equal(response.status, 502);
      assert.equal(calls.length, name === "ask" ? 2 : 1);
    }, { badVector: true }));
  Deno.test(`${name}: upstream denial is sanitized`, () =>
    withMock(async () => {
      const response = await handler(request({ text: "documento", question: "pregunta" }));
      assert.equal(response.status, 502);
      assert(!JSON.stringify(await response.json()).includes("upstream-detail"));
    }, { upstreamStatus: 403 }));
}

Deno.test("ingest: batch request and single atomic insert", () =>
  withMock(async (calls) => {
    const text = "Soporte disponible de lunes a viernes. ".repeat(150);
    const response = await ingest(request({ text, source: "manual-demo" }));
    assert.equal(response.status, 201);
    const result = await response.json();
    const count = splitIntoChunks(text).length;
    assert.equal(result.chunksInserted, count);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.get("x-goog-api-key"), "test-gemini-key");
    assert.equal(calls[0].body.requests.length, count);
    assert.equal(calls[0].body.requests[0].embedContentConfig.outputDimensionality, 1536);
    assert(calls[0].body.requests[0].content.parts[0].text.startsWith("title: manual-demo | text: "));
    assert(!JSON.stringify(calls[0].body).includes("taskType"));
    assert.equal(calls[1].body.length, count);
    assert(calls[1].body.every((row: any) => row.embedding_model === "gemini-embedding-2"));
  }));
Deno.test("ingest: rejects oversized text and invalid source", () =>
  withMock(async (calls) => {
    assert.equal((await ingest(request({ text: "a".repeat(120001) }))).status, 413);
    assert.equal((await ingest(request({ text: "ok", source: 42 }))).status, 400);
    assert.equal((await ingest(request({ text: "ok", source: "x".repeat(501) }))).status, 413);
    assert.equal(calls.length, 0);
  }));
Deno.test("database failure is sanitized", () =>
  withMock(async () => {
    for (const handler of [ingest, ask]) {
      const response = await handler(request({ text: "documento", question: "pregunta" }));
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.code, "DATABASE_ERROR");
      assert(!JSON.stringify(body).includes("private-database-error"));
    }
  }, { databaseError: true }));
Deno.test("ask: grounded answer, retrieval top 5 and cited sources", () =>
  withMock(async (calls) => {
    const response = await ask(request({ question: "Cual es el horario?" }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.answer, supported.answer);
    assert.equal(result.sources[0].source, "manual");
    assert.equal(result.sources[0].score, 0.85);
    assert.equal(result.kind, "document");
    assert.equal(result.trace.version, 1);
    assert.equal(result.trace.route, "documents");
    assert.equal(result.trace.retrieval.length, 1);
    assert.equal(result.trace.retrieval[0].score, 0.85);
    assert.equal(result.trace.retrieval[0].cited, true);
    assert(!("content" in result.trace.retrieval[0]));
    assert(!("embedding" in result.trace.retrieval[0]));
    assert(result.trace.steps.every((step: any) => step.status === "done"));
    assert(result.trace.steps.every((step: any) => step.durationMs >= 0));
    assert.equal(calls.length, 4);
    assert.equal(calls[2].body.match_count, 5);
    assert.equal(calls[2].body.match_threshold, -1);
    assert(calls[1].body.content.parts[0].text.startsWith("task: question answering | query: "));
    assert(calls[0].body.systemInstruction.parts[0].text.includes("aunque incluya un saludo"));
    assert(calls[3].url.includes("gemini-3.6-flash"));
  }));
Deno.test("ask: social conversation is natural and skips embeddings and database", () =>
  withMock(async (calls) => {
    const result = await (await ask(request({ question: "Hola, que gusto saludarte" }))).json();
    assert.equal(result.answer, "¡Hola! ¿Qué te gustaría consultar hoy?");
    assert.equal(result.kind, "conversation");
    assert.deepEqual(result.sources, []);
    assert.equal(result.trace.route, "conversation");
    assert.equal(result.trace.steps[0].status, "done");
    assert(result.trace.steps.slice(1).every((step: any) => step.status === "skipped"));
    assert.deepEqual(result.trace.retrieval, []);
    assert.equal(calls.length, 1);
  }, { route: { route: "conversation", answer: "¡Hola! ¿Qué te gustaría consultar hoy?" } }));
Deno.test("conversation router fails closed to document retrieval", () => {
  assert.deepEqual(conversationRoute(null), { route: "documents", answer: "" });
  assert.deepEqual(conversationRoute({ route: "conversation", answer: "" }), { route: "documents", answer: "" });
  assert.deepEqual(conversationRoute({ route: "anything", answer: "respuesta" }), {
    route: "documents",
    answer: "",
  });
  assert.deepEqual(conversationRoute({ route: "documents", answer: "No debe mostrarse" }), {
    route: "documents",
    answer: "",
  });
});
Deno.test("ask: retired model is reported explicitly", () =>
  withMock(async () => {
    const response = await ask(request({ question: "Pregunta" }));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "GEMINI_MODEL_UNAVAILABLE");
  }, { upstreamStatus: 404 }));
Deno.test("ask: provider capacity errors retain status 503", () =>
  withMock(async () => {
    const response = await ask(request({ question: "Pregunta" }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "GEMINI_UNAVAILABLE");
  }, { upstreamStatus: 503 }));
Deno.test("ask: empty corpus skips generation", () =>
  withMock(async (calls) => {
    const result = await (await ask(request({ question: "Pregunta" }))).json();
    assert.equal(result.answer, NO_INFORMATION);
    assert.deepEqual(result.sources, []);
    assert.equal(result.kind, "not_found");
    assert.equal(result.trace.steps.find((step: any) => step.key === "retrieval").status, "done");
    assert.equal(result.trace.steps.find((step: any) => step.key === "generation").status, "skipped");
    assert.deepEqual(result.trace.retrieval, []);
    assert.equal(calls.length, 3);
  }, { noMatches: true }));
Deno.test("ask: absent information returns exact refusal without sources", () =>
  withMock(async () => {
    const result = await (await ask(request({ question: "Cual es el precio del plan premium?" }))).json();
    assert.equal(result.answer, NO_INFORMATION);
    assert.deepEqual(result.sources, []);
  }, { answer: { answered: false, answer: NO_INFORMATION, citations: [] } }));
Deno.test("ask: invalid citations fail closed", () => {
  for (
    const citations of [[], [{ chunk: 6, quote: "soporte" }], [{ chunk: 1, quote: "dato inventado" }], [null]]
  ) {
    assert.equal(groundedResult({ ...supported, citations }, [match]).answer, NO_INFORMATION);
  }
});
Deno.test("ask: truncated model output is an explicit failure", () =>
  withMock(async () => {
    assert.equal((await ask(request({ question: "Pregunta" }))).status, 502);
  }, { finishReason: "MAX_TOKENS" }));
