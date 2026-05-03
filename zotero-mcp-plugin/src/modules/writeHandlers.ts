/**
 * Write Handlers for Zotero MCP Plugin
 * Provides write operations (notes, tags, collections, items) via Zotero's internal JS API.
 *
 * Writes are gated by per-scope preferences in serverPreferences (notes,
 * tags, collections, metadata, delete, bulk, import). Each handler asserts
 * the specific scope it needs, so a user who only enables "notes" cannot be
 * tricked into a destructive call.
 */

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

import { serverPreferences, type WriteScope } from "./serverPreferences";
import { resolvePMCPDFURL } from "./pmcURLResolver";

const ZOTERO_KEY_RE = /^[A-Z0-9]{8}$/;

function assertValidItemKey(itemKey: string, label = "itemKey"): void {
  if (!itemKey || typeof itemKey !== "string" || !ZOTERO_KEY_RE.test(itemKey)) {
    throw new Error(`Invalid ${label} format (expected 8-char A-Z/0-9)`);
  }
}

function assertValidCollectionKey(
  collectionKey: string,
  label = "collectionKey",
): void {
  if (
    !collectionKey ||
    typeof collectionKey !== "string" ||
    !ZOTERO_KEY_RE.test(collectionKey)
  ) {
    throw new Error(`Invalid ${label} format (expected 8-char A-Z/0-9)`);
  }
}

// --- Error Classes ---

export class InvalidURLError extends Error {
  constructor(url: string, reason: string) {
    super(`Invalid attachment URL "${url}": ${reason}`);
    this.name = "InvalidURLError";
  }
}

