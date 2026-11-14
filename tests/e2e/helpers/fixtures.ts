import { test as base, expect } from "@playwright/test";
import { fakeAnthropic } from "./fake-anthropic";
import { World } from "./scenario";

interface Fixtures {
  /** Creates synthetic users/pairs; cleaned up after the test. */
  world: World;
  /** Control and inspect the fake Anthropic server. Reset to `error` mode before every test. */
  fake: typeof fakeAnthropic;
}

export const test = base.extend<Fixtures>({
  world: async ({}, use) => {
    const world = new World();
    try {
      await use(world);
    } finally {
      await world.cleanup();
    }
  },
  fake: [
    async ({}, use) => {
      await fakeAnthropic.reset();
      await use(fakeAnthropic);
    },
    { auto: true },
  ],
});

export { expect };
