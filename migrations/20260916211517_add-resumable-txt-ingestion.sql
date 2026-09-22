CREATE TABLE public.knowledge_documents (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 500),
  file_hash TEXT NOT NULL UNIQUE CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 10485760),
  total_blocks INTEGER NOT NULL CHECK (total_blocks BETWEEN 1 AND 200),
  expected_chunks INTEGER NOT NULL CHECK (expected_chunks BETWEEN 1 AND 20000),
  completed_blocks INTEGER NOT NULL DEFAULT 0 CHECK (completed_blocks >= 0),
  total_chunks INTEGER NOT NULL DEFAULT 0 CHECK (total_chunks >= 0),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  embedding_model TEXT NOT NULL DEFAULT 'gemini-embedding-2',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  CHECK (completed_blocks <= total_blocks)
);

CREATE TABLE public.document_ingestion_blocks (
  document_id BIGINT NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  block_index INTEGER NOT NULL CHECK (block_index >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^[0-9a-f]{64}$'),
  character_count INTEGER NOT NULL CHECK (character_count BETWEEN 1 AND 110000),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'complete', 'failed')),
  total_groups INTEGER NOT NULL CHECK (total_groups BETWEEN 1 AND 20),
  processed_groups INTEGER NOT NULL DEFAULT 0 CHECK (processed_groups >= 0),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, block_index),
  CHECK (processed_groups <= total_groups)
);

ALTER TABLE public.documents
  ADD COLUMN document_id BIGINT REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  ADD COLUMN block_index INTEGER CHECK (block_index >= 0);

CREATE UNIQUE INDEX documents_document_chunk_unique_idx
  ON public.documents (document_id, chunk_index)
  WHERE document_id IS NOT NULL;

CREATE INDEX documents_document_block_idx
  ON public.documents (document_id, block_index)
  WHERE document_id IS NOT NULL;

CREATE INDEX knowledge_documents_status_idx
  ON public.knowledge_documents (status, updated_at DESC);

ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_ingestion_blocks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.knowledge_documents, public.document_ingestion_blocks
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.knowledge_documents_id_seq
  FROM anon, authenticated;

COMMENT ON TABLE public.knowledge_documents IS
  'Idempotent TXT ingestion jobs identified by SHA-256 file hash.';
COMMENT ON TABLE public.document_ingestion_blocks IS
  'Persistent per-block progress for resumable TXT ingestion.';

CREATE OR REPLACE FUNCTION public.match_documents(
  query_embedding vector(1536),
  match_count INTEGER DEFAULT 5,
  match_threshold DOUBLE PRECISION DEFAULT 0.0
)
RETURNS TABLE (
  id BIGINT, content TEXT, source TEXT, chunk_index INTEGER, score DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.id, d.content, d.source, d.chunk_index,
    1 - (d.embedding <=> query_embedding) AS score
  FROM public.documents AS d
  LEFT JOIN public.knowledge_documents AS kd ON kd.id = d.document_id
  WHERE d.embedding_model = 'gemini-embedding-2'
    AND (d.document_id IS NULL OR kd.status = 'ready')
    AND 1 - (d.embedding <=> query_embedding) >= match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT GREATEST(1, LEAST(match_count, 20));
$$;

REVOKE ALL ON FUNCTION public.match_documents(vector, INTEGER, DOUBLE PRECISION)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents(vector, INTEGER, DOUBLE PRECISION)
  TO project_admin;
