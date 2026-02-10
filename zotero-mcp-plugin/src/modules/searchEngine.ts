import { formatItem, formatItemBrief } from "./itemFormatter";

declare let ztoolkit: ZToolkit;

class MCPError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "MCPError";
  }
}

// Supported search parameters interface
interface SearchParams {
  q?: string;
  key?: string; // Added key for exact matching
  title?: string;
  creator?: string;
  year?: string;
  tag?: string; // Backward compatible
  tags?: string | string[]; // Supports string or array
  tagMode?: "any" | "all" | "none";
  tagMatch?: "exact" | "contains" | "startsWith";
  itemType?: string;
  doi?: string;
  isbn?: string;
  collection?: string;
  hasAttachment?: string;
  hasNote?: string;
  limit?: string;
  offset?: string;
  sort?: string;
  direction?: string;
  libraryID?: string; // Library ID parameter
  includeAttachments?: string; // Whether to include attachments
  includeNotes?: string; // Whether to include notes

  // Fulltext search parameters
  fulltext?: string; // Fulltext search content
  fulltextMode?: "attachment" | "note" | "both"; // Fulltext search mode: attachments only, notes only, or both
  fulltextOperator?: "contains" | "exact" | "regex"; // Fulltext search operator

  // Advanced search parameters
  titleOperator?: "contains" | "exact" | "startsWith" | "endsWith" | "regex";
  creatorOperator?: "contains" | "exact" | "startsWith" | "endsWith";
  yearRange?: string; // Format: "2020-2023" or "2020-" or "-2023"
  dateAdded?: string; // ISO date string
  dateAddedRange?: string; // Format: "2023-01-01,2023-12-31"
  dateModified?: string;
  dateModifiedRange?: string;
  publicationTitle?: string;
  publicationTitleOperator?: "contains" | "exact";
  abstractText?: string;
  abstractOperator?: "contains" | "regex";
  language?: string;
  rights?: string;
  url?: string;
  extra?: string;
  numPages?: string;
  numPagesRange?: string; // Format: "100-500"

  // Boolean query support
  booleanQuery?: string; // Advanced boolean query string
  fieldQueries?: FieldQuery[]; // Structured field queries

  // Result relevance and sorting
  relevanceScoring?: "true" | "false";
  boostFields?: string; // Comma-separated field list for boosting relevance weight

  // Saved searches
  savedSearchName?: string;
  saveSearch?: "true" | "false";
}

// Field query structure
interface FieldQuery {
  field: string;
  operator:
    | "contains"
    | "exact"
    | "startsWith"
    | "endsWith"
    | "regex"
    | "range"
    | "gt"
    | "lt"
    | "gte"
    | "lte";
  value: string;
  boost?: number; // Relevance boost factor
}

// Relevance scoring result
interface ScoredItem {
  item: Zotero.Item;
  relevanceScore: number;
  matchedFields: string[];
}

// Supported sort fields
const SUPPORTED_SORT_FIELDS = [
  "date",
  "title",
  "creator",
  "dateAdded",
  "dateModified",
  "relevance",
];

// Advanced search helper functions

/**
 * Parse date range string
 * @param rangeStr Format: "2020-2023" or "2020-" or "-2023" or "2023-01-01,2023-12-31"
 * @returns {start: Date|null, end: Date|null}
 */
function parseDateRange(rangeStr: string): {
  start: Date | null;
  end: Date | null;
} {
  if (!rangeStr) return { start: null, end: null };

  // Handle comma-separated date format
  if (rangeStr.includes(",")) {
    const [startStr, endStr] = rangeStr.split(",").map((s) => s.trim());
    return {
      start: startStr ? new Date(startStr) : null,
      end: endStr ? new Date(endStr) : null,
    };
  }

  // Handle hyphen-separated year format
  if (rangeStr.includes("-")) {
    const parts = rangeStr.split("-");
    if (parts.length === 2) {
      const [startYear, endYear] = parts;
      return {
        start: startYear ? new Date(`${startYear}-01-01`) : null,
        end: endYear ? new Date(`${endYear}-12-31`) : null,
      };
    }
  }

  return { start: null, end: null };
}

