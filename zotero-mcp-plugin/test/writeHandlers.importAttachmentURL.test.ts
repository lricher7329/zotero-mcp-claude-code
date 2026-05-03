/**
 * Regression tests for inferContentTypeFromURL.
 *
 * Anchors the contract that import_attachment_url callers can omit
 * `contentType` for unambiguous PDF/EPUB URLs and still get steered onto
 * Zotero's binary-download path. Required because Zotero's HTML-snapshot
 * fallback (SingleFile) has been observed to throw cryptic, intermittent
 * errors for PMC PDF URLs — see the v1.8.x release notes for the
 * import_attachment_url connector bug.
 *
 * Pure-function test: no Zotero globals, no SingleFile, no network.
 */

import { expect } from "chai";

// serverPreferences (transitively imported from writeHandlers) reaches
// for Zotero.Prefs at module-load time. Stub the bare minimum so the
// import doesn't crash. The function under test never touches it.
(globalThis as any).Zotero = {
  ...((globalThis as any).Zotero || {}),
  Prefs: {
    get: () => undefined,
    set: () => {},
  },
};
(globalThis as any).ztoolkit = { log: () => {} };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const writeHandlers = require("../src/modules/writeHandlers");
const { inferContentTypeFromURL } = writeHandlers as {
  inferContentTypeFromURL: (url: string) => string | undefined;
};

describe("inferContentTypeFromURL", function () {
  describe("PDF detection", function () {
    it("returns application/pdf for URLs ending in .pdf", function () {
      expect(inferContentTypeFromURL("https://example.org/paper.pdf")).to.equal(
        "application/pdf",
      );
    });

    it("returns application/pdf for the PMC /pdf/ directory pattern", function () {
      // The exact URL form that broke in production: PMC's PDF index
      // endpoint, which Zotero's snapshot path mishandles.
      expect(
        inferContentTypeFromURL(
          "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9679560/pdf/",
        ),
      ).to.equal("application/pdf");
      expect(
        inferContentTypeFromURL(
          "https://pmc.ncbi.nlm.nih.gov/articles/PMC9679560/pdf/",
        ),
      ).to.equal("application/pdf");
    });

    it("returns application/pdf for /pdf with no trailing slash", function () {
      expect(
        inferContentTypeFromURL(
          "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/pdf",
        ),
      ).to.equal("application/pdf");
    });

    it("ignores case in the path", function () {
      expect(inferContentTypeFromURL("https://example.org/Paper.PDF")).to.equal(
        "application/pdf",
      );
    });

    it("ignores query strings (extension still matches)", function () {
      // A URL like /file.pdf?download=1 should still be detected; the
      // pathname (not search) is what matters.
      expect(
        inferContentTypeFromURL("https://example.org/file.pdf?download=1"),
      ).to.equal("application/pdf");
    });
  });

  describe("EPUB detection", function () {
    it("returns application/epub+zip for URLs ending in .epub", function () {
      expect(inferContentTypeFromURL("https://example.org/book.epub")).to.equal(
        "application/epub+zip",
      );
    });
  });

  describe("ambiguous URLs (no inference)", function () {
    it("returns undefined for an article landing page", function () {
      // No file-extension hint and no /pdf/ marker — caller must pass
      // contentType explicitly or accept the snapshot path.
      expect(
        inferContentTypeFromURL(
          "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/",
        ),
      ).to.equal(undefined);
    });

    it("returns undefined for a generic HTML URL", function () {
      expect(inferContentTypeFromURL("https://example.org/article")).to.equal(
        undefined,
      );
    });

    it("does NOT match .pdf as a non-terminal segment", function () {
      // /pdf-viewer/foo isn't a PDF file. Anchoring to endsWith avoids
      // false positives.
      expect(
        inferContentTypeFromURL("https://example.org/pdf-viewer/foo"),
      ).to.equal(undefined);
    });
  });

  describe("malformed input", function () {
    it("returns undefined for a non-URL string", function () {
      expect(inferContentTypeFromURL("not a url at all")).to.equal(undefined);
    });

    it("returns undefined for an empty string", function () {
      expect(inferContentTypeFromURL("")).to.equal(undefined);
    });
  });
});
