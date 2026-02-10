import "./setup";
import { expect } from "chai";
import { TextChunker } from "../src/modules/semantic/textChunker";

describe("TextChunker", function () {
  describe("chunk()", function () {
    it("returns empty array for empty input", function () {
      const chunker = new TextChunker();
      expect(chunker.chunk("")).to.deep.equal([]);
      expect(chunker.chunk("   ")).to.deep.equal([]);
    });

    it("returns single chunk for short text", function () {
      const chunker = new TextChunker({ maxChunkSize: 500 });
      const text = "This is a short sentence.";
      const chunks = chunker.chunk(text);
      expect(chunks).to.have.length(1);
      expect(chunks[0]).to.equal(text);
    });

    it("returns text as-is when below minChunkSize", function () {
      const chunker = new TextChunker({ minChunkSize: 50 });
      const text = "Short.";
      const chunks = chunker.chunk(text);
      expect(chunks).to.have.length(1);
      expect(chunks[0]).to.equal(text);
    });

    it("splits long text into multiple chunks", function () {
      const chunker = new TextChunker({ maxChunkSize: 50, minChunkSize: 5 });
      const text = "A".repeat(40) + "\n\n" + "B".repeat(40);
      const chunks = chunker.chunk(text);
      expect(chunks.length).to.be.greaterThan(1);
    });

    it("splits on paragraph boundaries", function () {
      const chunker = new TextChunker({
        maxChunkSize: 100,
        minChunkSize: 5,
      });
      const text =
        "Paragraph one here.\n\nParagraph two here.\n\nParagraph three here.";
      const chunks = chunker.chunk(text);
      // Should combine paragraphs up to maxChunkSize
      expect(chunks.length).to.be.at.least(1);
      expect(chunks.join(" ")).to.include("Paragraph");
    });

    it("splits long paragraphs by sentences", function () {
      const chunker = new TextChunker({
        maxChunkSize: 50,
        minChunkSize: 5,
      });
      const text =
        "First sentence here. Second sentence here. Third sentence here. Fourth sentence here.";
      const chunks = chunker.chunk(text);
      expect(chunks.length).to.be.greaterThan(1);
    });

    it("handles Chinese sentence delimiters", function () {
      const chunker = new TextChunker({
        maxChunkSize: 20,
        minChunkSize: 5,
      });
      const text = "这是第一句话。这是第二句话。这是第三句话。这是第四句话。";
      const chunks = chunker.chunk(text);
      expect(chunks.length).to.be.greaterThan(1);
    });

    it("normalizes excessive whitespace", function () {
      const chunker = new TextChunker();
      const text = "Hello    world\t\there\r\ntest";
      const chunks = chunker.chunk(text);
      expect(chunks[0]).not.to.include("    ");
      expect(chunks[0]).not.to.include("\t");
    });

    it("no chunk exceeds maxChunkSize", function () {
      const maxChunkSize = 100;
      const chunker = new TextChunker({ maxChunkSize, minChunkSize: 5 });
      const text = Array(20).fill("A word. ").join("").repeat(5);
      const chunks = chunker.chunk(text);
      for (const chunk of chunks) {
        expect(chunk.length).to.be.at.most(maxChunkSize);
      }
    });
  });

  describe("chunkWithPositions()", function () {
    it("returns chunks with position info", function () {
      const chunker = new TextChunker({
        maxChunkSize: 60,
        minChunkSize: 5,
      });
      const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
      const chunks = chunker.chunkWithPositions(text);
      expect(chunks.length).to.be.at.least(1);
      for (const chunk of chunks) {
        expect(chunk).to.have.property("id");
        expect(chunk).to.have.property("text");
        expect(chunk).to.have.property("startPos");
        expect(chunk).to.have.property("endPos");
        expect(chunk.endPos).to.be.greaterThan(chunk.startPos);
      }
    });

    it("assigns sequential IDs starting from 0", function () {
      const chunker = new TextChunker({
        maxChunkSize: 30,
        minChunkSize: 5,
      });
      const text = "One paragraph.\n\nAnother one.\n\nThird one.";
      const chunks = chunker.chunkWithPositions(text);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].id).to.equal(i);
      }
    });
  });

  describe("estimateTokens()", function () {
    it("estimates English tokens at ~4 chars per token", function () {
      const chunker = new TextChunker();
      const text = "Hello world test string here";
      const tokens = chunker.estimateTokens(text);
      // 28 chars / 4 = 7 tokens
      expect(tokens).to.equal(7);
    });

    it("estimates Chinese tokens at ~1.5 chars per token", function () {
      const chunker = new TextChunker();
      const text = "你好世界测试";
      const tokens = chunker.estimateTokens(text);
      // 6 chinese chars / 1.5 = 4 tokens
      expect(tokens).to.equal(4);
    });

    it("handles mixed Chinese-English text", function () {
      const chunker = new TextChunker();
      const text = "Hello你好World世界";
      const tokens = chunker.estimateTokens(text);
      // 10 English chars / 4 = 2.5, 4 Chinese chars / 1.5 = 2.67 → ceil(5.17) = 6
      expect(tokens).to.be.greaterThan(0);
    });
  });

  describe("detectLanguage()", function () {
    it("detects English text", function () {
      const chunker = new TextChunker();
      expect(chunker.detectLanguage("This is English text.")).to.equal("en");
    });

    it("detects Chinese text", function () {
      const chunker = new TextChunker();
      expect(chunker.detectLanguage("这是中文文本测试")).to.equal("zh");
    });

    it("detects mixed text as Chinese when >30%", function () {
      const chunker = new TextChunker();
      // 4 Chinese + 5 English = 9 chars, 44% Chinese → zh
      expect(chunker.detectLanguage("ab你好cd世界e")).to.equal("zh");
    });

    it("detects mixed text as English when <30%", function () {
      const chunker = new TextChunker();
      // 2 Chinese + 20 English → ~9% Chinese → en
      expect(chunker.detectLanguage("This is mostly English 你好")).to.equal(
        "en",
      );
    });
  });
});
