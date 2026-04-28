import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@talkio/testkit": fileURLToPath(new URL("../testkit/src/index.ts", import.meta.url)),
      talkio: fileURLToPath(new URL("../talkio/src/index.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
