/**
 * Structured JSON logging on stdout — one object per line, ready for any log shipper.
 *
 * Every record carries `ts`, `level`, `msg` and `svc`; call sites add arbitrary fields.
 * BigInt is serialised as a decimal string (raw token units are always bigint in this service,
 * never a lossy Number).
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps `fields` onto every record (e.g. `{ tick: 7 }`). */
  child(fields: LogFields): Logger;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** JSON.stringify replacer: bigint -> decimal string, Error -> {name, message}. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    const out: LogFields = { errName: err.name, errMsg: err.message };
    // viem errors carry a `shortMessage`; surface it, it is the useful one-liner.
    const short = (err as { shortMessage?: unknown }).shortMessage;
    if (typeof short === 'string') out.errShort = short;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) out.errCause = cause.message;
    return out;
  }
  return { errMsg: String(err) };
}

interface LoggerOptions {
  level: LogLevel;
  base: LogFields;
  sink: (line: string) => void;
}

function make(opts: LoggerOptions): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (RANK[level] < RANK[opts.level]) return;
    const record = { ts: new Date().toISOString(), level, msg, ...opts.base, ...fields };
    opts.sink(JSON.stringify(record, jsonReplacer));
  };
  return {
    level: opts.level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => make({ ...opts, base: { ...opts.base, ...fields } }),
  };
}

export function createLogger(level: LogLevel, base: LogFields = {}): Logger {
  return make({
    level,
    base: { svc: 'poolmigo-keeper', ...base },
    // eslint-disable-next-line no-console -- stdout is the log transport for a container service
    sink: (line) => console.log(line),
  });
}

/** Test helper: collect records instead of writing them. */
export function createMemoryLogger(level: LogLevel = 'debug'): {
  logger: Logger;
  records: LogFields[];
} {
  const records: LogFields[] = [];
  const logger = make({
    level,
    base: { svc: 'poolmigo-keeper' },
    sink: (line) => void records.push(JSON.parse(line) as LogFields),
  });
  return { logger, records };
}
