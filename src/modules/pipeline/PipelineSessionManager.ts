/**
 * PipelineSessionManager: manages per-call CallOrchestrator instances.
 *
 * Bridges TwilioService callbacks → CallOrchestrator lifecycle.
 * Each call gets its own orchestrator (Deepgram STT → Groq LLM → Sarvam TTS).
 */

import { CallOrchestrator } from './CallOrchestrator';
import { TwilioService } from '../twilio/TwilioService';
import { Logger } from '../../shared/Logger';
import type { TwilioStreamSession } from '../twilio/TwilioTypes';

const log = Logger.root('PipelineSessionManager');

export class PipelineSessionManager {
  private readonly orchestrators = new Map<string, CallOrchestrator>();
  private readonly twilioService: TwilioService;

  constructor(twilioService: TwilioService) {
    this.twilioService = twilioService;

    // Wire Twilio callbacks to route audio and lifecycle events
    twilioService.registerCallbacks(
      // onAudio: route inbound audio to the correct orchestrator
      (callSid, audioBase64) => {
        const orch = this.orchestrators.get(callSid);
        if (orch) orch.handleInboundAudio(audioBase64);
      },
      // onStreamStarted: create a new orchestrator for this call
      (callSid, _session: TwilioStreamSession) => {
        this.createOrchestrator(callSid);
      },
      // onStreamStopped: tear down the orchestrator
      (callSid) => {
        this.destroyOrchestrator(callSid);
      },
    );

    log.info('PipelineSessionManager initialized');
  }

  private createOrchestrator(callSid: string): void {
    if (this.orchestrators.has(callSid)) {
      log.warn('Orchestrator already exists for call', { callSid });
      return;
    }

    const orchestrator = new CallOrchestrator(callSid, this.twilioService);
    this.orchestrators.set(callSid, orchestrator);

    log.info('Pipeline orchestrator created', { callSid, active: this.orchestrators.size });

    // Start the orchestrator (connects Deepgram, opens TTS, plays greeting)
    orchestrator.start();
  }

  private destroyOrchestrator(callSid: string): void {
    const orchestrator = this.orchestrators.get(callSid);
    if (!orchestrator) return;

    this.orchestrators.delete(callSid);
    void orchestrator.end();

    log.info('Pipeline orchestrator destroyed', { callSid, active: this.orchestrators.size });
  }

  get activeCallCount(): number {
    return this.orchestrators.size;
  }
}