/**
 * Parse numeric range string
 * @param rangeStr Format: "100-500" or "100-" or "-500"
 * @returns {min: number|null, max: number|null}
 */
function parseNumberRange(rangeStr: string): {
  min: number | null;
  max: number | null;
} {
  if (!rangeStr) return { min: null, max: null };

  if (rangeStr.includes("-")) {
    const parts = rangeStr.split("-");
    if (parts.length === 2) {
      const [minStr, maxStr] = parts;
      return {
        min: minStr ? parseInt(minStr, 10) : null,
        max: maxStr ? parseInt(maxStr, 10) : null,
      };
    }
  }

  return { min: null, max: null };
}

/**
 * Check if a field value matches the operator and query value
 * @param fieldValue Field value
 * @param operator Operator
 * @param queryValue Query value
 * @returns Whether it matches
 */
function matchesFieldQuery(
  fieldValue: any,
  operator: string,
  queryValue: string,
): boolean {
  if (!fieldValue && !queryValue) return true;
  if (!fieldValue || !queryValue) return false;

  const fieldStr = String(fieldValue).toLowerCase();
  const queryStr = queryValue.toLowerCase();

  switch (operator) {
    case "exact":
      return fieldStr === queryStr;
    case "contains":
      return fieldStr.includes(queryStr);
    case "startsWith":
      return fieldStr.startsWith(queryStr);
    case "endsWith":
      return fieldStr.endsWith(queryStr);
    case "regex":
      try {
        // Reject patterns with nested quantifiers that cause catastrophic backtracking
        if (/(\+|\*|\{)\)?(\+|\*|\{)/.test(queryValue)) {
          return false;
        }
        const regex = new RegExp(queryValue, "i");
        return regex.test(fieldStr.slice(0, 100000));
      } catch {
        return false;
      }
    default:
      return fieldStr.includes(queryStr);
  }
}

/**
 * Calculate relevance score for an item
 * @param item Zotero item
 * @param params Search parameters
 * @returns Relevance score and matched fields
 */
function calculateRelevanceScore(
  item: Zotero.Item,
  params: SearchParams,
): { score: number; matchedFields: string[] } {
  let score = 0;
  const matchedFields: string[] = [];
  const boostFields = params.boostFields?.split(",").map((f) => f.trim()) || [];

  // Base field weights
  const fieldWeights: Record<string, number> = {
    title: 3.0,
    creator: 2.0,
    abstractNote: 1.5,
    publicationTitle: 1.2,
    tags: 1.0,
    extra: 0.5,
  };

  // Apply boost weights
  boostFields.forEach((field) => {
    if (fieldWeights[field]) {
      fieldWeights[field] *= 2;
    }
  });

  // Check field match results
  if (params.q) {
    const query = params.q.toLowerCase();
    Object.entries(fieldWeights).forEach(([field, weight]) => {
      let fieldValue: string = "";

      if (field === "creator") {
        fieldValue =
          item
            .getCreators?.()
            ?.map((c) => `${c.firstName} ${c.lastName}`)
            ?.join(" ") || "";
      } else if (field === "tags") {
        fieldValue =
          item
            .getTags?.()
            ?.map((t) => t.tag)
            ?.join(" ") || "";
      } else {
        try {
          fieldValue = item.getField(field as any) || "";
        } catch {
          fieldValue = "";
        }
      }

      if (fieldValue.toLowerCase().includes(query)) {
        score += weight;
        matchedFields.push(field);
      }
    });
  }

  // Bonus for specific field matches
  if (
    params.title &&
    item.getField("title")?.toLowerCase().includes(params.title.toLowerCase())
  ) {
    score += fieldWeights.title || 3.0;
    if (!matchedFields.includes("title")) matchedFields.push("title");
  }

  if (params.creator) {
    const creators = (item.getCreators?.() || []).map((c) =>
      `${c.firstName} ${c.lastName}`.toLowerCase(),
    );
    if (creators.some((c) => c.includes(params.creator!.toLowerCase()))) {
      score += fieldWeights.creator || 2.0;
      if (!matchedFields.includes("creator")) matchedFields.push("creator");
    }
  }

  return { score, matchedFields };
}

/**
 * Perform fulltext search
 * @param query Search term
 * @param libraryID Library ID
 * @param mode Search mode
 * @param operator Operator
 * @returns List of matching item IDs
 */
async function performFulltextSearch(
  query: string,
  libraryID: number,
  mode: "attachment" | "note" | "both" = "both",
  operator: "contains" | "exact" | "regex" = "contains",
): Promise<{ itemIDs: number[]; matchDetails: Map<number, any> }> {
  const matchDetails = new Map<number, any>();
  const itemIDs: number[] = [];

  try {
    if (mode === "attachment" || mode === "both") {
      // Use Zotero.Search to search attachment fulltext
      const attachmentSearch = new Zotero.Search();
      (attachmentSearch as any).libraryID = libraryID;

      // Search attachment content
      const searchOperator = operator === "exact" ? "is" : "contains";
      attachmentSearch.addCondition("fulltextContent", searchOperator, query);
      attachmentSearch.addCondition("itemType", "is", "attachment");

      const attachmentIDs = await attachmentSearch.search();

      for (const attachmentID of attachmentIDs) {
        const attachment = Zotero.Items.get(attachmentID);
        if (attachment && attachment.isAttachment()) {
          const parentItem = attachment.parentItem;
          const targetID = parentItem ? parentItem.id : attachment.id;

          if (parentItem && !itemIDs.includes(parentItem.id)) {
            itemIDs.push(parentItem.id);
          } else if (!parentItem && !itemIDs.includes(attachment.id)) {
            itemIDs.push(attachment.id);
          }

          // Record match details
          if (!matchDetails.has(targetID)) {
            matchDetails.set(targetID, {
              attachments: [],
              notes: [],
              score: 0,
            });
          }

          const details = matchDetails.get(targetID);

          // Try to get matching snippet
          let snippet = "";
          try {
            const content = (await attachment.attachmentText) || "";
            if (content) {
              const queryPos = content
                .toLowerCase()
                .indexOf(query.toLowerCase());
              if (queryPos >= 0) {
                const start = Math.max(0, queryPos - 50);
                const end = Math.min(
                  content.length,
                  queryPos + query.length + 50,
                );
                snippet = "..." + content.substring(start, end) + "...";
              }
            }
          } catch (e) {
            // Failed to get snippet, use empty string
            snippet = "";
          }

          details.attachments.push({
            attachmentID: attachment.id,
            filename: attachment.attachmentFilename || "",
            snippet: snippet,
            score: 1,
          });
          details.score += 1;
        }
      }
    }

    if (mode === "note" || mode === "both") {
      // Search note content
      const s = new Zotero.Search();
      (s as any).libraryID = libraryID;
      s.addCondition("itemType", "is", "note");

      // Set search condition based on operator
      const searchOperator = operator === "exact" ? "is" : "contains";
      s.addCondition("note", searchOperator, query);

      const noteIDs = await s.search();

      for (const noteID of noteIDs) {
        const note = Zotero.Items.get(noteID);
        if (note && note.isNote()) {
          const parentItem = note.parentItem;
          if (parentItem && !itemIDs.includes(parentItem.id)) {
            itemIDs.push(parentItem.id);
          }

          const targetID = parentItem ? parentItem.id : note.id;
          if (!matchDetails.has(targetID)) {
            matchDetails.set(targetID, {
              attachments: [],
              notes: [],
              score: 0,
            });
          }

          const details = matchDetails.get(targetID);
          const noteContent = note.getNote();
          let snippet = "";

          // Extract matching snippet
          if (noteContent) {
            const cleanContent = noteContent
              .replace(/<[^>]*>/g, " ")
              .replace(/\s+/g, " ");
            const queryPos = cleanContent
              .toLowerCase()
              .indexOf(query.toLowerCase());
            if (queryPos >= 0) {
              const start = Math.max(0, queryPos - 50);
              const end = Math.min(
                cleanContent.length,
                queryPos + query.length + 50,
              );
              snippet = "..." + cleanContent.substring(start, end) + "...";
            }
          }

          details.notes.push({
            noteID: note.id,
            snippet: snippet,
            score: 1,
          });
          details.score += 1;
        }
      }
    }

    return { itemIDs: [...new Set(itemIDs)], matchDetails };
  } catch (error) {
    ztoolkit.log(`[SearchEngine] Fulltext search error: ${error}`, "error");
    return { itemIDs: [], matchDetails };
  }
}

/**
 * Apply advanced filters to item list
 * @param items Item list
 * @param params Search parameters
 * @returns Filtered item list
 */
function applyAdvancedFilters(
  items: Zotero.Item[],
  params: SearchParams,
): Zotero.Item[] {
  return items.filter((item) => {
    // Date range filter
    if (params.yearRange) {
      const { start, end } = parseDateRange(params.yearRange);
      if (start || end) {
        const itemDate = item.getField("date");
        if (itemDate) {
          const year = parseInt(itemDate.toString().substring(0, 4), 10);
          if (start && year < start.getFullYear()) return false;
          if (end && year > end.getFullYear()) return false;
        }
      }
    }

    // Date added range filter
    if (params.dateAddedRange) {
      const { start, end } = parseDateRange(params.dateAddedRange);
      if (start || end) {
        const dateAdded = new Date(item.dateAdded);
        if (start && dateAdded < start) return false;
        if (end && dateAdded > end) return false;
      }
    }

    // Date modified range filter
    if (params.dateModifiedRange) {
      const { start, end } = parseDateRange(params.dateModifiedRange);
      if (start || end) {
        const dateModified = new Date(item.dateModified);
        if (start && dateModified < start) return false;
        if (end && dateModified > end) return false;
      }
    }

    // Page count range filter
    if (params.numPagesRange) {
      const { min, max } = parseNumberRange(params.numPagesRange);
      if (min || max) {
        const numPages = parseInt(item.getField("numPages") || "0", 10);
        if (min && numPages < min) return false;
        if (max && numPages > max) return false;
      }
    }

    // Advanced field matching
    if (params.titleOperator && params.title) {
      const title = item.getField("title") || "";
      if (!matchesFieldQuery(title, params.titleOperator, params.title)) {
        return false;
      }
    }

    if (params.creatorOperator && params.creator) {
      const creators = (item.getCreators?.() || [])
        .map((c) => `${c.firstName} ${c.lastName}`)
        .join(" ");
      if (
        !matchesFieldQuery(creators, params.creatorOperator, params.creator)
      ) {
        return false;
      }
    }

    if (params.abstractOperator && params.abstractText) {
      const abstract = item.getField("abstractNote") || "";
      if (
        !matchesFieldQuery(
          abstract,
          params.abstractOperator,
          params.abstractText,
        )
      ) {
        return false;
      }
    }

    if (params.publicationTitleOperator && params.publicationTitle) {
      const pubTitle = item.getField("publicationTitle") || "";
      if (
        !matchesFieldQuery(
          pubTitle,
          params.publicationTitleOperator,
          params.publicationTitle,
        )
      ) {
        return false;
      }
    }

    // Other field exact matching
    const exactMatchFields = ["language", "rights", "url", "extra"];
    for (const field of exactMatchFields) {
      const paramValue = params[field as keyof SearchParams];
      if (paramValue && typeof paramValue === "string") {
        const fieldValue = item.getField(field as any) || "";
        if (!fieldValue.toLowerCase().includes(paramValue.toLowerCase())) {
          return false;
        }
      }
    }

    return true;
  });
}

/**
 * Handle search engine request
 * @param params Search parameters
 */
export async function handleSearchRequest(
  params: SearchParams,
): Promise<Record<string, any>> {
  Zotero.debug(
    `[MCP Search] Received search params: ${JSON.stringify(params)}`,
  );
  const startTime = Date.now();

  // --- 1. Parameter processing and validation ---
  const libraryID = params.libraryID
    ? parseInt(params.libraryID, 10)
    : Zotero.Libraries.userLibraryID;
  const limit = Math.min(parseInt(params.limit || "100", 10), 500);
  const offset = parseInt(params.offset || "0", 10);
  const sort = params.sort || "dateAdded";
  const direction = params.direction || "desc";

  if (!SUPPORTED_SORT_FIELDS.includes(sort)) {
    throw new MCPError(
      400,
      `Unsupported sort field: ${sort}. Supported fields are: ${SUPPORTED_SORT_FIELDS.join(", ")}`,
    );
  }
  if (!["asc", "desc"].includes(direction.toLowerCase())) {
    throw new MCPError(
      400,
      `Unsupported sort direction: ${direction}. Use 'asc' or 'desc'.`,
    );
  }

  // --- 2. Exact key lookup (priority) ---
  if (params.key) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      libraryID,
      params.key,
    );
    return {
      query: params,
      pagination: { limit: 1, offset: 0, total: item ? 1 : 0, hasMore: false },
      searchTime: `${Date.now() - startTime}ms`,
      results: item ? [await formatItem(item)] : [],
    };
  }

  // --- 3. Handle fulltext search (high priority) ---
  let fulltextItemIDs: number[] = [];
  let fulltextMatchDetails = new Map<number, any>();

  if (params.fulltext) {
    const mode = params.fulltextMode || "both";
    const operator = params.fulltextOperator || "contains";
    const fulltextResult = await performFulltextSearch(
      params.fulltext,
      libraryID,
      mode,
      operator,
    );
    fulltextItemIDs = fulltextResult.itemIDs;
    fulltextMatchDetails = fulltextResult.matchDetails;

    if (fulltextItemIDs.length === 0) {
      return {
        query: params,
        pagination: { limit, offset, total: 0, hasMore: false },
        searchTime: `${Date.now() - startTime}ms`,
        results: [],
        searchFeatures: ["fulltext"],
      };
    }
  }

  // --- 4. Build Zotero search conditions (excluding tags) ---
  const s = new Zotero.Search();
  (s as any).libraryID = libraryID;

  // Standard search conditions
  if (params.q) {
    s.addCondition("quicksearch-everything", "contains", params.q);
  }

  const fieldMappings: { [key in keyof SearchParams]?: string } = {
    title: "title",
    creator: "creator",
    year: "date",
    itemType: "itemType",
    doi: "DOI",
    isbn: "ISBN",
  };

  // Backward compatible: if old `tag` param is provided without new `tags` param, use Zotero's native tag search
  if (params.tag && !params.tags) {
    fieldMappings.tag = "tag";
  }

  for (const [paramKey, conditionKey] of Object.entries(fieldMappings)) {
    const value = params[paramKey as keyof SearchParams];
    if (value) {
      const operator = ["year", "itemType"].includes(paramKey)
        ? "is"
        : "contains";
      s.addCondition(conditionKey, operator, value as string);
    }
  }

  if (params.collection) {
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      params.collection,
    );
    if (collection) {
      s.addCondition("collection", "is", collection.id);
    } else {
      return {
        // Invalid collection, return empty results
        query: params,
        pagination: { limit, offset, total: 0, hasMore: false },
        searchTime: `${Date.now() - startTime}ms`,
        results: [],
      };
    }
  }

  if (params.hasAttachment)
    s.addCondition("attachment", "is", params.hasAttachment);
  if (params.hasNote) s.addCondition("note", "is", params.hasNote);
  if (params.includeAttachments !== "true")
    s.addCondition("itemType", "isNot", "attachment");
  if (params.includeNotes !== "true")
    s.addCondition("itemType", "isNot", "note");

  // --- 4. Execute initial search ---
  let initialItemIDs: number[];

  if (params.fulltext && fulltextItemIDs.length > 0) {
    // If fulltext search specified, use fulltext search results
    initialItemIDs = fulltextItemIDs;
  } else {
    // Otherwise execute standard search
    initialItemIDs = await s.search();
  }

  if (initialItemIDs.length === 0) {
    return {
      query: params,
      pagination: { limit, offset, total: 0, hasMore: false },
      searchTime: `${Date.now() - startTime}ms`,
      results: [],
    };
  }

  // --- 5. Advanced tag filtering (in-memory processing) ---
  let items = await Zotero.Items.getAsync(initialItemIDs);
  const queryTags = Array.isArray(params.tags)
    ? params.tags
    : params.tags
      ? [params.tags]
      : [];
  const matchedTagsStats: Record<string, number> = {};

  if (queryTags.length > 0) {
    const tagMatch = params.tagMatch || "exact";
    const tagMode = params.tagMode || "any";

    const filteredItems: Zotero.Item[] = [];
    items.forEach((item) => {
      const itemTags = (item.getTags?.() || []).map((t) => t.tag);
      const matchedTags: string[] = [];

      for (const queryTag of queryTags) {
        const isMatch = itemTags.some((itemTag) => {
          switch (tagMatch) {
            case "contains":
              return itemTag.toLowerCase().includes(queryTag.toLowerCase());
            case "startsWith":
              return itemTag.toLowerCase().startsWith(queryTag.toLowerCase());
            case "exact":
            default:
              return itemTag.toLowerCase() === queryTag.toLowerCase();
          }
        });
        if (isMatch) {
          matchedTags.push(queryTag);
        }
      }

      const uniqueMatched = [...new Set(matchedTags)];
      let shouldInclude = false;
      switch (tagMode) {
        case "all":
          shouldInclude = uniqueMatched.length === queryTags.length;
          break;
        case "none":
          shouldInclude = uniqueMatched.length === 0;
          break;
        case "any":
        default:
          shouldInclude = uniqueMatched.length > 0;
          break;
      }

      if (shouldInclude) {
        (item as any).matchedTags = uniqueMatched; // Attach matched tags
        filteredItems.push(item);
        uniqueMatched.forEach((tag) => {
          matchedTagsStats[tag] = (matchedTagsStats[tag] || 0) + 1;
        });
      }
    });
    items = filteredItems;
  }

  // --- 5.5. Apply advanced filters ---
  if (
    Object.keys(params).some((key) =>
      [
        "yearRange",
        "dateAddedRange",
        "dateModifiedRange",
        "numPagesRange",
        "titleOperator",
        "creatorOperator",
        "abstractOperator",
        "publicationTitleOperator",
        "language",
        "rights",
        "url",
        "extra",
      ].includes(key),
    )
  ) {
    items = applyAdvancedFilters(items, params);
  }

  // --- 6. Relevance scoring and sorting ---
  const useRelevanceScoring =
    params.relevanceScoring === "true" || sort === "relevance";
  let scoredItems: ScoredItem[] = [];

  if (useRelevanceScoring) {
    scoredItems = items.map((item) => {
      const { score, matchedFields } = calculateRelevanceScore(item, params);
      return {
        item,
        relevanceScore: score,
        matchedFields,
      };
    });

    if (sort === "relevance") {
      // Sort by relevance
      scoredItems.sort((a, b) => {
        const scoreA = a.relevanceScore;
        const scoreB = b.relevanceScore;
        return direction === "asc" ? scoreA - scoreB : scoreB - scoreA;
      });
      items = scoredItems.map((si) => si.item);
    } else {
      // Non-relevance sort, but preserve scoring info
      items.sort((a, b) => {
        let valA: any, valB: any;
        if (sort === "creator") {
          valA = (a.getCreators?.() || []).map((c) => c.lastName).join(", ");
          valB = (b.getCreators?.() || []).map((c) => c.lastName).join(", ");
        } else {
          valA = a.getField(sort as any) || "";
          valB = b.getField(sort as any) || "";
        }
        if (typeof valA === "string") valA = valA.toLowerCase();
        if (typeof valB === "string") valB = valB.toLowerCase();

        if (valA < valB) return direction === "asc" ? -1 : 1;
        if (valA > valB) return direction === "asc" ? 1 : -1;
        return 0;
      });
    }
  } else {
    // Traditional sorting
    items.sort((a, b) => {
      let valA: any, valB: any;
      if (sort === "creator") {
        valA = (a.getCreators?.() || []).map((c) => c.lastName).join(", ");
        valB = (b.getCreators?.() || []).map((c) => c.lastName).join(", ");
      } else {
        valA = a.getField(sort as any) || "";
        valB = b.getField(sort as any) || "";
      }
      if (typeof valA === "string") valA = valA.toLowerCase();
      if (typeof valB === "string") valB = valB.toLowerCase();

      if (valA < valB) return direction === "asc" ? -1 : 1;
      if (valA > valB) return direction === "asc" ? 1 : -1;
      return 0;
    });
  }

  // --- 7. Pagination and formatting ---
  const total = items.length;
  const paginatedItems = items.slice(offset, offset + limit);
  const results = paginatedItems.map((item) => {
    const formatted = formatItemBrief(item);

    // Add attachment path info
    try {
      const attachmentIDs = item.getAttachments();
      if (attachmentIDs && attachmentIDs.length > 0) {
        formatted.attachments = attachmentIDs
          .map((id: number) => {
            const attachment = Zotero.Items.get(id);
            if (attachment && attachment.isAttachment()) {
              return {
                key: attachment.key,
                filename: attachment.attachmentFilename || "",
                filePath: attachment.getFilePath() || "",
                contentType: attachment.attachmentContentType || "",
                linkMode: attachment.attachmentLinkMode,
              };
            }
            return null;
          })
          .filter((att: any) => att !== null);
      } else {
        formatted.attachments = [];
      }
    } catch (error) {
      ztoolkit.log(
        `[SearchEngine] Error getting attachments for item ${item.key}: ${error}`,
        "warn",
      );
      formatted.attachments = [];
    }

    // Add tag match info
    if ((item as any).matchedTags) {
      formatted.matchedTags = (item as any).matchedTags;
    }

    // Add relevance scoring info
    if (useRelevanceScoring) {
      const scoredItem = scoredItems.find((si) => si.item.id === item.id);
      if (scoredItem) {
        formatted.relevanceScore = scoredItem.relevanceScore;
        formatted.matchedFields = scoredItem.matchedFields;
      }
    }

    // Add fulltext search match details
    if (params.fulltext && fulltextMatchDetails.has(item.id)) {
      const matchDetails = fulltextMatchDetails.get(item.id);
      formatted.fulltextMatch = {
        query: params.fulltext,
        mode: params.fulltextMode || "both",
        attachments: matchDetails.attachments || [],
        notes: matchDetails.notes || [],
        totalScore: matchDetails.score || 0,
      };
    }

    return formatted;
  });

  // --- 8. Return final results ---
  const response: Record<string, any> = {
    query: params,
    pagination: {
      limit,
      offset,
      total,
      hasMore: offset + limit < total,
    },
    searchTime: `${Date.now() - startTime}ms`,
    results,
  };

  // Add tag statistics
  if (Object.keys(matchedTagsStats).length > 0) {
    response.matchedTags = matchedTagsStats;
  }

  // Add advanced search statistics
  if (useRelevanceScoring) {
    response.relevanceStats = {
      averageScore:
        scoredItems.length > 0
          ? scoredItems.reduce((sum, item) => sum + item.relevanceScore, 0) /
            scoredItems.length
          : 0,
      maxScore:
        scoredItems.length > 0
          ? Math.max(...scoredItems.map((item) => item.relevanceScore))
          : 0,
      minScore:
        scoredItems.length > 0
          ? Math.min(...scoredItems.map((item) => item.relevanceScore))
          : 0,
    };
  }

  // Add search feature info
  const searchFeatures: string[] = [];
  if (params.q) searchFeatures.push("fulltext");
  if (queryTags.length > 0) searchFeatures.push("tags");
  if (params.yearRange) searchFeatures.push("dateRange");
  if (
    params.titleOperator ||
    params.creatorOperator ||
    params.abstractOperator
  ) {
    searchFeatures.push("advancedOperators");
  }
  if (useRelevanceScoring) searchFeatures.push("relevanceScoring");

  response.searchFeatures = searchFeatures;
  response.version = "2.0"; // Mark as enhanced search engine

  return response;
}
