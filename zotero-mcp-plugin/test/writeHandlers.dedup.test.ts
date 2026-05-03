/**
 * Regression tests for import_attachment_url dedup helpers.
 *
 * `decideImportAction` is the policy core (pure: existing → action) and
 * `findSameTypeAttachments` is the Zotero-side query that feeds it.
 * Tests pin both so that future changes to the import handler don't
 * accidentally drop the dryRun / ifExists semantics.
 */

import { expect } from "chai";

// Module-load-time stub: just enough for `require("../src/modules/writeHandlers")`
// to succeed (serverPreferences pokes Zotero.Prefs). DO NOT clobber
// Zotero.Items here — sibling tests (itemFormatter) install their own
// Items.get at module load and we'd race them. Tests below use
// beforeEach/afterEach to install/restore an Items.get scoped to this
// suite only.
(globalThis as any).Zotero = {
  ...((globalThis as any).Zotero || {}),
  Prefs: ((globalThis as any).Zotero || {}).Prefs || {
    get: () => undefined,
    set: () => {},
  },
};
(globalThis as any).ztoolkit = { log: () => {} };

const mockItems: Record<number, any> = {};

function mockAttachment(opts: {
  id: number;
  key: string;
  title?: string;
  contentType: string;
  dateAdded?: string;
}): any {
  const fields: Record<string, string> = {
    title: opts.title ?? "",
  };
  return {
    id: opts.id,
    key: opts.key,
    attachmentContentType: opts.contentType,
    dateAdded: opts.dateAdded ?? "2026-05-03 10:00:00",
    getField: (name: string) => fields[name] ?? "",
  };
}

function mockParent(attachmentIds: number[]): any {
  return {
    getAttachments: () => attachmentIds,
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const writeHandlers = require("../src/modules/writeHandlers");
const { decideImportAction, findSameTypeAttachments } = writeHandlers as {
  decideImportAction: (
    existing: Array<{
      key: string;
      title: string;
      contentType: string;
      dateAdded: string;
    }>,
    policy: "add" | "skip" | "replace",
  ) => "create" | "skip" | "replace";
  findSameTypeAttachments: (
    parentItem: any,
    contentType: string | undefined,
  ) => Array<{
    key: string;
    title: string;
    contentType: string;
    dateAdded: string;
  }>;
};

describe("import_attachment_url dedup", function () {
  describe("decideImportAction", function () {
    it("returns 'create' when no existing attachments (any policy)", function () {
      expect(decideImportAction([], "add")).to.equal("create");
      expect(decideImportAction([], "skip")).to.equal("create");
      expect(decideImportAction([], "replace")).to.equal("create");
    });

    it("returns 'create' for policy 'add' even with existing attachments", function () {
      // 'add' is the backward-compatible default — never dedups.
      const existing = [
        {
          key: "AAAA1111",
          title: "Existing PDF",
          contentType: "application/pdf",
          dateAdded: "2026-05-01",
        },
      ];
      expect(decideImportAction(existing, "add")).to.equal("create");
    });

    it("returns 'skip' for policy 'skip' with existing attachments", function () {
      const existing = [
        {
          key: "AAAA1111",
          title: "Existing PDF",
          contentType: "application/pdf",
          dateAdded: "2026-05-01",
        },
      ];
      expect(decideImportAction(existing, "skip")).to.equal("skip");
    });

    it("returns 'replace' for policy 'replace' with existing attachments", function () {
      const existing = [
        {
          key: "AAAA1111",
          title: "Existing PDF",
          contentType: "application/pdf",
          dateAdded: "2026-05-01",
        },
      ];
      expect(decideImportAction(existing, "replace")).to.equal("replace");
    });
  });

  describe("findSameTypeAttachments", function () {
    let originalItems: any;

    beforeEach(function () {
      // Reset the mock item registry between tests.
      for (const k of Object.keys(mockItems)) delete mockItems[Number(k)];
      // Install our Items.get for this suite only — restore in
      // afterEach so we don't trample sibling test fixtures.
      originalItems = (globalThis as any).Zotero.Items;
      (globalThis as any).Zotero.Items = {
        get: (id: number) => mockItems[id] || null,
      };
    });

    afterEach(function () {
      (globalThis as any).Zotero.Items = originalItems;
    });

    it("returns [] when contentType is undefined", function () {
      const parent = mockParent([1]);
      mockItems[1] = mockAttachment({
        id: 1,
        key: "ATT11111",
        contentType: "application/pdf",
      });
      expect(findSameTypeAttachments(parent, undefined)).to.deep.equal([]);
    });

    it("returns [] when parent has no attachments", function () {
      const parent = mockParent([]);
      expect(findSameTypeAttachments(parent, "application/pdf")).to.deep.equal(
        [],
      );
    });

    it("returns matching same-type attachments only", function () {
      const parent = mockParent([1, 2, 3]);
      mockItems[1] = mockAttachment({
        id: 1,
        key: "PDF11111",
        title: "First PDF",
        contentType: "application/pdf",
      });
      mockItems[2] = mockAttachment({
        id: 2,
        key: "HTML1111",
        title: "Snapshot",
        contentType: "text/html",
      });
      mockItems[3] = mockAttachment({
        id: 3,
        key: "PDF22222",
        title: "Second PDF",
        contentType: "application/pdf",
      });
      const out = findSameTypeAttachments(parent, "application/pdf");
      expect(out).to.have.lengthOf(2);
      expect(out.map((a) => a.key)).to.deep.equal(["PDF11111", "PDF22222"]);
      expect(out[0]).to.include({
        title: "First PDF",
        contentType: "application/pdf",
      });
    });

    it("matches case-insensitively on content type", function () {
      // Defensive: Zotero usually stores lowercase MIME, but the caller
      // may pass "Application/PDF" or similar. Match should still hit.
      const parent = mockParent([1]);
      mockItems[1] = mockAttachment({
        id: 1,
        key: "PDF11111",
        contentType: "application/pdf",
      });
      expect(
        findSameTypeAttachments(parent, "Application/PDF"),
      ).to.have.lengthOf(1);
    });

    it("skips attachments with empty contentType", function () {
      // Some legacy attachments lack a recorded contentType. They
      // shouldn't be counted as matches for any wanted type.
      const parent = mockParent([1, 2]);
      mockItems[1] = mockAttachment({
        id: 1,
        key: "EMPTY111",
        contentType: "",
      });
      mockItems[2] = mockAttachment({
        id: 2,
        key: "PDF11111",
        contentType: "application/pdf",
      });
      const out = findSameTypeAttachments(parent, "application/pdf");
      expect(out).to.have.lengthOf(1);
      expect(out[0].key).to.equal("PDF11111");
    });

    it("returns [] when parent is null or undefined", function () {
      expect(findSameTypeAttachments(null, "application/pdf")).to.deep.equal(
        [],
      );
      expect(
        findSameTypeAttachments(undefined, "application/pdf"),
      ).to.deep.equal([]);
    });
  });
});
