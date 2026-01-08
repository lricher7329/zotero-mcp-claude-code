/**
 * Embedding Service for Semantic Search
 *
 * Uses OpenAI-compatible API for embedding generation.
 * Supports any API that follows the OpenAI embeddings format.
 */

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

export interface EmbeddingResult {
  embedding: Float32Array;
  language: 'zh' | 'en';
  dimensions: number;
}

export interface BatchEmbeddingItem {
  id: string;
  text: string;
  language?: 'zh' | 'en';
}

export interface EmbeddingServiceStatus {
  initialized: boolean;
  apiConfigured: boolean;
  lastError?: string;
}

/**
 * Configuration for embedding API
 */
export interface EmbeddingConfig {
  apiBase: string;          // API base URL (e.g., https://api.openai.com/v1)
  apiKey: string;           // API key
  model: string;            // Model name (e.g., text-embedding-3-small)
  dimensions?: number;      // Output dimensions (if supported by model)
  maxBatchSize: number;     // Max texts per API call
  timeout: number;          // Request timeout in ms
  maxRetries: number;       // Max retry attempts
}

const DEFAULT_CONFIG: EmbeddingConfig = {
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'text-embedding-3-small',
  dimensions: 512,  // Smaller dimensions for efficiency
  maxBatchSize: 100,  // OpenAI supports up to 2048
  timeout: 30000,
  maxRetries: 3
};

// Preference keys for storing API configuration
const PREF_API_BASE = 'extensions.zotero.zotero-mcp-plugin.embedding.apiBase';
const PREF_API_KEY = 'extensions.zotero.zotero-mcp-plugin.embedding.apiKey';
const PREF_MODEL = 'extensions.zotero.zotero-mcp-plugin.embedding.model';
const PREF_DIMENSIONS = 'extensions.zotero.zotero-mcp-plugin.embedding.dimensions';

export class EmbeddingService {
  private config: EmbeddingConfig;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private status: EmbeddingServiceStatus = {
    initialized: false,
    apiConfigured: false
  };

