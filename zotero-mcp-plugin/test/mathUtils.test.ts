import { expect } from "chai";
import {
  cosineSimilarity,
  cosineSimilarityInt8,
  quantizeToInt8,
  dequantizeFromInt8,
  float32ToInt8Buffer,
  int8BufferToFloat32,
} from "../src/modules/semantic/mathUtils";

describe("mathUtils", function () {
  describe("cosineSimilarity", function () {
    it("returns 1 for identical vectors", function () {
      const v = new Float32Array([1, 2, 3, 4]);
      expect(cosineSimilarity(v, v)).to.be.closeTo(1, 1e-6);
    });

    it("returns -1 for opposite vectors", function () {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([-1, 0, 0]);
      expect(cosineSimilarity(a, b)).to.be.closeTo(-1, 1e-6);
    });

    it("returns 0 for orthogonal vectors", function () {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      expect(cosineSimilarity(a, b)).to.be.closeTo(0, 1e-6);
    });

    it("returns 0 for zero vectors", function () {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(a, b)).to.equal(0);
    });

    it("is invariant to scaling", function () {
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([2, 4, 6]); // 2x scale of a
      expect(cosineSimilarity(a, b)).to.be.closeTo(1, 1e-6);
    });

    it("works with vectors longer than 8 (loop unrolling)", function () {
      const a = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const b = new Float32Array([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
      const result = cosineSimilarity(a, b);
      // Manually computed: dot = 220, normA = 385, normB = 385
      // cos = 220 / sqrt(385 * 385) = 220/385 ≈ 0.5714
      expect(result).to.be.closeTo(220 / 385, 1e-4);
    });

    it("handles exactly 8-element vectors (edge of unrolling)", function () {
      const a = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
      const b = new Float32Array([0, 0, 0, 0, 0, 0, 0, 1]);
      expect(cosineSimilarity(a, b)).to.be.closeTo(0, 1e-6);
    });

    it("throws on dimension mismatch", function () {
      const a = new Float32Array([1, 2]);
      const b = new Float32Array([1, 2, 3]);
      expect(() => cosineSimilarity(a, b)).to.throw("dimension mismatch");
    });
  });

  describe("quantizeToInt8 / dequantizeFromInt8", function () {
    it("maps max value to 127", function () {
      const v = new Float32Array([0.5, -0.5, 1.0]);
      const { quantized, scale } = quantizeToInt8(v);
      expect(scale).to.equal(127 / 1.0);
      expect(quantized[2]).to.equal(127);
    });

    it("maps negative max to -127", function () {
      const v = new Float32Array([0, 0, -1.0]);
      const { quantized } = quantizeToInt8(v);
      expect(quantized[2]).to.equal(-127);
    });

    it("round-trips with acceptable error", function () {
      const original = new Float32Array([0.3, -0.7, 0.1, 0.9]);
      const { quantized, scale } = quantizeToInt8(original);
      const restored = dequantizeFromInt8(quantized, scale);

      for (let i = 0; i < original.length; i++) {
        // Int8 quantization: max error is 1/127 * maxAbs ≈ 0.007
        expect(restored[i]).to.be.closeTo(original[i], 0.01);
      }
    });

    it("handles zero vector", function () {
      const v = new Float32Array([0, 0, 0]);
      const { quantized, scale } = quantizeToInt8(v);
      expect(scale).to.equal(1);
      expect(quantized[0]).to.equal(0);
      expect(quantized[1]).to.equal(0);
      expect(quantized[2]).to.equal(0);
    });

    it("preserves relative magnitudes", function () {
      const v = new Float32Array([0.1, 0.5, 1.0]);
      const { quantized } = quantizeToInt8(v);
      expect(quantized[0]).to.be.lessThan(quantized[1]);
      expect(quantized[1]).to.be.lessThan(quantized[2]);
    });
  });

  describe("cosineSimilarityInt8", function () {
    it("matches float cosine similarity within quantization error", function () {
      const a = new Float32Array([0.3, -0.7, 0.1, 0.9, 0.5, -0.2, 0.8, 0.4]);
      const b = new Float32Array([0.1, 0.5, -0.3, 0.6, -0.1, 0.9, 0.2, -0.7]);

      const floatSim = cosineSimilarity(a, b);
      const { quantized: qa } = quantizeToInt8(a);
      const { quantized: qb } = quantizeToInt8(b);
      const int8Sim = cosineSimilarityInt8(qa, qb);

      // Int8 cosine should be within ~1% of float cosine
      expect(int8Sim).to.be.closeTo(floatSim, 0.02);
    });

    it("returns 1 for identical quantized vectors", function () {
      const v = new Float32Array([0.5, -0.3, 0.8, 0.1]);
      const { quantized } = quantizeToInt8(v);
      expect(cosineSimilarityInt8(quantized, quantized)).to.be.closeTo(1, 1e-6);
    });

    it("returns 0 for zero vectors", function () {
      const zero = new Int8Array([0, 0, 0, 0]);
      expect(cosineSimilarityInt8(zero, zero)).to.equal(0);
    });
  });

  describe("float32ToInt8Buffer / int8BufferToFloat32", function () {
    it("round-trips through buffer storage", function () {
      const original = new Float32Array([0.3, -0.7, 0.1, 0.9]);
      const buffer = float32ToInt8Buffer(original);

      // Buffer should be 4 (scale) + 4 (int8 values) = 8 bytes
      expect(buffer.length).to.equal(8);

      const restored = int8BufferToFloat32(buffer, original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).to.be.closeTo(original[i], 0.01);
      }
    });

    it("stores scale in first 4 bytes as Float32LE", function () {
      const v = new Float32Array([1.0]);
      const buffer = float32ToInt8Buffer(v);
      const scaleView = new DataView(buffer.buffer);
      const scale = scaleView.getFloat32(0, true);
      expect(scale).to.equal(127);
    });

    it("handles high-dimensional vectors", function () {
      const dims = 512;
      const original = new Float32Array(dims);
      for (let i = 0; i < dims; i++) {
        original[i] = Math.sin(i * 0.1);
      }
      const buffer = float32ToInt8Buffer(original);
      expect(buffer.length).to.equal(4 + dims);

      const restored = int8BufferToFloat32(buffer, dims);
      const similarity = cosineSimilarity(original, restored);
      // Should have very high similarity after round-trip
      expect(similarity).to.be.greaterThan(0.99);
    });
  });
});
