/**
 * Regression tests for itemFormatter.
 *
 * Anchors the contract that the literature-search MCP project depends on:
 *   1. `extra` is in the default field list (so PMID/PMCID/citation-key
 *      stored per Zotero convention round-trip through get_item_details).
 *   2. ALL_FIELDS_SENTINEL enumerates all item-type fields, including
 *      `extra` and the special-cased fields (collections, dateAdded, etc.).
 *   3. Notes are returned as plain text, not raw HTML.
 *
 * If any of these break, downstream identifier extraction silently
 * degrades — see https://github.com/lricher7329/zotero-mcp-claude-code
 * release notes for v1.8.0 and the unified literature-search ingest
 * contract for context.
 */

import { expect } from "chai";

// Mock Zotero globals before importing the module under test.
// formatItem reaches into Zotero.{ItemFields,Collections,Items,CreatorTypes}
// at runtime, so we provide minimal stand-ins.
const mockItemTypeFields: Record<number, number[]> = {
  // journalArticle (id 4 in real Zotero, but our mock just uses ints)
  4: [10, 11, 12, 13, 14],
};
const mockFieldNames: Record<number, string> = {
  10: "publicationTitle",
  11: "volume",
  12: "issue",
  13: "pages",
  14: "DOI",
};
const mockCollections: Record<number, { key: string; name: string }> = {
  100: { key: "COLLAAAA", name: "Test Collection" },
};
const mockNotes: Record<number, { getNote: () => string }> = {
  900: {
    getNote: () =>
      "<p>First paragraph.</p><p>Second &amp; third.</p><br/><div>Block</div>",
  },
};

(globalThis as any).Zotero = {
  ItemFields: {
    getItemTypeFields: (typeID: number) => mockItemTypeFields[typeID] || [],
    getName: (fieldID: number) => mockFieldNames[fieldID] || "",
  },
  Collections: {
    get: (cid: number) => mockCollections[cid] || null,
  },
  Items: {
    get: (id: number) => mockNotes[id] || null,
  },
  CreatorTypes: {
    getName: (id: number) => (id === 1 ? "author" : "editor"),
  },
};

(globalThis as any).ztoolkit = { log: () => {} };

// nsIFile/OS.File aren't available in node — getAttachmentSize falls back
// gracefully and returns 0. That's fine for our tests; they don't assert
// attachment size.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const itemFormatter = require("../src/modules/itemFormatter");
const { formatItem, ALL_FIELDS_SENTINEL, parseExtraIdentifiers } =
  itemFormatter as {
    formatItem: (item: any, fields?: string[]) => Promise<Record<string, any>>;
    ALL_FIELDS_SENTINEL: string;
    parseExtraIdentifiers: (extra: string | null | undefined) => {
      PMID?: string;
      PMCID?: string;
      citationKey?: string;
    };
  };

/** Build a fake Zotero.Item for testing. */
function makeItem(opts: {
  key: string;
  itemType: string;
  itemTypeID?: number;
  fields: Record<string, string>;
  creators?: Array<{
    firstName: string;
    lastName: string;
    creatorTypeID: number;
  }>;
  tags?: string[];
  noteIds?: number[];
  collectionIds?: number[];
  dateAdded?: string;
  dateModified?: string;
}): any {
  // Real Zotero.getField("itemType") returns the type string, so mirror
  // that here. The plugin's formatItem reassigns itemType through the
  // default switch arm, so the mock needs to play along.
  const fields: Record<string, string> = {
    itemType: opts.itemType,
    ...opts.fields,
  };
  return {
    key: opts.key,
    itemType: opts.itemType,
    itemTypeID: opts.itemTypeID ?? 4,
    dateAdded: opts.dateAdded ?? "2025-01-01 00:00:00",
    dateModified: opts.dateModified ?? "2025-01-02 00:00:00",
    getField: (name: string) => fields[name] ?? "",
    getCreators: () => opts.creators ?? [],
    getTags: () => (opts.tags ?? []).map((t) => ({ tag: t })),
    getNotes: () => opts.noteIds ?? [],
    getCollections: () => opts.collectionIds ?? [],
    getAttachments: () => [],
    isAttachment: () => false,
    isNote: () => false,
  };
}

