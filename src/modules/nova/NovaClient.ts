/**
 * NovaClient: bidirectional streaming connection to Amazon Nova Sonic v2.
 *
 * Nova 2 Sonic model ID: amazon.nova-2-sonic-v1:0
 *
 * Correct Nova Sonic event sequence per the official API docs:
 * https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-conversational-speech.html
 *
 * CONVERSATION (one long-lived prompt for the whole call — Nova 2 native model):
 *   sessionStart                     (MUST include turnDetectionConfiguration — Nova 2 only)
 *   promptStart                      (promptName, audioOutputConfig with encoding+audioType)
 *   contentStart                     (contentName_sys, type:TEXT, role:SYSTEM, interactive:true)
 *   textInput                        (contentName_sys, system prompt text)
 *   contentEnd                       (contentName_sys)
 *   contentStart                     (contentName_cue, type:TEXT, role:USER, interactive:true)
 *   textInput                        (contentName_cue, greeting trigger e.g. "Hello?")
 *   contentEnd                       (contentName_cue)  ← Nova speaks the greeting
 *   contentStart                     (contentName_aud, type:AUDIO, role:USER, interactive:TRUE)
 *   audioInput × N …                 (caller speech streamed continuously for the
 *                                     whole call — Nova's VAD detects each end-of-turn
 *                                     and emits a response WITHOUT a per-turn promptEnd)
 *
 * END SESSION (call teardown):
 *   contentEnd                       (contentName_aud)
 *   promptEnd                        (promptName)
 *   sessionEnd
 *
 * WHY NOT a prompt-per-turn: with interactive audio Nova drives turn-taking itself,
 * emitting a fresh completionStart…completionEnd cycle for every caller utterance on
 * the SAME open audio block. Closing/reopening a prompt per turn (and the fact that
 * nothing in this app detects end-of-speech to send promptEnd) is exactly what made
 * the migrated build go silent. Silence input also never triggers output, so the
 * greeting is primed with a short text cue instead of PCM silence.
 *
 * Nova 2 OUTPUT events (in order):
 *   usageEvent
 *   completionStart                  ← NEW in Nova 2 — must handle, not just ignore
 *   contentStart (TEXT, USER)        ← ASR transcription of what user said
 *   textOutput                       ← transcription text
 *   contentEnd
 *   contentStart (AUDIO, ASSISTANT)  ← start of speech response
 *   audioOutput × N                  ← PCM16 audio chunks (base64)
 *   contentEnd
 *   contentStart (TEXT, ASSISTANT)   ← final text of spoken response
 *   textOutput
 *   contentEnd
 *   usageEvent
 *   completionEnd                    ← turn is done
 */

import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelWithBidirectionalStreamCommandInput,
  InvokeModelWithBidirectionalStreamInput,
} from '@aws-sdk/client-bedrock-runtime';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../../shared/Logger';
import {
  NovaAudioInputEvent,
  NovaClientConfig,
  NovaContentEndEvent,
  NovaContentStartAudio,
  NovaContentStartText,
  NovaInputEvent,
  NovaPromptEndEvent,
  NovaPromptStartEvent,
  NovaSessionEndEvent,
  NovaSessionStartEvent,
  NovaTextInputEvent,
} from './NovaTypes';

export class NovaClient extends EventEmitter {
  private readonly bedrockClient: BedrockRuntimeClient;
  private readonly config: NovaClientConfig;
  private readonly log: Logger;

  private inputQueue: NovaInputEvent[] = [];
  private inputResolve: ((event: NovaInputEvent | null) => void) | null = null;

  private closed: boolean = false;
  private novaSessionId: string = '';

  // Counters for detailed logging
  private audioChunksSent: number = 0;
  private audioChunksReceived: number = 0;
  private eventsSent: number = 0;

