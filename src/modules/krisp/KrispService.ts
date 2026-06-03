/**
 * KrispService: per-session noise suppression service.
 *
 * Each active call gets its own KrispProcessor instance to ensure
 * state isolation (Krisp maintains internal noise model state per stream).
 */

import { Logger } from '../../shared/Logger';
import { KrispProcessor } from './KrispProcessor';

const log = Logger.root('KrispService');

export class KrispService {
  /** One processor per active session. */
  private readonly processors: Map<string, KrispProcessor> = new Map();

  /**
   * Create a KrispProcessor for a new call session.
   * The processor is initialized and ready to process audio frames.
   */
  async createProcessor(sessionId: string): Promise<void> {
    if (this.processors.has(sessionId)) {
      log.warn('Krisp processor already exists for session', { sessionId });
      return;
    }

    const processor = new KrispProcessor();
    await processor.initialize();
    this.processors.set(sessionId, processor);

    log.info('Krisp processor created', { sessionId, active: processor.isActive });
  }

  /**
   * Apply noise suppression to a PCM16 audio buffer.
   * Returns the input unchanged if no processor is registered for the session.
   */
  process(sessionId: string, audioChunk: Buffer): Buffer {
    const processor = this.processors.get(sessionId);
    if (!processor) {
      log.warn('No Krisp processor for session — passing audio through', { sessionId });
      return audioChunk;
    }
    return processor.processAudio(audioChunk);
  }

  /**
   * Destroy the processor when a call ends.
   * Releases all native SDK resources tied to this session.
   */
  destroyProcessor(sessionId: string): void {
    const processor = this.processors.get(sessionId);
    if (!processor) return;

    processor.destroy();
    this.processors.delete(sessionId);
    log.info('Krisp processor destroyed', { sessionId });
  }

  /**
   * Destroy all processors (called on graceful shutdown).
   */
  destroyAll(): void {
    for (const [sessionId, processor] of this.processors) {
      processor.destroy();
      log.info('Krisp processor destroyed on shutdown', { sessionId });
    }
    this.processors.clear();
  }

  activeCount(): number {
    return this.processors.size;
  }
}