describe("itemFormatter", function () {
  describe("default field list", function () {
    it("includes `extra` so PMID/PMCID/citation-key round-trip", async function () {
      // Regression: literature-search ingest pipeline relies on this.
      // PMID is stored in extra per Zotero convention. Pre-1.8.0 the
      // default field list dropped extra, breaking identifier extraction.
      const item = makeItem({
        key: "ABCD1234",
        itemType: "journalArticle",
        fields: {
          title: "Test Article",
          extra: "PMID: 99999\nPMCID: PMC12345",
          DOI: "10.1234/test",
        },
      });
      const out = await formatItem(item);
      expect(out).to.have.property("extra");
      expect(out.extra).to.include("PMID: 99999");
      expect(out.extra).to.include("PMCID: PMC12345");
    });

    it("preserves the canonical fixed identity fields", async function () {
      const item = makeItem({
        key: "WXYZ5678",
        itemType: "book",
        fields: { title: "A Book" },
      });
      const out = await formatItem(item);
      expect(out.key).to.equal("WXYZ5678");
      expect(out.itemType).to.equal("book");
      expect(out.zoteroUrl).to.equal("zotero://select/library/items/WXYZ5678");
    });
  });

  describe("ALL_FIELDS_SENTINEL (mode=complete)", function () {
    it("returns extra plus collections/dateAdded/dateModified/accessDate", async function () {
      const item = makeItem({
        key: "FULL0001",
        itemType: "journalArticle",
        fields: {
          title: "Complete Mode Test",
          extra: "PMID: 12345",
          publicationTitle: "Test Journal",
          DOI: "10.1234/full",
          accessDate: "2025-06-01",
        },
        collectionIds: [100],
      });
      const out = await formatItem(item, [ALL_FIELDS_SENTINEL]);

      // Special-cased fields that exist outside the item-type field list:
      expect(out).to.have.property("extra");
      expect(out.extra).to.equal("PMID: 12345");
      expect(out).to.have.property("collections");
      expect(out.collections).to.deep.equal([
        { key: "COLLAAAA", name: "Test Collection" },
      ]);
      expect(out).to.have.property("dateAdded");
      expect(out).to.have.property("dateModified");
      expect(out).to.have.property("accessDate");
      expect(out.accessDate).to.equal("2025-06-01");

      // Item-type fields enumerated dynamically via Zotero.ItemFields:
      expect(out).to.have.property("publicationTitle");
      expect(out).to.have.property("DOI");
      expect(out.publicationTitle).to.equal("Test Journal");
      expect(out.DOI).to.equal("10.1234/full");
    });

    it("survives when an unknown itemTypeID returns no fields", async function () {
      // If the item type isn't in our mock map, dynamic enumeration returns
      // []. The base set should still be present.
      const item = makeItem({
        key: "EMPTY001",
        itemType: "unknown",
        itemTypeID: 9999,
        fields: { title: "Edge case" },
      });
      const out = await formatItem(item, [ALL_FIELDS_SENTINEL]);
      expect(out).to.have.property("title");
      expect(out).to.have.property("extra");
      expect(out).to.have.property("collections");
    });
  });

  describe("PMID round-trip (literature-search contract)", function () {
    it("an item written with extra='PMID: 99999' round-trips intact", async function () {
      // §6.4 of the literature-search development plan: regression test
      // that extra is parseable downstream. If this test ever regresses,
      // every kb-ingest run that depends on PMID extraction will silently
      // produce bare evidence pointers.
      const item = makeItem({
        key: "PMID0001",
        itemType: "journalArticle",
        fields: {
          title: "Round trip",
          extra: "PMID: 99999",
        },
      });
      const out = await formatItem(item);
      expect(out.extra).to.match(/\bPMID[:\s]*99999\b/i);

      // Same item via complete mode should also surface PMID.
      const fullOut = await formatItem(item, [ALL_FIELDS_SENTINEL]);
      expect(fullOut.extra).to.match(/\bPMID[:\s]*99999\b/i);
    });

    it("non-canonical PMID variants in extra still round-trip the raw text", async function () {
      // The plugin doesn't normalize on read — it returns extra verbatim
      // and lets the consumer parse with a tolerant regex. Test the
      // plugin half of that contract.
      const variants = [
        "PMID:99999",
        "pmid: 99999",
        "PubMed ID: 99999",
        "PMID 99999",
      ];
      for (const v of variants) {
        const item = makeItem({
          key: "PMID" + v.length.toString().padStart(4, "0"),
          itemType: "journalArticle",
          fields: { extra: v },
        });
        const out = await formatItem(item);
        expect(out.extra).to.equal(v);
      }
    });
  });

  describe("notes are returned as plain text", function () {
    it("strips HTML tags from note content", async function () {
      // Pre-1.8.0 inconsistency: get_item_details returned HTML notes
      // while get_content returned plain text. Now both are plain text.
      const item = makeItem({
        key: "NOTE0001",
        itemType: "journalArticle",
        fields: { title: "Has notes" },
        noteIds: [900],
      });
      const out = await formatItem(item);
      expect(out.notes).to.be.an("array").with.lengthOf(1);
      const note = out.notes[0];
      expect(note).to.not.match(/<p>/);
      expect(note).to.not.match(/<\/p>/);
      expect(note).to.not.match(/&amp;/);
      expect(note).to.include("First paragraph.");
      expect(note).to.include("Second & third.");
      expect(note).to.include("Block");
    });
  });

  describe("parseExtraIdentifiers (§6.2 invariant)", function () {
    it("parses canonical PMID/PMCID/Citation Key block", function () {
      const out = parseExtraIdentifiers(
        "PMID: 12345\nPMCID: PMC67890\nCitation Key: smith2024",
      );
      expect(out).to.deep.equal({
        PMID: "12345",
        PMCID: "PMC67890",
        citationKey: "smith2024",
      });
    });

    it("normalizes PMCID without the PMC prefix", function () {
      // Zotero permits the bare-digit form in extra; we normalize on read
      // so consumers always see the canonical PMC########## form.
      const out = parseExtraIdentifiers("PMCID: 1234567");
      expect(out.PMCID).to.equal("PMC1234567");
    });

    it("preserves PMCID when PMC prefix is already present", function () {
      const out = parseExtraIdentifiers("PMCID: PMC1234567");
      expect(out.PMCID).to.equal("PMC1234567");
    });

    it("handles non-canonical PMID variants", function () {
      const variants = [
        ["PMID:99999", "99999"],
        ["pmid: 99999", "99999"],
        ["PubMed ID: 99999", "99999"],
        ["PubMed ID:99999", "99999"],
        ["PMID 99999", "99999"],
      ];
      for (const [input, expected] of variants) {
        const out = parseExtraIdentifiers(input);
        expect(out.PMID, `input: ${input}`).to.equal(expected);
      }
    });

    it("returns empty object for null/undefined/empty extra", function () {
      expect(parseExtraIdentifiers(null)).to.deep.equal({});
      expect(parseExtraIdentifiers(undefined)).to.deep.equal({});
      expect(parseExtraIdentifiers("")).to.deep.equal({});
    });

    it("only returns identifiers actually present", function () {
      // Just a citation key, no PubMed identifiers.
      const out = parseExtraIdentifiers("Citation Key: jones2023");
      expect(out).to.deep.equal({ citationKey: "jones2023" });
      expect(out).to.not.have.property("PMID");
      expect(out).to.not.have.property("PMCID");
    });

    it("finds identifiers interleaved with other extra fields", function () {
      // Real Zotero `extra` blocks often mix BBT/citation tooling fields
      // with PubMed IDs and free-form notes. We anchor identifiers to line
      // starts but don't require a particular order.
      const extra = [
        "tex.note: imported from medline",
        "PMID: 40123456",
        "Citation Key: doe2024foo",
        "type: article",
        "PMCID: PMC10987654",
      ].join("\n");
      const out = parseExtraIdentifiers(extra);
      expect(out).to.deep.equal({
        PMID: "40123456",
        PMCID: "PMC10987654",
        citationKey: "doe2024foo",
      });
    });

    it("ignores PMID-like substrings that aren't at line start", function () {
      // The regex anchors to (?:^|\n) — a passing mention of "see PMID
      // 12345 in the abstract" inside a free-form note shouldn't poison
      // structured output.
      const out = parseExtraIdentifiers(
        "tex.note: see PMID 99999 in the abstract",
      );
      expect(out).to.not.have.property("PMID");
    });
  });

  describe("formatItem identifier synthesis", function () {
    it("exposes PMID/PMCID/citationKey as top-level fields", async function () {
      const item = makeItem({
        key: "SYNTH001",
        itemType: "journalArticle",
        fields: {
          title: "Synth test",
          extra: "PMID: 40123456\nPMCID: PMC10987654\nCitation Key: doe2024",
        },
      });
      const out = await formatItem(item);
      expect(out.PMID).to.equal("40123456");
      expect(out.PMCID).to.equal("PMC10987654");
      expect(out.citationKey).to.equal("doe2024");
    });

    it("preserves the raw `extra` string alongside synthesized fields", async function () {
      // Anything already parsing extra directly must keep working —
      // synthesis is additive, not a replacement.
      const raw = "PMID: 40123456\nPMCID: PMC10987654\nCitation Key: doe2024";
      const item = makeItem({
        key: "SYNTH002",
        itemType: "journalArticle",
        fields: { title: "Raw preserved", extra: raw },
      });
      const out = await formatItem(item);
      expect(out.extra).to.equal(raw);
    });

    it("synthesizes identifiers in ALL_FIELDS_SENTINEL (complete) mode too", async function () {
      const item = makeItem({
        key: "SYNTH003",
        itemType: "journalArticle",
        fields: {
          title: "Complete mode",
          extra: "PMID: 40000001",
        },
      });
      const out = await formatItem(item, [ALL_FIELDS_SENTINEL]);
      expect(out.PMID).to.equal("40000001");
    });

    it("does not add identifier keys when extra has none", async function () {
      const item = makeItem({
        key: "SYNTH004",
        itemType: "journalArticle",
        fields: { title: "No identifiers", extra: "type: article" },
      });
      const out = await formatItem(item);
      expect(out).to.not.have.property("PMID");
      expect(out).to.not.have.property("PMCID");
      expect(out).to.not.have.property("citationKey");
    });

    it("does not add identifier keys when extra is empty", async function () {
      const item = makeItem({
        key: "SYNTH005",
        itemType: "journalArticle",
        fields: { title: "Empty extra" },
      });
      const out = await formatItem(item);
      expect(out).to.not.have.property("PMID");
      expect(out).to.not.have.property("PMCID");
      expect(out).to.not.have.property("citationKey");
    });

    it("normalizes a bare-digit PMCID through formatItem", async function () {
      const item = makeItem({
        key: "SYNTH006",
        itemType: "journalArticle",
        fields: { title: "Bare PMCID", extra: "PMCID: 1234567" },
      });
      const out = await formatItem(item);
      expect(out.PMCID).to.equal("PMC1234567");
    });
  });

  describe("explicit collections field (regression)", function () {
    it("returns structured collections when requested by name", async function () {
      // Pre-1.8.0 bug: requesting "collections" in the fields array fell
      // into the default `item.getField("collections")` branch which
      // throws (it's not a real Zotero field), got caught silently, and
      // set the value to "". Tools that wanted collection membership got
      // an empty string instead of the actual list.
      const item = makeItem({
        key: "COLL0001",
        itemType: "journalArticle",
        fields: { title: "In a collection" },
        collectionIds: [100],
      });
      const out = await formatItem(item, ["title", "collections"]);
      expect(out.collections).to.deep.equal([
        { key: "COLLAAAA", name: "Test Collection" },
      ]);
    });
  });
});
