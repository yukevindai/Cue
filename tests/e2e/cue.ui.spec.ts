import { test } from "./helpers/fixtures";

// UI-level cases. They need the frontend branch; selectors are intentionally
// not invented here. Turn each into a real test once the UI is merged.
test.describe("UI (pending frontend)", () => {
  test.fixme("two signed-in browsers both show the match within 2 s of the second signal", async () => {});
  test.fixme("the first signal shows nothing in the other person's browser", async () => {});
  test.fixme("a third account sees no match, no profile and no session contents", async () => {});
  test.fixme('"Find common ground" shows a retry state when the model fails', async () => {});
});
