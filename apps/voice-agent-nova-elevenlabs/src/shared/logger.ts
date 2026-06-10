/**
 * Structured logger wrapping Winston.
 * Every log line includes: timestamp, callSid, component, severity.
 *
 * Transports:
 *   - Console (pretty in dev, JSON in prod)
 *   - logs/combined.log  — all levels, JSON, rotated at 20 MB
 *   - logs/error.log     — errors only, JSON
 *   - logs/calls/<callSid>.log — per-call full trace (created on first log)
 */

import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { Env } from '../config/env';

export interface LogContext {
  callSid?: string;
  component?: string;
  [key: string]: unknown;
}

// ─── Log directory ─────────────────────────────────────────────────────────────

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const CALLS_DIR = path.join(LOGS_DIR, 'calls');

fs.mkdirSync(CALLS_DIR, { recursive: true });

// ─── Formats ──────────────────────────────────────────────────────────────────

const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const prettyFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, callSid, component, ...rest }) => {
    const ctx = [callSid && `call=${callSid}`, component && `[${component}]`]
      .filter(Boolean)
      .join(' ');
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `${timestamp} [${level}] ${ctx ? `${ctx} ` : ''}${message}${extra}`;
  }),
);

// ─── Shared file transports ───────────────────────────────────────────────────

const combinedTransport = new winston.transports.File({
  filename: path.join(LOGS_DIR, 'combined.log'),
  format:   jsonFormat,
  maxsize:  20 * 1024 * 1024, // 20 MB
  maxFiles: 5,
  tailable: true,
});

const errorTransport = new winston.transports.File({
  filename: path.join(LOGS_DIR, 'error.log'),
  level:    'error',
  format:   jsonFormat,
  maxsize:  10 * 1024 * 1024,
  maxFiles: 3,
  tailable: true,
});

// ─── Root winston logger ──────────────────────────────────────────────────────

const winstonLogger = winston.createLogger({
  level: Env.logging.level,
  format: Env.logging.pretty ? prettyFormat : jsonFormat,
  transports: [
    new winston.transports.Console(),
    combinedTransport,
    errorTransport,
  ],
});

// ─── Per-call loggers (cached by callSid) ────────────────────────────────────

const callLoggers = new Map<string, winston.Logger>();

function getCallLogger(callSid: string): winston.Logger {
  const existing = callLoggers.get(callSid);
  if (existing) return existing;

  const logger = winston.createLogger({
    level: 'debug', // always verbose per-call
    format: jsonFormat,
    transports: [
      new winston.transports.File({
        filename: path.join(CALLS_DIR, `${callSid}.log`),
        format:   jsonFormat,
      }),
    ],
  });

  callLoggers.set(callSid, logger);
  return logger;
}

/** Remove the per-call logger from cache once a call ends (allows GC). */
export function closeCallLogger(callSid: string): void {
  const logger = callLoggers.get(callSid);
  if (logger) {
    logger.close();
    callLoggers.delete(callSid);
  }
}

// ─── Logger class ─────────────────────────────────────────────────────────────

export class Logger {
  private readonly context: LogContext;

  private constructor(context: LogContext) {
    this.context = context;
  }

  static root(component?: string): Logger {
    return new Logger({ component });
  }

  static forCall(callSid: string, component?: string): Logger {
    return new Logger({ callSid, component });
  }

  child(overrides: LogContext): Logger {
    return new Logger({ ...this.context, ...overrides });
  }

  private write(level: string, message: string, meta: Record<string, unknown>): void {
    const payload = { ...this.context, ...meta };
    winstonLogger.log(level, message, payload);
    // Also write to per-call file if we have a callSid
    if (this.context.callSid) {
      getCallLogger(this.context.callSid).log(level, message, payload);
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta ?? {});
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta ?? {});
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta ?? {});
  }

  error(message: string, errorOrMeta?: Error | Record<string, unknown>, meta?: Record<string, unknown>): void {
    if (errorOrMeta instanceof Error) {
      this.write('error', message, {
        error: { name: errorOrMeta.name, message: errorOrMeta.message, stack: errorOrMeta.stack },
        ...meta,
      });
    } else {
      this.write('error', message, errorOrMeta ?? {});
    }
  }
}

export const rootLogger = Logger.root('APP');
