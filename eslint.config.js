const prettier = require("eslint-config-prettier/flat");

module.exports = [
  {
    ignores: ["dist/**", "release/**", "node_modules/**"],
  },
  prettier,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        // Node.js globals
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-undef": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      // A catch block that discards the error must say why. Swallowing errors
      // silently was this codebase's largest bug-concealment surface: 109
      // sites, several of which hid real failures (a dropped attachment, an
      // unsaved setting, a Pi stream error thrown into its own catch).
      // `allowEmptyCatch: false` plus this rule means an empty catch has to
      // carry a comment explaining that the failure is genuinely expected.
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    // Split client files: sequential classic scripts sharing one global
    // scope. Per-file analysis cannot see cross-file symbols (there are
    // ~2,200 cross-file references), so undef/unused can only be checked on
    // the whole program. scripts/lint-frontend.js does exactly that — it
    // concatenates these files the way index.html loads them and runs
    // no-undef/no-unused-vars over the result, mapping findings back to
    // file:line. It runs in `npm run lint` and on pre-commit.
    files: ["assets/js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
];
