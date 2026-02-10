/**
 * Write Handlers for Zotero MCP Plugin
 * Provides write operations (notes, tags, collections, items) via Zotero's internal JS API.
 * All writes are gated by the mcp.write.enabled preference.
 */

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

import { config } from "../../package.json";

const PREF_PREFIX = config.prefsPrefix;
const MCP_WRITE_ENABLED = `${PREF_PREFIX}.mcp.write.enabled`;

// --- Error Classes ---

export class WriteDisabledError extends Error {
  constructor(message?: string) {
    super(
      message ||
        "Write operations are disabled. Enable 'Allow write operations' in Zotero → Settings → Zotero MCP Plugin.",
    );
    this.name = "WriteDisabledError";
  }
}

export class ItemNotFoundError extends Error {
  constructor(itemKey: string) {
    super(`Item with key "${itemKey}" not found in library`);
    this.name = "ItemNotFoundError";
  }
}

export class CollectionNotFoundError extends Error {
  constructor(collectionKey: string) {
    super(`Collection with key "${collectionKey}" not found`);
    this.name = "CollectionNotFoundError";
  }
}

export class BatchLimitError extends Error {
  constructor(limit: number) {
    super(`Batch operations are limited to ${limit} items`);
    this.name = "BatchLimitError";
  }
}

// --- Response Interface ---

export interface MutationResult {
  success: boolean;
  action: string;
  itemKey: string;
  details: Record<string, any>;
  timestamp: string;
}

// --- Shared Utilities ---

export function isWriteEnabled(): boolean {
  try {
    const enabled = Zotero.Prefs.get(MCP_WRITE_ENABLED, true);
    return enabled === true;
  } catch {
    return false;
  }
}

function assertWriteEnabled(): void {
  if (!isWriteEnabled()) {
    throw new WriteDisabledError();
  }
}

function resolveItem(itemKey: string): any {
  const item = Zotero.Items.getByLibraryAndKey(
    Zotero.Libraries.userLibraryID,
    itemKey,
  );
  if (!item) {
    throw new ItemNotFoundError(itemKey);
  }
  return item;
}

function resolveCollection(collectionKey: string): any {
  const collection = Zotero.Collections.getByLibraryAndKey(
    Zotero.Libraries.userLibraryID,
    collectionKey,
  );
  if (!collection) {
    throw new CollectionNotFoundError(collectionKey);
  }
  return collection;
}

// --- Priority 1: Core Write Handlers ---

