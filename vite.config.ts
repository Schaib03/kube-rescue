import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/kube-rescue/",
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
