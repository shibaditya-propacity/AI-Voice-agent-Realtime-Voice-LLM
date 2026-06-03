/**
 * Typed internal event bus.
 * Modules communicate exclusively through this bus — no direct service coupling.
 */

import { EventEmitter } from 'events';
import { AppEventName, EventPayloadMap } from '../events/EventTypes';
import { Logger } from './Logger';

const log = Logger.root('EventBus');

type EventHandler<T extends AppEventName> = (payload: EventPayloadMap[T]) => void | Promise<void>;

class TypedEventEmitter extends EventEmitter {
  // Increase max listeners since many modules subscribe to the same events.
  constructor() {
    super();
    this.setMaxListeners(50);
  }
}

// ─── EventBus ────────────────────────────────────────────────────────────────

export class EventBus {
  private readonly emitter: TypedEventEmitter;
  private static instance: EventBus;

  private constructor() {
    this.emitter = new TypedEventEmitter();
    this.emitter.on('error', (err: Error) => {
      log.error('Unhandled EventBus error', err);
    });
  }

  /** Singleton accessor. */
  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  /**
   * Subscribe to a typed event.
   * Returns an unsubscribe function for easy cleanup.
   */
  on<T extends AppEventName>(event: T, handler: EventHandler<T>): () => void {
    const wrappedHandler = async (payload: EventPayloadMap[T]) => {
      try {
        await handler(payload);
      } catch (err) {
        log.error(`Uncaught error in handler for event "${event}"`, err as Error);
      }
    };

    this.emitter.on(event, wrappedHandler);
    return () => this.emitter.off(event, wrappedHandler);
  }

  /**
   * Subscribe to an event for one emission only.
   */
  once<T extends AppEventName>(event: T, handler: EventHandler<T>): void {
    const wrappedHandler = async (payload: EventPayloadMap[T]) => {
      try {
        await handler(payload);
      } catch (err) {
        log.error(`Uncaught error in once-handler for event "${event}"`, err as Error);
      }
    };
    this.emitter.once(event, wrappedHandler);
  }

  /**
   * Publish a typed event synchronously.
   * Handlers are invoked in registration order.
   */
  emit<T extends AppEventName>(event: T, payload: EventPayloadMap[T]): void {
    log.debug(`Event emitted: ${event}`, {
      sessionId: (payload as { sessionId?: string }).sessionId,
      callId: (payload as { callId?: string }).callId,
    });
    this.emitter.emit(event, payload);
  }

  /** Remove all listeners for cleanup (e.g. tests). */
  removeAllListeners(event?: AppEventName): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  /** Number of registered listeners for an event. */
  listenerCount(event: AppEventName): number {
    return this.emitter.listenerCount(event);
  }
}

/** Global singleton event bus. */
export const eventBus = EventBus.getInstance();
