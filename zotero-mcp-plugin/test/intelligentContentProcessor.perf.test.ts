/**
 * Guards against the quadratic/cubic scoring regression: a long document
 * (~2,000 sentences, the size of a typical paper's cached full text) took
 * ~130 s in Zotero before TF-IDF and TextRank were rewritten.
 */

import { expect } from "chai";
import { IntelligentContentProcessor } from "../src/modules/intelligentContentProcessor";

describe("IntelligentContentProcessor performance", function () {
  this.timeout(20000);

  it("scores a ~2,000-sentence document in a few seconds", async function () {
    const vocabulary = [
      "cohort",
      "sibling",
      "twin",
      "exposure",
      "outcome",
      "risk",
      "birth",
      "weight",
      "gestational",
      "income",
      "maternal",
      "smoking",
      "autism",
      "attention",
      "deficit",
      "disorder",
      "confounding",
      "familial",
      "genetic",
      "environment",
      "association",
      "estimate",
      "analysis",
      "design",
    ];
    const sentences: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const words = Array.from(
        { length: 14 },
        (_, k) => vocabulary[(i * 7 + k * 5) % vocabulary.length],
      );
      sentences.push(`Sentence ${i} ${words.join(" ")}.`);
    }

    const start = Date.now();
    const result = await new IntelligentContentProcessor().processContent(
      sentences.join(" "),
      "standard",
      {},
    );
    const elapsed = Date.now() - start;

    expect(result.processedText.length).to.be.greaterThan(0);
    expect(elapsed).to.be.lessThan(5000);
  });
});
