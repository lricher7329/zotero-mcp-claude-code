/**
 * Regression tests for pmcURLResolver.
 *
 * The resolver exists because PMC `/pdf/` URLs serve an HTML gateway
 * page (with the real PDF in <meta name="citation_pdf_url">) rather than
 * the PDF itself. This pair of tests pins:
 *   1. The pure URL-shape detection — only PMC PDF URLs trigger the
 *      network round-trip.
 *   2. The pure HTML extraction — the citation_pdf_url meta tag is read
 *      regardless of attribute order.
 *   3. The async resolver behavior — short-circuits when the server
 *      already returns a PDF, falls through silently on any failure.
 *
 * No real network calls; Zotero.HTTP is stubbed per-test.
 */

import { expect } from "chai";

(globalThis as any).ztoolkit = { log: () => {} };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const resolver = require("../src/modules/pmcURLResolver");
const { isPMCURL, isPMCPDFURL, extractCitationPDFURL, resolvePMCPDFURL } =
  resolver as {
    isPMCURL: (url: string) => boolean;
    isPMCPDFURL: (url: string) => boolean;
    extractCitationPDFURL: (html: string) => string | null;
    resolvePMCPDFURL: (url: string) => Promise<string | null>;
  };

/** Per-test Zotero.HTTP stub. Reset in beforeEach. */
function stubHTTP(impl: (method: string, url: string, opts: any) => any): void {
  (globalThis as any).Zotero = {
    ...((globalThis as any).Zotero || {}),
    HTTP: { request: impl },
  };
}

describe("pmcURLResolver", function () {
  describe("isPMCURL", function () {
    it("recognizes www.ncbi.nlm.nih.gov", function () {
      expect(isPMCURL("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/")).to
        .be.true;
    });

    it("recognizes pmc.ncbi.nlm.nih.gov", function () {
      expect(isPMCURL("https://pmc.ncbi.nlm.nih.gov/articles/PMC123/")).to.be
        .true;
    });

    it("recognizes cdn.ncbi.nlm.nih.gov", function () {
      expect(
        isPMCURL("https://cdn.ncbi.nlm.nih.gov/pmc/articles/PMC123/pdf/x.pdf"),
      ).to.be.true;
    });

    it("rejects non-PMC hosts", function () {
      expect(isPMCURL("https://example.org/articles/PMC123/")).to.be.false;
    });

    it("rejects malformed URLs", function () {
      expect(isPMCURL("not a url")).to.be.false;
    });
  });

  describe("isPMCPDFURL", function () {
    it("matches the PMC /pdf/ directory pattern (www host)", function () {
      expect(
        isPMCPDFURL(
          "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/",
        ),
      ).to.be.true;
    });

    it("matches the PMC /pdf/ directory pattern (pmc host)", function () {
      expect(
        isPMCPDFURL("https://pmc.ncbi.nlm.nih.gov/articles/PMC9679560/pdf/"),
      ).to.be.true;
    });

    it("matches a direct .pdf file URL on a PMC host", function () {
      expect(
        isPMCPDFURL(
          "https://cdn.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/article.pdf",
        ),
      ).to.be.true;
    });

    it("rejects a PMC article landing page (no /pdf/)", function () {
      expect(isPMCPDFURL("https://pmc.ncbi.nlm.nih.gov/articles/PMC9679560/"))
        .to.be.false;
    });

    it("rejects a non-PMC URL even with /pdf/", function () {
      expect(isPMCPDFURL("https://example.org/articles/PMC1/pdf/")).to.be.false;
    });

    it("rejects a PMC URL without articles/PMC#### path", function () {
      // E.g. NCBI homepage or unrelated PMC tooling.
      expect(isPMCPDFURL("https://www.ncbi.nlm.nih.gov/about/pdf/")).to.be
        .false;
    });
  });

  describe("extractCitationPDFURL", function () {
    it("extracts when name precedes content", function () {
      const html =
        '<meta name="citation_pdf_url" content="https://cdn.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/x.pdf">';
      expect(extractCitationPDFURL(html)).to.equal(
        "https://cdn.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/x.pdf",
      );
    });

    it("extracts when content precedes name", function () {
      const html =
        '<meta content="https://cdn.example.org/x.pdf" name="citation_pdf_url" />';
      expect(extractCitationPDFURL(html)).to.equal(
        "https://cdn.example.org/x.pdf",
      );
    });

    it("decodes &amp; in URLs", function () {
      const html =
        '<meta name="citation_pdf_url" content="https://example.org/x.pdf?a=1&amp;b=2">';
      expect(extractCitationPDFURL(html)).to.equal(
        "https://example.org/x.pdf?a=1&b=2",
      );
    });

    it("returns null when the tag is absent", function () {
      expect(extractCitationPDFURL("<html><body>nope</body></html>")).to.equal(
        null,
      );
    });

    it("returns null on empty input", function () {
      expect(extractCitationPDFURL("")).to.equal(null);
    });
  });

  describe("resolvePMCPDFURL", function () {
    it("returns null without making a request when URL isn't a PMC PDF URL", async function () {
      let called = false;
      stubHTTP(() => {
        called = true;
        throw new Error("should not be called");
      });
      const out = await resolvePMCPDFURL("https://example.org/x.pdf");
      expect(out).to.equal(null);
      expect(called).to.equal(false);
    });

    it("returns null when the gateway already serves a PDF", async function () {
      // No indirection needed — Zotero will fetch the same URL and get
      // the PDF directly. Returning null tells the caller "use original".
      stubHTTP(() =>
        Promise.resolve({
          status: 200,
          getResponseHeader: (h: string) =>
            h.toLowerCase() === "content-type" ? "application/pdf" : null,
          responseText: "",
        }),
      );
      const out = await resolvePMCPDFURL(
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(null);
    });

    it("extracts citation_pdf_url from an HTML gateway response", async function () {
      const cdn =
        "https://cdn.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/10.1177_17407745221110199.pdf";
      stubHTTP(() =>
        Promise.resolve({
          status: 200,
          getResponseHeader: (h: string) =>
            h.toLowerCase() === "content-type"
              ? "text/html; charset=utf-8"
              : null,
          responseText: `<html><head><meta name="citation_pdf_url" content="${cdn}"></head></html>`,
        }),
      );
      const out = await resolvePMCPDFURL(
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(cdn);
    });

    it("returns null when HTML lacks citation_pdf_url", async function () {
      stubHTTP(() =>
        Promise.resolve({
          status: 200,
          getResponseHeader: (h: string) =>
            h.toLowerCase() === "content-type" ? "text/html" : null,
          responseText: "<html><body>no meta tag</body></html>",
        }),
      );
      const out = await resolvePMCPDFURL(
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(null);
    });

    it("returns null when extracted URL equals the input (loop guard)", async function () {
      const url = "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/";
      stubHTTP(() =>
        Promise.resolve({
          status: 200,
          getResponseHeader: () => "text/html",
          responseText: `<meta name="citation_pdf_url" content="${url}">`,
        }),
      );
      const out = await resolvePMCPDFURL(url);
      expect(out).to.equal(null);
    });

    it("returns null on HTTP error (network failure)", async function () {
      stubHTTP(() => Promise.reject(new Error("timeout")));
      const out = await resolvePMCPDFURL(
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(null);
    });

    it("returns null on non-200 response", async function () {
      stubHTTP(() =>
        Promise.resolve({
          status: 403,
          getResponseHeader: () => "text/html",
          responseText: "",
        }),
      );
      const out = await resolvePMCPDFURL(
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(null);
    });
  });
});
