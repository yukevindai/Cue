/**
 * Per-tab conveniences for the composer: the unsent draft, and an opener
 * handed over from "Use this opener" on the match page. sessionStorage only;
 * every access is guarded because storage can be unavailable.
 */

const draftKey = (matchId: string) => `socialeyes.chat-draft.${matchId}`;
const openerKey = (matchId: string) => `socialeyes.chat-opener.${matchId}`;

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null || value === "") window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // storage unavailable: the draft just won't survive navigation
  }
}

export const chatDraft = {
  load: (matchId: string) => read(draftKey(matchId)) ?? "",
  save: (matchId: string, text: string) => write(draftKey(matchId), text),
  /** Leave an opener for the composer to pick up. It is never sent on its own. */
  offerOpener: (matchId: string, text: string) => write(openerKey(matchId), text),
  /** Take (and clear) a pending opener, if any. */
  takeOpener: (matchId: string): string | null => {
    const v = read(openerKey(matchId));
    if (v !== null) write(openerKey(matchId), null);
    return v;
  },
};

/** Put an opener into an existing draft without losing what was already typed. */
export function withOpener(draft: string, opener: string): string {
  const d = draft.trimEnd();
  return d ? `${d}\n\n${opener}` : opener;
}
