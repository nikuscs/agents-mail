import { preset } from "oxlint-plugin-arch/preset";

export default preset({
  root: import.meta.dirname,
  folders: {
    ".": {
      style: { quotes: "double" },
      rules: { "arch/layout-chain": ["error", { groups: [{ min: 3, methods: ["map", "filter", "reduce", "flatMap", "find", "some", "every", "sort"] }] }] },
    },
    "apps/worker": { types: { colocated: ["apps/worker/src/worker.types.ts"] } },
    "apps/worker/src": {
      naming: { exports: false },
      rules: { "no-console": ["error", { allow: ["error"] }] },
    },
    scripts: { rules: { "no-alert": "off" } },
  },
});
