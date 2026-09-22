-- Preserve old rows/history, but never compare vectors from different models.
ALTER TABLE public.documents
  ALTER COLUMN embedding_model SET DEFAULT 'gemini-embedding-2';

COMMENT ON TABLE public.documents IS
  'Private RAG chunks. Gemini Embedding 2 at 1536 dimensions; AI called directly from edge functions.';

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
  WHERE d.embedding_model = 'gemini-embedding-2'
    AND 1 - (d.embedding <=> query_embedding) >= match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT GREATEST(1, LEAST(match_count, 20));
$$;

REVOKE ALL ON FUNCTION public.match_documents(vector, INTEGER, DOUBLE PRECISION)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents(vector, INTEGER, DOUBLE PRECISION)
  TO project_admin;
