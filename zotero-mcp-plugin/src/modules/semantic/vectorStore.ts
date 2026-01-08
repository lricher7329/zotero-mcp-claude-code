/**
 * Vector Store for Semantic Search
 *
 * SQLite-based vector storage using Zotero's database infrastructure.
 * Stores embeddings as BLOBs and performs similarity search in memory.
 */

declare let Zotero: any;
declare let ztoolkit: ZToolkit;
declare let PathUtils: any;

export interface VectorRecord {
  itemKey: string;
  chunkId: number;
  vector: Float32Array;
  language: 'zh' | 'en';
  chunkText: string;
  metadata?: Record<string, any>;
}

export interface SearchResult {
  itemKey: string;
  chunkId: number;
  score: number;
  chunkText: string;
  language: string;
}

export interface IndexStatus {
  itemKey: string;
  indexedAt: number;
  chunkCount: number;
  contentHash: string;
  version: number;
  itemModified?: string;       // Item's dateModified for fast change detection
  attachmentModified?: string; // Latest attachment dateModified
}

export interface VectorStoreStats {
  totalVectors: number;
  totalItems: number;
  zhVectors: number;
  enVectors: number;
  dbSizeBytes?: number;
  // Content cache stats
  cachedContentItems: number;
  cachedContentSizeBytes: number;
}

// Global instance counter for debugging
let vectorStoreInstanceCounter = 0;

export class VectorStore {
  private dbPath: string = '';
  private db: any = null;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  // In-memory cache for frequently accessed vectors
  private vectorCache: Map<string, Float32Array> = new Map();
  private cacheMaxSize: number = 1000;

  // Debug: instance ID for tracking multiple instances
  private instanceId: number;

  constructor() {
    this.instanceId = ++vectorStoreInstanceCounter;
    ztoolkit.log(`[VectorStore] Constructor called, instanceId=${this.instanceId}, total instances=${vectorStoreInstanceCounter}`);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    try {
      // Get Zotero data directory
      const dataDir = Zotero.DataDirectory.dir;
      this.dbPath = PathUtils.join(dataDir, 'zotero-mcp-vectors.sqlite');

      ztoolkit.log(`[VectorStore] Initializing database: instanceId=${this.instanceId}, dbPath=${this.dbPath}`);

      // Create database connection
      this.db = new Zotero.DBConnection(this.dbPath);

      // Create tables
      await this.createTables();

      this.initialized = true;
      ztoolkit.log('[VectorStore] Initialized successfully');
    } catch (error) {
      ztoolkit.log(`[VectorStore] Initialization failed: ${error}`, 'error');
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    // Embeddings table
    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_key TEXT NOT NULL,
        chunk_id INTEGER NOT NULL,
        vector BLOB NOT NULL,
        language TEXT NOT NULL CHECK(language IN ('zh', 'en')),
        chunk_text TEXT,
        dimensions INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(item_key, chunk_id)
      )
    `);

    // Index for faster lookups
    await this.db.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_item_key
      ON embeddings(item_key)
    `);

