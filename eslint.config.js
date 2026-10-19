const { defineConfig } = require("eslint/config");
const raycastConfig = require("@raycast/eslint-config");

module.exports = defineConfig([
  ...raycastConfig,
  {
    // Deutsche Titel folgen nicht der englischen Title-Case-Regel.
    rules: { "@raycast/prefer-title-case": "off" },
  },
]);
