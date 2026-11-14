import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The device token must never reach a log. All output goes through
      // src/logger.ts, which redacts; raw console use is a lint error.
      "no-console": "error",
    },
  },
);
