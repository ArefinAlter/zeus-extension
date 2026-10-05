// Structured, redacting logger (spec 00 section 8). Callers pass identifiers, counts, codes and
// sizes. Any string that looks like an http(s) URL is reduced to its `log` form regardless, and
// long strings are cut, so a careless call cannot leak a signed URL. Cookie values, headers and
// frame bodies are never logged by anyone.
import { redactUrl, scrubUrls } from './redact';

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LogSink {
  (level: LogLevel, line: string): void;
}

const MAX_FIELD_CHARS = 200;

function cleanValue(v: LogValue): string {
  if (v === undefined || v === null) return String(v);
  if (typeof v !== 'string') return String(v);
  const text = /^https?:\/\//i.test(v) ? redactUrl(v, 'log').url : scrubUrls(v);
  return text.length > MAX_FIELD_CHARS ? text.slice(0, MAX_FIELD_CHARS) + '…' : text;
}

export function formatLine(message: string, fields?: LogFields): string {
  const head = `[zeus] ${scrubUrls(message)}`;
  if (!fields) return head;
  const tail = Object.entries(fields)
    .map(([k, v]) => `${k}=${cleanValue(v)}`)
    .join(' ');
  return tail === '' ? head : `${head} ${tail}`;
}

export function createLogger(sink: LogSink, minLevel: LogLevel = 'info'): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const emit =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      if (order[level] >= order[minLevel]) sink(level, formatLine(message, fields));
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const consoleSink: LogSink = (level, line) => {
  console[level](line);
};

export const nullLogger: Logger = createLogger(() => undefined);
