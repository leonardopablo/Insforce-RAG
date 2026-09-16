import OpenAI from "npm:openai@4.96.2";
import { createAdminClient } from "npm:@insforge/sdk@latest";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-rag-api-key",
};

const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const MAX_TEXT_LENGTH = 120_000;
const MAX_CHUNKS = 100;

type IngestBody = {
  text?: unknown;
  source?: unknown;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isAuthorized(req: Request): boolean {
  const configuredKey = Deno.env.get("RAG_API_KEY")?.trim();
  const requestKey = req.headers.get("x-rag-api-key")?.trim();
  return Boolean(configuredKey && requestKey && configuredKey === requestKey);
}

/**
 * Splits on words using a practical approximation of 0.75 words per token.
 * The defaults produce chunks of roughly 500 tokens with an ~80-token overlap.
 */
function splitIntoChunks(
  text: string,
  targetTokens = 500,
  overlapTokens = 80,
): string[] {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const targetWords = Math.max(1, Math.floor(targetTokens * 0.75));
  const overlapWords = Math.min(
    targetWords - 1,
    Math.max(0, Math.floor(overlapTokens * 0.75)),
  );
  const chunks: string[] = [];

  for (let start = 0; start < words.length;) {
    const end = Math.min(start + targetWords, words.length);
    chunks.push(words.slice(start, end).join(" "));

    if (end >= words.length) break;
    start = end - overlapWords;
  }

  return chunks;
}

export default async function ingest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  try {
    const body = (await req.json()) as IngestBody;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const source = typeof body.source === "string" ? body.source.trim() : "manual";

    if (!text) return json({ error: "text must be a non-empty string" }, 400);
    if (!source) return json({ error: "source must be a non-empty string" }, 400);
    if (text.length > MAX_TEXT_LENGTH) {
      return json({ error: `text exceeds the ${MAX_TEXT_LENGTH}-character limit` }, 413);
    }

    const chunks = splitIntoChunks(text);
    if (chunks.length > MAX_CHUNKS) {
      return json({ error: `text produced more than ${MAX_CHUNKS} chunks` }, 413);
    }

    const openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: requiredEnv("OPENROUTER_API_KEY"),
    });

    const embeddingResult = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: chunks,
    });

    const orderedEmbeddings = [...embeddingResult.data].sort((a, b) => a.index - b.index);
    if (orderedEmbeddings.length !== chunks.length) {
      throw new Error("Embedding count did not match chunk count");
    }

    const admin = createAdminClient({
      baseUrl: requiredEnv("INSFORGE_BASE_URL"),
      apiKey: requiredEnv("API_KEY"),
    });

    const rows = chunks.map((content, index) => ({
      content,
      source: source.slice(0, 500),
      chunk_index: index,
      embedding: orderedEmbeddings[index].embedding,
      embedding_model: EMBEDDING_MODEL,
    }));

    const { error } = await admin.database.from("documents").insert(rows);
    if (error) throw new Error(`Database insert failed: ${error.message}`);

    return json({
      success: true,
      source: source.slice(0, 500),
      chunksInserted: rows.length,
      embeddingModel: EMBEDDING_MODEL,
      chunking: { targetTokens: 500, overlapTokens: 80 },
    }, 201);
  } catch (error) {
    console.error("ingest failed", error);
    return json({ error: "Unable to ingest document" }, 500);
  }
}
