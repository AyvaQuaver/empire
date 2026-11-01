import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "web/dist/**", "*.min.js"],
  },
  {
    files: ["server/src/**/*.ts", "server/test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      // The server tolerates `any` casts for node:sqlite row reads in tests;
      // strictness lives at the typecheck level.
      "@typescript-eslint/no-explicit-any": "off",
      // `_`-prefixed parameters are documentation of intent.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Control-character rejection regexes are safe here (we PROHIBIT them).
      "no-control-regex": "off",
    },
  },
  {
    files: ["web/src/**/*.ts", "web/src/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
