/**
 * Regression tests for annotation ordering.
 *
 * Zotero's `annotationSortIndex` is a fixed-width, zero-padded string
 * ("page|offset|top"). It was previously typed and sorted as a number,
 * which produced NaN comparisons and string concatenation in the
 * "position" sort.
 */

import { expect } from "chai";
import {
  compareSortIndex,
  positionKey,
  AnnotationContent,
} from "../src/modules/annotationService";

function annotation(page: number, sortIndex: string): AnnotationContent {
  return {
    id: sortIndex,
    itemKey: sortIndex,
    type: "highlight",
    content: "",
    tags: [],
    dateAdded: "",
    dateModified: "",
    page,
    sortIndex,
  };
}

describe("annotation sort", function () {
  describe("compareSortIndex", function () {
    it("orders by offset within a page", function () {
      const indexes = ["00002|000300|00010", "00002|000045|00500"];
      expect(indexes.sort(compareSortIndex)).to.deep.equal([
        "00002|000045|00500",
        "00002|000300|00010",
      ]);
    });

    it("treats missing indexes as smallest and equal values as 0", function () {
      expect(compareSortIndex(undefined, "00000|000000|00000")).to.equal(-1);
      expect(
        compareSortIndex("00001|000001|00001", "00001|000001|00001"),
      ).to.equal(0);
    });
  });

  describe("positionKey", function () {
    it("orders by page number numerically, then sort index", function () {
      const items = [
        annotation(10, "00009|000001|00001"),
        annotation(2, "00001|000500|00001"),
        annotation(2, "00001|000020|00001"),
      ];
      const ordered = items
        .sort((a, b) => (positionKey(a) < positionKey(b) ? -1 : 1))
        .map((a) => `${a.page}:${a.sortIndex}`);
      expect(ordered).to.deep.equal([
        "2:00001|000020|00001",
        "2:00001|000500|00001",
        "10:00009|000001|00001",
      ]);
    });
  });
});
