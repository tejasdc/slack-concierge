/** The Cloudflare Worker and Concierge must agree before a vector enters an index. */
export const WORKERS_AI_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const WORKERS_AI_EMBEDDING_DIMENSIONS = 1024;
/** Cloudflare's input schema for this model accepts at most 32 texts per call. */
export const WORKERS_AI_EMBEDDING_MAX_TEXTS = 32;
/**
 * Qwen3-Embedding's documented prompt format: an instruction on queries, nothing on documents.
 * Part of what the model's vectors mean, so changing it requires a new index file, as changing the model does.
 */
export const WORKERS_AI_EMBEDDING_QUERY_PREFIX = "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ";
export const WORKERS_AI_EMBEDDING_DOCUMENT_PREFIX = "";
