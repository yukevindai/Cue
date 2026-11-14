import { MiniappRequestType, MiniappResponseType, MiniappSession } from "@mentra/miniapp";
import type { Transport, TransportDisconnectHandler, TransportMessageHandler } from "@mentra/miniapp";
import { describe, expect, it } from "vitest";
import { normalizeTouchEvent } from "../touch-events";

/**
 * Drives the REAL @mentra/miniapp MiniappSession (same class registerMiniapp
 * builds) over a host-side test transport. Only the transport is ours: it
 * plays the phone host (CONNECT -> CONNECT_ACK, records SUBSCRIBE, injects
 * EVENT envelopes). Everything after it is the SDK's own code.
 */
class HostTransport implements Transport {
  sent: { payload: { type?: string } & Record<string, unknown>; requestId?: string }[] = [];
  private onMsg: TransportMessageHandler | null = null;
  private opened = false;

  async open(): Promise<void> {
    this.opened = true;
  }
  send(raw: string): void {
    const env = JSON.parse(raw) as HostTransport["sent"][number];
    this.sent.push(env);
    if (env.payload.type === MiniappRequestType.CONNECT) {
      queueMicrotask(() =>
        this.deliver({
          payload: {
            type: MiniappResponseType.CONNECT_ACK,
            userId: "mentra-user-1",
            packageName: "com.example.cue",
            capabilities: null,
            visibility: "background",
            colorScheme: "light",
            configuration: {},
          },
        }),
      );
    }
  }
  onMessage(handler: TransportMessageHandler): void {
    this.onMsg = handler;
  }
  onDisconnect(handler: TransportDisconnectHandler): void {
    void handler;
  }
  close(): void {
    this.opened = false;
  }
  isOpen(): boolean {
    return this.opened;
  }
  deliver(envelope: unknown): void {
    this.onMsg?.(JSON.stringify(envelope));
  }
  /** What the host's forwarding code sends for a touch-strip event. */
  touch(data: Record<string, unknown>): void {
    this.deliver({ payload: { type: MiniappResponseType.EVENT, streamType: "touch_event", data } });
  }
}

async function connected() {
  const transport = new HostTransport();
  const session = new MiniappSession({ transport, packageName: "com.example.cue" });
  await session.connect();
  return { transport, session };
}

describe("@mentra/miniapp 3.4.0 touch dispatch", () => {
  it("subscribes to the bare touch_event stream and delivers a full host payload to onTouch", async () => {
    const { transport, session } = await connected();
    const received: unknown[] = [];
    session.input.onTouch((data) => received.push(data));

    const subscribe = transport.sent.filter((m) => m.payload.type === MiniappRequestType.SUBSCRIBE);
    expect(subscribe.length).toBeGreaterThan(0);
    expect(subscribe.at(-1)!.payload.subscriptions).toContain("touch_event");

    const payload = {
      type: "touch_event",
      deviceModel: "Mentra Live",
      gestureName: "backward_swipe",
      kind: "backward_swipe",
      timestamp: 1_800_000_000_000,
    };
    transport.touch(payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload); // passed through untouched
    expect(normalizeTouchEvent(received[0])).toEqual({ gestureName: "backward_swipe", timestampMs: 1_800_000_000_000 });
  });

  it("delivers every gesture to the bare handler (no SDK-side filtering)", async () => {
    const { transport, session } = await connected();
    const names: string[] = [];
    session.input.onTouch((data) => names.push(normalizeTouchEvent(data)?.gestureName ?? "<null>"));
    for (const g of ["single_tap", "double_tap", "forward_swipe", "backward_swipe", "up_swipe", "down_swipe"]) {
      transport.touch({ type: "touch_event", gestureName: g, kind: g, timestamp: 1_800_000_000_000 });
    }
    expect(names).toEqual(["single_tap", "double_tap", "forward_swipe", "backward_swipe", "up_swipe", "down_swipe"]);
  });

  it("a payload with only `kind` reaches the handler intact", async () => {
    const { transport, session } = await connected();
    const received: unknown[] = [];
    session.input.onTouch((data) => received.push(data));
    transport.touch({ kind: "backward_swipe" });
    expect(received).toEqual([{ kind: "backward_swipe" }]);
  });

  it("a kind-only payload (the only field the SDK types) still normalizes", async () => {
    const { transport, session } = await connected();
    const received: unknown[] = [];
    session.input.onTouch((data) => received.push(data));
    transport.touch({ kind: "backward_swipe" });
    expect(normalizeTouchEvent(received[0])?.gestureName).toBe("backward_swipe");
  });

  it("onTouch(gesture, handler) listens on touch_event:<gesture>, which the bare stream does not feed", async () => {
    const { transport, session } = await connected();
    const bare: unknown[] = [];
    session.input.onTouch((d) => bare.push(d));
    transport.deliver({
      payload: {
        type: MiniappResponseType.EVENT,
        streamType: "touch_event:backward_swipe",
        data: { gestureName: "backward_swipe" },
      },
    });
    expect(bare).toEqual([]);
  });
});
