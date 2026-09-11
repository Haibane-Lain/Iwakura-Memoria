// ESLint flat config for the frontend sources, tests and the Electron shell.
// The vendored `static/lib/marked.js` and the esbuild output under
// `static/dist/` are generated/third-party and deliberately ignored.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "electron/node_modules/**",
      ".venv/**",
      "_jre/**",
      "LanguageTool 6.9/**",
      "WordNet 3.0/**",
      "static/lib/**",
      "static/dist/**",
      "dist/**",
      "scripts/build/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["static/js/**/*.js", "client/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // The JS tests run pieces of the frontend inside jsdom, so browser
      // globals (window, document, CustomEvent, …) are available too.
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["electron/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
];
