"use client";

import { useSyncExternalStore } from "react";
import { Card, Switch } from "@/components/ui";
import { readVoicePref, subscribeVoicePref, writeVoicePref } from "@/lib/wingman-voice";

export const WINGMAN_VOICE_HELP =
  "When you match, SocialEyes says a short tip out loud. It plays through your glasses when they're connected to this phone, otherwise through the phone's speaker.";

/** "Wingman voice": per-browser on/off for the spoken line on a new match. On by default. */
export function WingmanVoiceCard() {
  const on = useSyncExternalStore(subscribeVoicePref, readVoicePref, () => true);
  return (
    <Card data-testid="wingman-voice-card">
      <Switch checked={on} onChange={writeVoicePref} label="Wingman voice" description={WINGMAN_VOICE_HELP} />
    </Card>
  );
}
