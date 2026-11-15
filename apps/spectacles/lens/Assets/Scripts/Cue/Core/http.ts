/**
 * The smallest HTTP surface the Lens needs. The Lens adapter implements it
 * with `InternetModule.fetch` (Spectacles only, HTTPS for published Lenses);
 * tests implement it with a fake. Throws on network failure.
 */
export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface HttpResponse {
  status: number;
  /** Raw response text ("" when empty). */
  text: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** Promise-based wait; the Lens builds it from a DelayedCallbackEvent. */
export type Sleep = (ms: number) => Promise<void>;
