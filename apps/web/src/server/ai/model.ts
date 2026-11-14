import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { WingmanModelOutput } from "@cue/contracts";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import type { ModelInput } from "./types";

/**
 * Pinned default. Claude Opus 5.5 at low effort: the card is on demand and a
 * person is waiting, but a wrong "you both like X" is worse than a slow card,
 * so the stronger model is kept and latency is bought with effort instead.
 * Override with ANTHROPIC_MODEL.
 */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_TIMEOUT_MS = 15_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class WingmanUpstreamError extends Error {
  constructor(
    readonly kind: "timeout" | "error",
    /** Safe to log: never contains profile text or credentials. */
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** The one SDK call the wingman makes; tests inject a fake. */
export interface WingmanModelClient {
  beta: {
    messages: {
      parse(
        params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
        options?: Anthropic.RequestOptions,
      ): PromiseLike<{ stop_reason: string | null; parsed_output: unknown }>;
    };
  };
}

export interface ModelConfig {
  model: string;
  timeoutMs: number;
  fallbacks: boolean;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const timeout = Number(env.WINGMAN_TIMEOUT_MS);
  return {
    model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    fallbacks: env.ANTHROPIC_FALLBACKS?.trim().toLowerCase() !== "off",
  };
}

let client: Anthropic | undefined;

/**
 * Uses ANTHROPIC_API_KEY only. `authToken: null` stops the SDK from picking up
 * any other ambient credential (ANTHROPIC_AUTH_TOKEN, a CLI profile).
 */
export function getAnthropicClient(env: NodeJS.ProcessEnv = process.env): WingmanModelClient {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new WingmanUpstreamError("error", "ANTHROPIC_API_KEY is not set");
  client ??= new Anthropic({
    apiKey,
    authToken: null,
    baseURL: env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com",
    maxRetries: 0,
  });
  return client;
}

/** One bounded, non-streaming call. Returns schema-valid model output or throws WingmanUpstreamError. */
export async function callWingmanModel(
  input: ModelInput,
  modelClient: WingmanModelClient,
  config: ModelConfig,
): Promise<WingmanModelOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let message: { stop_reason: string | null; parsed_output: unknown };
  try {
    message = await modelClient.beta.messages.parse(
      {
        model: config.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(input) }],
        output_config: { effort: "low", format: zodOutputFormat(WingmanModelOutput) },
        // A safety decline is retried server-side on Anthropic's default fallback model.
        ...(config.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      },
      { timeout: config.timeoutMs, maxRetries: 0, signal: controller.signal },
    );
  } catch (err) {
    if (
      controller.signal.aborted ||
      err instanceof Anthropic.APIConnectionTimeoutError ||
      err instanceof Anthropic.APIUserAbortError
    ) {
      throw new WingmanUpstreamError("timeout", `no response within ${config.timeoutMs} ms`);
    }
    if (err instanceof Anthropic.APIError) {
      // Status only: an error body can echo the request.
      throw new WingmanUpstreamError("error", `api error status=${err.status ?? "none"}`);
    }
    throw new WingmanUpstreamError("error", err instanceof Error ? err.name : "unknown failure");
  } finally {
    clearTimeout(timer);
  }

  if (message.stop_reason !== "end_turn") {
    throw new WingmanUpstreamError("error", `stop_reason=${message.stop_reason ?? "none"}`);
  }
  const parsed = WingmanModelOutput.safeParse(message.parsed_output);
  if (!parsed.success) throw new WingmanUpstreamError("error", "model output did not match the schema");
  return parsed.data;
}
