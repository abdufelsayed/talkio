import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^talkio\/audio$/,
        replacement: fileURLToPath(new URL("../talkio/src/audio/index.ts", import.meta.url)),
      },
      {
        find: /^talkio$/,
        replacement: fileURLToPath(new URL("../talkio/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
