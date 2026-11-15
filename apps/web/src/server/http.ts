import "server-only";

import type { ApiError, ApiErrorCode } from "@cue/contracts";
import type { z } from "zod";

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  encounter_mode_off: 409,
  blocked: 403,
  rate_limited: 429,
  upstream_timeout: 504,
  upstream_error: 502,
  internal: 500,
};

/** Throw from anywhere in a route handler; `handle` turns it into an ApiError response. */
export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(code: ApiErrorCode, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status: STATUS[code] });
}

/** Parse and validate a JSON body, or throw `invalid_request`. */
export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError("invalid_request", "Body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError("invalid_request", parsed.error.issues.map((i) => i.message).join("; "));
  }
  return parsed.data;
}

/** Wrap a route handler body: maps HttpError to ApiError, hides everything else. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.code, err.message);
    console.error(err);
    return errorResponse("internal", "Something went wrong");
  }
}
