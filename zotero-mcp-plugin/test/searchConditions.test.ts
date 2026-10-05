/**
 * Tests for structured search_library conditions (Zotero 10 condition groups,
 * resultLevel, isEmpty/isNotEmpty) and their Zotero 7–9 fallback.
 */

import { expect } from "chai";
import {
  buildConditionList,
  parseConditions,
  SearchConditionError,
  supportsConditionGroups,
} from "../src/modules/searchConditions";

const z10 = { supportsGroups: true };
const z9 = { supportsGroups: false };

describe("searchConditions", function () {
  describe("parseConditions", function () {
    it("accepts arrays and JSON strings", function () {
      const tree = [{ field: "title", operator: "contains", value: "twin" }];
      expect(parseConditions(tree)).to.deep.equal(tree);
      expect(parseConditions(JSON.stringify(tree))).to.deep.equal(tree);
    });

    it("rejects non-arrays and bad JSON", function () {
      expect(() => parseConditions("{")).to.throw(SearchConditionError);
      expect(() => parseConditions({ field: "title" })).to.throw(
        SearchConditionError,
      );
    });
  });

  describe("on Zotero 10", function () {
    it("wraps the tree in one group so joinMode stays local", function () {
      const out = buildConditionList(
        [
          { field: "title", operator: "contains", value: "twin" },
          { field: "title", operator: "contains", value: "sibling" },
        ],
        { ...z10, joinMode: "any" },
      );
      expect(out).to.deep.equal([
        ["groupStart", "true", ""],
        ["joinMode", "any", ""],
        ["title", "contains", "twin"],
        ["title", "contains", "sibling"],
        ["groupEnd", "true", ""],
      ]);
    });

    it("emits nested groups with their own joinMode and resultLevel", function () {
      const out = buildConditionList(
        [
          { field: "itemType", operator: "is", value: "journalArticle" },
          {
            resultLevel: "annotation",
            conditions: [
              {
                field: "annotationText",
                operator: "contains",
                value: "birth weight",
              },
              { field: "annotationColor", operator: "is", value: "#ffd400" },
            ],
          },
        ],
        z10,
      );
      expect(out).to.deep.equal([
        ["groupStart", "true", ""],
        ["joinMode", "all", ""],
        ["itemType", "is", "journalArticle"],
        ["groupStart", "true", ""],
        ["joinMode", "all", ""],
        ["resultLevel", "annotation", ""],
        ["annotationText", "contains", "birth weight"],
        ["annotationColor", "is", "#ffd400"],
        ["groupEnd", "true", ""],
        ["groupEnd", "true", ""],
      ]);
    });

    it("drops values for isEmpty/isNotEmpty and stringifies numbers", function () {
      const out = buildConditionList(
        [
          { field: "abstractNote", operator: "isEmpty", value: "ignored" },
          { field: "numAnnotations", operator: "isGreaterThan", value: 3 },
        ],
        z10,
      );
      expect(out.slice(2, 4)).to.deep.equal([
        ["abstractNote", "isEmpty", ""],
        ["numAnnotations", "isGreaterThan", "3"],
      ]);
    });
  });

  describe("on Zotero 7–9", function () {
    it("passes a flat all-joined list through unchanged", function () {
      expect(
        buildConditionList(
          [{ field: "creator", operator: "contains", value: "Carlsson" }],
          z9,
        ),
      ).to.deep.equal([["creator", "contains", "Carlsson"]]);
    });

    it("rejects groups, any-joins and Zotero 10 operators", function () {
      expect(() =>
        buildConditionList(
          [{ conditions: [{ field: "title", operator: "is", value: "x" }] }],
          z9,
        ),
      ).to.throw(/requires Zotero 10/);
      expect(() =>
        buildConditionList([{ field: "title", operator: "is", value: "x" }], {
          ...z9,
          joinMode: "any",
        }),
      ).to.throw(/requires Zotero 10/);
      expect(() =>
        buildConditionList(
          [{ field: "abstractNote", operator: "isEmpty" }],
          z9,
        ),
      ).to.throw(/requires Zotero 10/);
    });
  });

  describe("validation", function () {
    it("rejects structural fields, unknown operators and empty groups", function () {
      expect(() =>
        buildConditionList(
          [{ field: "groupStart", operator: "true", value: "" }],
          z10,
        ),
      ).to.throw(/not allowed/);
      expect(() =>
        buildConditionList(
          [{ field: "title", operator: "LIKE", value: "x" }],
          z10,
        ),
      ).to.throw(/Invalid operator/);
      expect(() => buildConditionList([{ conditions: [] }], z10)).to.throw(
        /cannot be empty/,
      );
      expect(() =>
        buildConditionList(
          [
            {
              resultLevel: "chapter" as any,
              conditions: [{ field: "title", operator: "is", value: "x" }],
            },
          ],
          z10,
        ),
      ).to.throw(/Invalid resultLevel/);
    });

    it("limits nesting depth and condition count", function () {
      let deep: any = { field: "title", operator: "is", value: "x" };
      for (let i = 0; i < 5; i++) deep = { conditions: [deep] };
      expect(() => buildConditionList([deep], z10)).to.throw(/nested/);

      const many = Array.from({ length: 51 }, () => ({
        field: "title",
        operator: "contains",
        value: "x",
      }));
      expect(() => buildConditionList(many, z10)).to.throw(/At most 50/);
    });

    it("reports a 400 status for request errors", function () {
      expect(new SearchConditionError("x").status).to.equal(400);
    });
  });

  describe("supportsConditionGroups", function () {
    const g = globalThis as any;
    let saved: any;

    beforeEach(function () {
      saved = g.Zotero;
    });

    afterEach(function () {
      g.Zotero = saved;
    });

    it("detects the groupStart condition", function () {
      g.Zotero = {
        SearchConditions: { get: (n: string) => n === "groupStart" },
      };
      expect(supportsConditionGroups()).to.equal(true);
      g.Zotero = { SearchConditions: { get: () => false } };
      expect(supportsConditionGroups()).to.equal(false);
      g.Zotero = {};
      expect(supportsConditionGroups()).to.equal(false);
    });
  });
});
