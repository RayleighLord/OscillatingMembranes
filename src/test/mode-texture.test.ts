import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { encodeModeTexturePixels } from "../membrane/renderer";

describe("half-float mode texture encoding", () => {
  it("preserves exact normalized landmarks, signs, and signed zero", () => {
    const source = new Float32Array([-1, -0.5, -0, 0, 0.5, 1]);
    const encoded = encodeModeTexturePixels(source);

    expect(encoded).toEqual(
      new Uint16Array([0xbc00, 0xb800, 0x8000, 0x0000, 0x3800, 0x3c00])
    );
    const decoded = Array.from(encoded, (value) => THREE.DataUtils.fromHalfFloat(value));
    expect(decoded).toEqual([-1, -0.5, -0, 0, 0.5, 1]);
    expect(Object.is(decoded[2], -0)).toBe(true);
    expect(Object.is(decoded[3], 0)).toBe(true);
  });

  it("keeps dense normalized samples within one FP16 step at unit scale", () => {
    const source = Float32Array.from(
      { length: 8_193 },
      (_, index) => -1 + (2 * index) / 8_192
    );
    const encoded = encodeModeTexturePixels(source);
    let maximumError = 0;

    for (let index = 0; index < source.length; index += 1) {
      const original = source[index];
      const half = encoded[index];
      expect(original).toBeDefined();
      expect(half).toBeDefined();
      maximumError = Math.max(
        maximumError,
        Math.abs(THREE.DataUtils.fromHalfFloat(half ?? 0) - (original ?? 0))
      );
    }

    expect(maximumError).toBeLessThanOrEqual(2 ** -11);
  });

  it("reuses a correctly sized target and rejects invalid inputs", () => {
    const target = new Uint16Array(4);
    const encoded = encodeModeTexturePixels([1, -0.25, 0.125, 0], target);

    expect(encoded).toBe(target);
    expect(encoded).toEqual(new Uint16Array([0x3c00, 0xb400, 0x3000, 0x0000]));
    expect(() => encodeModeTexturePixels([0, 1], new Uint16Array(1))).toThrow(
      /target length 1 does not match source length 2/
    );
    expect(() => encodeModeTexturePixels([0, Number.NaN])).toThrow(/sample 1 must be finite/);
    expect(() => encodeModeTexturePixels([Number.POSITIVE_INFINITY])).toThrow(
      /sample 0 must be finite/
    );
  });
});