    await this.db.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_language
      ON embeddings(language)
    `);

    // Index status table - tracks indexing state and timestamps for change detection
    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS index_status (
        item_key TEXT PRIMARY KEY,
        indexed_at INTEGER NOT NULL,
        version INTEGER DEFAULT 1,
        chunk_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        item_modified TEXT,
        attachment_modified TEXT
      )
    `);

    // Migrate existing tables - add new columns if they don't exist
    try {
      await this.db.queryAsync(`ALTER TABLE index_status ADD COLUMN item_modified TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }
    try {
      await this.db.queryAsync(`ALTER TABLE index_status ADD COLUMN attachment_modified TEXT`);
    } catch (e) {
      // Column already exists, ignore
    }

    // Content cache table - stores extracted PDF content to avoid re-extraction
    await this.db.queryAsync(`
      CREATE TABLE IF NOT EXISTS content_cache (
        item_key TEXT PRIMARY KEY,
        full_content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        cached_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    ztoolkit.log('[VectorStore] Tables created/verified');
  }

  /**
   * Insert a single vector
   */
  async insertVector(record: VectorRecord): Promise<void> {
    await this.ensureInitialized();

    ztoolkit.log(`[VectorStore] insertVector: ${record.itemKey}_${record.chunkId}, dims=${record.vector.length}, lang=${record.language}`);

    const vectorBlob = this.float32ArrayToBuffer(record.vector);

    await this.db.queryAsync(`
      INSERT OR REPLACE INTO embeddings
      (item_key, chunk_id, vector, language, chunk_text, dimensions)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      record.itemKey,
      record.chunkId,
      vectorBlob,
      record.language,
      record.chunkText || '',
      record.vector.length
    ]);

    // Update cache
    const cacheKey = `${record.itemKey}_${record.chunkId}`;
    this.updateCache(cacheKey, record.vector);
  }

  /**
   * Insert multiple vectors in a transaction
   */
  async insertVectorsBatch(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    await this.ensureInitialized();

    await this.db.executeTransaction(async () => {
      for (const record of records) {
        const vectorBlob = this.float32ArrayToBuffer(record.vector);

        await this.db.queryAsync(`
          INSERT OR REPLACE INTO embeddings
          (item_key, chunk_id, vector, language, chunk_text, dimensions)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          record.itemKey,
          record.chunkId,
          vectorBlob,
          record.language,
          record.chunkText || '',
          record.vector.length
        ]);
      }
    });

    ztoolkit.log(`[VectorStore] Inserted ${records.length} vectors`);
  }

  /**
   * Search for similar vectors
   */
  async search(
    queryVector: Float32Array,
    options: {
      topK?: number;
      language?: 'zh' | 'en' | 'all';
      itemKeys?: string[];
      minScore?: number;
    } = {}
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const { topK = 10, language = 'all', itemKeys, minScore = 0 } = options;
    const startTime = Date.now();

    ztoolkit.log(`[VectorStore] search() start: instanceId=${this.instanceId}, dbPath=${this.dbPath}, topK=${topK}, lang=${language}, minScore=${minScore}, queryDims=${queryVector.length}`);

    // Build query conditions
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (language !== 'all') {
      conditions.push('language = ?');
      params.push(language);
    }

    if (itemKeys && itemKeys.length > 0) {
      const placeholders = itemKeys.map(() => '?').join(',');
      conditions.push(`item_key IN (${placeholders})`);
      params.push(...itemKeys);
    }

    // Use batch processing to avoid memory issues with large datasets
    // IMPORTANT: SQL queries must be single-line (multi-line causes queryAsync to return undefined in Zotero)
    const BATCH_SIZE = 5000;
    const results: SearchResult[] = [];
    let offset = 0;
    let totalScanned = 0;
    let batchCount = 0;

    // Get total count first
    const whereClause = conditions.join(' AND ');
    const totalCount = await this.db.valueQueryAsync(`SELECT COUNT(*) FROM embeddings WHERE ${whereClause}`, params);
    ztoolkit.log(`[VectorStore] search() total vectors matching conditions: ${totalCount}`);

    if (!totalCount || totalCount === 0) {
      ztoolkit.log(`[VectorStore] search() no vectors found`);
      return [];
    }

    // Pre-normalize query vector for faster comparisons
    const { normalized: normalizedQuery, norm: queryNorm } = this.prepareQueryVector(queryVector);
    if (queryNorm === 0) {
      ztoolkit.log(`[VectorStore] search() query vector has zero norm, returning empty results`);
      return [];
    }

    // Process in batches
    while (offset < totalCount) {
      batchCount++;
      const batchParams = [...params, BATCH_SIZE, offset];

      // IMPORTANT: Single-line query to avoid Zotero queryAsync bug
      const rows = await this.db.queryAsync(`SELECT item_key, chunk_id, vector, language, chunk_text, dimensions FROM embeddings WHERE ${whereClause} LIMIT ? OFFSET ?`, batchParams);

      if (!rows || rows.length === 0) {
        ztoolkit.log(`[VectorStore] search() batch ${batchCount} returned no rows at offset ${offset}`);
        break;
      }

      // Process this batch
      for (const row of rows) {
        try {
          const storedVector = this.bufferToFloat32Array(row.vector, row.dimensions);
          // Use optimized similarity: compute dot product with normalized query, then divide by stored vector norm
          const score = this.cosineSimilarityWithNormalizedQuery(normalizedQuery, storedVector);
          totalScanned++;

          if (score >= minScore) {
            results.push({
              itemKey: row.item_key,
              chunkId: row.chunk_id,
              score,
              chunkText: row.chunk_text,
              language: row.language
            });

            // Keep results sorted and limited to avoid memory growth
            if (results.length > topK * 2) {
              results.sort((a, b) => b.score - a.score);
              results.length = topK;
            }
          }
        } catch (e) {
          // Skip invalid vectors
        }
      }

      offset += rows.length;

      // Log progress for large datasets
      if (batchCount % 10 === 0) {
        ztoolkit.log(`[VectorStore] search() progress: ${offset}/${totalCount} vectors scanned, ${results.length} candidates found`);
      }
    }

    // Final sort and limit
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, topK);

    const searchTime = Date.now() - startTime;
    const topScores = topResults.slice(0, 5).map(r => r.score.toFixed(3)).join(', ');
    ztoolkit.log(`[VectorStore] search() completed in ${searchTime}ms: ${totalScanned} vectors scanned in ${batchCount} batches, ${results.length} passed minScore, returning ${topResults.length}`);
    if (topResults.length > 0) {
      ztoolkit.log(`[VectorStore] search() top scores: [${topScores}]`);
    }

    return topResults;
  }

  /**
   * Get all indexed item keys
   */
  async getIndexedItems(): Promise<Set<string>> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key FROM index_status`);

    // Zotero's queryAsync returns undefined when no rows found
    if (!rows || rows.length === 0) {
      return new Set();
    }

    return new Set(rows.map((r: any) => r.item_key));
  }

  /**
   * Get index status for an item
   */
  async getIndexStatus(itemKey: string): Promise<IndexStatus | null> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key, indexed_at, version, chunk_count, content_hash, item_modified, attachment_modified FROM index_status WHERE item_key = ?`, [itemKey]);

    // Zotero's queryAsync returns undefined when no rows found
    if (!rows || rows.length === 0) return null;

    const row = rows[0];
    return {
      itemKey: row.item_key,
      indexedAt: row.indexed_at,
      chunkCount: row.chunk_count,
      contentHash: row.content_hash,
      version: row.version,
      itemModified: row.item_modified,
      attachmentModified: row.attachment_modified
    };
  }

  /**
   * Update index status for an item (with optional timestamps)
   */
  async updateIndexStatus(
    itemKey: string,
    chunkCount: number,
    contentHash: string,
    itemModified?: string,
    attachmentModified?: string
  ): Promise<void> {
    await this.ensureInitialized();

    await this.db.queryAsync(`
      INSERT OR REPLACE INTO index_status
      (item_key, indexed_at, version, chunk_count, content_hash, item_modified, attachment_modified)
      VALUES (?, strftime('%s', 'now'), 1, ?, ?, ?, ?)
    `, [itemKey, chunkCount, contentHash, itemModified || null, attachmentModified || null]);
  }

  /**
   * Check if item needs re-indexing by timestamp (fast check, no content extraction needed)
   * Returns: true if needs reindex, false if timestamps unchanged
   */
  async needsReindexByTimestamp(
    itemKey: string,
    itemModified: string,
    attachmentModified: string
  ): Promise<boolean> {
    const status = await this.getIndexStatus(itemKey);

    // No existing index, needs indexing
    if (!status) return true;

    // No stored timestamps (old data), needs re-check with content hash
    if (!status.itemModified || !status.attachmentModified) return true;

    // Compare timestamps
    if (status.itemModified !== itemModified) return true;
    if (status.attachmentModified !== attachmentModified) return true;

    // Timestamps unchanged, no need to reindex
    return false;
  }

  /**
   * Check if item needs re-indexing by content hash
   */
  async needsReindex(itemKey: string, contentHash: string): Promise<boolean> {
    const status = await this.getIndexStatus(itemKey);
    if (!status) return true;
    return status.contentHash !== contentHash;
  }

  // ============ Content Cache Methods ============

  /**
   * Get cached content for an item
   * Returns null if not cached or hash doesn't match
   */
  async getCachedContent(itemKey: string): Promise<{ content: string; hash: string } | null> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT full_content, content_hash FROM content_cache WHERE item_key = ?`, [itemKey]);

    if (!rows || rows.length === 0) return null;

    return {
      content: rows[0].full_content,
      hash: rows[0].content_hash
    };
  }

  /**
   * Set cached content for an item
   */
  async setCachedContent(itemKey: string, content: string, contentHash: string): Promise<void> {
    await this.ensureInitialized();

    await this.db.queryAsync(`
      INSERT OR REPLACE INTO content_cache (item_key, full_content, content_hash, cached_at)
      VALUES (?, ?, ?, strftime('%s', 'now'))
    `, [itemKey, content, contentHash]);
  }

  /**
   * Delete cached content for an item
   */
  async deleteCachedContent(itemKey: string): Promise<void> {
    await this.ensureInitialized();

    await this.db.queryAsync(`DELETE FROM content_cache WHERE item_key = ?`, [itemKey]);
  }

  /**
   * Get all cached content item keys with metadata
   */
  async listCachedContent(): Promise<Array<{
    itemKey: string;
    contentLength: number;
    hash: string;
    cachedAt: number;
  }>> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key, LENGTH(full_content) as content_length, content_hash, cached_at FROM content_cache ORDER BY cached_at DESC`);

    if (!rows || rows.length === 0) return [];

    return rows.map((row: any) => ({
      itemKey: row.item_key,
      contentLength: row.content_length,
      hash: row.content_hash,
      cachedAt: row.cached_at
    }));
  }

  /**
   * Full-text search within cached content
   * Returns items whose content contains the search term
   */
  async searchCachedContent(
    searchTerm: string,
    options: { limit?: number; caseSensitive?: boolean } = {}
  ): Promise<Array<{
    itemKey: string;
    snippet: string;
    matchCount: number;
  }>> {
    await this.ensureInitialized();

    const { limit = 20, caseSensitive = false } = options;

    // SQLite LIKE is case-insensitive by default for ASCII
    const searchPattern = `%${searchTerm}%`;

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key, full_content FROM content_cache WHERE full_content LIKE ? LIMIT ?`, [searchPattern, limit * 2]); // Fetch more to account for filtering

    if (!rows || rows.length === 0) return [];

    const results: Array<{ itemKey: string; snippet: string; matchCount: number }> = [];

    for (const row of rows) {
      const content: string = row.full_content;
      const searchStr = caseSensitive ? searchTerm : searchTerm.toLowerCase();
      const contentToSearch = caseSensitive ? content : content.toLowerCase();

      // Count matches
      let matchCount = 0;
      let pos = 0;
      while ((pos = contentToSearch.indexOf(searchStr, pos)) !== -1) {
        matchCount++;
        pos += searchStr.length;
      }

      if (matchCount > 0) {
        // Extract snippet around first match
        const firstMatch = contentToSearch.indexOf(searchStr);
        const snippetStart = Math.max(0, firstMatch - 100);
        const snippetEnd = Math.min(content.length, firstMatch + searchTerm.length + 100);
        let snippet = content.substring(snippetStart, snippetEnd);
        if (snippetStart > 0) snippet = '...' + snippet;
        if (snippetEnd < content.length) snippet = snippet + '...';

        results.push({
          itemKey: row.item_key,
          snippet,
          matchCount
        });
      }

      if (results.length >= limit) break;
    }

    // Sort by match count descending
    results.sort((a, b) => b.matchCount - a.matchCount);

    return results;
  }

  /**
   * Get full cached content for an item (alias for getCachedContent for clarity)
   */
  async getFullContent(itemKey: string): Promise<string | null> {
    const cached = await this.getCachedContent(itemKey);
    return cached ? cached.content : null;
  }

  /**
   * Get full cached content for multiple items
   */
  async getFullContentBatch(itemKeys: string[]): Promise<Map<string, string>> {
    await this.ensureInitialized();

    const result = new Map<string, string>();
    if (itemKeys.length === 0) return result;

    const placeholders = itemKeys.map(() => '?').join(',');
    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key, full_content FROM content_cache WHERE item_key IN (${placeholders})`, itemKeys);

    if (!rows || rows.length === 0) return result;

    for (const row of rows) {
      result.set(row.item_key, row.full_content);
    }

    return result;
  }

  /**
   * Delete vectors for an item (preserves content cache for full-text database)
   */
  async deleteItemVectors(itemKey: string): Promise<void> {
    await this.ensureInitialized();

    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(
        `DELETE FROM embeddings WHERE item_key = ?`,
        [itemKey]
      );
      await this.db.queryAsync(
        `DELETE FROM index_status WHERE item_key = ?`,
        [itemKey]
      );
      // Note: content_cache is NOT deleted - it serves as permanent full-text database
    });

    // Clear cache entries
    for (const key of this.vectorCache.keys()) {
      if (key.startsWith(`${itemKey}_`)) {
        this.vectorCache.delete(key);
      }
    }

    ztoolkit.log(`[VectorStore] Deleted vectors for item: ${itemKey} (content cache preserved)`);
  }

  /**
   * Clear all vectors and index status (preserves content cache)
   * Use this for re-indexing while keeping extracted content
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();

    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(`DELETE FROM embeddings`);
      await this.db.queryAsync(`DELETE FROM index_status`);
      // Note: content_cache is preserved as full-text database
    });

    this.vectorCache.clear();
    ztoolkit.log('[VectorStore] Vectors cleared (content cache preserved)');
  }

  /**
   * Clear everything including content cache
   * Use this for complete reset
   */
  async clearAll(): Promise<void> {
    await this.ensureInitialized();

    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(`DELETE FROM embeddings`);
      await this.db.queryAsync(`DELETE FROM index_status`);
      await this.db.queryAsync(`DELETE FROM content_cache`);
    });

    this.vectorCache.clear();
    ztoolkit.log('[VectorStore] All data cleared including content cache');
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<VectorStoreStats> {
    await this.ensureInitialized();

    ztoolkit.log(`[VectorStore] getStats() called: instanceId=${this.instanceId}, dbPath=${this.dbPath}`);

    const total = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings`
    );
    const items = await this.db.valueQueryAsync(
      `SELECT COUNT(DISTINCT item_key) FROM embeddings`
    );
    const zh = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings WHERE language = 'zh'`
    );
    const en = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM embeddings WHERE language = 'en'`
    );

    // Content cache stats
    const cachedItems = await this.db.valueQueryAsync(
      `SELECT COUNT(*) FROM content_cache`
    );
    const cachedSize = await this.db.valueQueryAsync(
      `SELECT COALESCE(SUM(LENGTH(full_content)), 0) FROM content_cache`
    );

    return {
      totalVectors: total || 0,
      totalItems: items || 0,
      zhVectors: zh || 0,
      enVectors: en || 0,
      cachedContentItems: cachedItems || 0,
      cachedContentSizeBytes: cachedSize || 0
    };
  }

  /**
   * Get vectors for a specific item (for find_similar)
   */
  async getItemVectors(itemKey: string): Promise<Array<{
    chunkId: number;
    vector: Float32Array;
    language: string;
  }>> {
    await this.ensureInitialized();

    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT chunk_id, vector, language, dimensions FROM embeddings WHERE item_key = ? ORDER BY chunk_id`, [itemKey]);

    // Zotero's queryAsync returns undefined when no rows found
    if (!rows || rows.length === 0) {
      return [];
    }

    return rows.map((row: any) => ({
      chunkId: row.chunk_id,
      vector: this.bufferToFloat32Array(row.vector, row.dimensions),
      language: row.language
    }));
  }

  /**
   * Get chunk texts for items (without vectors, for filling keyword search results)
   */
  async getItemChunks(itemKeys: string[]): Promise<Map<string, Array<{
    chunkId: number;
    text: string;
    language: string;
  }>>> {
    await this.ensureInitialized();

    const result = new Map<string, Array<{ chunkId: number; text: string; language: string }>>();

    if (itemKeys.length === 0) return result;

    const placeholders = itemKeys.map(() => '?').join(',');
    // IMPORTANT: Single-line query to avoid Zotero queryAsync bug with multi-line SQL
    const rows = await this.db.queryAsync(`SELECT item_key, chunk_id, chunk_text, language FROM embeddings WHERE item_key IN (${placeholders}) ORDER BY item_key, chunk_id`, itemKeys);

    if (!rows || rows.length === 0) {
      return result;
    }

    for (const row of rows) {
      const chunks = result.get(row.item_key) || [];
      chunks.push({
        chunkId: row.chunk_id,
        text: row.chunk_text || '',
        language: row.language
      });
      result.set(row.item_key, chunks);
    }

    return result;
  }

  // ============ Utility Methods ============

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Convert Float32Array to buffer for storage
   */
  private float32ArrayToBuffer(arr: Float32Array): Uint8Array {
    return new Uint8Array(arr.buffer.slice(
      arr.byteOffset,
      arr.byteOffset + arr.byteLength
    ));
  }

  /**
   * Convert buffer back to Float32Array
   */
  private bufferToFloat32Array(buffer: any, dimensions: number): Float32Array {
    // Handle different buffer formats from SQLite
    let uint8Array: Uint8Array;

    if (buffer instanceof Uint8Array) {
      uint8Array = buffer;
    } else if (buffer instanceof ArrayBuffer) {
      uint8Array = new Uint8Array(buffer);
    } else if (typeof buffer === 'object' && buffer.buffer) {
      uint8Array = new Uint8Array(buffer.buffer);
    } else {
      // Try to convert from array-like object
      uint8Array = new Uint8Array(buffer);
    }

    // Create properly aligned Float32Array
    const alignedBuffer = new ArrayBuffer(dimensions * 4);
    const alignedView = new Uint8Array(alignedBuffer);
    alignedView.set(uint8Array.slice(0, dimensions * 4));

    return new Float32Array(alignedBuffer);
  }

  // ============ Int8 Quantization Methods ============

  /**
   * Quantize Float32Array to Int8Array with scale factor
   * Uses symmetric quantization: int8_val = round(float_val * scale)
   * Scale is chosen so that max(|float_val|) maps to 127
   * @returns { quantized: Int8Array, scale: number }
   */
  private quantizeToInt8(vector: Float32Array): { quantized: Int8Array; scale: number } {
    const len = vector.length;

    // Find max absolute value for scaling
    let maxAbs = 0;
    for (let i = 0; i < len; i++) {
      const abs = Math.abs(vector[i]);
      if (abs > maxAbs) maxAbs = abs;
    }

    // Compute scale factor (avoid division by zero)
    const scale = maxAbs > 0 ? 127 / maxAbs : 1;

    // Quantize
    const quantized = new Int8Array(len);
    for (let i = 0; i < len; i++) {
      quantized[i] = Math.round(vector[i] * scale);
    }

    return { quantized, scale };
  }

  /**
   * Dequantize Int8Array back to Float32Array
   */
  private dequantizeFromInt8(quantized: Int8Array, scale: number): Float32Array {
    const len = quantized.length;
    const vector = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      vector[i] = quantized[i] / scale;
    }

    return vector;
  }

  /**
   * Fast cosine similarity using Int8 quantized vectors
   * Uses integer arithmetic for dot product, then converts to float for final result
   * ~4x faster than float comparison with ~99% accuracy
   * Note: Scale factors are not used in cosine similarity as they cancel out
   */
  private cosineSimilarityInt8(
    queryInt8: Int8Array,
    _queryScale: number,
    storedInt8: Int8Array,
    _storedScale: number
  ): number {
    const len = queryInt8.length;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Loop unrolling for integer arithmetic
    const unrollEnd = len - (len % 8);
    let i = 0;

    for (; i < unrollEnd; i += 8) {
      const a0 = queryInt8[i], a1 = queryInt8[i+1], a2 = queryInt8[i+2], a3 = queryInt8[i+3];
      const a4 = queryInt8[i+4], a5 = queryInt8[i+5], a6 = queryInt8[i+6], a7 = queryInt8[i+7];
      const b0 = storedInt8[i], b1 = storedInt8[i+1], b2 = storedInt8[i+2], b3 = storedInt8[i+3];
      const b4 = storedInt8[i+4], b5 = storedInt8[i+5], b6 = storedInt8[i+6], b7 = storedInt8[i+7];

      dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3 + a4*b4 + a5*b5 + a6*b6 + a7*b7;
      normA += a0*a0 + a1*a1 + a2*a2 + a3*a3 + a4*a4 + a5*a5 + a6*a6 + a7*a7;
      normB += b0*b0 + b1*b1 + b2*b2 + b3*b3 + b4*b4 + b5*b5 + b6*b6 + b7*b7;
    }

    // Handle remaining elements
    for (; i < len; i++) {
      dotProduct += queryInt8[i] * storedInt8[i];
      normA += queryInt8[i] * queryInt8[i];
      normB += storedInt8[i] * storedInt8[i];
    }

    // Convert to float and compute final similarity
    // The scale factors cancel out in cosine similarity
    const magnitude = Math.sqrt(normA * normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Convert Float32Array to Int8Array buffer for storage (with scale prepended)
   * Format: [scale as Float32 (4 bytes)] + [Int8 values (n bytes)]
   */
  private float32ArrayToInt8Buffer(arr: Float32Array): Uint8Array {
    const { quantized, scale } = this.quantizeToInt8(arr);

    // Create buffer: 4 bytes for scale + n bytes for Int8 values
    const buffer = new Uint8Array(4 + quantized.length);

    // Write scale as Float32 at the beginning
    const scaleView = new DataView(buffer.buffer);
    scaleView.setFloat32(0, scale, true); // little-endian

    // Copy Int8 values
    buffer.set(new Uint8Array(quantized.buffer), 4);

    return buffer;
  }

  /**
   * Convert Int8 buffer back to Float32Array
   */
  private int8BufferToFloat32Array(buffer: Uint8Array, dimensions: number): Float32Array {
    // Read scale from first 4 bytes
    const scaleView = new DataView(buffer.buffer, buffer.byteOffset, 4);
    const scale = scaleView.getFloat32(0, true);

    // Read Int8 values
    const quantized = new Int8Array(buffer.buffer, buffer.byteOffset + 4, dimensions);

    return this.dequantizeFromInt8(quantized, scale);
  }

  /**
   * Calculate cosine similarity between two vectors
   * Optimized version with loop unrolling for better performance
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    const len = a.length;
    if (len !== b.length) {
      throw new Error(`Vector dimension mismatch: ${len} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Loop unrolling: process 8 elements at a time for better CPU pipelining
    const unrollEnd = len - (len % 8);
    let i = 0;

    for (; i < unrollEnd; i += 8) {
      const a0 = a[i], a1 = a[i+1], a2 = a[i+2], a3 = a[i+3];
      const a4 = a[i+4], a5 = a[i+5], a6 = a[i+6], a7 = a[i+7];
      const b0 = b[i], b1 = b[i+1], b2 = b[i+2], b3 = b[i+3];
      const b4 = b[i+4], b5 = b[i+5], b6 = b[i+6], b7 = b[i+7];

      dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3 + a4*b4 + a5*b5 + a6*b6 + a7*b7;
      normA += a0*a0 + a1*a1 + a2*a2 + a3*a3 + a4*a4 + a5*a5 + a6*a6 + a7*a7;
      normB += b0*b0 + b1*b1 + b2*b2 + b3*b3 + b4*b4 + b5*b5 + b6*b6 + b7*b7;
    }

    // Handle remaining elements
    for (; i < len; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA * normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Cosine similarity with pre-normalized query vector
   * Only computes norm for the stored vector, saving ~33% computation
   * @param normalizedQuery - Pre-normalized query vector (norm = 1)
   * @param storedVector - Stored vector (may not be normalized)
   */
  private cosineSimilarityWithNormalizedQuery(normalizedQuery: Float32Array, storedVector: Float32Array): number {
    const len = normalizedQuery.length;
    let dotProduct = 0;
    let normB = 0;

    // Loop unrolling: process 8 elements at a time
    const unrollEnd = len - (len % 8);
    let i = 0;

    for (; i < unrollEnd; i += 8) {
      const a0 = normalizedQuery[i], a1 = normalizedQuery[i+1], a2 = normalizedQuery[i+2], a3 = normalizedQuery[i+3];
      const a4 = normalizedQuery[i+4], a5 = normalizedQuery[i+5], a6 = normalizedQuery[i+6], a7 = normalizedQuery[i+7];
      const b0 = storedVector[i], b1 = storedVector[i+1], b2 = storedVector[i+2], b3 = storedVector[i+3];
      const b4 = storedVector[i+4], b5 = storedVector[i+5], b6 = storedVector[i+6], b7 = storedVector[i+7];

      dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3 + a4*b4 + a5*b5 + a6*b6 + a7*b7;
      normB += b0*b0 + b1*b1 + b2*b2 + b3*b3 + b4*b4 + b5*b5 + b6*b6 + b7*b7;
    }

    // Handle remaining elements
    for (; i < len; i++) {
      dotProduct += normalizedQuery[i] * storedVector[i];
      normB += storedVector[i] * storedVector[i];
    }

    const magnitude = Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Pre-compute query vector norm for batch comparisons
   * Returns: { normalizedQuery, queryNorm }
   */
  private prepareQueryVector(queryVector: Float32Array): { normalized: Float32Array; norm: number } {
    const len = queryVector.length;
    let normSq = 0;

    for (let i = 0; i < len; i++) {
      normSq += queryVector[i] * queryVector[i];
    }

    const norm = Math.sqrt(normSq);
    if (norm === 0) {
      return { normalized: queryVector, norm: 0 };
    }

    // Normalize the query vector
    const normalized = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      normalized[i] = queryVector[i] / norm;
    }

    return { normalized, norm };
  }

  /**
   * Update LRU cache
   */
  private updateCache(key: string, vector: Float32Array): void {
    // Simple LRU: remove oldest when cache is full
    if (this.vectorCache.size >= this.cacheMaxSize) {
      const firstKey = this.vectorCache.keys().next().value;
      if (firstKey) {
        this.vectorCache.delete(firstKey);
      }
    }
    this.vectorCache.set(key, vector);
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.closeDatabase();
      this.db = null;
      this.initialized = false;
    }
    this.vectorCache.clear();
    ztoolkit.log('[VectorStore] Database closed');
  }
}

// Singleton instance
let vectorStoreInstance: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!vectorStoreInstance) {
    ztoolkit.log(`[VectorStore] getVectorStore() creating new singleton instance`);
    vectorStoreInstance = new VectorStore();
  } else {
    ztoolkit.log(`[VectorStore] getVectorStore() returning existing instance, instanceId=${(vectorStoreInstance as any).instanceId}`);
  }
  return vectorStoreInstance;
}
