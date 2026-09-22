import { createAdminClient } from "npm:@insforge/sdk@1.5.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-rag-api-key",
};
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

export default async function ingestComplete(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json(
      { code: "METHOD_NOT_ALLOWED", error: "Method not allowed" },
      405,
    );
  }
  try {
    if (req.headers.get("x-rag-api-key")?.trim() !== env("RAG_API_KEY")) {
      return json({ code: "UNAUTHORIZED", error: "Unauthorized" }, 401);
    }
    let body;
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "INVALID_JSON", "Envia un JSON valido.");
    }
    const documentId = Number(body?.documentId);
    const fileHash = typeof body?.fileHash === "string" ? body.fileHash.toLowerCase() : "";
    if (
      !Number.isSafeInteger(documentId) || documentId < 1 ||
      !/^[0-9a-f]{64}$/.test(fileHash)
    ) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        "Identificador de documento invalido.",
      );
    }
    const admin = createAdminClient({
      baseUrl: env("INSFORGE_BASE_URL"),
      apiKey: env("API_KEY"),
    });
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
    if (doc.status === "ready") {
      return json({
        documentId: doc.id,
        status: "ready",
        totalBlocks: doc.total_blocks,
        completedBlocks: doc.completed_blocks,
        totalChunks: doc.total_chunks,
      });
    }
    const { data: blocks, error: blockError } = await admin.database.from(
      "document_ingestion_blocks",
    ).select("block_index,status,chunk_count").eq("document_id", documentId);
    if (blockError) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "No se pudo comprobar el progreso.",
      );
    }
    const complete = (blocks ?? []).filter((block: any) => block.status === "complete");
    if (complete.length !== doc.total_blocks) {
      throw new ApiError(
        409,
        "DOCUMENT_INCOMPLETE",
        `Faltan ${doc.total_blocks - complete.length} bloques por procesar.`,
      );
    }
    const totalChunks = complete.reduce(
      (sum: number, block: any) => sum + Number(block.chunk_count),
      0,
    );
    const now = new Date().toISOString();
    const { error } = await admin.database.from("knowledge_documents").update({
      status: "ready",
      completed_blocks: doc.total_blocks,
      total_chunks: totalChunks,
      expected_chunks: totalChunks,
      last_error: null,
      updated_at: now,
      ready_at: now,
    }).eq("id", documentId);
    if (error) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "No se pudo finalizar el documento.",
      );
    }
    return json({
      documentId,
      status: "ready",
      totalBlocks: doc.total_blocks,
      completedBlocks: doc.total_blocks,
      totalChunks,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ code: error.code, error: error.message }, error.status);
    }
    console.error("ingest-complete: unexpected internal error");
    return json({
      code: "INTERNAL_ERROR",
      error: "Error interno al finalizar la ingesta.",
    }, 500);
  }
}
