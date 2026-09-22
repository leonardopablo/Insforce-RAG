import { createAdminClient } from "npm:@insforge/sdk@1.5.2";

// Standalone file: InsForge deploys one source file per function.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-rag-api-key",
};
export const EMBEDDING_MODEL = "gemini-embedding-2";
const DIMENSIONS = 1536;

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new ApiError(
      503,
      `${name}_NOT_CONFIGURED`,
      `Falta configurar ${name} en los secretos de InsForge.`,
    );
  }
  return value;
}

// About 500 tokens, with about 80 tokens of overlap (4 characters/token).
// A character ceiling also bounds unbroken strings and non-Latin text.
// Exact token counts depend on the tokenizer/language.
export function splitIntoChunks(text: string): string[] {
  const chars = Array.from(text.trim());
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + 2000, chars.length);
    if (end < chars.length) {
      for (let boundary = end; boundary > start + 1600; boundary--) {
        if (/\s/u.test(chars[boundary])) {
          end = boundary;
          break;
        }
      }
    }
    const chunk = chars.slice(start, end).join("").trim();
    if (chunk) chunks.push(chunk);
    if (end === chars.length) break;
    start = end - 320;
  }
  return chunks;
}

export function validEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === DIMENSIONS &&
    value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    value.some((n) => n !== 0);
}

async function geminiEmbeddings(texts: string[], source: string): Promise<number[][]> {
  const key = env("GEMINI_API_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    // Synchronous batchEmbedContents, NOT the paid/asynchronous Batch API.
    // Each Content is a separate request so chunks do not collapse into one vector.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: `title: ${source} | text: ${text}` }] },
            embedContentConfig: { outputDimensionality: DIMENSIONS, autoTruncate: false },
          })),
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) {
        throw new ApiError(
          502,
          "GEMINI_MODEL_UNAVAILABLE",
          `El modelo ${EMBEDDING_MODEL} ya no esta disponible para esta clave. Actualiza el modelo configurado.`,
        );
      }
      if (response.status === 429) {
        throw new ApiError(
          429,
          "GEMINI_QUOTA_EXCEEDED",
          "Cuota de Gemini agotada. Espera al reinicio de tu cuota; no se usara otro modelo.",
        );
      }
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new ApiError(
          502,
          "GEMINI_REQUEST_REJECTED",
          "Gemini rechazo la solicitud. Revisa la clave, sus restricciones y el acceso al modelo.",
        );
      }
      throw new ApiError(502, "GEMINI_UNAVAILABLE", "Gemini no esta disponible. Intenta mas tarde.");
    }
    const result = await response.json();
    if (
      !Array.isArray(result.embeddings) || result.embeddings.length !== texts.length ||
      !result.embeddings.every((item: { values?: unknown }) => validEmbedding(item?.values))
    ) {
      throw new ApiError(
        502,
        "INVALID_EMBEDDINGS",
        "Gemini devolvio embeddings incompletos o de dimension incorrecta.",
      );
    }
    return result.embeddings.map((item: { values: number[] }) => item.values);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError(504, "GEMINI_TIMEOUT", "Gemini excedio el tiempo de espera.");
    }
    throw new ApiError(502, "GEMINI_UNAVAILABLE", "No se pudo obtener una respuesta valida de Gemini.");
  } finally {
    clearTimeout(timeout);
  }
}

export default async function ingest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405);
  try {
    if (req.headers.get("x-rag-api-key")?.trim() !== env("RAG_API_KEY")) {
      return json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }
    if (Number(req.headers.get("content-length")) > 800_000) {
      throw new ApiError(413, "BODY_TOO_LARGE", "El JSON es demasiado grande.");
    }
    const raw = await req.text();
    if (raw.length > 800_000) throw new ApiError(413, "BODY_TOO_LARGE", "El JSON es demasiado grande.");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ApiError(400, "INVALID_JSON", "Envia un objeto JSON valido.");
    }
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new ApiError(400, "INVALID_JSON", "Envia un objeto JSON valido.");
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const source = body.source === undefined
      ? "manual"
      : typeof body.source === "string"
      ? body.source.trim()
      : "";
    if (!text || !source) {
      throw new ApiError(400, "INVALID_INPUT", "text y source deben ser cadenas no vacias.");
    }
    if (text.length > 120_000 || source.length > 500) {
      throw new ApiError(413, "INPUT_TOO_LARGE", "Limites: text 120000 caracteres, source 500 caracteres.");
    }
    const chunks = splitIntoChunks(text);
    if (chunks.length > 80) {
      throw new ApiError(413, "TOO_MANY_CHUNKS", "Envia un documento mas pequeno (maximo 80 chunks).");
    }
    // All vectors are generated/validated before the single atomic database insert.
    const embeddings = await geminiEmbeddings(chunks, source);
    const admin = createAdminClient({ baseUrl: env("INSFORGE_BASE_URL"), apiKey: env("API_KEY") });
    const { error } = await admin.database.from("documents").insert(chunks.map((content, index) => ({
      content,
      source,
      chunk_index: index,
      embedding: embeddings[index],
      embedding_model: EMBEDDING_MODEL,
    })));
    if (error) throw new ApiError(500, "DATABASE_ERROR", "No se pudieron guardar los documentos.");
    return json({
      source,
      chunksInserted: chunks.length,
      embeddingModel: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      chunking: { targetTokensApprox: 500, overlapTokensApprox: 80 },
    }, 201);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
    // Never log prompts, documents, API keys or upstream error bodies.
    console.error("ingest: unexpected internal error");
    return json({ error: "Error interno de ingesta.", code: "INTERNAL_ERROR" }, 500);
  }
}
