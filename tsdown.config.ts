import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    neverBundle: ["bun:sqlite"],
  },
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
});
