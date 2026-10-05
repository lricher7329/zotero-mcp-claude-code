/**
 * Tests for Zotero 10 undo integration. On runtimes without
 * Zotero.UndoHistory (Zotero 7–9) the helpers must be no-ops so saves behave
 * exactly as before.
 */

import { expect } from "chai";
import {
  isUndoAvailable,
  stageUndo,
  undoOptions,
} from "../src/modules/undoSupport";

const g = globalThis as any;

describe("undoSupport", function () {
  let savedZotero: any;
  let staged: Array<[string, any]>;

  beforeEach(function () {
    savedZotero = g.Zotero;
    staged = [];
  });

  afterEach(function () {
    g.Zotero = savedZotero;
  });

  function withUndoHistory(enabled = true) {
    g.Zotero = {
      UndoHistory: {
        isEnabled: () => enabled,
        stageAction: (action: string, args: any) => staged.push([action, args]),
      },
    };
  }

  describe("without Zotero.UndoHistory (Zotero 7–9)", function () {
    beforeEach(function () {
      g.Zotero = {};
    });

    it("reports undo unavailable and returns empty save options", function () {
      expect(isUndoAvailable()).to.equal(false);
      expect(undoOptions("undo-action-edit-metadata")).to.deep.equal({});
    });

    it("does not throw when staging", function () {
      expect(() => stageUndo("undo-action-add-related")).to.not.throw();
    });
  });

  describe("with Zotero.UndoHistory (Zotero 10)", function () {
    it("adds a count argument for plural messages", function () {
      withUndoHistory();
      expect(undoOptions("undo-action-add-tag", 3)).to.deep.equal({
        undoAction: "undo-action-add-tag",
        undoActionArgs: { count: 3 },
      });
    });

    it("omits arguments for messages without a count", function () {
      withUndoHistory();
      expect(undoOptions("undo-action-edit-note")).to.deep.equal({
        undoAction: "undo-action-edit-note",
      });
    });

    it("clamps counts to at least 1", function () {
      withUndoHistory();
      expect(undoOptions("undo-action-trash", 0).undoActionArgs).to.deep.equal({
        count: 1,
      });
    });

    it("stages actions on the undo history", function () {
      withUndoHistory();
      stageUndo("undo-action-remove-from-collection", 2);
      stageUndo("undo-action-add-related");
      expect(staged).to.deep.equal([
        ["undo-action-remove-from-collection", { count: 2 }],
        ["undo-action-add-related", undefined],
      ]);
    });

    it("is a no-op when undo is disabled in preferences", function () {
      withUndoHistory(false);
      expect(undoOptions("undo-action-edit-metadata")).to.deep.equal({});
      stageUndo("undo-action-add-tag", 1);
      expect(staged).to.have.length(0);
    });
  });
});
