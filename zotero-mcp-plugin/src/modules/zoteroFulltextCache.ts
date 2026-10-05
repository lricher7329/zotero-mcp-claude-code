declare let ztoolkit: ZToolkit;
declare const IOUtils: any;

/**
 * Read the text Zotero has already extracted for an attachment.
 *
 * Zotero 7–10 keep it in the attachment's `.zotero-ft-cache` file, located via
 * `Zotero.Fulltext.getItemCacheFile()`. Zotero 10 removed
 * `Zotero.Fulltext.getItemContent()` (full-text search moved to an FTS5 index),
 * so that call is only a fallback for runtimes that still provide it.
 *
 * Returns null when Zotero has no cached text, so callers can fall back to
 * extracting the file themselves.
 */
export async function getCachedFulltext(
  attachment: Zotero.Item,
): Promise<string | null> {
  const fulltext = Zotero.Fulltext as any;
  try {
    if (fulltext?.getItemCacheFile) {
      const path: string = fulltext.getItemCacheFile(attachment).path;
      if (await IOUtils.exists(path)) {
        const text = (await Zotero.File.getContentsAsync(path)) as string;
        if (typeof text === "string" && text.trim().length > 0) {
          return text;
        }
      }
    }

    if (fulltext?.getItemContent) {
      const content = await fulltext.getItemContent(attachment.id);
      if (content?.content && content.content.trim().length > 0) {
        return content.content;
      }
    }
  } catch (error) {
    ztoolkit.log(
      `[FulltextCache] Cached fulltext unavailable for ${attachment.key}: ${error}`,
      "warn",
    );
  }
  return null;
}
