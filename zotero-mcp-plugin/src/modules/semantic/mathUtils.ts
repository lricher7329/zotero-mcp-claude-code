/**
 * Pure math utilities for vector operations.
 * Extracted for testability — no Zotero dependencies.
 */

/**
 * Calculate cosine similarity between two Float32 vectors.
 * Optimized with 8-element loop unrolling.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = a.length;
  if (len !== b.length) {
    throw new Error(`Vector dimension mismatch: ${len} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  const unrollEnd = len - (len % 8);
  let i = 0;

  for (; i < unrollEnd; i += 8) {
    const a0 = a[i],
      a1 = a[i + 1],
      a2 = a[i + 2],
      a3 = a[i + 3];
    const a4 = a[i + 4],
      a5 = a[i + 5],
      a6 = a[i + 6],
      a7 = a[i + 7];
    const b0 = b[i],
      b1 = b[i + 1],
      b2 = b[i + 2],
      b3 = b[i + 3];
    const b4 = b[i + 4],
      b5 = b[i + 5],
      b6 = b[i + 6],
      b7 = b[i + 7];

    dotProduct +=
      a0 * b0 +
      a1 * b1 +
      a2 * b2 +
      a3 * b3 +
      a4 * b4 +
      a5 * b5 +
      a6 * b6 +
      a7 * b7;
    normA +=
      a0 * a0 +
      a1 * a1 +
      a2 * a2 +
      a3 * a3 +
      a4 * a4 +
      a5 * a5 +
      a6 * a6 +
      a7 * a7;
    normB +=
      b0 * b0 +
      b1 * b1 +
      b2 * b2 +
      b3 * b3 +
      b4 * b4 +
      b5 * b5 +
      b6 * b6 +
      b7 * b7;
  }

  for (; i < len; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA * normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Quantize a Float32Array to Int8Array with scale factor.
 * Scale maps the max absolute value to 127.
 */
export function quantizeToInt8(vector: Float32Array): {
  quantized: Int8Array;
  scale: number;
} {
  const len = vector.length;

  let maxAbs = 0;
  for (let i = 0; i < len; i++) {
    const abs = Math.abs(vector[i]);
    if (abs > maxAbs) maxAbs = abs;
  }

  const scale = maxAbs > 0 ? 127 / maxAbs : 1;

  const quantized = new Int8Array(len);
  for (let i = 0; i < len; i++) {
    quantized[i] = Math.round(vector[i] * scale);
  }

  return { quantized, scale };
}

/**
 * Dequantize Int8Array back to Float32Array using the scale factor.
 */
export function dequantizeFromInt8(
  quantized: Int8Array,
  scale: number,
): Float32Array {
  const len = quantized.length;
  const vector = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    vector[i] = quantized[i] / scale;
  }

  return vector;
}

/**
 * Fast cosine similarity using Int8 quantized vectors.
 * Scale factors cancel out in cosine similarity, so they're unused.
 */
export function cosineSimilarityInt8(
  queryInt8: Int8Array,
  storedInt8: Int8Array,
): number {
  const len = queryInt8.length;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  const unrollEnd = len - (len % 8);
  let i = 0;

  for (; i < unrollEnd; i += 8) {
    const a0 = queryInt8[i],
      a1 = queryInt8[i + 1],
      a2 = queryInt8[i + 2],
      a3 = queryInt8[i + 3];
    const a4 = queryInt8[i + 4],
      a5 = queryInt8[i + 5],
      a6 = queryInt8[i + 6],
      a7 = queryInt8[i + 7];
    const b0 = storedInt8[i],
      b1 = storedInt8[i + 1],
      b2 = storedInt8[i + 2],
      b3 = storedInt8[i + 3];
    const b4 = storedInt8[i + 4],
      b5 = storedInt8[i + 5],
      b6 = storedInt8[i + 6],
      b7 = storedInt8[i + 7];

    dotProduct +=
      a0 * b0 +
      a1 * b1 +
      a2 * b2 +
      a3 * b3 +
      a4 * b4 +
      a5 * b5 +
      a6 * b6 +
      a7 * b7;
    normA +=
      a0 * a0 +
      a1 * a1 +
      a2 * a2 +
      a3 * a3 +
      a4 * a4 +
      a5 * a5 +
      a6 * a6 +
      a7 * a7;
    normB +=
      b0 * b0 +
      b1 * b1 +
      b2 * b2 +
      b3 * b3 +
      b4 * b4 +
      b5 * b5 +
      b6 * b6 +
      b7 * b7;
  }

  for (; i < len; i++) {
    const a = queryInt8[i];
    const b = storedInt8[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  const magnitude = Math.sqrt(normA * normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Pack a Float32Array into an Int8 storage buffer.
 * Format: [scale as Float32LE (4 bytes)] + [Int8 values (n bytes)]
 */
export function float32ToInt8Buffer(arr: Float32Array): Uint8Array {
  const { quantized, scale } = quantizeToInt8(arr);
  const buffer = new Uint8Array(4 + quantized.length);
  const scaleView = new DataView(buffer.buffer);
  scaleView.setFloat32(0, scale, true);
  buffer.set(new Uint8Array(quantized.buffer), 4);
  return buffer;
}

/**
 * Unpack an Int8 storage buffer back to Float32Array.
 */
export function int8BufferToFloat32(
  buffer: Uint8Array,
  dimensions: number,
): Float32Array {
  const scaleView = new DataView(buffer.buffer, buffer.byteOffset, 4);
  const scale = scaleView.getFloat32(0, true);
  const quantized = new Int8Array(
    buffer.buffer,
    buffer.byteOffset + 4,
    dimensions,
  );
  return dequantizeFromInt8(quantized, scale);
}
