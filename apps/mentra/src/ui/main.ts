/**
 * Phone-side setup screen (WebView layer). It only talks to the background
 * layer over the `mentra` bus; it never sees the device token and makes no
 * network requests itself.
 */
import type { FeedbackCue } from "../feedback";
import type { BridgeStatus } from "../status";
import "../shared/channels";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function setMessage(text: string) {
  $("message").textContent = text;
}

function render(status: BridgeStatus) {
  const linkPill = $("link-pill");
  linkPill.textContent = status.linked ? "Paired" : "Not paired";
  linkPill.className = `pill ${status.linked ? "ok" : "bad"}`;

  const contextLabels: Record<string, [string, string]> = {
    ready: ["Encounter mode ON", "ok"],
    encounter_mode_off: ["Encounter mode off", "warn"],
    no_place: ["Open Cue on your phone", "warn"],
    unlinked: ["No account", "bad"],
    offline: ["Server unreachable", "bad"],
    stale: ["Checking…", "warn"],
  };
  const [label, tone] = contextLabels[status.context] ?? [status.context, "warn"];
  const contextPill = $("context-pill");
  contextPill.textContent = label;
  contextPill.className = `pill ${tone}`;

  $("calibration-pill").hidden = !status.calibration;
  $("toggle-calibration").textContent = status.calibration ? "Stop calibration" : "Start calibration";
  $("toggle-calibration").dataset.on = status.calibration ? "1" : "0";
  $("unlink").hidden = !status.linked;
  $("last-outcome").textContent = status.lastOutcome ? `Last swipe: ${status.lastOutcome}` : "";
  $("mapping").textContent = status.backwardGestureName ?? "(none: nothing will be sent)";
  $("identity").textContent = status.mentraUserId ? `Mentra user: ${status.mentraUserId}` : "";

  const serverInput = $<HTMLInputElement>("server-url");
  if (document.activeElement !== serverInput && status.serverUrl) serverInput.value = status.serverUrl;

  const body = $("gestures");
  body.replaceChildren(
    ...status.recentGestures.map(({ gestureName, at }) => {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      const code = document.createElement("code");
      code.textContent = gestureName;
      name.append(code);
      const time = document.createElement("td");
      time.className = "muted";
      time.textContent = new Date(at).toLocaleTimeString();
      const action = document.createElement("td");
      if (gestureName === status.backwardGestureName) {
        action.textContent = "= backward";
      } else {
        const use = document.createElement("button");
        use.className = "plain";
        use.textContent = "Use as backward swipe";
        use.addEventListener("click", () => mentra.send("cue:set-backward-gesture", { gestureName }));
        action.append(use);
      }
      row.append(name, time, action);
      return row;
    }),
  );
}

mentra.on("cue:status", render);

$("save-server").addEventListener("click", async () => {
  const result = await mentra.request("cue:set-server", { url: $<HTMLInputElement>("server-url").value }, { timeout: 10000 });
  setMessage(result.ok ? "Server saved." : result.error);
});

$("pair").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("pair-code");
  setMessage("Pairing…");
  try {
    const result = await mentra.request("cue:link", { code: input.value }, { timeout: 15000 });
    setMessage(result.ok ? "Paired." : result.error);
    if (result.ok) input.value = "";
  } catch {
    setMessage("Pairing timed out.");
  }
});

$("unlink").addEventListener("click", () => mentra.send("cue:unlink", {}));
$("refresh").addEventListener("click", () => mentra.send("cue:refresh", {}));
$("toggle-calibration").addEventListener("click", (event) => {
  const on = (event.currentTarget as HTMLElement).dataset.on !== "1";
  mentra.send("cue:set-calibration", { on });
});
document.querySelectorAll<HTMLElement>("[data-cue]").forEach((button) => {
  button.addEventListener("click", () => mentra.send("cue:test-cue", { cue: button.dataset.cue as FeedbackCue }));
});

mentra.onOpen(() => mentra.send("cue:refresh", {}));
mentra.ready();
