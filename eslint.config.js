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
    },
  },
  {
    // Split client files: sequential classic scripts sharing one global
    // scope. Per-file analysis cannot see cross-file symbols, so the
    // undef/unused rules only produce noise here; the jsdom boot tests
    // verify the recomposed whole.
    files: ["assets/js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