  constructor(config: NovaClientConfig, sessionId: string, callId: string) {
    super();
    this.config = config;
    this.log = Logger.forSession(sessionId, callId, 'NovaClient');

    this.bedrockClient = new BedrockRuntimeClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    this.log.info('NovaClient created', {
      modelId: config.modelId,
      region: config.region,
      voiceId: config.voiceId,
      sampleRate: config.sampleRate,
      endpointingSensitivity: config.endpointingSensitivity,
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Step 1: queue sessionStart (must be first event in the stream).
   * Call this before startConversation() so the event order is correct.
   */
  initialize(): void {
    this.log.info('Initializing Nova session — queueing sessionStart');
    this.enqueue(this.buildSessionStart());
  }

  /**
   * Step 2: open the HTTP/2 bidirectional stream connection to AWS Bedrock.
   * By this point the queue should already have all greeting events so Nova
   * has enough input to generate a response without deadlocking send().
   */
  async connect(connectTimeoutMs = 10_000): Promise<void> {
    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: this.config.modelId,
      body: this.createInputStream(),
    } as InvokeModelWithBidirectionalStreamCommandInput);

    this.log.info('Opening Nova Sonic bidirectional stream', {
      modelId: this.config.modelId,
      region: this.config.region,
      connectTimeoutMs,
    });

    try {
      const sendPromise = this.bedrockClient.send(command);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Nova Sonic connect timed out after ${connectTimeoutMs}ms`)),
          connectTimeoutMs,
        ),
      );
      const response = await Promise.race([sendPromise, timeoutPromise]);

      this.log.info('Nova Sonic stream opened successfully', {
        modelId: this.config.modelId,
        hasBody: !!response.body,
      });

      if (response.body) {
        this.consumeOutputStream(response.body).catch((err) => {
          this.log.error('Nova Sonic output stream error', err as Error);
          this.emit('error', err as Error);
          this.close();
        });
      } else {
        this.log.error('Nova Sonic stream opened but response.body is null — cannot receive events', new Error('No response body'));
        throw new Error('Nova Sonic stream opened but response.body is null');
      }
    } catch (err) {
      const error = err as Error;
      this.log.error('Failed to open Nova Sonic stream', error, {
        modelId: this.config.modelId,
        hint: [
          'Check: AWS credentials are valid',
          'Check: bedrock:InvokeModelWithBidirectionalStream IAM permission is granted',
          'Check: Nova Sonic model access is enabled in Bedrock console',
          `Check: Model ID "${this.config.modelId}" is correct (Nova 2 = amazon.nova-2-sonic-v1:0)`,
          'Check: AWS region supports Nova 2 Sonic',
        ].join(' | '),
      });
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.enqueue({ event: { sessionEnd: {} } });
    if (this.inputResolve) {
      const r = this.inputResolve;
      this.inputResolve = null;
      r(null);
    }
    this.log.info('Nova Sonic client closed', {
      audioChunksSent: this.audioChunksSent,
      audioChunksReceived: this.audioChunksReceived,
      eventsSent: this.eventsSent,
    });
    this.emit('closed');
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  // ─── Turn Management ───────────────────────────────────────────────────────

  /**
   * Begin a new prompt turn.
   * On first turn (includeSystemPrompt=true), also sends SYSTEM text block.
   * Returns the promptName for use in subsequent calls.
   */
  startPrompt(includeSystemPrompt: boolean): string {
    const promptName = `prompt_${uuidv4().replace(/-/g, '')}`;
    this.enqueue(this.buildPromptStart(promptName));
    this.log.debug('promptStart queued', { promptName, includeSystemPrompt });

    if (includeSystemPrompt) {
      const sysContentName = `sys_${uuidv4().replace(/-/g, '')}`;
      this.enqueue(this.buildContentStartText(promptName, sysContentName, 'SYSTEM'));
      this.enqueue(this.buildTextInput(promptName, sysContentName, this.config.systemPrompt));
      this.enqueue(this.buildContentEnd(promptName, sysContentName));
      this.log.debug('System prompt block queued', { promptName, sysContentName, promptLength: this.config.systemPrompt.length });
    }

    return promptName;
  }

  /**
   * Open a USER audio content block.
   * @param interactive  true  = Nova uses its own VAD to detect end-of-speech (normal listening turns)
   *                     false = We control turn end via explicit contentEnd+promptEnd (greeting turn)
   */
  openAudioBlock(promptName: string, contentName: string, interactive = true): void {
    this.enqueue(this.buildContentStartAudio(promptName, contentName, interactive));
    this.log.debug('Audio block opened', { promptName, contentName, interactive });
  }

  /** Send a complete USER text content block (contentStart + textInput + contentEnd). */
  sendUserTextBlock(promptName: string, contentName: string, content: string): void {
    this.enqueue(this.buildContentStartText(promptName, contentName, 'USER'));
    this.enqueue(this.buildTextInput(promptName, contentName, content));
    this.enqueue(this.buildContentEnd(promptName, contentName));
    this.log.debug('User text block queued', { promptName, contentName, contentLength: content.length });
  }

  /** Send a base64 PCM16 audio chunk inside an open audio block. */
  sendAudio(promptName: string, contentName: string, audioBase64: string): void {
    if (this.closed) return;
    const event: NovaAudioInputEvent = {
      event: {
        audioInput: { promptName, contentName, content: audioBase64 },
      },
    };
    this.enqueue(event);
    this.audioChunksSent++;

    // Log every 50 chunks to avoid flooding
    if (this.audioChunksSent % 50 === 0) {
      this.log.debug('Audio chunks sent to Nova', {
        audioChunksSent: this.audioChunksSent,
        promptName,
        contentName,
      });
    }
  }

  /** Close the current audio content block. */
  closeAudioBlock(promptName: string, contentName: string): void {
    this.enqueue(this.buildContentEnd(promptName, contentName));
    this.log.debug('Audio block closed', { promptName, contentName });
  }

  /** Signal Nova Sonic to generate a response for this prompt. */
  sendPromptEnd(promptName: string): void {
    if (this.closed) return;
    const event: NovaPromptEndEvent = {
      event: { promptEnd: { promptName } },
    };
    this.enqueue(event);
    this.log.debug('promptEnd sent — Nova will now generate response', { promptName });
  }

  // ─── Async Input Generator ─────────────────────────────────────────────────

  private async *createInputStream(): AsyncGenerator<InvokeModelWithBidirectionalStreamInput> {
    while (true) {
      const event = await this.nextInputEvent();
      if (event === null) break;

      const json = JSON.stringify(event);
      this.eventsSent++;

      // Determine event type for logging
      const eventType = event.event ? Object.keys(event.event)[0] : 'unknown';
      if (eventType !== 'audioInput') {
        // Log all non-audio events at debug level (audio is too frequent)
        this.log.debug('Nova input event → stream', { eventType, eventsSent: this.eventsSent, preview: json.slice(0, 300) });
      }

      const bytes = Buffer.from(json, 'utf-8');
      yield { chunk: { bytes } };

      if ('event' in event && 'sessionEnd' in (event as NovaSessionEndEvent).event) {
        this.log.info('sessionEnd sent — closing input stream', { totalEventsSent: this.eventsSent });
        break;
      }
    }
  }

  private enqueue(event: NovaInputEvent): void {
    if (this.inputResolve) {
      const r = this.inputResolve;
      this.inputResolve = null;
      r(event);
    } else {
      this.inputQueue.push(event);
    }
  }

  private nextInputEvent(): Promise<NovaInputEvent | null> {
    if (this.inputQueue.length > 0) {
      return Promise.resolve(this.inputQueue.shift()!);
    }
    return new Promise<NovaInputEvent | null>((r) => {
      this.inputResolve = r;
    });
  }

  // ─── Output Event Consumer ─────────────────────────────────────────────────

  private async consumeOutputStream(
    stream: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>,
  ): Promise<void> {
    this.log.info('Nova output stream consumer started — waiting for events');
    let totalOutputEvents = 0;

    for await (const item of stream) {
      if (this.closed) break;

      // Detect SDK-level error envelopes (non-chunk items)
      const raw = item as unknown as Record<string, unknown>;
      if (!('chunk' in raw)) {
        const keys = Object.keys(raw);
        this.log.warn('Nova stream item has no "chunk" key — possible SDK error envelope', {
          keys,
          raw: JSON.stringify(raw).slice(0, 500),
          hint: 'This usually means AWS returned an error (invalid model ID, auth failure, quota exceeded)',
        });
        continue;
      }

      try {
        const bytes = item.chunk?.bytes;
        if (!bytes || bytes.length === 0) {
          this.log.debug('Received empty chunk from Nova — skipping');
          continue;
        }

        const rawStr = Buffer.from(bytes).toString('utf-8');
        totalOutputEvents++;

        // Log raw bytes for first few events (critical for debugging startup)
        if (totalOutputEvents <= 5) {
          this.log.info(`Nova output event #${totalOutputEvents} (raw)`, { raw: rawStr.slice(0, 500) });
        } else {
          this.log.debug('Nova raw output bytes', { raw: rawStr.slice(0, 200) });
        }

        const parsed = JSON.parse(rawStr) as Record<string, unknown>;
        this.dispatchOutputEvent(parsed);
      } catch (err) {
        this.log.warn('Failed to parse Nova Sonic output event', {
          error: (err as Error).message,
        });
      }
    }

