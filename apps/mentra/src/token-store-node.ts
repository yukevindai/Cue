import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenStore } from "./account-link";

/** Node-only token store (kept separate so the rest bundles for a WebView). */
export function fileTokenStore(path: string): TokenStore {
  return {
    load: async () => {
      try {
        const text = (await readFile(path, "utf8")).trim();
        return text.length > 0 ? text : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    save: async (token) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, token, { mode: 0o600 });
      await chmod(path, 0o600); // writeFile's mode is ignored for an existing file
    },
    clear: async () => {
      await rm(path, { force: true });
    },
  };
}
