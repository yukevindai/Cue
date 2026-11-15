import { z } from "zod";
import { Uuid } from "./common";

/** Upper bound on the spoken wingman line; it is meant to be heard in a few seconds. */
export const HYPE_MAX_LENGTH = 280;

/**
 * POST /api/matches/{id}/hype and POST /api/devices/hype: one or two short
 * sentences for the caller about their new match, written to be spoken aloud.
 * `source` is `model` when Claude phrased it from the verified shared items,
 * `fallback` when a fixed line was used (Claude unavailable, or AI assist off
 * for either person). It never contains anything the other person does not
 * share with matches.
 */
export const HypeLine = z.object({
  matchId: Uuid,
  text: z.string().min(1).max(HYPE_MAX_LENGTH),
  source: z.enum(["model", "fallback"]),
});
export type HypeLine = z.infer<typeof HypeLine>;

/** Body of POST /api/devices/hype. */
export const DeviceHypeInput = z.object({ matchId: Uuid }).strict();
export type DeviceHypeInput = z.infer<typeof DeviceHypeInput>;
