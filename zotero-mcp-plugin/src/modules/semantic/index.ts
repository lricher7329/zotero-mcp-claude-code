/**
 * Semantic Search Module
 *
 * Exports all semantic search components for use in the Zotero MCP Plugin.
 */

// Core services
export {
  SemanticSearchService,
  getSemanticSearchService,
  resetSemanticSearchService,
  type SemanticSearchOptions,
  type SemanticSearchResult,
  type IndexProgress,
  type SemanticServiceStats,
} from "./semanticSearchService";

// Embedding service
export {
  EmbeddingService,
  getEmbeddingService,
  resetEmbeddingService,
  type EmbeddingResult,
  type BatchEmbeddingItem,
  type EmbeddingConfig,
  type EmbeddingServiceStatus,
} from "./embeddingService";

// Vector storage
export {
  VectorStore,
  getVectorStore,
  resetVectorStore,
  DimensionMismatchError,
  type VectorRecord,
  type QuantizedVector,
  type SearchResult,
  type IndexStatus,
  type VectorStoreStats,
} from "./vectorStore";

// Text processing
export {
  TextChunker,
  getTextChunker,
  type ChunkerOptions,
  type TextChunk,
} from "./textChunker";
