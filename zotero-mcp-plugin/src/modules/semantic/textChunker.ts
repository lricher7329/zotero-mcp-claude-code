/**
 * Text Chunker for Semantic Search
 *
 * Splits text into optimal chunks for embedding generation.
 * Supports Chinese and English text with intelligent boundary detection.
 */

declare let ztoolkit: ZToolkit;

export interface ChunkerOptions {
  maxChunkSize: number; // Maximum chunk size (characters, ~tokens for Chinese)
  overlapSize: number; // Overlap between chunks
  minChunkSize: number; // Minimum chunk size
}

export interface TextChunk {
  id: number;
  text: string;
  startPos: number;
  endPos: number;
}

export class TextChunker {
  private options: ChunkerOptions;

  constructor(options: Partial<ChunkerOptions> = {}) {
    this.options = {
      maxChunkSize: options.maxChunkSize || 450, // Leave room for instruction prefix
      overlapSize: options.overlapSize || 50,
      minChunkSize: options.minChunkSize || 20,
    };
  }

  /**
   * Split text into chunks
   */
  chunk(text: string): string[] {
    const startTime = Date.now();
    const inputLength = text?.length || 0;
    ztoolkit.log(
      `[TextChunker] Starting chunk: input length=${inputLength}, maxChunkSize=${this.options.maxChunkSize}`,
    );

    if (!text || text.trim().length < this.options.minChunkSize) {
      ztoolkit.log(`[TextChunker] Text too short, returning as-is`);
      return text?.trim() ? [text.trim()] : [];
    }

    const chunks: string[] = [];
    const cleanText = this.preprocessText(text);

    // First split by paragraphs
    const paragraphs = cleanText.split(/\n\n+/);
    let currentChunk = "";

    for (const paragraph of paragraphs) {
      const trimmedPara = paragraph.trim();
      if (!trimmedPara) continue;

      // If paragraph itself exceeds max length, split further
      if (trimmedPara.length > this.options.maxChunkSize) {
        // Save current chunk first
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
        }

        // Split long paragraph
        const subChunks = this.splitLongParagraph(trimmedPara);
        chunks.push(...subChunks);
        continue;
      }

      // Check if adding would exceed max length
      const potentialChunk = currentChunk
        ? currentChunk + "\n\n" + trimmedPara
        : trimmedPara;

      if (potentialChunk.length <= this.options.maxChunkSize) {
        currentChunk = potentialChunk;
      } else {
        // Save current chunk, start new one
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = trimmedPara;
      }
    }

    // Add last chunk
    if (
      currentChunk.trim() &&
      currentChunk.trim().length >= this.options.minChunkSize
    ) {
      chunks.push(currentChunk.trim());
    }

    const elapsed = Date.now() - startTime;
    ztoolkit.log(
      `[TextChunker] Chunking completed: ${chunks.length} chunks in ${elapsed}ms, avg size=${chunks.length > 0 ? Math.round(chunks.reduce((a, c) => a + c.length, 0) / chunks.length) : 0}`,
    );

    return chunks;
  }

  /**
   * Split text into chunks with position info
   */
  chunkWithPositions(text: string): TextChunk[] {
    const chunks = this.chunk(text);
    const result: TextChunk[] = [];
    let searchStart = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      // Find position in original text (approximate)
      const startPos = text.indexOf(chunkText.substring(0, 50), searchStart);
      const endPos = startPos + chunkText.length;

      result.push({
        id: i,
        text: chunkText,
        startPos: startPos >= 0 ? startPos : searchStart,
        endPos: startPos >= 0 ? endPos : searchStart + chunkText.length,
      });

      searchStart = startPos >= 0 ? startPos + 1 : searchStart + 1;
    }

    return result;
  }

  /**
   * Preprocess text - clean up whitespace and normalize
   */
  private preprocessText(text: string): string {
    return (
      text
        // Normalize whitespace
        .replace(/\r\n/g, "\n")
        .replace(/\t/g, " ")
        // Remove excessive spaces
        .replace(/ +/g, " ")
        // Remove excessive newlines (keep paragraph breaks)
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    );
  }

  /**
   * Split long paragraph by sentences
   */
  private splitLongParagraph(paragraph: string): string[] {
    const chunks: string[] = [];

    // Split by sentences (supports Chinese and English punctuation)
    const sentencePattern = /(?<=[。！？.!?;；])\s*/;
    const sentences = paragraph.split(sentencePattern);
    let currentChunk = "";

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;

      const potentialChunk = currentChunk
        ? currentChunk + " " + trimmedSentence
        : trimmedSentence;

      if (potentialChunk.length <= this.options.maxChunkSize) {
        currentChunk = potentialChunk;
      } else {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }

        // If single sentence is still too long, force split
        if (trimmedSentence.length > this.options.maxChunkSize) {
          chunks.push(...this.forceSplit(trimmedSentence));
          currentChunk = "";
        } else {
          currentChunk = trimmedSentence;
        }
      }
    }

    if (
      currentChunk.trim() &&
      currentChunk.trim().length >= this.options.minChunkSize
    ) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Force split text with overlap
   */
  private forceSplit(text: string): string[] {
    const chunks: string[] = [];
    const { maxChunkSize, overlapSize } = this.options;

    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxChunkSize, text.length);

      // Try to find a good break point (space, punctuation)
      if (end < text.length) {
        const searchStart = Math.max(start + maxChunkSize - 50, start);
        const breakPoints = [" ", "，", ",", "。", ".", "、", ";", "；"];
        let bestBreak = -1;

        for (let i = end - 1; i >= searchStart; i--) {
          if (breakPoints.includes(text[i])) {
            bestBreak = i + 1;
            break;
          }
        }

        if (bestBreak > start) {
          end = bestBreak;
        }
      }

      chunks.push(text.slice(start, end).trim());
      start = end - overlapSize;

      // Avoid infinite loop
      if (start >= text.length - overlapSize) break;
    }

    return chunks.filter((c) => c.length >= this.options.minChunkSize);
  }

  /**
   * Estimate token count (rough approximation)
   * Chinese: ~1.5 chars per token
   * English: ~4 chars per token
   */
  estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [])
      .length;
    const otherChars = text.length - chineseChars;

    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }

  /**
   * Detect primary language
   */
  detectLanguage(text: string): "zh" | "en" {
    const chineseRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
    const chineseChars = (text.match(chineseRegex) || []).length;
    const totalChars = text.replace(/\s/g, "").length;

    // If Chinese chars > 30%, consider it Chinese
    return totalChars > 0 && chineseChars / totalChars > 0.3 ? "zh" : "en";
  }
}

// Export singleton factory
let chunkerInstance: TextChunker | null = null;

export function getTextChunker(options?: Partial<ChunkerOptions>): TextChunker {
  if (!chunkerInstance) {
    chunkerInstance = new TextChunker(options);
  } else if (options) {
    ztoolkit.log(
      `[TextChunker] getTextChunker() called with options but instance already exists; ignoring options`,
      "warn",
    );
  }
  return chunkerInstance;
}
