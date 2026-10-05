/**
 * search_library result shape for top-level items and for child results
 * returned by resultLevel attachment/note/annotation (Zotero 10).
 */

import { expect } from "chai";
import { formatItemBrief } from "../src/modules/itemFormatter";

function fakeItem(props: Record<string, any>): any {
  return {
    isTopLevelItem: () => !props.topLevelItem,
    isAnnotation: () => props.itemType === "annotation",
    isNote: () => props.itemType === "note",
    getField: (f: string) => props.fields?.[f] ?? "",
    getCreators: () => props.creators ?? [],
    getDisplayTitle: () => props.fields?.title ?? "",
    getNoteTitle: () => props.noteTitle ?? "",
    ...props,
  };
}

describe("formatItemBrief", function () {
  let paper: any;
  let pdf: any;

  beforeEach(function () {
    paper = fakeItem({
      key: "PAPER001",
      itemType: "journalArticle",
      fields: { title: "Twin study", date: "2021-05-01" },
      creators: [{ firstName: "Ann", lastName: "Carlsson" }],
    });
    pdf = fakeItem({
      key: "PDF00001",
      itemType: "attachment",
      fields: { title: "Full Text PDF" },
      topLevelItem: paper,
      parentItem: paper,
    });
  });

  it("formats top-level items without parent fields", function () {
    expect(formatItemBrief(paper)).to.deep.equal({
      key: "PAPER001",
      itemType: "journalArticle",
      title: "Twin study",
      creators: "Ann Carlsson",
      date: "2021",
    });
  });

  it("links attachments and notes to their top-level item", function () {
    const brief = formatItemBrief(pdf);
    expect(brief).to.include({
      itemType: "attachment",
      title: "Full Text PDF",
      parentItemKey: "PAPER001",
      parentTitle: "Twin study",
    });

    const note = fakeItem({
      key: "NOTE0001",
      itemType: "note",
      noteTitle: "Reading notes",
      topLevelItem: paper,
    });
    expect(formatItemBrief(note)).to.include({
      title: "Reading notes",
      parentItemKey: "PAPER001",
    });
  });

  it("describes annotations with their text and owning paper", function () {
    const highlight = fakeItem({
      key: "ANNOT001",
      itemType: "annotation",
      annotationType: "highlight",
      annotationText: "low birth weight",
      annotationComment: "",
      annotationColor: "#ffd400",
      annotationPageLabel: "1488",
      parentItem: pdf,
      topLevelItem: paper,
    });
    expect(formatItemBrief(highlight)).to.deep.equal({
      key: "ANNOT001",
      itemType: "annotation",
      title: "Twin study",
      annotationType: "highlight",
      text: "low birth weight",
      comment: "",
      color: "#ffd400",
      pageLabel: "1488",
      attachmentKey: "PDF00001",
      parentItemKey: "PAPER001",
      creators: "",
      date: "",
    });
  });
});
