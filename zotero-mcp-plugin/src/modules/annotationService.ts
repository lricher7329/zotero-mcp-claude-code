/**
 * Annotation and Highlight Content Service
 * Provides retrieval of notes, PDF annotations, highlights and other content in Zotero
 */

declare let ztoolkit: ZToolkit;

import { TextFormatter } from "./textFormatter";

// Annotation content interface
export interface AnnotationContent {
  id: string;
  itemKey: string;
  parentKey?: string;
  type: "note" | "highlight" | "annotation" | "ink" | "text" | "image";
  content: string;
  text?: string; // Original highlighted text
  comment?: string; // User-added comment
  color?: string; // Highlight color
  tags: string[];
  dateAdded: string;
  dateModified: string;
  page?: number;
  position?: any; // Position info in PDF
  sortIndex?: number;
}

// Search parameters
export interface AnnotationSearchParams {
  q?: string; // Search keywords
  itemKey?: string; // Specific item key
  type?: string | string[]; // Annotation type filter
  tags?: string | string[]; // Tag filter
  color?: string; // Color filter
  dateRange?: string; // Date range
  hasComment?: boolean; // Whether has comment
  limit?: string;
  offset?: string;
  sort?: string; // dateAdded, dateModified, position
  direction?: string;
  // Content detail level control
  detailed?: boolean; // Whether to return full content, default false
}

export class AnnotationService {
  /**
   * Smart text truncation, preserving complete sentences
   */
  private smartTruncate(text: string, maxLength: number = 200): string {
    if (!text || text.length <= maxLength) return text;

    const truncated = text.substring(0, maxLength);
    // Find the last period or newline
    const lastPeriod = Math.max(
      truncated.lastIndexOf("。"),
      truncated.lastIndexOf("."),
      truncated.lastIndexOf("\n"),
    );

    // If a suitable sentence boundary is found without truncating too much
    if (lastPeriod > maxLength * 0.6) {
      return truncated.substring(0, lastPeriod + 1) + "...";
    }

    return truncated + "...";
  }

  /**
   * Extract keywords
   */
  private extractKeywords(text: string, maxCount: number = 5): string[] {
    if (!text) return [];

    // Simple keyword extraction: remove stop words, sort by frequency
    const stopWords = new Set([
      "的",
      "了",
      "在",
      "是",
      "和",
      "与",
      "或",
      "但",
      "然而",
      "因此",
      "所以",
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, " ") // Keep Chinese and English characters
      .split(/\s+/)
      .filter((word) => word.length > 1 && !stopWords.has(word));

    // Count word frequency
    const wordCount = new Map<string, number>();
    words.forEach((word) => {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    });

    // Sort by frequency and return top N
    return Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxCount)
      .map(([word]) => word);
  }

  /**
   * Process annotation content, returning simplified or full version as needed
   */
  private processAnnotationContent(
    annotation: AnnotationContent,
    detailed: boolean = false,
  ): AnnotationContent {
    if (detailed) {
      return annotation; // Return full content
    }

    // Create simplified version
    const processed: AnnotationContent = {
      ...annotation,
      content: this.smartTruncate(annotation.content),
      text: annotation.text
        ? this.smartTruncate(annotation.text, 150)
        : annotation.text,
      comment: annotation.comment
        ? this.smartTruncate(annotation.comment, 100)
        : annotation.comment,
    };

    // Add extra metadata
    (processed as any).contentMeta = {
      isPreview: !detailed,
      originalLength: annotation.content?.length || 0,
      textLength: annotation.text?.length || 0,
      commentLength: annotation.comment?.length || 0,
      keywords: this.extractKeywords(
        annotation.content +
          " " +
          (annotation.text || "") +
          " " +
          (annotation.comment || ""),
      ),
    };

    return processed;
  }

