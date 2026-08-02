import { brotliDecompressSync } from "node:zlib";
import { presetCssA } from "./presetCssA.js";
import { presetCssB } from "./presetCssB.js";
import { presetJsA } from "./presetJsA.js";
import { presetJsB } from "./presetJsB.js";

export const presetCssAsset = brotliDecompressSync(Buffer.from(presetCssA + presetCssB, "base64"));
export const presetJsAsset = brotliDecompressSync(Buffer.from(presetJsA + presetJsB, "base64"));
