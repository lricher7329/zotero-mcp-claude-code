/**
 * PubMed Central PDF URL resolver.
 *
 * PMC `/pdf/` URLs (e.g. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/pdf/)
 * frequently serve an HTML gateway page rather than the PDF itself, even
 * though the canonical `<meta name="citation_pdf_url">` on that page
 * points at the actual file. Zotero's `importFromURL` can't follow that
 * indirection, so it either snapshots the gateway HTML (wrong file) or
 * surfaces "Downloaded file was not a supported type".
 *
 * This module resolves a PMC PDF URL to the underlying PDF URL by
 * fetching the gateway and extracting `citation_pdf_url`. Designed to be
 * called from `handleImportAttachmentURL` before the URL is handed to
 * Zotero.
 *
 * Scope: deliberately narrow. Only PMC PDF-shaped URLs trigger
 * resolution; anything else is left untouched. Resolved URLs are
 * re-validated by the caller through the SSRF guard.
 */

declare let Zotero: any;
declare let ztoolkit: any;

const PMC_HOSTS = new Set([
  "www.ncbi.nlm.nih.gov",
  "pmc.ncbi.nlm.nih.gov",
  "cdn.ncbi.nlm.nih.gov",
]);

/** Path under any PMC host that points at an article: /articles/PMC#### or /pmc/articles/PMC####. */
const PMC_ARTICLE_PATH = /\/(?:pmc\/)?articles\/PMC\d+/i;

/** True if the URL is hosted on a known PMC host (ignoring path). */
export function isPMCURL(url: string): boolean {
  try {
    const u = new URL(url);
    return PMC_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * True if the URL is a PMC URL whose path looks like a PDF endpoint —
 * either an article PDF directory (`/articles/PMC.../pdf[/]`) or a
 * direct `.pdf` file. Used as the trigger condition for resolution: we
 * only pay the network cost for URLs that genuinely look like PDF
 * requests gone wrong.
 */
export function isPMCPDFURL(url: string): boolean {
  try {
    const u = new URL(url);
    if (!PMC_HOSTS.has(u.hostname.toLowerCase())) return false;
    if (!PMC_ARTICLE_PATH.test(u.pathname)) return false;
    const path = u.pathname.toLowerCase();
    return (
      path.endsWith("/pdf/") || path.endsWith("/pdf") || path.endsWith(".pdf")
    );
  } catch {
    return false;
  }
}

/**
 * Extract the value of the Highwire/Google-Scholar `citation_pdf_url`
 * meta tag from raw HTML. Handles both attribute orders
 * (name-then-content and content-then-name) and HTML-decodes a small
 * subset of entities commonly seen in URLs (`&amp;`).
 *
 * Returns null if no such tag is present.
 */
export function extractCitationPDFURL(html: string): string | null {
  if (!html) return null;
  const patterns = [
    /<meta[^>]*\bname=["']citation_pdf_url["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']citation_pdf_url["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      // Minimal HTML entity decode — citation_pdf_url URLs occasionally
      // contain &amp; in query strings.
      return m[1].replace(/&amp;/gi, "&");
    }
  }
  return null;
}

/**
 * Resolve a PMC PDF URL to the underlying PDF URL.
 *
 * Returns:
 *   - A new URL string if the gateway HTML pointed at a different PDF.
 *   - `null` if no resolution was needed or possible. Specifically:
 *       * URL isn't a PMC PDF URL (caller should pass through unchanged).
 *       * Server returned the PDF directly (no indirection to resolve).
 *       * Network/parse error (caller falls back to original URL).
 *       * Resolved URL equals the input (no actual indirection).
 *
 * Never throws — designed to be a best-effort enhancement, never a
 * blocker. All failure modes log and return null.
 */
export async function resolvePMCPDFURL(url: string): Promise<string | null> {
  if (!isPMCPDFURL(url)) return null;

  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "text",
      timeout: 15000,
    });

    if (!xhr || xhr.status !== 200) {
      ztoolkit?.log?.(
        `[PMCResolver] Non-200 (${xhr?.status}) for ${url}; skipping resolution`,
      );
      return null;
    }

    const contentType = (
      (typeof xhr.getResponseHeader === "function" &&
        xhr.getResponseHeader("Content-Type")) ||
      ""
    ).toLowerCase();

    // Server actually delivered a PDF. No indirection — let Zotero fetch
    // this same URL with `contentType: application/pdf` and it'll work.
    if (contentType.includes("application/pdf")) {
      return null;
    }

    // We expected HTML to scrape. If it's neither HTML nor PDF, give up.
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      return null;
    }

    const html = typeof xhr.responseText === "string" ? xhr.responseText : "";
    const resolved = extractCitationPDFURL(html);
    if (!resolved) {
      ztoolkit?.log?.(`[PMCResolver] No citation_pdf_url in HTML for ${url}`);
      return null;
    }
    if (resolved === url) return null;

    ztoolkit?.log?.(`[PMCResolver] Resolved ${url} → ${resolved}`);
    return resolved;
  } catch (err: any) {
    ztoolkit?.log?.(
      `[PMCResolver] Error resolving ${url}: ${err?.message || err}`,
    );
    return null;
  }
}
