/**
 * NovaClient: bidirectional streaming connection to Amazon Nova Sonic.
 *
 * Correct Nova Sonic event sequence per the official API docs:
 * https://docs.aws.amazon.com/nova/latest/userguide/speech-bidirection.html
 *
 * FIRST TURN:
 *   sessionStart
 *   promptStart              (promptName, audioOutputConfig with encoding+audioType)
 *   contentStart             (contentName_sys, type:TEXT, role:SYSTEM, textInputConfiguration)
 *   textInput                (contentName_sys, system prompt text)
 *   contentEnd               (contentName_sys)
 *   contentStart             (contentName_aud, type:AUDIO, role:USER, audioInputConfiguration)
 *   audioInput × N           (contentName_aud, base64 PCM16 chunks)
 *   contentEnd               (contentName_aud)
 *   promptEnd                (promptName)
 *
 * SUBSEQUENT TURNS:
 *   promptStart              (new promptName)
 *   contentStart             (new contentName_aud, type:AUDIO, role:USER)
 *   audioInput × N
 *   contentEnd
 *   promptEnd
 *
 * END SESSION:
 *   sessionEnd
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
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Step 1: queue sessionStart (must be first event in the stream).
   * Call this before beginUserTurn() so the event order is correct.
   */
  initialize(): void {
    this.enqueue(this.buildSessionStart());
  }

  /**
   * Step 2: open the HTTP/2 WebSocket connection to AWS Bedrock.
   * By this point the queue should have: sessionStart → promptStart → contentStart(SYS)
   * → textInput → contentEnd → contentStart(USER), giving Nova enough to respond.
   */
  async connect(connectTimeoutMs = 10_000): Promise<void> {
    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: this.config.modelId,
      body: this.createInputStream(),
    } as InvokeModelWithBidirectionalStreamCommandInput);

    this.log.info('Opening Nova Sonic bidirectional stream', { modelId: this.config.modelId });

    try {
      const sendPromise = this.bedrockClient.send(command);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Nova Sonic connect timed out after ${connectTimeoutMs}ms`)),
          connectTimeoutMs,
        ),
      );
      const response = await Promise.race([sendPromise, timeoutPromise]);

      this.log.info('Nova Sonic stream opened successfully', { modelId: this.config.modelId });

      if (response.body) {
        this.consumeOutputStream(response.body).catch((err) => {
          this.log.error('Nova Sonic output stream error', err as Error);
          this.emit('error', err as Error);
          this.close();
        });
      }
    } catch (err) {
      this.log.error('Failed to open Nova Sonic stream', err as Error, {
        modelId: this.config.modelId,
        hint: 'Verify AWS credentials, bedrock:InvokeModelWithBidirectionalStream IAM permission, and Nova Sonic model access in the Bedrock console.',
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
    this.log.info('Nova Sonic client closed');
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

    if (includeSystemPrompt) {
      const sysContentName = `sys_${uuidv4().replace(/-/g, '')}`;
      this.enqueue(this.buildContentStartText(promptName, sysContentName, 'SYSTEM'));
      this.enqueue(this.buildTextInput(promptName, sysContentName, this.config.systemPrompt));
      this.enqueue(this.buildContentEnd(promptName, sysContentName));
    }

    return promptName;
  }

  /** Open a USER audio content block. Returns the contentName to use for audio/close calls. */
  openAudioBlock(promptName: string, contentName: string): void {
    this.enqueue(this.buildContentStartAudio(promptName, contentName));
  }

  /** Send a complete USER text content block (contentStart + textInput + contentEnd). */
  sendUserTextBlock(promptName: string, contentName: string, content: string): void {
    this.enqueue(this.buildContentStartText(promptName, contentName, 'USER'));
    this.enqueue(this.buildTextInput(promptName, contentName, content));
    this.enqueue(this.buildContentEnd(promptName, contentName));
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
  }

  /** Close the current audio content block. */
  closeAudioBlock(promptName: string, contentName: string): void {
    this.enqueue(this.buildContentEnd(promptName, contentName));
  }

  /** Signal Nova Sonic to generate a response for this prompt. */
  sendPromptEnd(promptName: string): void {
    if (this.closed) return;
    const event: NovaPromptEndEvent = {
      event: { promptEnd: { promptName } },
    };
    this.enqueue(event);
  }

  // ─── Async Input Generator ─────────────────────────────────────────────────

  private async *createInputStream(): AsyncGenerator<InvokeModelWithBidirectionalStreamInput> {
    while (true) {
      const event = await this.nextInputEvent();
      if (event === null) break;

      const json = JSON.stringify(event);
      this.log.debug('Nova input event sent', { preview: json.slice(0, 200) });
      const bytes = Buffer.from(json, 'utf-8');
      yield { chunk: { bytes } };

      if ('event' in event && 'sessionEnd' in (event as NovaSessionEndEvent).event) {
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
    for await (const item of stream) {
      if (this.closed) break;

      // Log all top-level keys so we can see errors the SDK delivers
      const raw = item as unknown as Record<string, unknown>;
      const itemKeys = Object.keys(raw);
      if (!('chunk' in raw)) {
        this.log.warn('Nova stream item has no chunk — possible SDK error envelope', {
          keys: itemKeys,
          raw: JSON.stringify(raw).slice(0, 500),
        });
        continue;
      }

      try {
        const bytes = item.chunk?.bytes;
        if (!bytes || bytes.length === 0) continue;
        const rawStr = Buffer.from(bytes).toString('utf-8');
        this.log.debug('Nova raw output bytes', { raw: rawStr.slice(0, 400) });
        const parsed = JSON.parse(rawStr) as Record<string, unknown>;
        this.dispatchOutputEvent(parsed);
      } catch (err) {
        this.log.warn('Failed to parse Nova Sonic output event', {
          error: (err as Error).message,
        });
      }
    }
    this.log.info('Nova Sonic output stream ended');
    if (!this.closed) this.emit('closed');
  }

  private dispatchOutputEvent(raw: Record<string, unknown>): void {
    const inner = (raw as { event?: Record<string, unknown> }).event;
    if (!inner) return;

    this.log.debug('Nova output event', { keys: Object.keys(inner) });

    if ('sessionStart' in inner) {
      const e = inner.sessionStart as { sessionId?: string };
      this.novaSessionId = e.sessionId ?? '';
      this.log.info('Nova session started', { novaSessionId: this.novaSessionId });
      this.emit('session-started', this.novaSessionId);

    } else if ('contentStart' in inner) {
      // Output contentStart has contentId (UUID Nova assigns)
      const e = inner.contentStart as { contentId: string; type: 'AUDIO' | 'TEXT' | 'TOOL'; role?: string };
      if (e.type === 'AUDIO') {
        this.emit('content-start', e.contentId, 'AUDIO');
      } else if (e.type === 'TEXT') {
        this.emit('content-start', e.contentId, 'TEXT');
      }

    } else if ('audioOutput' in inner) {
      const e = inner.audioOutput as { contentId: string; content: string };
      this.emit('audio-output', Buffer.from(e.content, 'base64'), e.contentId);

    } else if ('textOutput' in inner) {
      const e = inner.textOutput as { contentId: string; content: string };
      this.emit('text-output', e.content, e.contentId);

    } else if ('contentEnd' in inner) {
      const e = inner.contentEnd as { contentId: string; stopReason?: string };
      this.emit('content-end', e.contentId, e.stopReason ?? '');

    } else if ('completionEnd' in inner) {
      const e = inner.completionEnd as { stopReason: string };
      this.emit('turn-complete', e.stopReason);

    } else if ('usageEvent' in inner) {
      const e = inner.usageEvent as { totalInputTokens: number; totalOutputTokens: number };
      this.emit('usage', e.totalInputTokens ?? 0, e.totalOutputTokens ?? 0);

    } else {
      this.log.debug('Unhandled Nova Sonic output event', { keys: Object.keys(inner) });
    }
  }

  // ─── Event Builders ────────────────────────────────────────────────────────

  private buildSessionStart(): NovaSessionStartEvent {
    return {
      event: {
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
            topP: this.config.topP,
          },
        },
      },
    };
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
          interactive: false,
          role,
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    };
  }

  private buildContentStartAudio(
    promptName: string,
    contentName: string,
  ): NovaContentStartAudio {
    return {
      event: {
        contentStart: {
          promptName,
          contentName,
          type: 'AUDIO',
          interactive: true,
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