    this.log.info('Nova Sonic output stream ended', {
      totalOutputEvents,
      audioChunksReceived: this.audioChunksReceived,
    });
    if (!this.closed) this.emit('closed');
  }

  private dispatchOutputEvent(raw: Record<string, unknown>): void {
    const inner = (raw as { event?: Record<string, unknown> }).event;
    if (!inner) {
      this.log.warn('Nova output event has no "event" key', { raw: JSON.stringify(raw).slice(0, 200) });
      return;
    }

    const eventType = Object.keys(inner)[0] ?? 'unknown';
    this.log.debug('Nova output event dispatching', { eventType, keys: Object.keys(inner) });

    if ('sessionStart' in inner) {
      const e = inner.sessionStart as { sessionId?: string };
      this.novaSessionId = e.sessionId ?? '';
      this.log.info('✅ Nova session started successfully', { novaSessionId: this.novaSessionId });
      this.emit('session-started', this.novaSessionId);

    } else if ('completionStart' in inner) {
      // Nova 2: fires before any content blocks in a turn — must handle or output parse breaks
      const e = inner.completionStart as { completionId?: string; promptName?: string; sessionId?: string };
      this.log.info('Nova completion started', {
        completionId: e.completionId,
        promptName: e.promptName,
      });
      this.emit('completion-start', e.completionId ?? '', e.promptName ?? '');

    } else if ('contentStart' in inner) {
      const e = inner.contentStart as {
        contentId: string;
        type: 'AUDIO' | 'TEXT' | 'TOOL';
        role?: string;
        additionalModelFields?: string;
      };
      this.log.info('Nova content block started', {
        contentId: e.contentId,
        type: e.type,
        role: e.role,
        additionalModelFields: e.additionalModelFields,
      });

      if (e.type === 'AUDIO') {
        this.emit('content-start', e.contentId, 'AUDIO');
      } else if (e.type === 'TEXT') {
        this.emit('content-start', e.contentId, 'TEXT');
      }

    } else if ('audioOutput' in inner) {
      const e = inner.audioOutput as { contentId: string; content: string };
      this.audioChunksReceived++;

      if (this.audioChunksReceived === 1) {
        this.log.info('✅ First audio output chunk received from Nova', {
          contentId: e.contentId,
          audioChunksReceived: this.audioChunksReceived,
          base64Length: e.content.length,
        });
      } else if (this.audioChunksReceived % 50 === 0) {
        this.log.debug('Audio output progress', { audioChunksReceived: this.audioChunksReceived });
      }

      this.emit('audio-output', Buffer.from(e.content, 'base64'), e.contentId);

    } else if ('textOutput' in inner) {
      const e = inner.textOutput as { contentId: string; content: string; role?: string };
      this.log.debug('Nova text output', { role: e.role, contentLength: e.content.length, preview: e.content.slice(0, 100) });
      // role distinguishes the caller's ASR transcript (USER) from the agent's reply (ASSISTANT)
      this.emit('text-output', e.content, e.contentId, e.role ?? 'ASSISTANT');

    } else if ('contentEnd' in inner) {
      const e = inner.contentEnd as { contentId: string; stopReason?: string; type?: string };
      this.log.debug('Nova content block ended', {
        contentId: e.contentId,
        stopReason: e.stopReason,
        type: e.type,
      });
      this.emit('content-end', e.contentId, e.stopReason ?? '');

    } else if ('completionEnd' in inner) {
      const e = inner.completionEnd as { stopReason: string; completionId?: string };
      this.log.info('✅ Nova turn complete', {
        stopReason: e.stopReason,
        completionId: e.completionId,
        audioChunksReceived: this.audioChunksReceived,
      });
      this.emit('turn-complete', e.stopReason);

    } else if ('usageEvent' in inner) {
      const e = inner.usageEvent as {
        totalInputTokens?: number;
        totalOutputTokens?: number;
        totalTokens?: number;
      };
      this.log.debug('Nova usage event', {
        totalInputTokens: e.totalInputTokens,
        totalOutputTokens: e.totalOutputTokens,
        totalTokens: e.totalTokens,
      });
      this.emit('usage', e.totalInputTokens ?? 0, e.totalOutputTokens ?? 0);

    } else {
      this.log.warn('Unhandled Nova Sonic output event type', {
        eventType,
        keys: Object.keys(inner),
        raw: JSON.stringify(inner).slice(0, 200),
      });
    }
  }

  // ─── Event Builders ────────────────────────────────────────────────────────

  private buildSessionStart(): NovaSessionStartEvent {
    const sessionStart: NovaSessionStartEvent['event']['sessionStart'] = {
      inferenceConfiguration: {
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        topP: this.config.topP,
      },
    };

    // Only include for Nova 2 — Nova 1 rejects this field with a hard error
    if (this.config.endpointingSensitivity) {
      sessionStart.turnDetectionConfiguration = {
        endpointingSensitivity: this.config.endpointingSensitivity,
      };
    }

    return { event: { sessionStart } };
  }

  private buildPromptStart(promptName: string): NovaPromptStartEvent {
    return {
      event: {
        promptStart: {
          promptName,
          textOutputConfiguration: { mediaType: 'text/plain' },
          audioOutputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: this.config.sampleRate,
            sampleSizeBits: 16,
            channelCount: 1,
            voiceId: this.config.voiceId,
            encoding: 'base64',    // required
            audioType: 'SPEECH',   // required
          },
        },
      },
    };
  }

  private buildContentStartText(
    promptName: string,
    contentName: string,
    role: 'SYSTEM' | 'USER' | 'ASSISTANT',
  ): NovaContentStartText {
    return {
      event: {
        contentStart: {
          promptName,
          contentName,
          type: 'TEXT',
          // Validated against the docs reference (scripts/test-nova-v2.ts): TEXT
          // content blocks use interactive:true.
          interactive: true,
          role,
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    };
  }

  private buildContentStartAudio(
    promptName: string,
    contentName: string,
    interactive: boolean,
  ): NovaContentStartAudio {
    return {
      event: {
        contentStart: {
          promptName,
          contentName,
          type: 'AUDIO',
          interactive,
          role: 'USER',
          audioInputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: this.config.sampleRate,
            sampleSizeBits: 16,
            channelCount: 1,
            audioType: 'SPEECH',
            encoding: 'base64',
          },
        },
      },
    };
  }

  private buildTextInput(
    promptName: string,
    contentName: string,
    content: string,
  ): NovaTextInputEvent {
    return {
      event: { textInput: { promptName, contentName, content } },
    };
  }

  private buildContentEnd(
    promptName: string,
    contentName: string,
  ): NovaContentEndEvent {
    return {
      event: { contentEnd: { promptName, contentName } },
    };
  }
}
