/**
 * RFC 4122 version 4 UUID from 16 random bytes.
 *
 * The Lens runtime has no `crypto.randomUUID`, so the host supplies bytes
 * (Math.random in the Lens). The id is an idempotency key for one gesture, not
 * a secret: it only has to be unique enough that two gestures never collide.
 */
export type RandomBytes = (count: number) => number[];

export const mathRandomBytes: RandomBytes = (count) =>
  Array.from({ length: count }, () => Math.floor(Math.random() * 256));

export function uuidV4(random: RandomBytes = mathRandomBytes): string {
  const b = random(16).map((n) => n & 0xff);
  while (b.length < 16) b.push(0);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