  /**
   * Get all note content
   * @param itemKey Optional, notes for a specific item
   * @returns Note list
   */
  async getAllNotes(itemKey?: string): Promise<AnnotationContent[]> {
    try {
      ztoolkit.log(
        `[AnnotationService] Getting all notes${itemKey ? " for item " + itemKey : ""}`,
      );

      let items: Zotero.Item[];

      if (itemKey) {
        // Get notes for specific item
        const parentItem = Zotero.Items.getByLibraryAndKey(
          Zotero.Libraries.userLibraryID,
          itemKey,
        );
        if (!parentItem) {
          throw new Error(`Item with key ${itemKey} not found`);
        }

        const noteIds = parentItem.getNotes(false);
        items = noteIds.map((id) => Zotero.Items.get(id)).filter(Boolean);
      } else {
        // Get all notes
        const search = new Zotero.Search();
        (search as any).libraryID = Zotero.Libraries.userLibraryID;
        search.addCondition("itemType", "is", "note");

        const itemIds = await search.search();
        items = await Zotero.Items.getAsync(itemIds);
      }

      const notes: AnnotationContent[] = [];

      for (const item of items) {
        try {
          const noteContent = this.formatNoteItem(item);
          if (noteContent) {
            notes.push(noteContent);
          }
        } catch (e) {
          ztoolkit.log(
            `[AnnotationService] Error processing note ${item.id}: ${e}`,
            "error",
          );
        }
      }

      ztoolkit.log(`[AnnotationService] Found ${notes.length} notes`);
      return notes;
    } catch (error) {
      ztoolkit.log(
        `[AnnotationService] Error getting notes: ${error}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Get PDF annotations and highlights
   * @param itemKey Key of the PDF item
   * @returns List of annotations
   */
  async getPDFAnnotations(itemKey: string): Promise<AnnotationContent[]> {
    try {
      ztoolkit.log(
        `[AnnotationService] Getting PDF annotations for ${itemKey}`,
      );

      const item = Zotero.Items.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        itemKey,
      );

      if (!item) {
        throw new Error(`Item with key ${itemKey} not found`);
      }

      const annotations: AnnotationContent[] = [];

      // Get attachments
      const attachmentIds = item.getAttachments();

      for (const attachmentId of attachmentIds) {
        try {
          const attachment = Zotero.Items.get(attachmentId);
          if (!attachment || !attachment.isPDFAttachment()) {
            continue;
          }

          // Get PDF annotations
          const annotationItems = attachment.getAnnotations();

          for (const annotationItem of annotationItems) {
            try {
              const annotationContent = this.formatAnnotationItem(
                annotationItem,
                attachment.key,
              );
              if (annotationContent) {
                annotations.push(annotationContent);
              }
            } catch (e) {
              ztoolkit.log(
                `[AnnotationService] Error processing annotation ${annotationItem.id}: ${e}`,
                "error",
              );
            }
          }
        } catch (e) {
          ztoolkit.log(
            `[AnnotationService] Error processing attachment ${attachmentId}: ${e}`,
            "error",
          );
        }
      }

      // Sort by position
      annotations.sort((a, b) => {
        if (a.page !== b.page) {
          return (a.page || 0) - (b.page || 0);
        }
        return (a.sortIndex || 0) - (b.sortIndex || 0);
      });

      ztoolkit.log(
        `[AnnotationService] Found ${annotations.length} PDF annotations`,
      );
      return annotations;
    } catch (error) {
      ztoolkit.log(
        `[AnnotationService] Error getting PDF annotations: ${error}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Search annotations and highlights
   * @param params Search parameters
   * @returns Search results
   */
  async searchAnnotations(params: AnnotationSearchParams): Promise<{
    pagination: any;
    searchTime: string;
    totalCount: number;
    contentMode: string;
    version: string;
    endpoint: string;
    results: AnnotationContent[];
  }> {
    const startTime = Date.now();
    ztoolkit.log(
      `[AnnotationService] Searching annotations with params: ${JSON.stringify(params)}`,
    );

    try {
      const allAnnotations: AnnotationContent[] = [];

      // Get notes
      if (
        !params.type ||
        params.type === "note" ||
        (Array.isArray(params.type) && params.type.includes("note"))
      ) {
        const notes = await this.getAllNotes(params.itemKey);
        allAnnotations.push(...notes);
      }

      // Get PDF annotations
      if (!params.type || params.type !== "note") {
        if (params.itemKey) {
          const pdfAnnotations = await this.getPDFAnnotations(params.itemKey);
          allAnnotations.push(...pdfAnnotations);
        } else {
          // Search all annotation items directly (faster and more accurate)
          ztoolkit.log(
            `[AnnotationService] Searching for all annotation items directly`,
          );
          try {
            const search = new Zotero.Search();
            (search as any).libraryID = Zotero.Libraries.userLibraryID;
            search.addCondition("itemType", "is", "annotation");
            const annotationIds = await search.search();
            ztoolkit.log(
              `[AnnotationService] Found ${annotationIds.length} annotation items via search`,
            );

            const annotationItems = await Zotero.Items.getAsync(annotationIds);
            for (const annotationItem of annotationItems) {
              try {
                // Get parent attachment key for context
                const parentItem = annotationItem.parentItem;
                const parentKey = parentItem ? parentItem.key : "";

                const annotationContent = this.formatAnnotationItem(
                  annotationItem,
                  parentKey,
                );
                if (annotationContent) {
                  allAnnotations.push(annotationContent);
                }
              } catch (e) {
                // Ignore individual annotation errors
              }
            }
            ztoolkit.log(
              `[AnnotationService] Processed ${allAnnotations.length} PDF annotations`,
            );
          } catch (searchError) {
            ztoolkit.log(
              `[AnnotationService] Direct annotation search failed: ${searchError}, falling back to item iteration`,
              "warn",
            );
            // Fallback to old method
            const allItems = await Zotero.Items.getAll(
              Zotero.Libraries.userLibraryID,
            );
            const itemLimit = 100;
            let processedCount = 0;
            for (const item of allItems) {
              if (processedCount >= itemLimit) break;
              if (
                item.isRegularItem() &&
                !item.isNote() &&
                !item.isAttachment()
              ) {
                try {
                  const pdfAnnotations = await this.getPDFAnnotations(item.key);
                  allAnnotations.push(...pdfAnnotations);
                  processedCount++;
                } catch (e) {
                  // Ignore individual item errors
                }
              }
            }
          }
        }
      }

      // Apply filters
      let filteredAnnotations = this.filterAnnotations(allAnnotations, params);

      // Apply search
      if (params.q) {
        filteredAnnotations = this.searchInAnnotations(
          filteredAnnotations,
          params.q,
        );
      }

      // Process content (simplified or full)
      const detailed =
        params.detailed === true || String(params.detailed) === "true";

      // Sort
      const sort = params.sort || "dateModified";
      const direction = params.direction || "desc";
      this.sortAnnotations(filteredAnnotations, sort, direction);

      // Pagination - use smaller defaults for preview mode
      const defaultLimit = detailed ? "50" : "20"; // preview mode defaults to 20, detailed mode 50
      const limit = Math.min(
        parseInt(params.limit || defaultLimit, 10),
        detailed ? 200 : 100,
      );
      const offset = parseInt(params.offset || "0", 10);
      const totalCount = filteredAnnotations.length;
      const paginatedResults = filteredAnnotations.slice(
        offset,
        offset + limit,
      );
      const processedResults = paginatedResults.map((annotation) =>
        this.processAnnotationContent(annotation, detailed),
      );

      const searchTime = `${Date.now() - startTime}ms`;
      ztoolkit.log(
        `[AnnotationService] Search completed in ${searchTime}, found ${totalCount} results (detailed: ${detailed})`,
      );

      return {
        // Metadata first
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + limit < totalCount,
        },
        searchTime,
        totalCount,
        contentMode: detailed ? "full" : "preview",
        version: "2.0",
        endpoint: "annotations/search",
        // Actual data after metadata
        results: processedResults,
      };
    } catch (error) {
      ztoolkit.log(
        `[AnnotationService] Error searching annotations: ${error}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Format note item
   */
  private formatNoteItem(item: Zotero.Item): AnnotationContent | null {
    try {
      const noteText = item.getNote() || "";
      if (!noteText.trim()) {
        return null;
      }

      // Extract formatted text content - keep simple formatting for annotations
      const textContent = TextFormatter.htmlToText(noteText, {
        preserveParagraphs: true,
        preserveHeadings: false, // Heading formatting usually not needed for annotations
        preserveLists: true,
        preserveEmphasis: false,
      });

      return {
        id: item.key,
        itemKey: item.key,
        parentKey: item.parentKey || undefined,
        type: "note",
        content: noteText,
        text: textContent,
        tags: item.getTags().map((t) => t.tag),
        dateAdded: item.dateAdded,
        dateModified: item.dateModified,
      };
    } catch (error) {
      ztoolkit.log(
        `[AnnotationService] Error formatting note item: ${error}`,
        "error",
      );
      return null;
    }
  }

  /**
   * Format annotation item
   */
  private formatAnnotationItem(
    item: Zotero.Item,
    parentKey: string,
  ): AnnotationContent | null {
    try {
      if (!item.isAnnotation()) {
        return null;
      }

      const annotationText = item.annotationText || "";
      const annotationComment = item.annotationComment || "";
      const annotationType = item.annotationType;
      const annotationColor = item.annotationColor || "";
      const annotationPageLabel = item.annotationPageLabel;
      const annotationSortIndex = item.annotationSortIndex;

      if (!annotationText.trim() && !annotationComment.trim()) {
        return null;
      }

      // Map annotation type
      let type: AnnotationContent["type"] = "annotation";
      switch (annotationType) {
        case "highlight":
          type = "highlight";
          break;
        case "note":
          type = "text";
          break;
        case "image":
          type = "image";
          break;
        case "ink":
          type = "ink";
          break;
        default:
          type = "annotation";
          break;
      }

      return {
        id: item.key,
        itemKey: item.key,
        parentKey: parentKey,
        type,
        content: annotationComment || annotationText,
        text: annotationText,
        comment: annotationComment,
        color: annotationColor,
        tags: item.getTags().map((t) => t.tag),
        dateAdded: item.dateAdded,
        dateModified: item.dateModified,
        page: annotationPageLabel
          ? parseInt(annotationPageLabel, 10)
          : undefined,
        sortIndex: annotationSortIndex,
      };
    } catch (error) {
      ztoolkit.log(
        `[AnnotationService] Error formatting annotation item: ${error}`,
        "error",
      );
      return null;
    }
  }

  /**
   * Filter annotations
   */
  private filterAnnotations(
    annotations: AnnotationContent[],
    params: AnnotationSearchParams,
  ): AnnotationContent[] {
    return annotations.filter((annotation) => {
      // Type filter
      if (params.type) {
        const types = Array.isArray(params.type) ? params.type : [params.type];
        if (!types.includes(annotation.type)) {
          return false;
        }
      }

      // Tag filter
      if (params.tags) {
        const searchTags = Array.isArray(params.tags)
          ? params.tags
          : [params.tags];
        const hasMatchingTag = searchTags.some((searchTag) =>
          annotation.tags.some((tag) =>
            tag.toLowerCase().includes(searchTag.toLowerCase()),
          ),
        );
        if (!hasMatchingTag) {
          return false;
        }
      }

      // Color filter
      if (params.color && annotation.color !== params.color) {
        return false;
      }

      // Comment filter
      if (params.hasComment !== undefined) {
        const hasComment = !!(annotation.comment && annotation.comment.trim());
        if (params.hasComment !== hasComment) {
          return false;
        }
      }

      // Date range filter
      if (params.dateRange) {
        const [startDate, endDate] = params.dateRange
          .split(",")
          .map((d) => new Date(d.trim()));
        const itemDate = new Date(annotation.dateModified);
        if (startDate && itemDate < startDate) return false;
        if (endDate && itemDate > endDate) return false;
      }

      return true;
    });
  }

  /**
   * Search within annotations
   */
  private searchInAnnotations(
    annotations: AnnotationContent[],
    query: string,
  ): AnnotationContent[] {
    const lowerQuery = query.toLowerCase();

    return annotations.filter((annotation) => {
      const searchFields = [
        annotation.content,
        annotation.text,
        annotation.comment,
        annotation.tags.join(" "),
      ].filter(Boolean);

      return searchFields.some(
        (field) => field && field.toLowerCase().includes(lowerQuery),
      );
    });
  }

  /**
   * Sort annotations
   */
  private sortAnnotations(
    annotations: AnnotationContent[],
    sort: string,
    direction: string,
  ): void {
    annotations.sort((a, b) => {
      let valueA: any, valueB: any;

      switch (sort) {
        case "dateAdded":
          valueA = new Date(a.dateAdded);
          valueB = new Date(b.dateAdded);
          break;
        case "dateModified":
          valueA = new Date(a.dateModified);
          valueB = new Date(b.dateModified);
          break;
        case "position":
          valueA = (a.page || 0) * 1000 + (a.sortIndex || 0);
          valueB = (b.page || 0) * 1000 + (b.sortIndex || 0);
          break;
        case "type":
          valueA = a.type;
          valueB = b.type;
          break;
        default:
          valueA = a.dateModified;
          valueB = b.dateModified;
          break;
      }

      if (valueA < valueB) return direction === "asc" ? -1 : 1;
      if (valueA > valueB) return direction === "asc" ? 1 : -1;
      return 0;
    });
  }

  /**
   * Get full annotation content by ID
   */
  async getAnnotationById(
    annotationId: string,
  ): Promise<AnnotationContent | null> {
    try {
      ztoolkit.log(
        `[AnnotationService] Getting annotation by ID: ${annotationId}`,
      );

      // Try to find in notes
      const notes = await this.getAllNotes();
      const note = notes.find((n) => n.id === annotationId);
      if (note) {
        return note;
      }

      // Search all PDF annotations
      const allItems = await Zotero.Items.getAll(
        Zotero.Libraries.userLibraryID,
      );
      for (const item of allItems.slice(0, 100)) {
        // Limit search scope to avoid performance issues
        if (item.isRegularItem() && !item.isNote() && !item.isAttachment()) {
          try {
            const annotations = await this.getPDFAnnotations(item.key);
            const annotation = annotations.find((a) => a.id === annotationId);
            if (annotation) {
              return annotation;
            }
          } catch (e) {
            // Ignore individual item errors
          }
        }
      }

      return null;
    } catch (error) {
      ztoolkit.log(
        `[AnnotationService] Error getting annotation by ID: ${error}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Get full annotation content in batch
   */
  async getAnnotationsByIds(
    annotationIds: string[],
  ): Promise<AnnotationContent[]> {
    try {
      ztoolkit.log(
        `[AnnotationService] Getting annotations by IDs: ${annotationIds.join(", ")}`,
      );

      const results: AnnotationContent[] = [];

      for (const id of annotationIds) {
        const annotation = await this.getAnnotationById(id);
        if (annotation) {
          results.push(annotation);
        }
      }

      return results;
    } catch (error) {
      ztoolkit.log(
        `[AnnotationService] Error getting annotations by IDs: ${error}`,
        "error",
      );
      throw error;
    }
  }
}
