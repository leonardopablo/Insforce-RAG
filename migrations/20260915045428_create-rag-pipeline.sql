CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE public.documents (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL CHECK (length(btrim(content)) > 0),
  source TEXT NOT NULL CHECK (length(btrim(source)) > 0),
  chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (chunk_index >= 0),
  embedding vector(1536) NOT NULL,
  embedding_model TEXT NOT NULL DEFAULT 'openai/text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.documents IS
  'RAG document chunks and their OpenRouter embeddings.';

COMMENT ON COLUMN public.documents.source IS
  'Stable source label supplied by the ingestion caller.';

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.documents FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.documents_id_seq FROM anon, authenticated;

CREATE INDEX documents_source_idx
  ON public.documents (source);

CREATE INDEX documents_embedding_hnsw_idx
  ON public.documents
  USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION public.match_documents(
  query_embedding vector(1536),
  match_count INTEGER DEFAULT 5,
  match_threshold DOUBLE PRECISION DEFAULT 0.0
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  source TEXT,
  chunk_index INTEGER,
  score DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT
    d.id,
    d.content,
    d.source,
    d.chunk_index,
    1 - (d.embedding <=> query_embedding) AS score
  FROM public.documents AS d
  WHERE 1 - (d.embedding <=> query_embedding) >= match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT GREATEST(1, LEAST(match_count, 20));
$$;

REVOKE ALL ON FUNCTION public.match_documents(vector, INTEGER, DOUBLE PRECISION)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.match_documents(vector, INTEGER, DOUBLE PRECISION)
  TO project_admin;
