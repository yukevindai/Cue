/**
 * The only place the Lens writes output (the Lens passes `print`). Everything
 * passes through `redact`, so a device token or pairing code never reaches the
 * Lens Studio logger or a device log even if a caller passes one by mistake.
 * Same rules as apps/mentra/src/logger.ts.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Register a secret value (device token, pairing code) to scrub from all later output. */
  addSecret(value: string): void;
}

const REDACTED = "[redacted]";
/** Field names whose values are never printed, whatever they contain. */
const SECRET_KEY = /token|authorization|secret|password|pairing|^code$/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text.replace(BEARER, `Bearer ${REDACTED}`);
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  return out;
}

function stringifyFields(fields: LogFields): string {
  return JSON.stringify(fields, (key, value: unknown) => {
    if (key !== "" && SECRET_KEY.test(key)) return REDACTED;
    if (value instanceof Error) return { name: value.name, message: value.message };
    return value;
  });
}

export function createLogger(sink: LogSink, minLevel: LogLevel = "info"): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const secrets = new Set<string>();
  const write = (level: LogLevel, message: string, fields?: LogFields) => {
    if (order[level] < order[minLevel]) return;
    const body = fields && Object.keys(fields).length > 0 ? `${message} ${stringifyFields(fields)}` : message;
    sink(level, redact(`[cue-spectacles] ${level} ${body}`, secrets));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    addSecret: (value) => {
      if (value.length > 0) secrets.add(value);
    },
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  addSecret: () => {},
};
