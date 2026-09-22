import { createAdminClient } from "npm:@insforge/sdk@1.5.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-rag-api-key",
};
const MAX_FILE_BYTES = 10 * 1024 * 1024;
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
async function parse(req: Request) {
  if (Number(req.headers.get("content-length")) > 30_000) {
    throw new ApiError(413, "BODY_TOO_LARGE", "Solicitud demasiado grande.");
  }
  let body;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Envia un JSON valido.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_JSON", "Envia un objeto JSON.");
  }
  return body as Record<string, unknown>;
}
function present(row: any, completeIndexes: number[]) {
  return {
    id: row.id,
    source: row.source,
    fileHash: row.file_hash,
    fileSizeBytes: Number(row.file_size_bytes),
    totalBlocks: row.total_blocks,
    expectedChunks: row.expected_chunks,
    completedBlocks: row.completed_blocks,
    totalChunks: row.total_chunks,
    status: row.status,
    completeBlockIndexes: completeIndexes,
  };
}
async function currentState(admin: any, row: any) {
  const { data, error } = await admin.database.from("document_ingestion_blocks")
    .select("block_index").eq("document_id", row.id).eq("status", "complete");
  if (error) {
    throw new ApiError(
      500,
      "DATABASE_ERROR",
      "No se pudo recuperar el progreso.",
    );
  }
  return present(
    row,
    (data ?? []).map((item: any) => item.block_index).sort((
      a: number,
      b: number,
    ) => a - b),
  );
}

export default async function ingestStart(req: Request): Promise<Response> {
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
    const body = await parse(req);
    const source = typeof body.source === "string" ? body.source.trim() : "";
    const fileHash = typeof body.fileHash === "string" ? body.fileHash.toLowerCase() : "";
    const fileSizeBytes = Number(body.fileSizeBytes);
    const totalBlocks = Number(body.totalBlocks);
    const expectedChunks = Number(body.expectedChunks);
    if (
      !source || source.length > 500 || !/^[0-9a-f]{64}$/.test(fileHash) ||
      !Number.isInteger(fileSizeBytes) || fileSizeBytes < 1 ||
      fileSizeBytes > MAX_FILE_BYTES ||
      !Number.isInteger(totalBlocks) || totalBlocks < 1 || totalBlocks > 200 ||
      !Number.isInteger(expectedChunks) || expectedChunks < 1 ||
      expectedChunks > 20_000
    ) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        "Metadatos de archivo invalidos.",
      );
    }
    const admin = adminClient();
    const { data: found, error: findError } = await admin.database.from(
      "knowledge_documents",
    )
      .select("*").eq("file_hash", fileHash).limit(1);
    if (findError) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "No se pudo consultar el documento.",
      );
    }
    if (found?.length) {
      const row = found[0];
      if (
        Number(row.file_size_bytes) !== fileSizeBytes ||
        row.total_blocks !== totalBlocks
      ) {
        throw new ApiError(
          409,
          "HASH_CONFLICT",
          "El hash ya existe con metadatos diferentes.",
        );
      }
      return json({
        document: await currentState(admin, row),
        duplicate: row.status === "ready",
      });
    }
    const now = new Date().toISOString();
    const { data: inserted, error: insertError } = await admin.database.from(
      "knowledge_documents",
    ).insert([{
      source,
      file_hash: fileHash,
      file_size_bytes: fileSizeBytes,
      total_blocks: totalBlocks,
      expected_chunks: expectedChunks,
      status: "processing",
      updated_at: now,
    }]).select("*").single();
    if (insertError || !inserted) {
      // A concurrent identical start may win the unique constraint. Resolve it idempotently.
      const { data: raced } = await admin.database.from("knowledge_documents")
        .select("*").eq("file_hash", fileHash).limit(1);
      if (raced?.length) {
        return json({
          document: await currentState(admin, raced[0]),
          duplicate: raced[0].status === "ready",
        });
      }
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "No se pudo crear el documento.",
      );
    }
    return json({ document: present(inserted, []), duplicate: false }, 201);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ code: error.code, error: error.message }, error.status);
    }
    console.error("ingest-start: unexpected internal error");
    return json({
      code: "INTERNAL_ERROR",
      error: "Error interno al iniciar la ingesta.",
    }, 500);
  }
}
