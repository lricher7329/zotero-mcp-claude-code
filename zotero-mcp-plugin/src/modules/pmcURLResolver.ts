/**
 * PubMed Central PDF URL resolver.
 *
 * PMC's `/pdf/` URLs (e.g. https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/pdf/)
 * are gated behind a proof-of-work challenge: every PDF URL — including
 * the one advertised in the article landing page's
 * `<meta name="citation_pdf_url">` — returns a ~1.8 KB JS loader that
 * computes a `cloudpmc-viewer-pow` cookie before the real PDF is served.
 * Server-side HTTP clients (Zotero, curl, anything without a JS engine)
 * can't satisfy that gate and end up downloading the loader HTML in
 * place of the PDF, which Zotero then rejects as "not a supported type".
 *
 * EuropePMC (operated by EMBL-EBI) mirrors the same OA content without
 * the PoW gate. Their `https://europepmc.org/articles/PMC{ID}?pdf=render`
 * endpoint 302s to a plain `application/pdf` response. This module
 * detects PMC PDF URLs and reroutes them through EuropePMC, falling
 * back silently when EuropePMC doesn't have the article (non-OA, or any
 * other failure).
 *
 * Scope: deliberately narrow. Only PMC PDF-shaped URLs trigger
 * resolution. The HEAD-verification step keeps us from handing Zotero a
 * URL that won't actually serve a PDF, and resolved URLs are
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

/** Pull the canonical PMC#### identifier out of a PMC URL. */
export function extractPMCID(url: string): string | null {
  try {
    const u = new URL(url);
    if (!PMC_HOSTS.has(u.hostname.toLowerCase())) return null;
    const m = u.pathname.match(/\/(?:pmc\/)?articles\/(PMC\d+)/i);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a PMC PDF URL to a fetchable equivalent.
 *
 * Returns:
 *   - The EuropePMC PDF URL (`https://europepmc.org/articles/PMC...?pdf=render`)
 *     if EuropePMC confirms it serves a PDF for that PMCID.
 *   - `null` for any of:
 *       * URL isn't a PMC PDF URL (caller passes through unchanged).
 *       * PMCID couldn't be extracted from the URL.
 *       * EuropePMC HEAD returned non-200 or non-PDF (article isn't on
 *         EuropePMC, e.g. non-OA).
 *       * Network/timeout error during the HEAD probe.
 *
 * Never throws — designed as a best-effort enhancement, never a blocker.
 */
export async function resolvePMCPDFURL(url: string): Promise<string | null> {
  if (!isPMCPDFURL(url)) return null;

  const pmcid = extractPMCID(url);
  if (!pmcid) return null;

  const europepmcURL = `https://europepmc.org/articles/${pmcid}?pdf=render`;

  try {
    const xhr = await Zotero.HTTP.request("HEAD", europepmcURL, {
      timeout: 15000,
    });

    if (!xhr || xhr.status !== 200) {
      ztoolkit?.log?.(
        `[PMCResolver] EuropePMC HEAD ${xhr?.status} for ${pmcid}; falling back`,
      );
      return null;
    }

    const ct = (
      (typeof xhr.getResponseHeader === "function" &&
        xhr.getResponseHeader("Content-Type")) ||
      ""
    ).toLowerCase();
    if (!ct.includes("application/pdf")) {
      ztoolkit?.log?.(
        `[PMCResolver] EuropePMC didn't return PDF for ${pmcid} (${ct}); falling back`,
      );
      return null;
    }

    ztoolkit?.log?.(`[PMCResolver] Resolved ${url} → ${europepmcURL}`);
    return europepmcURL;
  } catch (err: any) {
    ztoolkit?.log?.(
      `[PMCResolver] EuropePMC HEAD failed for ${pmcid}: ${err?.message || err}`,
    );
    return null;
  }
}
