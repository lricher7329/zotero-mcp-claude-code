/**
 * Regression tests for pmcURLResolver.
 *
 * The resolver exists because PMC `/pdf/` URLs are gated by a
 * proof-of-work cookie (`cloudpmc-viewer-pow`) that server-side HTTP
 * clients can't compute — every PDF URL, including the one in the
 * landing page's `<meta name="citation_pdf_url">`, returns a ~1.8 KB JS
 * loader instead of the file. EuropePMC mirrors the same OA content
 * without that gate, so the resolver reroutes PMC PDF URLs through
 * `https://europepmc.org/articles/PMC#?pdf=render`.
 *
 * Tests pin:
 *   1. Pure URL-shape detection — only PMC PDF URLs trigger the network.
 *   2. PMCID extraction from various PMC URL forms.
 *   3. The async resolver's behaviour: rewrite to EuropePMC when the
 *      mirror serves a PDF; fall through silently when it doesn't.
 *
 * No real network calls; Zotero.HTTP is stubbed per-test.
 */

import { expect } from "chai";

(globalThis as any).ztoolkit = { log: () => {} };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const resolver = require("../src/modules/pmcURLResolver");
const { isPMCURL, isPMCPDFURL, extractPMCID, resolvePMCPDFURL } = resolver as {
  isPMCURL: (url: string) => boolean;
  isPMCPDFURL: (url: string) => boolean;
  extractPMCID: (url: string) => string | null;
  resolvePMCPDFURL: (url: string) => Promise<string | null>;
};

/** Per-test Zotero.HTTP stub. */
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
      expect(isPMCPDFURL("https://www.ncbi.nlm.nih.gov/about/pdf/")).to.be
        .false;
    });
  });

  describe("extractPMCID", function () {
    it("pulls PMC#### from a www-host article path", function () {
      expect(
        extractPMCID("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/"),
      ).to.equal("PMC9679560");
    });

    it("pulls PMC#### from a pmc-host article path", function () {
      expect(
        extractPMCID("https://pmc.ncbi.nlm.nih.gov/articles/PMC9679560/pdf/"),
      ).to.equal("PMC9679560");
    });

    it("normalizes case to upper", function () {
      expect(
        extractPMCID("https://pmc.ncbi.nlm.nih.gov/articles/pmc12345/"),
      ).to.equal("PMC12345");
    });

    it("returns null for non-PMC hosts", function () {
      expect(extractPMCID("https://example.org/articles/PMC123/")).to.equal(
        null,
      );
    });

    it("returns null when no PMCID is in the path", function () {
      expect(extractPMCID("https://pmc.ncbi.nlm.nih.gov/about/")).to.equal(
        null,
      );
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

    it("rewrites to EuropePMC when the mirror confirms PDF", async function () {
      let requestedURL: string | null = null;
      stubHTTP((method, url) => {
        requestedURL = url;
        expect(method).to.equal("HEAD");
        return Promise.resolve({
          status: 200,
          getResponseHeader: (h: string) =>
            h.toLowerCase() === "content-type" ? "application/pdf" : null,
        });
      });
      const out = await resolvePMCPDFURL(
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(
        "https://europepmc.org/articles/PMC9679560?pdf=render",
      );
      expect(requestedURL).to.equal(
        "https://europepmc.org/articles/PMC9679560?pdf=render",
      );
    });

    it("returns null when EuropePMC HEAD is not 200 (article not on mirror)", async function () {
      stubHTTP(() =>
        Promise.resolve({
          status: 404,
          getResponseHeader: () => null,
        }),
      );
      const out = await resolvePMCPDFURL(
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(null);
    });

    it("returns null when EuropePMC returns 200 but not a PDF", async function () {
      stubHTTP(() =>
        Promise.resolve({
          status: 200,
          getResponseHeader: (h: string) =>
            h.toLowerCase() === "content-type" ? "text/html" : null,
        }),
      );
      const out = await resolvePMCPDFURL(
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(null);
    });

    it("returns null on network failure", async function () {
      stubHTTP(() => Promise.reject(new Error("timeout")));
      const out = await resolvePMCPDFURL(
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC9679560/pdf/",
      );
      expect(out).to.equal(null);
    });

    it("works for the cdn-host PDF URL pattern too", async function () {
      stubHTTP(() =>
        Promise.resolve({
          status: 200,
          getResponseHeader: () => "application/pdf",
        }),
      );
      const out = await resolvePMCPDFURL(
        "https://cdn.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/x.pdf",
      );
      expect(out).to.equal(
        "https://europepmc.org/articles/PMC9679560?pdf=render",
      );
    });
  });
});
