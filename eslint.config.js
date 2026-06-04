// Flat ESLint config (ESLint 9). Lints the TypeScript source only; the build output, the bundled
// plugin server, the VS Code extension, and the loose .mjs tooling scripts are out of scope.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "claude-plugin/server/**",
      "extension/**",
      "scratch/**",
      "tools/**",
      "node_modules/**",
      "**/*.mjs",
      "**/*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Disables stylistic rules that Prettier owns, so the two never fight.
  prettier,
  {
    rules: {
      // Unused *vars* are dead code → error (underscore prefix is the intentional escape hatch).
      // Unused *args* are not linted: callbacks and tool handlers routinely conform to a wider
      // signature than they use (mock fakes, MCP payloads), and TypeScript already catches a
      // genuinely wrong signature. caughtErrors:none lets `catch (e)` stand without forcing `_e`.
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // `any` is used deliberately and locally at a few untyped boundaries (SQLite row shapes,
      // JSON parsed from the board, MCP payloads). Each site is small and cast immediately; a
      // blanket ban would push us to noisier `unknown` + guards with no real safety gain here.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
