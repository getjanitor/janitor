import { defineConfig } from "tsdown";

export default defineConfig({
  copy: {
    from: "src/commands/templates/*",
    to: "dist/templates",
  },
  dts: {
    tsgo: true,
  },
  exports: true,
});
