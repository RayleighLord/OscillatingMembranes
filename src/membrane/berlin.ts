import * as THREE from "three";

/**
 * Fabio Crameri's Berlin scientific colour map, version 8.0.1.
 *
 * Berlin is a perceptually uniform, colour-vision-deficiency-friendly diverging
 * map designed for dark backgrounds. Its dark centre represents zero, while
 * the light blue and coral ends represent negative and positive displacement.
 * The colour-table data are distributed under the MIT licence.
 *
 * Source: https://doi.org/10.5281/zenodo.8409685
 * Copyright (c) 2023 Fabio Crameri
 */
const BERLIN_HEX =
  "9eb0ff9cb0fe9ab0fd98affc95affb93affa91aef98eaef78caef68aaef587adf485adf382adf280acf17eacf07bacee79abed76abec74aaeb71aae96fa9e86c" +
  "a9e66aa8e567a8e365a7e262a6e060a5df5da5dd5ba4db58a3d956a2d754a0d5519fd34f9ed14d9dcf4b9bcd489aca4698c84497c64395c34194c13f92be3e90" +
  "bc3c8eb93b8db7398bb43889b23787af3685ad3584aa3382a83280a6327ea3317ca1307a9e2f789c2e76992d75972c73942c71922b6f8f2a6d8d296b8b296988" +
  "28688627668327648126627f25607c245e7a245d78235b7522597322577121556e20546c20526a1f50681e4e651e4d631d4b611c495f1c475c1b465a1a44581a" +
  "4256194153193f51183d4f173c4d173a4b16384916374715354415334214324014303e132f3c132d3a122c38122a3612293411273211263011242e11232c1121" +
  "2a112028101f26101d25101c23111b21111a2011191e11181c11161b111519111418111317121215121214131112141011140f10150e0e160e0d170d0b180c0a" +
  "190c091a0c081b0b071c0b061d0b051e0b04200b04210b03220c02230c02240c02250c01260d01270d01280d012a0e012b0e012c0e002d0e002f0e00300f0031" +
  "0f00330f00340f003510003710003810003911003b11003c11013e12013f12014112014213014413014514014714014815024a15024b16024d16024f17035018" +
  "03521804541905561a05571b06591c075b1d085d1e095f1f0a61200b63210c65230e68240f6a25106c27116e2813702a14732b16752d17772f1979301b7b321c" +
  "7d341e803620823722843924863b26883d288a3f2a8c402c8e422e904430924632944834964a36984c399a4d3b9c4f3d9e513fa05341a25544a45746a65948a8" +
  "5a4aaa5c4cac5e4fae6051b06253b26455b46658b6685ab86a5cba6b5fbc6d61be6f63c07165c27368c4756ac6776cc8796fca7b71cc7d73ce7f76d08178d283" +
  "7ad5857dd7877fd98982db8b84dd8d86df8f89e1918be3938ee59590e79792ea9995ec9b97ee9d9af09f9cf2a19ff4a3a1f6a5a3f9a7a6fba9a8fdababffadad";

export const BERLIN_SAMPLE_COUNT = 256;

export const BERLIN_ENDPOINTS = {
  negative: "#9eb0ff",
  zero: "#190c09",
  positive: "#ffadad"
} as const;

/** Create the one-dimensional sRGB lookup texture used by the membrane shader. */
export function createBerlinTexture(): THREE.DataTexture {
  const data = new Uint8Array(BERLIN_SAMPLE_COUNT * 4);
  for (let index = 0; index < BERLIN_SAMPLE_COUNT; index += 1) {
    const sourceOffset = index * 6;
    const destinationOffset = index * 4;
    data[destinationOffset] = Number.parseInt(BERLIN_HEX.slice(sourceOffset, sourceOffset + 2), 16);
    data[destinationOffset + 1] = Number.parseInt(
      BERLIN_HEX.slice(sourceOffset + 2, sourceOffset + 4),
      16
    );
    data[destinationOffset + 2] = Number.parseInt(
      BERLIN_HEX.slice(sourceOffset + 4, sourceOffset + 6),
      16
    );
    data[destinationOffset + 3] = 255;
  }

  const texture = new THREE.DataTexture(
    data,
    BERLIN_SAMPLE_COUNT,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  texture.name = "Crameri Berlin v8";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Map signed normalized displacement from [-1, 1] to the Berlin LUT domain. */
export function berlinCoordinate(displacement: number): number {
  return (THREE.MathUtils.clamp(displacement, -1, 1) + 1) * 0.5;
}
