import { createAdminClient } from "npm:@insforge/sdk@1.5.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-rag-api-key",
};
const EMBEDDING_MODEL = "gemini-embedding-2";
const DIMENSIONS = 1536;
const EMBEDDING_GROUP_SIZE = 20;
const MAX_BLOCK_CHARS = 110_000;
const CHUNK_INDEX_STRIDE = 1000;
class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
function env(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new ApiError(
      503,
      `${name}_NOT_CONFIGURED`,
      `Falta configurar ${name}.`,
    );
  }
  return value;
}
function adminClient() {
  return createAdminClient({
    baseUrl: env("INSFORGE_BASE_URL"),
    apiKey: env("API_KEY"),
  });
}
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
async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function validEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === DIMENSIONS &&
    value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    value.some((n) => n !== 0);
}
async function embeddings(
  texts: string[],
  source: string,
): Promise<number[][]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env("GEMINI_API_KEY"),
        },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: `title: ${source} | text: ${text}` }] },
            embedContentConfig: {
              outputDimensionality: DIMENSIONS,
              autoTruncate: false,
            },
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
          "El modelo de embeddings ya no esta disponible.",
        );
      }
      if (response.status === 429) {
        throw new ApiError(
          429,
          "GEMINI_QUOTA_EXCEEDED",
          "Cuota de Gemini agotada. Espera al reinicio de la cuota.",
        );
      }
      if ([400, 401, 403].includes(response.status)) {
        throw new ApiError(
          502,
          "GEMINI_REQUEST_REJECTED",
          "Gemini rechazo la solicitud.",
        );
      }
      throw new ApiError(
        502,
        "GEMINI_UNAVAILABLE",
        "Gemini no esta disponible.",
      );
    }
    const data = await response.json();
    if (
      !Array.isArray(data.embeddings) ||
      data.embeddings.length !== texts.length ||
      !data.embeddings.every((item: any) => validEmbedding(item?.values))
    ) {
      throw new ApiError(
        502,
        "INVALID_EMBEDDINGS",
        "Gemini devolvio embeddings invalidos.",
      );
    }
    return data.embeddings.map((item: { values: number[] }) => item.values);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError(
        504,
        "GEMINI_TIMEOUT",
        "Gemini excedio el tiempo de espera.",
      );
    }
    throw new ApiError(
      502,
      "GEMINI_UNAVAILABLE",
      "No se pudo conectar con Gemini.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
async function syncProgress(admin: any, documentId: number | string) {
  const { data: blocks, error } = await admin.database.from(
    "document_ingestion_blocks",
  )
    .select("block_index,status,chunk_count").eq("document_id", documentId);
  if (error) {
    throw new ApiError(
      500,
      "DATABASE_ERROR",
      "No se pudo actualizar el progreso.",
    );
  }
  const completedBlocks = (blocks ?? []).filter((item: any) => item.status === "complete").length;
  const totalChunks = (blocks ?? []).reduce(
    (sum: number, item: any) => sum + Number(item.chunk_count),
    0,
  );
  const now = new Date().toISOString();
  const { error: updateError } = await admin.database.from(
    "knowledge_documents",
  ).update({
    status: "processing",
    completed_blocks: completedBlocks,
    total_chunks: totalChunks,
    last_error: null,
    updated_at: now,
  }).eq("id", documentId);
  if (updateError) {
    throw new ApiError(
      500,
      "DATABASE_ERROR",
      "No se pudo guardar el progreso.",
    );
  }
  return { completedBlocks, totalChunks };
}

export default async function ingestBlock(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json(
      { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" },
      405,
    );
  }
  let admin: any;
  let documentId: number | undefined;
  let blockIndex: number | undefined;
  try {
    if (req.headers.get("x-rag-api-key")?.trim() !== env("RAG_API_KEY")) {
      return json({ code: "UNAUTHORIZED", error: "Unauthorized" }, 401);
    }
    if (Number(req.headers.get("content-length")) > 700_000) {
      throw new ApiError(413, "BODY_TOO_LARGE", "Bloque demasiado grande.");
    }
    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "INVALID_JSON", "Envia un JSON valido.");
    }
    documentId = Number(body?.documentId);
    blockIndex = Number(body?.blockIndex);
    const fileHash = typeof body?.fileHash === "string" ? body.fileHash.toLowerCase() : "";
    const blockHash = typeof body?.blockHash === "string" ? body.blockHash.toLowerCase() : "";
    const text = typeof body?.text === "string" ? body.text : "";
    if (
      !Number.isSafeInteger(documentId) || documentId < 1 ||
      !Number.isInteger(blockIndex) || blockIndex < 0 ||
      !/^[0-9a-f]{64}$/.test(fileHash) || !/^[0-9a-f]{64}$/.test(blockHash) ||
      !text.trim() || text.length > MAX_BLOCK_CHARS
    ) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        "Bloque o identificadores invalidos.",
      );
    }
    if (await sha256(text) !== blockHash) {
      throw new ApiError(
        409,
        "BLOCK_HASH_MISMATCH",
        "El contenido del bloque no coincide con su hash.",
      );
    }
    admin = adminClient();
    const { data: docs, error: docError } = await admin.database.from(
      "knowledge_documents",
    ).select("*").eq("id", documentId).eq("file_hash", fileHash).limit(1);
    if (docError) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "No se pudo consultar el documento.",
      );
    }
    if (!docs?.length) {
      throw new ApiError(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
    }
    const doc = docs[0];
    if (blockIndex >= doc.total_blocks) {
      throw new ApiError(
        400,
        "INVALID_BLOCK_INDEX",
        "Indice de bloque fuera de rango.",
      );
    }
    if (doc.status === "ready") {
      return json({
        documentId,
        blockIndex,
        blockStatus: "complete",
        documentStatus: "ready",
        completedBlocks: doc.completed_blocks,
        totalBlocks: doc.total_blocks,
        totalChunks: doc.total_chunks,
        expectedChunks: doc.expected_chunks,
      });
    }
    const chunks = splitIntoChunks(text);
    if (!chunks.length || chunks.length >= CHUNK_INDEX_STRIDE) {
      throw new ApiError(
        400,
        "INVALID_BLOCK",
        "El bloque no produjo una cantidad valida de fragmentos.",
      );
    }
    const totalGroups = Math.ceil(chunks.length / EMBEDDING_GROUP_SIZE);
    const { data: priorBlocks, error: priorError } = await admin.database.from(
      "document_ingestion_blocks",
    ).select("*").eq("document_id", documentId).eq("block_index", blockIndex)
      .limit(1);
    if (priorError) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "No se pudo consultar el bloque.",
      );
    }
    const now = new Date().toISOString();
    if (priorBlocks?.length) {
      const prior = priorBlocks[0];
      if (
        prior.block_hash !== blockHash ||
        prior.character_count !== text.length ||
        prior.total_groups !== totalGroups
      ) {
        throw new ApiError(
          409,
          "BLOCK_CONFLICT",
          "El bloque ya existe con contenido diferente.",
        );
      }
      if (prior.status === "complete") {
        const progress = await syncProgress(admin, documentId);
        return json({
          documentId,
          blockIndex,
          blockStatus: "complete",
          documentStatus: "processing",
          totalBlocks: doc.total_blocks,
          expectedChunks: doc.expected_chunks,
          ...progress,
        });
      }
      await admin.database.from("document_ingestion_blocks").update({
        status: "processing",
        attempts: Number(prior.attempts) + 1,
        last_error: null,
        updated_at: now,
      }).eq("document_id", documentId).eq("block_index", blockIndex);
    } else {
      const { error } = await admin.database.from("document_ingestion_blocks")
        .insert([{
          document_id: documentId,
          block_index: blockIndex,
          block_hash: blockHash,
          character_count: text.length,
          status: "processing",
          total_groups: totalGroups,
          processed_groups: 0,
          chunk_count: 0,
          attempts: 1,
          updated_at: now,
        }]);
      if (error) {
        throw new ApiError(
          500,
          "DATABASE_ERROR",
          "No se pudo crear el bloque.",
        );
      }
    }
    const { data: existingRows, error: existingError } = await admin.database
      .from("documents").select("chunk_index").eq("document_id", documentId).eq(
        "block_index",
        blockIndex,
      );
    if (existingError) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "No se pudo recuperar el progreso del bloque.",
      );
    }
    const existing = new Set<number>(
      (existingRows ?? []).map((row: any) => Number(row.chunk_index)),
    );
    for (let groupIndex = 0; groupIndex < totalGroups; groupIndex++) {
      const from = groupIndex * EMBEDDING_GROUP_SIZE;
      const to = Math.min(from + EMBEDDING_GROUP_SIZE, chunks.length);
      const missing: { localIndex: number; content: string }[] = [];
      for (let localIndex = from; localIndex < to; localIndex++) {
        const globalIndex = blockIndex * CHUNK_INDEX_STRIDE + localIndex;
        if (!existing.has(globalIndex)) {
          missing.push({ localIndex, content: chunks[localIndex] });
        }
      }
      if (missing.length) {
        const vectors = await embeddings(
          missing.map((item) => item.content),
          doc.source,
        );
        const { error } = await admin.database.from("documents").insert(
          missing.map((item, index) => ({
            content: item.content,
            source: doc.source,
            document_id: documentId,
            block_index: blockIndex,
            chunk_index: blockIndex! * CHUNK_INDEX_STRIDE + item.localIndex,
            embedding: vectors[index],
            embedding_model: EMBEDDING_MODEL,
          })),
        );
        if (error) {
          throw new ApiError(
            500,
            "DATABASE_ERROR",
            "No se pudieron guardar los fragmentos.",
          );
        }
        missing.forEach((item) => existing.add(blockIndex! * CHUNK_INDEX_STRIDE + item.localIndex));
      }
      const chunkCount = [...existing].filter((index) =>
        Math.floor(index / CHUNK_INDEX_STRIDE) === blockIndex
      ).length;
      const { error } = await admin.database.from("document_ingestion_blocks")
        .update({
          processed_groups: groupIndex + 1,
          chunk_count: chunkCount,
          updated_at: new Date().toISOString(),
        }).eq("document_id", documentId).eq("block_index", blockIndex);
      if (error) {
        throw new ApiError(
          500,
          "DATABASE_ERROR",
          "No se pudo guardar el progreso del grupo.",
        );
      }
      await syncProgress(admin, documentId);
    }
    const { error: finishError } = await admin.database.from(
      "document_ingestion_blocks",
    ).update({
      status: "complete",
      processed_groups: totalGroups,
      chunk_count: chunks.length,
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("document_id", documentId).eq("block_index", blockIndex);
    if (finishError) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "No se pudo confirmar el bloque.",
      );
    }
    const progress = await syncProgress(admin, documentId);
    return json({
      documentId,
      blockIndex,
      blockStatus: "complete",
      documentStatus: "processing",
      totalBlocks: doc.total_blocks,
      expectedChunks: doc.expected_chunks,
      ...progress,
    });
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError(
      500,
      "INTERNAL_ERROR",
      "Error interno al procesar el bloque.",
    );
    if (!(error instanceof ApiError)) {
      console.error("ingest-block: unexpected internal error");
    }
    if (admin && documentId && blockIndex !== undefined) {
      const now = new Date().toISOString();
      try {
        await admin.database.from("document_ingestion_blocks").update({
          status: "failed",
          last_error: apiError.code,
          updated_at: now,
        }).eq("document_id", documentId).eq("block_index", blockIndex);
        await admin.database.from("knowledge_documents").update({
          status: "processing",
          last_error: apiError.code,
          updated_at: now,
        }).eq("id", documentId);
      } catch {
        /* Best-effort diagnostic state; original safe error is returned. */
      }
    }
    return json(
      { code: apiError.code, error: apiError.message, blockIndex },
      apiError.status,
    );
  }
}
