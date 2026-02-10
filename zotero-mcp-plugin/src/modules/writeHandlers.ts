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

// --- Tier 1: Additional Write Handlers ---

export async function handleUpdateNote(args: {
  noteKey: string;
  content: string;
  tags?: string[];
}): Promise<MutationResult> {
  assertWriteEnabled();

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
  assertWriteEnabled();

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
  assertWriteEnabled();

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
  assertWriteEnabled();

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
  assertWriteEnabled();

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
  assertWriteEnabled();

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
  assertWriteEnabled();

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

  // Add bidirectional relation
  item.addRelatedItem(relatedItem);
  await item.saveTx();

  relatedItem.addRelatedItem(item);
  await relatedItem.saveTx();

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
  assertWriteEnabled();

  if (!args.itemKey) {
    throw new Error("itemKey is required");
  }
  if (!args.relatedItemKey) {
    throw new Error("relatedItemKey is required");
  }

  const item = resolveItem(args.itemKey);
  const relatedItem = resolveItem(args.relatedItemKey);

  // Remove bidirectional relation
  item.removeRelatedItem(relatedItem);
  await item.saveTx();

  relatedItem.removeRelatedItem(item);
  await relatedItem.saveTx();

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

export async function handleImportAttachmentURL(args: {
  url: string;
  parentItemKey?: string;
  title?: string;
}): Promise<MutationResult> {
  assertWriteEnabled();

  if (!args.url) {
    throw new Error("url is required");
  }

  const libraryID = Zotero.Libraries.userLibraryID;
  let parentItemID: number | undefined;

  if (args.parentItemKey) {
    const parentItem = resolveItem(args.parentItemKey);
    parentItemID = parentItem.id;
  }

  const importOptions: any = {
    libraryID,
    url: args.url,
  };
  if (parentItemID !== undefined) {
    importOptions.parentItemID = parentItemID;
  }
  if (args.title) {
    importOptions.title = args.title;
  }

  const attachment = await Zotero.Attachments.importFromURL(importOptions);

  ztoolkit.log(
    `[WriteHandlers] Imported attachment from URL: ${args.url} (key: ${attachment.key})`,
  );

  return {
    success: true,
    action: "import_attachment_url",
    itemKey: attachment.key,
    details: {
      attachmentKey: attachment.key,
      url: args.url,
      parentItemKey: args.parentItemKey || null,
      title: args.title || null,
    },
    timestamp: new Date().toISOString(),
  };
}

// --- Tier 3: Additional Write Handlers ---

export async function handleRestoreFromTrash(args: {
  itemKey: string;
}): Promise<MutationResult> {
  assertWriteEnabled();

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
  assertWriteEnabled();

  if (!args.collectionKey) {
    throw new Error("collectionKey is required");
  }

  const collection = resolveCollection(args.collectionKey);
  const oldParentKey = collection.parentKey || null;

  if (args.newParentKey) {
    const newParent = resolveCollection(args.newParentKey);

    // Validate no circular parent: walk up from newParent to ensure we don't hit collection
    let current = newParent;
    while (current.parentKey) {
      if (current.parentKey === args.collectionKey) {
        throw new Error(
          "Cannot move collection: would create circular parent hierarchy",
        );
      }
      current = Zotero.Collections.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        current.parentKey,
      );
      if (!current) break;
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
  assertWriteEnabled();

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
  assertWriteEnabled();

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
  assertWriteEnabled();

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