export class WriteDisabledError extends Error {
  public scope?: WriteScope;
  constructor(scope?: WriteScope, message?: string) {
    super(
      message ||
        (scope
          ? `Write scope '${scope}' is disabled. Enable it in Zotero → Settings → Zotero MCP Plugin.`
          : "Write operations are disabled. Enable the relevant scope in Zotero → Settings → Zotero MCP Plugin."),
    );
    this.name = "WriteDisabledError";
    this.scope = scope;
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

/** Back-compat shim: any write scope on means "write enabled". */
export function isWriteEnabled(): boolean {
  return serverPreferences.isAnyWriteScopeEnabled();
}

export function isScopeEnabled(scope: WriteScope): boolean {
  return serverPreferences.isScopeEnabled(scope);
}

function assertScope(scope: WriteScope): void {
  if (!serverPreferences.isScopeEnabled(scope)) {
    throw new WriteDisabledError(scope);
  }
}

/** Require every listed scope (e.g. bulk-trash needs `bulk` AND `delete`). */
function assertScopes(scopes: WriteScope[]): void {
  for (const s of scopes) assertScope(s);
}

function resolveItem(itemKey: string): any {
  assertValidItemKey(itemKey);
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
  assertValidCollectionKey(collectionKey);
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
  assertScope("notes");

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
  assertScope("tags");

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
  assertScope("tags");

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
  assertScope("collections");

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
  assertScope("collections");

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
  assertScope("metadata");

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
  assertScope("metadata");

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
  assertScope("collections");

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
  assertScopes(["bulk", "tags"]);

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
  assertScopes(["bulk", "collections"]);

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

// --- Tier 1: Additional Write Handlers ---

export async function handleUpdateNote(args: {
  noteKey: string;
  content: string;
  tags?: string[];
}): Promise<MutationResult> {
  assertScope("notes");

  if (!args.noteKey) {
    throw new Error("noteKey is required");
  }
  if (!args.content || args.content.trim().length === 0) {
    throw new Error("Note content cannot be empty");
  }

  const item = resolveItem(args.noteKey);

  if (!item.isNote()) {
    throw new Error(
      `Item "${args.noteKey}" is not a note (type: ${item.itemType})`,
    );
  }

  item.setNote(args.content);

  if (args.tags !== undefined) {
    // Replace all tags
    const existingTags = item.getTags();
    for (const tag of existingTags) {
      item.removeTag(tag.tag);
    }
    for (const tag of args.tags) {
      const trimmed = tag.trim();
      if (trimmed) {
        item.addTag(trimmed, 0);
      }
    }
  }

  await item.saveTx();

  ztoolkit.log(
    `[WriteHandlers] Updated note ${args.noteKey} (${args.content.length} chars)`,
  );

  return {
    success: true,
    action: "update_note",
    itemKey: args.noteKey,
    details: {
      contentLength: args.content.length,
      tags: args.tags || null,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleTrashItem(args: {
  itemKey: string;
}): Promise<MutationResult> {
  assertScope("delete");

  if (!args.itemKey) {
    throw new Error("itemKey is required");
  }

  const item = resolveItem(args.itemKey);
  const title = item.getField("title") || item.key;
  const itemType = item.itemType;

  await Zotero.Items.trashTx(item.id);

  ztoolkit.log(`[WriteHandlers] Trashed item ${args.itemKey} ("${title}")`);

  return {
    success: true,
    action: "trash_item",
    itemKey: args.itemKey,
    details: {
      title,
      itemType,
      trashedAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleRenameCollection(args: {
  collectionKey: string;
  newName: string;
}): Promise<MutationResult> {
  assertScope("collections");

  if (!args.collectionKey) {
    throw new Error("collectionKey is required");
  }
  if (!args.newName || args.newName.trim().length === 0) {
    throw new Error("newName cannot be empty");
  }

  const collection = resolveCollection(args.collectionKey);
  const oldName = collection.name;

  collection.name = args.newName.trim();
  await collection.saveTx();

  ztoolkit.log(
    `[WriteHandlers] Renamed collection "${oldName}" → "${collection.name}"`,
  );

  return {
    success: true,
    action: "rename_collection",
    itemKey: args.collectionKey,
    details: {
      collectionKey: args.collectionKey,
      oldName,
      newName: collection.name,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleDeleteCollection(args: {
  collectionKey: string;
  deleteItems?: boolean;
}): Promise<MutationResult> {
  // Always require `delete`. If the user opted into deleteItems=true, require
  // `bulk` too — this turns one tool call into a hard delete of every item.
  if (args.deleteItems === true) {
    assertScopes(["delete", "bulk"]);
  } else {
    assertScope("delete");
  }

  if (!args.collectionKey) {
    throw new Error("collectionKey is required");
  }

  const collection = resolveCollection(args.collectionKey);
  const name = collection.name;
  const deleteItems = args.deleteItems || false;

  await collection.eraseTx({ deleteItems });

  ztoolkit.log(
    `[WriteHandlers] Deleted collection "${name}" (deleteItems: ${deleteItems})`,
  );

  return {
    success: true,
    action: "delete_collection",
    itemKey: args.collectionKey,
    details: {
      collectionKey: args.collectionKey,
      name,
      deleteItems,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleRenameTag(args: {
  oldName: string;
  newName: string;
}): Promise<MutationResult> {
  // Library-wide tag rewrite. Need both `tags` and `bulk` since a single call
  // mutates every item carrying that tag.
  assertScopes(["tags", "bulk"]);

  if (!args.oldName || args.oldName.trim().length === 0) {
    throw new Error("oldName is required");
  }
  if (!args.newName || args.newName.trim().length === 0) {
    throw new Error("newName is required");
  }

  const libraryID = Zotero.Libraries.userLibraryID;
  const oldName = args.oldName.trim();
  const newName = args.newName.trim();

  await Zotero.Tags.rename(libraryID, oldName, newName);

  ztoolkit.log(`[WriteHandlers] Renamed tag "${oldName}" → "${newName}"`);

  return {
    success: true,
    action: "rename_tag",
    itemKey: oldName,
    details: {
      oldName,
      newName,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleDeleteTag(args: {
  tagName: string;
}): Promise<MutationResult> {
  // Library-wide tag deletion strips the tag from every item.
  assertScopes(["delete", "bulk"]);

  if (!args.tagName || args.tagName.trim().length === 0) {
    throw new Error("tagName is required");
  }

  const libraryID = Zotero.Libraries.userLibraryID;
  const tagName = args.tagName.trim();

  // Look up tag ID
  const tagID = Zotero.Tags.getID(tagName);
  if (!tagID) {
    throw new Error(`Tag "${tagName}" not found in library`);
  }

  await Zotero.Tags.removeFromLibrary(libraryID, [tagID]);

  ztoolkit.log(`[WriteHandlers] Deleted tag "${tagName}" from library`);

  return {
    success: true,
    action: "delete_tag",
    itemKey: tagName,
    details: {
      tagName,
      tagID,
    },
    timestamp: new Date().toISOString(),
  };
}

// --- Tier 2: Extended Write Handlers ---

export async function handleAddRelatedItem(args: {
  itemKey: string;
  relatedItemKey: string;
}): Promise<MutationResult> {
  assertScope("metadata");

  if (!args.itemKey) {
    throw new Error("itemKey is required");
  }
  if (!args.relatedItemKey) {
    throw new Error("relatedItemKey is required");
  }
  if (args.itemKey === args.relatedItemKey) {
    throw new Error("Cannot relate an item to itself");
  }

  const item = resolveItem(args.itemKey);
  const relatedItem = resolveItem(args.relatedItemKey);

  // Atomic bidirectional relation: both sides save in the same transaction.
  // Without this, a failure on the second save leaves a half-related state
  // (A→B exists, B→A doesn't) while still reporting success.
  await Zotero.DB.executeTransaction(async () => {
    item.addRelatedItem(relatedItem);
    await item.save();
    relatedItem.addRelatedItem(item);
    await relatedItem.save();
  });

  ztoolkit.log(
    `[WriteHandlers] Related items ${args.itemKey} ↔ ${args.relatedItemKey}`,
  );

  return {
    success: true,
    action: "add_related_item",
    itemKey: args.itemKey,
    details: {
      itemKey: args.itemKey,
      relatedItemKey: args.relatedItemKey,
      bidirectional: true,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleRemoveRelatedItem(args: {
  itemKey: string;
  relatedItemKey: string;
}): Promise<MutationResult> {
  assertScope("metadata");

  if (!args.itemKey) {
    throw new Error("itemKey is required");
  }
  if (!args.relatedItemKey) {
    throw new Error("relatedItemKey is required");
  }

  const item = resolveItem(args.itemKey);
  const relatedItem = resolveItem(args.relatedItemKey);

  // Atomic bidirectional removal — see handleAddRelatedItem for rationale.
  await Zotero.DB.executeTransaction(async () => {
    item.removeRelatedItem(relatedItem);
    await item.save();
    relatedItem.removeRelatedItem(item);
    await relatedItem.save();
  });

  ztoolkit.log(
    `[WriteHandlers] Unrelated items ${args.itemKey} ↔ ${args.relatedItemKey}`,
  );

  return {
    success: true,
    action: "remove_related_item",
    itemKey: args.itemKey,
    details: {
      itemKey: args.itemKey,
      relatedItemKey: args.relatedItemKey,
      bidirectional: true,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reject obviously dangerous URLs before passing them to
 * Zotero.Attachments.importFromURL. The MCP server is reachable from any local
 * client, so an unvalidated URL is an SSRF vector — the Zotero process can be
 * coerced into hitting cloud metadata services, internal LAN hosts, or local
 * file paths.
 *
 * This is a string-level guard. It does not resolve DNS, so a public hostname
 * that resolves to a private IP, or a public URL that 30x-redirects to one,
 * still gets through. The `import` write scope must be enabled separately,
 * which is the second layer of defense; treat this validator as defense-in-
 * depth, not a complete fix.
 */
function validateAttachmentURL(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "invalid URL";
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `scheme not allowed (${u.protocol})`;
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) {
    return "missing hostname";
  }

  // Loopback hostnames.
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "loopback hostname not allowed";
  }

  const v4 = parseIPv4Liberal(host);
  if (v4) {
    if (isPrivateIPv4(v4)) {
      return `private or loopback IPv4 not allowed (${host})`;
    }
  }

  // IPv6 loopback / link-local / unique-local plus v4-mapped-v6.
  if (host === "::1" || host === "::") {
    return `private or loopback IPv6 not allowed (${host})`;
  }
  if (/^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) {
    return `private or loopback IPv6 not allowed (${host})`;
  }
  // ::ffff:127.0.0.1 or ::ffff:7f00:0001 — IPv4-mapped IPv6.
  const mapped = host.match(/^::ffff:(.+)$/i);
  if (mapped) {
    const inner = mapped[1];
    const innerV4 = parseIPv4Liberal(inner);
    if (innerV4 && isPrivateIPv4(innerV4)) {
      return `private or loopback IPv6-mapped IPv4 not allowed (${host})`;
    }
    // Inner could be hex pairs (7f00:0001 = 127.0.0.1).
    const hexMatch = inner.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const a = parseInt(hexMatch[1], 16);
      const b = parseInt(hexMatch[2], 16);
      const tuple: [number, number, number, number] = [
        (a >> 8) & 0xff,
        a & 0xff,
        (b >> 8) & 0xff,
        b & 0xff,
      ];
      if (isPrivateIPv4(tuple)) {
        return `private or loopback IPv6-mapped IPv4 not allowed (${host})`;
      }
    }
  }

  return null;
}

/**
 * Parse an IPv4 address that may be in dotted-decimal, decimal, or octal
 * forms. Returns the four octets, or null if the string is not a valid
 * IPv4 address. `2130706433` and `0177.0.0.1` both decode to 127.0.0.1.
 */
function parseIPv4Liberal(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  const parsePart = (p: string): number | null => {
    if (p === "") return null;
    let n: number;
    if (/^0x/i.test(p)) {
      n = parseInt(p, 16);
    } else if (/^0/.test(p) && p.length > 1) {
      n = parseInt(p, 8);
    } else if (/^\d+$/.test(p)) {
      n = parseInt(p, 10);
    } else {
      return null;
    }
    return isNaN(n) ? null : n;
  };
  if (parts.length === 4) {
    const out = parts.map(parsePart);
    if (
      out.some((x) => x === null || (x as number) > 255 || (x as number) < 0)
    ) {
      return null;
    }
    return out as [number, number, number, number];
  }
  if (parts.length === 1) {
    const n = parsePart(parts[0]);
    if (n === null || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  return null;
}

function isPrivateIPv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

/**
 * Infer a MIME type from a URL when the caller didn't supply one.
 *
 * Zotero's `importFromURL` has two internal paths: a binary-download path
 * (used when `contentType` is supplied and isn't `text/html`) and an
 * HTML-snapshot path that runs the URL through a hidden browser plus
 * SingleFile. The snapshot path is fragile under parallel calls — it has
 * been observed to throw `TypeError: parts.pathname is null`,
 * `'contentType' not provided`, and `AbortError: Actor 'SingleFile'
 * destroyed before query 'snapshot' was resolved` for ordinary PMC PDF
 * URLs. Steering callers onto the binary path by guessing a content-type
 * from the URL avoids all three.
 *
 * Conservative: only returns a guess for unambiguous cases. Callers can
 * always override with the explicit `contentType` parameter.
 */
export function inferContentTypeFromURL(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  if (pathname.endsWith(".pdf")) return "application/pdf";
  if (pathname.endsWith(".epub")) return "application/epub+zip";
  // PubMed Central PDF directory URLs (e.g. .../PMC1234567/pdf/) serve a
  // PDF (or a redirect to one) when fetched as a file. Same for the rare
  // trailing-slashless variant. Treating these as PDF avoids the snapshot
  // path; if the server actually returns HTML, Zotero's downstream type
  // sniff still rejects it with a clear "not a supported type" error.
  if (pathname.endsWith("/pdf/") || pathname.endsWith("/pdf")) {
    return "application/pdf";
  }
  return undefined;
}

export async function handleImportAttachmentURL(args: {
  url: string;
  parentItemKey?: string;
  title?: string;
  contentType?: string;
}): Promise<MutationResult> {
  assertScope("import");

  if (!args.url) {
    throw new Error("url is required");
  }

  const urlError = validateAttachmentURL(args.url);
  if (urlError) {
    throw new InvalidURLError(args.url, urlError);
  }

  const libraryID = Zotero.Libraries.userLibraryID;
  let parentItemID: number | undefined;

  if (args.parentItemKey) {
    const parentItem = resolveItem(args.parentItemKey);
    parentItemID = parentItem.id;
  }

  // PMC `/pdf/` URLs serve an HTML gateway that points at the actual
  // PDF via <meta name="citation_pdf_url">. Resolve it here so Zotero
  // gets handed the real file URL. Best-effort — null on any failure
  // means "fall back to the original URL".
  let importURL = args.url;
  const pmcResolved = await resolvePMCPDFURL(args.url);
  if (pmcResolved && pmcResolved !== args.url) {
    const resolvedError = validateAttachmentURL(pmcResolved);
    if (resolvedError) {
      // Resolution produced a URL that fails the SSRF guard — refuse to
      // follow it. Keep going with the original URL.
      ztoolkit.log(
        `[WriteHandlers] PMC resolver returned URL that failed SSRF guard (${resolvedError}); using original`,
      );
    } else {
      importURL = pmcResolved;
    }
  }

  const resolvedContentType =
    args.contentType ?? inferContentTypeFromURL(importURL);

  const importOptions: any = {
    libraryID,
    url: importURL,
  };
  if (parentItemID !== undefined) {
    importOptions.parentItemID = parentItemID;
  }
  if (args.title) {
    importOptions.title = args.title;
  }
  if (resolvedContentType) {
    importOptions.contentType = resolvedContentType;
  }

  let attachment: any;
  try {
    attachment = await Zotero.Attachments.importFromURL(importOptions);
  } catch (err: any) {
    // Zotero's snapshot path throws "TypeError: can't access property
    // 'split', parts.pathname is null" when no contentType is supplied
    // and the URL it follows ends up with a parser-hostile final URL.
    // Re-surface with guidance instead of leaking an internal stack.
    const msg = err?.message || String(err);
    if (/parts\.pathname is null/i.test(msg)) {
      throw new Error(
        `Zotero failed to snapshot ${importURL} (parts.pathname is null). ` +
          `This usually means the URL was routed through the SingleFile ` +
          `snapshotter. Pass contentType (e.g. "application/pdf") to use ` +
          `the binary-download path instead.`,
      );
    }
    if (/'contentType' not provided/i.test(msg)) {
      throw new Error(
        `Zotero refused to import ${importURL}: contentType could not be ` +
          `inferred from the URL. Pass contentType explicitly (e.g. ` +
          `"application/pdf" or "text/html").`,
      );
    }
    throw err;
  }

  ztoolkit.log(
    `[WriteHandlers] Imported attachment from URL: ${importURL} (key: ${attachment.key}, contentType: ${resolvedContentType ?? "auto"})`,
  );

  return {
    success: true,
    action: "import_attachment_url",
    itemKey: attachment.key,
    details: {
      attachmentKey: attachment.key,
      url: importURL,
      originalUrl: importURL === args.url ? null : args.url,
      parentItemKey: args.parentItemKey || null,
      title: args.title || null,
      contentType: resolvedContentType || null,
    },
    timestamp: new Date().toISOString(),
  };
}

// --- Tier 3: Additional Write Handlers ---

export async function handleRestoreFromTrash(args: {
  itemKey: string;
}): Promise<MutationResult> {
  assertScope("delete");

  if (!args.itemKey) {
    throw new Error("itemKey is required");
  }

  const libraryID = Zotero.Libraries.userLibraryID;

  // Try normal resolution first (trashed items may still resolve)
  let item = Zotero.Items.getByLibraryAndKey(libraryID, args.itemKey);

  // If not found via getByLibraryAndKey, search among deleted items
  if (!item) {
    const deletedIDs = await Zotero.Items.getDeleted(libraryID, true);
    if (deletedIDs && deletedIDs.length > 0) {
      const deletedItems = await Zotero.Items.getAsync(deletedIDs);
      item = deletedItems.find((i: any) => i.key === args.itemKey);
    }
  }

  if (!item) {
    throw new ItemNotFoundError(args.itemKey);
  }

  if (!item.deleted) {
    return {
      success: true,
      action: "restore_from_trash",
      itemKey: args.itemKey,
      details: {
        alreadyRestored: true,
        title: item.getField("title") || item.key,
      },
      timestamp: new Date().toISOString(),
    };
  }

  item.deleted = false;
  await item.saveTx();

  const title = item.getField("title") || item.key;

  ztoolkit.log(
    `[WriteHandlers] Restored item ${args.itemKey} ("${title}") from trash`,
  );

  return {
    success: true,
    action: "restore_from_trash",
    itemKey: args.itemKey,
    details: {
      title,
      itemType: item.itemType,
      restoredAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleMoveCollection(args: {
  collectionKey: string;
  newParentKey?: string;
}): Promise<MutationResult> {
  assertScope("collections");

  if (!args.collectionKey) {
    throw new Error("collectionKey is required");
  }

  // Reject self-parent up front. The previous loop walked the new parent's
  // ancestry checking parentKey === collectionKey, which only catches
  // *transitive* cycles, not the direct case `move(A, A)`.
  if (args.newParentKey === args.collectionKey) {
    throw new Error(
      "Cannot move collection: a collection cannot be its own parent",
    );
  }

  const collection = resolveCollection(args.collectionKey);
  const oldParentKey = collection.parentKey || null;

  if (args.newParentKey) {
    const newParent = resolveCollection(args.newParentKey);

    // Validate no circular parent: walk up from newParent to ensure we don't hit collection
    let current: any = newParent;
    while (current && current.parentKey) {
      if (current.parentKey === args.collectionKey) {
        throw new Error(
          "Cannot move collection: would create circular parent hierarchy",
        );
      }
      current = Zotero.Collections.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        current.parentKey,
      );
    }

    collection.parentKey = args.newParentKey;
  } else {
    // Move to root
    collection.parentKey = false;
  }

  await collection.saveTx();

  ztoolkit.log(
    `[WriteHandlers] Moved collection "${collection.name}" (parent: ${oldParentKey} → ${args.newParentKey || "root"})`,
  );

  return {
    success: true,
    action: "move_collection",
    itemKey: args.collectionKey,
    details: {
      collectionKey: args.collectionKey,
      name: collection.name,
      oldParentKey,
      newParentKey: args.newParentKey || null,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleBatchRemoveFromCollection(args: {
  itemKeys: string[];
  collectionKey: string;
}): Promise<MutationResult> {
  assertScopes(["bulk", "collections"]);

  if (!args.itemKeys || args.itemKeys.length === 0) {
    throw new Error("At least one itemKey is required");
  }
  if (!args.collectionKey) {
    throw new Error("collectionKey is required");
  }
  if (args.itemKeys.length > BATCH_LIMIT) {
    throw new BatchLimitError(BATCH_LIMIT);
  }

  const collection = resolveCollection(args.collectionKey);

  const results: Array<{
    itemKey: string;
    removed: boolean;
    wasInCollection: boolean;
    error?: string;
  }> = [];

  await Zotero.DB.executeTransaction(async () => {
    for (const itemKey of args.itemKeys) {
      try {
        const item = resolveItem(itemKey);

        if (!collection.hasItem(item.id)) {
          results.push({
            itemKey,
            removed: false,
            wasInCollection: false,
          });
        } else {
          item.removeFromCollection(collection.key);
          await item.save({ skipDateModifiedUpdate: true });
          results.push({
            itemKey,
            removed: true,
            wasInCollection: true,
          });
        }
      } catch (e) {
        results.push({
          itemKey,
          removed: false,
          wasInCollection: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  const totalRemoved = results.filter((r) => r.removed).length;

  ztoolkit.log(
    `[WriteHandlers] Batch removed ${totalRemoved}/${args.itemKeys.length} items from "${collection.name}"`,
  );

  return {
    success: totalRemoved > 0 || results.every((r) => !r.error),
    action: "batch_remove_from_collection",
    itemKey: args.itemKeys[0],
    details: {
      collectionKey: args.collectionKey,
      collectionName: collection.name,
      totalItems: args.itemKeys.length,
      totalRemoved,
      results,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleBatchTrash(args: {
  itemKeys: string[];
}): Promise<MutationResult> {
  // Most dangerous tool: bulk + delete required.
  assertScopes(["bulk", "delete"]);

  if (!args.itemKeys || args.itemKeys.length === 0) {
    throw new Error("At least one itemKey is required");
  }
  if (args.itemKeys.length > BATCH_LIMIT) {
    throw new BatchLimitError(BATCH_LIMIT);
  }

  const libraryID = Zotero.Libraries.userLibraryID;
  const ids: number[] = [];
  const errors: Array<{ itemKey: string; error: string }> = [];

  for (const itemKey of args.itemKeys) {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    if (!item) {
      errors.push({ itemKey, error: `Item not found` });
    } else {
      ids.push(item.id);
    }
  }

  if (ids.length > 0) {
    await Zotero.Items.trashTx(ids);
  }

  ztoolkit.log(
    `[WriteHandlers] Batch trashed ${ids.length}/${args.itemKeys.length} items (errors: ${errors.length})`,
  );

  return {
    success: ids.length > 0,
    action: "batch_trash",
    itemKey: args.itemKeys[0],
    details: {
      totalRequested: args.itemKeys.length,
      totalTrashed: ids.length,
      errors: errors.length > 0 ? errors : undefined,
    },
    timestamp: new Date().toISOString(),
  };
}

export async function handleMoveItemToCollection(args: {
  itemKey: string;
  fromCollectionKey: string;
  toCollectionKey: string;
}): Promise<MutationResult> {
  assertScope("collections");

  if (!args.itemKey) {
    throw new Error("itemKey is required");
  }
  if (!args.fromCollectionKey) {
    throw new Error("fromCollectionKey is required");
  }
  if (!args.toCollectionKey) {
    throw new Error("toCollectionKey is required");
  }

  const item = resolveItem(args.itemKey);
  const fromCollection = resolveCollection(args.fromCollectionKey);
  const toCollection = resolveCollection(args.toCollectionKey);

  if (!fromCollection.hasItem(item.id)) {
    throw new Error(
      `Item "${args.itemKey}" is not in collection "${fromCollection.name}"`,
    );
  }

  item.removeFromCollection(fromCollection.key);
  item.addToCollection(toCollection.key);
  await item.saveTx({ skipDateModifiedUpdate: true });

  ztoolkit.log(
    `[WriteHandlers] Moved ${args.itemKey} from "${fromCollection.name}" to "${toCollection.name}"`,
  );

  return {
    success: true,
    action: "move_item_to_collection",
    itemKey: args.itemKey,
    details: {
      fromCollectionKey: args.fromCollectionKey,
      fromCollectionName: fromCollection.name,
      toCollectionKey: args.toCollectionKey,
      toCollectionName: toCollection.name,
    },
    timestamp: new Date().toISOString(),
  };
}
