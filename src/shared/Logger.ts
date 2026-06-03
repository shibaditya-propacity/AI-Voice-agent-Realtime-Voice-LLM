/**
 * Structured logger wrapping Winston.
 * Every log line includes: timestamp, sessionId, callId, eventType, severity.
 */

import winston from 'winston';
import { Env } from '../config';

// ─── Log Context ─────────────────────────────────────────────────────────────

export interface LogContext {
  sessionId?: string;
  callId?: string;
  eventType?: string;
  [key: string]: unknown;
}

// ─── Formatter ────────────────────────────────────────────────────────────────

const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const prettyFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, sessionId, callId, eventType, ...rest }) => {
    const ctx = [sessionId && `sid=${sessionId}`, callId && `cid=${callId}`]
      .filter(Boolean)
      .join(' ');
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `${timestamp} [${level}] ${eventType ? `[${eventType}] ` : ''}${ctx ? `(${ctx}) ` : ''}${message}${extra}`;
  }),
);

// ─── Root Winston Instance ────────────────────────────────────────────────────

const winstonLogger = winston.createLogger({
  level: Env.logging.level,
  format: Env.logging.pretty ? prettyFormat : jsonFormat,
  transports: [new winston.transports.Console()],
});

// ─── Logger Class ─────────────────────────────────────────────────────────────

export class Logger {
  private readonly context: LogContext;

  private constructor(context: LogContext) {
    this.context = context;
  }

  /** Create a root logger with no call context. */
  static root(eventType?: string): Logger {
    return new Logger({ eventType });
  }

  /** Create a child logger bound to a specific session and call. */
  static forSession(sessionId: string, callId: string, eventType?: string): Logger {
    return new Logger({ sessionId, callId, eventType });
  }

  /** Derive a child logger with overridden fields. */
  child(overrides: LogContext): Logger {
    return new Logger({ ...this.context, ...overrides });
  }

  /** Return a copy with a different eventType. */
  withEvent(eventType: string): Logger {
    return new Logger({ ...this.context, eventType });
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    winstonLogger.debug(message, { ...this.context, severity: 'debug', ...meta });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    winstonLogger.info(message, { ...this.context, severity: 'info', ...meta });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    winstonLogger.warn(message, { ...this.context, severity: 'warn', ...meta });
  }

  error(message: string, errorOrMeta?: Error | Record<string, unknown>, meta?: Record<string, unknown>): void {
    if (errorOrMeta instanceof Error) {
      winstonLogger.error(message, {
        ...this.context,
        severity: 'error',
        error: {
          name: errorOrMeta.name,
          message: errorOrMeta.message,
          stack: errorOrMeta.stack,
        },
        ...meta,
      });
    } else {
      winstonLogger.error(message, { ...this.context, severity: 'error', ...errorOrMeta });
    }
  }

  fatal(message: string, error?: Error): void {
    winstonLogger.error(message, {
      ...this.context,
      severity: 'fatal',
      ...(error && {
        error: { name: error.name, message: error.message, stack: error.stack },
      }),
    });
  }
}

/** Singleton root logger for module-level use. */
export const rootLogger = Logger.root('APP');
