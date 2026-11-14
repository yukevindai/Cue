import { startFakeAnthropic } from "./helpers/fake-anthropic";

/** Starts the fake Anthropic server for the whole run; returns its teardown. */
export default async function globalSetup() {
  const server = await startFakeAnthropic();
  return async () => {
    await server.close();
  };
}
