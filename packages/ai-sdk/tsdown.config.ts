import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  deps: {
    neverBundle: ["talkio", "ai"],
  },
  minify: true,
});