export async function handleAddNote(args: {
  itemKey?: string;
  content: string;
  tags?: string[];
}): Promise<MutationResult> {
  assertWriteEnabled();

  if (!args.content || args.content.trim().length === 0) {
    throw new Error("Note content cannot be empty");
  }

  const noteItem = new Zotero.Item("note");
  noteItem.libraryID = Zotero.Libraries.userLibraryID;

  if (args.itemKey) {
    const parentItem = resolveItem(args.itemKey);
    noteItem.parentKey = parentItem.key;
  }

  noteItem.setNote(args.content);

  if (args.tags && args.tags.length > 0) {
    for (const tag of args.tags) {
      const trimmed = tag.trim();
      if (trimmed) {
        noteItem.addTag(trimmed, 0);
      }
    }
  }

  const noteID = await noteItem.saveTx();

  ztoolkit.log(
    `[WriteHandlers] Created note ${noteItem.key} (parent: ${args.itemKey || "standalone"})`,
  );

  return {
    success: true,
    action: "add_note",
    itemKey: noteItem.key,
    details: {
      noteKey: noteItem.key,
      noteID,
      parentItemKey: args.itemKey || null,
      contentLength: args.content.length,
      isStandalone: !args.itemKey,
      tags: args.tags || [],
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleAddTags(args: {
  itemKey: string;
  tags: string[];
  type?: number;
}): Promise<MutationResult> {
  assertWriteEnabled();

  if (!args.tags || args.tags.length === 0) {
    throw new Error("At least one tag is required");
  }

  const item = resolveItem(args.itemKey);
  const tagType = args.type ?? 0;

  const added: string[] = [];
  const skipped: string[] = [];

  for (const tag of args.tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;

    if (item.hasTag(trimmed)) {
      skipped.push(trimmed);
    } else {
      item.addTag(trimmed, tagType);
      added.push(trimmed);
    }
  }

  if (added.length > 0) {
    await item.saveTx();
  }

  ztoolkit.log(
    `[WriteHandlers] Tagged ${args.itemKey}: added=${added.length}, skipped=${skipped.length}`,
  );

  return {
    success: true,
    action: "add_tags",
    itemKey: args.itemKey,
    details: {
      added,
      skipped,
      totalTagsNow: item.getTags().length,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleRemoveTags(args: {
  itemKey: string;
  tags: string[];
}): Promise<MutationResult> {
  assertWriteEnabled();

  if (!args.tags || args.tags.length === 0) {
    throw new Error("At least one tag is required");
  }

  const item = resolveItem(args.itemKey);

  const removed: string[] = [];
  const notFound: string[] = [];

  for (const tag of args.tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;

    if (item.hasTag(trimmed)) {
      item.removeTag(trimmed);
      removed.push(trimmed);
    } else {
      notFound.push(trimmed);
    }
  }

  if (removed.length > 0) {
    await item.saveTx();
  }

  ztoolkit.log(
    `[WriteHandlers] Untagged ${args.itemKey}: removed=${removed.length}, notFound=${notFound.length}`,
  );

  return {
    success: true,
    action: "remove_tags",
    itemKey: args.itemKey,
    details: {
      removed,
      notFound,
      totalTagsNow: item.getTags().length,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleAddToCollection(args: {
  itemKey: string;
  collectionKey: string;
}): Promise<MutationResult> {
  assertWriteEnabled();

  const item = resolveItem(args.itemKey);
  const collection = resolveCollection(args.collectionKey);

  // Check if already in collection
  if (collection.hasItem(item.id)) {
    ztoolkit.log(
      `[WriteHandlers] Item ${args.itemKey} already in collection ${args.collectionKey}`,
    );
    return {
      success: true,
      action: "add_to_collection",
      itemKey: args.itemKey,
      details: {
        collectionKey: args.collectionKey,
        collectionName: collection.name,
        alreadyInCollection: true,
      },
      timestamp: new Date().toISOString(),
    };
  }

  item.addToCollection(collection.key);
  await item.saveTx({ skipDateModifiedUpdate: true });

  ztoolkit.log(
    `[WriteHandlers] Added ${args.itemKey} to collection "${collection.name}"`,
  );

  return {
    success: true,
    action: "add_to_collection",
    itemKey: args.itemKey,
    details: {
      collectionKey: args.collectionKey,
      collectionName: collection.name,
      alreadyInCollection: false,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleCreateCollection(args: {
  name: string;
  parentCollectionKey?: string;
}): Promise<MutationResult> {
  assertWriteEnabled();

  if (!args.name || args.name.trim().length === 0) {
    throw new Error("Collection name cannot be empty");
  }

  const collection = new Zotero.Collection();
  collection.name = args.name.trim();
  collection.libraryID = Zotero.Libraries.userLibraryID;

  if (args.parentCollectionKey) {
    const parent = resolveCollection(args.parentCollectionKey);
    collection.parentKey = parent.key;
  }

  await collection.saveTx();

  ztoolkit.log(
    `[WriteHandlers] Created collection "${collection.name}" (key: ${collection.key})`,
  );

  return {
    success: true,
    action: "create_collection",
    itemKey: collection.key,
    details: {
      collectionKey: collection.key,
      name: collection.name,
      parentCollectionKey: args.parentCollectionKey || null,
    },
    timestamp: new Date().toISOString(),
  };
}

// --- Priority 2: Extended Write Handlers ---

export async function handleUpdateItem(args: {
  itemKey: string;
  fields: Record<string, string>;
  creators?: Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
    creatorType: string;
  }>;
}): Promise<MutationResult> {
  assertWriteEnabled();

  const item = resolveItem(args.itemKey);

  const restrictedFields = [
    "key",
    "itemType",
    "dateAdded",
    "dateModified",
    "libraryID",
    "version",
  ];

  const updated: string[] = [];
  const errors: Array<{ field: string; error: string }> = [];

  for (const [field, value] of Object.entries(args.fields)) {
    if (restrictedFields.includes(field)) {
      errors.push({
        field,
        error: `Field "${field}" cannot be modified via this tool`,
      });
      continue;
    }

    try {
      item.setField(field, value);
      updated.push(field);
    } catch (e) {
      errors.push({
        field,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (args.creators) {
    try {
      item.setCreators(
        args.creators.map((c) => ({
          creatorType: c.creatorType,
          ...(c.name
            ? { name: c.name, fieldMode: 1 }
            : { firstName: c.firstName || "", lastName: c.lastName || "" }),
        })),
      );
      updated.push("creators");
    } catch (e) {
      errors.push({
        field: "creators",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (updated.length > 0) {
    await item.saveTx();
  }

  ztoolkit.log(
    `[WriteHandlers] Updated ${args.itemKey}: ${updated.join(", ")} (errors: ${errors.length})`,
  );

  return {
    success: updated.length > 0,
    action: "update_item",
    itemKey: args.itemKey,
    details: { updated, errors },
    timestamp: new Date().toISOString(),
  };
}

export async function handleCreateItem(args: {
  itemType: string;
  fields?: Record<string, string>;
  creators?: Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
    creatorType: string;
  }>;
  tags?: string[];
  collections?: string[];
}): Promise<MutationResult> {
  assertWriteEnabled();

  const item = new Zotero.Item(args.itemType);
  item.libraryID = Zotero.Libraries.userLibraryID;

  const fieldErrors: Array<{ field: string; error: string }> = [];

  if (args.fields) {
    for (const [field, value] of Object.entries(args.fields)) {
      try {
        item.setField(field, value);
      } catch (e) {
        fieldErrors.push({
          field,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  if (args.creators) {
    try {
      item.setCreators(
        args.creators.map((c) => ({
          creatorType: c.creatorType,
          ...(c.name
            ? { name: c.name, fieldMode: 1 }
            : { firstName: c.firstName || "", lastName: c.lastName || "" }),
        })),
      );
    } catch (e) {
      fieldErrors.push({
        field: "creators",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (args.tags) {
    for (const tag of args.tags) {
      const trimmed = tag.trim();
      if (trimmed) {
        item.addTag(trimmed, 0);
      }
    }
  }

  if (args.collections) {
    for (const collectionKey of args.collections) {
      // Validate collection exists
      resolveCollection(collectionKey);
      item.addToCollection(collectionKey);
    }
  }

  const itemID = await item.saveTx();

  ztoolkit.log(
    `[WriteHandlers] Created ${args.itemType} item "${item.getField("title") || "(untitled)"}" (key: ${item.key})`,
  );

  return {
    success: true,
    action: "create_item",
    itemKey: item.key,
    details: {
      itemID,
      itemType: args.itemType,
      title: item.getField("title") || null,
      fieldErrors: fieldErrors.length > 0 ? fieldErrors : undefined,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleRemoveFromCollection(args: {
  itemKey: string;
  collectionKey: string;
}): Promise<MutationResult> {
  assertWriteEnabled();

  const item = resolveItem(args.itemKey);
  const collection = resolveCollection(args.collectionKey);

  if (!collection.hasItem(item.id)) {
    ztoolkit.log(
      `[WriteHandlers] Item ${args.itemKey} not in collection ${args.collectionKey}`,
    );
    return {
      success: true,
      action: "remove_from_collection",
      itemKey: args.itemKey,
      details: {
        collectionKey: args.collectionKey,
        collectionName: collection.name,
        wasInCollection: false,
      },
      timestamp: new Date().toISOString(),
    };
  }

  item.removeFromCollection(collection.key);
  await item.saveTx({ skipDateModifiedUpdate: true });

  ztoolkit.log(
    `[WriteHandlers] Removed ${args.itemKey} from collection "${collection.name}"`,
  );

  return {
    success: true,
    action: "remove_from_collection",
    itemKey: args.itemKey,
    details: {
      collectionKey: args.collectionKey,
      collectionName: collection.name,
      wasInCollection: true,
    },
    timestamp: new Date().toISOString(),
  };
}

// --- Priority 3: Batch Handlers ---

const BATCH_LIMIT = 100;

export async function handleBatchTag(args: {
  itemKeys: string[];
  tags: string[];
  type?: number;
}): Promise<MutationResult> {
  assertWriteEnabled();

  if (!args.itemKeys || args.itemKeys.length === 0) {
    throw new Error("At least one itemKey is required");
  }
  if (!args.tags || args.tags.length === 0) {
    throw new Error("At least one tag is required");
  }
  if (args.itemKeys.length > BATCH_LIMIT) {
    throw new BatchLimitError(BATCH_LIMIT);
  }

  const tagType = args.type ?? 0;
  const results: Array<{
    itemKey: string;
    added: string[];
    skipped: string[];
    error?: string;
  }> = [];

  await Zotero.DB.executeTransaction(async () => {
    for (const itemKey of args.itemKeys) {
      try {
        const item = resolveItem(itemKey);
        const added: string[] = [];
        const skipped: string[] = [];

        for (const tag of args.tags) {
          const trimmed = tag.trim();
          if (!trimmed) continue;

          if (item.hasTag(trimmed)) {
            skipped.push(trimmed);
          } else {
            item.addTag(trimmed, tagType);
            added.push(trimmed);
          }
        }

        if (added.length > 0) {
          await item.save();
        }

        results.push({ itemKey, added, skipped });
      } catch (e) {
        results.push({
          itemKey,
          added: [],
          skipped: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  const totalAdded = results.reduce((sum, r) => sum + r.added.length, 0);

  ztoolkit.log(
    `[WriteHandlers] Batch tagged ${args.itemKeys.length} items: ${totalAdded} tags added`,
  );

  return {
    success: totalAdded > 0 || results.every((r) => !r.error),
    action: "batch_tag",
    itemKey: args.itemKeys[0],
    details: {
      totalItems: args.itemKeys.length,
      totalTagsAdded: totalAdded,
      results,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleBatchAddToCollection(args: {
  itemKeys: string[];
  collectionKey: string;
}): Promise<MutationResult> {
  assertWriteEnabled();

  if (!args.itemKeys || args.itemKeys.length === 0) {
    throw new Error("At least one itemKey is required");
  }
  if (args.itemKeys.length > BATCH_LIMIT) {
    throw new BatchLimitError(BATCH_LIMIT);
  }

  const collection = resolveCollection(args.collectionKey);

  const results: Array<{
    itemKey: string;
    added: boolean;
    alreadyInCollection: boolean;
    error?: string;
  }> = [];

  await Zotero.DB.executeTransaction(async () => {
    for (const itemKey of args.itemKeys) {
      try {
        const item = resolveItem(itemKey);

        if (collection.hasItem(item.id)) {
          results.push({
            itemKey,
            added: false,
            alreadyInCollection: true,
          });
        } else {
          item.addToCollection(collection.key);
          await item.save({ skipDateModifiedUpdate: true });
          results.push({
            itemKey,
            added: true,
            alreadyInCollection: false,
          });
        }
      } catch (e) {
        results.push({
          itemKey,
          added: false,
          alreadyInCollection: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  const totalAdded = results.filter((r) => r.added).length;

  ztoolkit.log(
    `[WriteHandlers] Batch added ${totalAdded}/${args.itemKeys.length} items to "${collection.name}"`,
  );

  return {
    success: totalAdded > 0 || results.every((r) => !r.error),
    action: "batch_add_to_collection",
    itemKey: args.itemKeys[0],
    details: {
      collectionKey: args.collectionKey,
      collectionName: collection.name,
      totalItems: args.itemKeys.length,
      totalAdded,
      results,
    },
    timestamp: new Date().toISOString(),
  };
}