  constructor(config: Partial<EmbeddingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the embedding service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    ztoolkit.log('[EmbeddingService] Initializing API-based embedding service...');

    try {
      // Load configuration from Zotero preferences
      this.loadConfigFromPrefs();

      // Validate configuration - check apiBase and model (apiKey is optional for local models)
      if (!this.config.apiBase || !this.config.model) {
        ztoolkit.log('[EmbeddingService] Warning: API base or model not configured', 'warn');
        this.status.apiConfigured = false;
      } else {
        this.status.apiConfigured = true;
        ztoolkit.log(`[EmbeddingService] API configured: ${this.config.apiBase}, model: ${this.config.model}, apiKey: ${this.config.apiKey ? 'yes' : 'no'}`);
      }

      this.initialized = true;
      this.status.initialized = true;
      ztoolkit.log('[EmbeddingService] Initialized successfully');

    } catch (error) {
      this.status.lastError = String(error);
      ztoolkit.log(`[EmbeddingService] Initialization failed: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Load configuration from Zotero preferences
   */
  private loadConfigFromPrefs(): void {
    try {
      const apiBase = Zotero.Prefs.get(PREF_API_BASE, true);
      const apiKey = Zotero.Prefs.get(PREF_API_KEY, true);
      const model = Zotero.Prefs.get(PREF_MODEL, true);
      const dimensions = Zotero.Prefs.get(PREF_DIMENSIONS, true);

      if (apiBase) this.config.apiBase = apiBase;
      if (apiKey) this.config.apiKey = apiKey;
      if (model) this.config.model = model;
      if (dimensions) this.config.dimensions = parseInt(dimensions, 10);

      ztoolkit.log(`[EmbeddingService] Loaded config from prefs: apiBase=${this.config.apiBase}, model=${this.config.model}, dims=${this.config.dimensions}`);
    } catch (e) {
      ztoolkit.log(`[EmbeddingService] Failed to load prefs: ${e}`, 'warn');
    }
  }

  /**
   * Save configuration to Zotero preferences
   */
  saveConfigToPrefs(): void {
    try {
      Zotero.Prefs.set(PREF_API_BASE, this.config.apiBase, true);
      Zotero.Prefs.set(PREF_API_KEY, this.config.apiKey, true);
      Zotero.Prefs.set(PREF_MODEL, this.config.model, true);
      if (this.config.dimensions) {
        Zotero.Prefs.set(PREF_DIMENSIONS, String(this.config.dimensions), true);
      }
      ztoolkit.log('[EmbeddingService] Config saved to prefs');
    } catch (e) {
      ztoolkit.log(`[EmbeddingService] Failed to save prefs: ${e}`, 'warn');
    }
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<EmbeddingConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.status.apiConfigured = !!this.config.apiBase && !!this.config.model;
    this.saveConfigToPrefs();
    ztoolkit.log(`[EmbeddingService] Config updated: apiBase=${this.config.apiBase}, model=${this.config.model}, apiKey=${this.config.apiKey ? 'yes' : 'no'}`);
  }

  /**
   * Get current configuration (without sensitive data)
   */
  getConfig(): Omit<EmbeddingConfig, 'apiKey'> & { apiKeyConfigured: boolean } {
    return {
      apiBase: this.config.apiBase,
      model: this.config.model,
      dimensions: this.config.dimensions,
      maxBatchSize: this.config.maxBatchSize,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      apiKeyConfigured: !!this.config.apiKey
    };
  }

  /**
   * Generate embedding for a single text
   *
   * @param text - Text to embed
   * @param language - Language hint ('zh', 'en', or 'auto') - used for tracking
   * @param isQuery - Not used for API-based embedding, kept for interface compatibility
   */
  async embed(text: string, language?: 'zh' | 'en' | 'auto', isQuery: boolean = false): Promise<EmbeddingResult> {
    const startTime = Date.now();
    await this.initialize();

    // Detect language for tracking (API doesn't need language-specific models)
    const detectedLang = language === 'auto' || !language
      ? this.detectLanguage(text)
      : language;

    const textPreview = text.substring(0, 50).replace(/\n/g, ' ');
    ztoolkit.log(`[EmbeddingService] embed() start: lang=${detectedLang}, len=${text.length}, text="${textPreview}..."`);

    if (!this.config.apiBase || !this.config.model) {
      ztoolkit.log('[EmbeddingService] API not configured, using fallback', 'warn');
      return this.generateFallbackEmbedding(text, detectedLang);
    }

    try {
      const embeddings = await this.callEmbeddingAPI([text]);
      const embedding = embeddings[0];

      const elapsed = Date.now() - startTime;
      ztoolkit.log(`[EmbeddingService] embed() completed: dims=${embedding.length}, time=${elapsed}ms`);

      return {
        embedding: new Float32Array(embedding),
        language: detectedLang,
        dimensions: embedding.length
      };
    } catch (error) {
      ztoolkit.log(`[EmbeddingService] API call failed: ${error}`, 'error');
      this.status.lastError = String(error);
      // Fall back to hash-based embedding
      return this.generateFallbackEmbedding(text, detectedLang);
    }
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(items: BatchEmbeddingItem[]): Promise<Map<string, EmbeddingResult>> {
    const startTime = Date.now();
    await this.initialize();

    ztoolkit.log(`[EmbeddingService] embedBatch() start: ${items.length} items`);

    const results = new Map<string, EmbeddingResult>();

    if (!this.config.apiBase || !this.config.model) {
      ztoolkit.log('[EmbeddingService] API not configured, using fallback', 'warn');
      for (const item of items) {
        const lang = item.language || this.detectLanguage(item.text);
        results.set(item.id, this.generateFallbackEmbedding(item.text, lang));
      }
      return results;
    }

    // Process in batches
    const batches: BatchEmbeddingItem[][] = [];
    for (let i = 0; i < items.length; i += this.config.maxBatchSize) {
      batches.push(items.slice(i, i + this.config.maxBatchSize));
    }

    ztoolkit.log(`[EmbeddingService] Processing ${batches.length} batches (maxBatchSize=${this.config.maxBatchSize})`);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const texts = batch.map(item => item.text);

      try {
        const embeddings = await this.callEmbeddingAPI(texts);

        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          const embedding = embeddings[i];
          const lang = item.language || this.detectLanguage(item.text);

          results.set(item.id, {
            embedding: new Float32Array(embedding),
            language: lang,
            dimensions: embedding.length
          });
        }

        ztoolkit.log(`[EmbeddingService] Batch ${batchIdx + 1}/${batches.length} completed: ${batch.length} embeddings`);
      } catch (error) {
        ztoolkit.log(`[EmbeddingService] Batch ${batchIdx + 1} failed: ${error}`, 'warn');
        // Process individually with fallback
        for (const item of batch) {
          const lang = item.language || this.detectLanguage(item.text);
          results.set(item.id, this.generateFallbackEmbedding(item.text, lang));
        }
      }
    }

    const elapsed = Date.now() - startTime;
    ztoolkit.log(`[EmbeddingService] embedBatch() completed: ${results.size}/${items.length} embeddings in ${elapsed}ms`);

    return results;
  }

  /**
   * Call the embedding API using Zotero.HTTP
   */
  private async callEmbeddingAPI(texts: string[]): Promise<number[][]> {
    const url = `${this.config.apiBase}/embeddings`;

    const requestBody: any = {
      model: this.config.model,
      input: texts
    };

    // Add dimensions if supported (OpenAI text-embedding-3-* models support this)
    if (this.config.dimensions && this.config.model.includes('text-embedding-3')) {
      requestBody.dimensions = this.config.dimensions;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };

        // Add Authorization header if API key is provided
        if (this.config.apiKey) {
          headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        // Use Zotero.HTTP.request which is available in Zotero environment
        const response = await Zotero.HTTP.request('POST', url, {
          headers,
          body: JSON.stringify(requestBody),
          timeout: this.config.timeout,
          responseType: 'json'
        });

        const data = response.response;

        if (!data || !data.data) {
          throw new Error(`Invalid API response: ${JSON.stringify(data).substring(0, 200)}`);
        }

        // Sort by index to ensure correct order
        const sortedData = data.data.sort((a: any, b: any) => a.index - b.index);
        return sortedData.map((item: any) => item.embedding);

      } catch (error: any) {
        lastError = error;
        const errorMsg = error.message || error.status || String(error);
        ztoolkit.log(`[EmbeddingService] API attempt ${attempt + 1}/${this.config.maxRetries} failed: ${errorMsg}`, 'warn');

        // Wait before retry (exponential backoff)
        if (attempt < this.config.maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('API call failed after all retries');
  }

  /**
   * Simple language detection
   */
  detectLanguage(text: string): 'zh' | 'en' {
    const chineseRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
    const chineseChars = (text.match(chineseRegex) || []).length;
    const totalChars = text.replace(/\s/g, '').length;

    return totalChars > 0 && chineseChars / totalChars > 0.3 ? 'zh' : 'en';
  }

  /**
   * Generate fallback embedding using hash (for when API is not available)
   */
  private generateFallbackEmbedding(text: string, language: 'zh' | 'en'): EmbeddingResult {
    const dimensions = this.config.dimensions || 512;
    const embedding = new Float32Array(dimensions);

    // Simple hash-based embedding (NOT for production use)
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & hash;
    }

    const seed = Math.abs(hash);
    for (let i = 0; i < dimensions; i++) {
      const val = ((seed * (i + 1) * 1103515245 + 12345) % 2147483648) / 2147483648;
      embedding[i] = (val - 0.5) * 2;
    }

    // Normalize
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) {
        embedding[i] /= norm;
      }
    }

    return {
      embedding,
      language,
      dimensions
    };
  }

  /**
   * Check if service is ready
   */
  async isReady(): Promise<boolean> {
    if (!this.initialized) {
      try {
        await this.initialize();
      } catch {
        return false;
      }
    }
    return this.status.apiConfigured;
  }

  /**
   * Get service status
   */
  getStatus(): EmbeddingServiceStatus {
    return { ...this.status };
  }

  /**
   * Check if using fallback mode (API not configured)
   */
  isFallbackMode(): boolean {
    return !this.config.apiBase || !this.config.model;
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<{ success: boolean; message: string; dimensions?: number }> {
    if (!this.config.apiBase || !this.config.model) {
      return { success: false, message: 'API base or model not configured' };
    }

    try {
      const result = await this.embed('test', 'en');
      return {
        success: true,
        message: `Connection successful. Model: ${this.config.model}`,
        dimensions: result.dimensions
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Connection failed: ${error.message}`
      };
    }
  }

  /**
   * Destroy the service
   */
  destroy(): void {
    this.initialized = false;
    this.initPromise = null;
    this.status = {
      initialized: false,
      apiConfigured: false
    };
    ztoolkit.log('[EmbeddingService] Destroyed');
  }
}

// Singleton instance
let embeddingServiceInstance: EmbeddingService | null = null;

export function getEmbeddingService(config?: Partial<EmbeddingConfig>): EmbeddingService {
  if (!embeddingServiceInstance) {
    embeddingServiceInstance = new EmbeddingService(config);
  }
  return embeddingServiceInstance;
}
