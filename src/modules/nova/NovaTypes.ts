/**
 * Amazon Nova Sonic type definitions.
 *
 * Based on the official AWS Bidirectional Streaming API:
 * https://docs.aws.amazon.com/nova/latest/userguide/speech-bidirection.html
 *
 * Key facts:
 *   - Input content blocks are identified by contentName (unique string we supply)
 *   - Output content blocks are identified by contentId  (UUID Nova assigns)
 *   - promptStart MUST include encoding:"base64" and audioType:"SPEECH"
 *   - role is part of contentStart, NOT part of textInput/audioInput
 *   - contentStart for audio includes audioInputConfiguration
 *   - contentStart for text includes textInputConfiguration
 */

// ─── Shared ───────────────────────────────────────────────────────────────────

export interface NovaInferenceConfig {
  maxTokens: number;
  temperature: number;
  topP: number;
}

export type NovaContentRole = 'SYSTEM' | 'USER' | 'ASSISTANT';

// ─── Input Events (Client → Nova Sonic) ─────────────────────────────────────

// ── sessionStart ──────────────────────────────────────────────────────────────
// Nova 2 added turnDetectionConfiguration — controls how quickly Nova detects
// end-of-speech (endpointing). Missing this was a silent break in Nova 2.
export interface NovaSessionStartEvent {
  event: {
    sessionStart: {
      inferenceConfiguration: NovaInferenceConfig;
      // Nova 2 only — v1 rejects this field entirely
      turnDetectionConfiguration?: {
        endpointingSensitivity: 'HIGH' | 'MEDIUM' | 'LOW';
      };
    };
  };
}

// ── promptStart ───────────────────────────────────────────────────────────────
export interface NovaPromptStartEvent {
  event: {
    promptStart: {
      promptName: string;
      textOutputConfiguration: { mediaType: 'text/plain' };
      audioOutputConfiguration: {
        mediaType: 'audio/lpcm';
        sampleRateHertz: number;
        sampleSizeBits: 16;
        channelCount: 1;
        voiceId: string;
        encoding: 'base64';    // REQUIRED by API
        audioType: 'SPEECH';   // REQUIRED by API
      };
    };
  };
}

// ── contentStart (text) ───────────────────────────────────────────────────────
// Used for the system prompt (role: SYSTEM).
export interface NovaContentStartText {
  event: {
    contentStart: {
      promptName: string;
      contentName: string;     // unique string per block (we generate)
      type: 'TEXT';
      interactive: boolean;
      role: NovaContentRole;
      textInputConfiguration: { mediaType: 'text/plain' };
    };
  };
}

// ── contentStart (audio) ──────────────────────────────────────────────────────
// Used for each USER audio turn.
// interactive:false → we control turn end with explicit contentEnd+promptEnd (greeting)
// interactive:true  → Nova's VAD controls turn end (normal listening turns)
export interface NovaContentStartAudio {
  event: {
    contentStart: {
      promptName: string;
      contentName: string;     // unique string per block (we generate)
      type: 'AUDIO';
      interactive: boolean;
      role: 'USER';
      audioInputConfiguration: {
        mediaType: 'audio/lpcm';
        sampleRateHertz: number;
        sampleSizeBits: 16;
        channelCount: 1;
        audioType: 'SPEECH';
        encoding: 'base64';
      };
    };
  };
}

// ── textInput ─────────────────────────────────────────────────────────────────
// Carries the actual text content (e.g. system prompt). Role NOT included here.
export interface NovaTextInputEvent {
  event: {
    textInput: {
      promptName: string;
      contentName: string;
      content: string;
    };
  };
}

// ── audioInput ────────────────────────────────────────────────────────────────
// PCM16 audio chunks (base64). Role NOT included here.
export interface NovaAudioInputEvent {
  event: {
    audioInput: {
      promptName: string;
      contentName: string;
      content: string; // base64-encoded PCM16
    };
  };
}

// ── contentEnd ────────────────────────────────────────────────────────────────
export interface NovaContentEndEvent {
  event: {
    contentEnd: {
      promptName: string;
      contentName: string;
    };
  };
}

// ── promptEnd ─────────────────────────────────────────────────────────────────
export interface NovaPromptEndEvent {
  event: {
    promptEnd: {
      promptName: string;
    };
  };
}

// ── sessionEnd ────────────────────────────────────────────────────────────────
export interface NovaSessionEndEvent {
  event: {
    sessionEnd: Record<string, never>;
  };
}

export type NovaInputEvent =
  | NovaSessionStartEvent
  | NovaPromptStartEvent
  | NovaContentStartText
  | NovaContentStartAudio
  | NovaTextInputEvent
  | NovaAudioInputEvent
  | NovaContentEndEvent
  | NovaPromptEndEvent
  | NovaSessionEndEvent;

// ─── Output Events (Nova Sonic → Client) ─────────────────────────────────────
// Output blocks use contentId (UUID assigned by Nova Sonic).

export interface NovaSessionStartedOutput {
  event: { sessionStart: { sessionId: string } };
}

export interface NovaContentStartOutput {
  event: {
    contentStart: {
      sessionId: string;
      promptName: string;
      completionId: string;
      contentId: string;
      type: 'AUDIO' | 'TEXT' | 'TOOL';
      role: NovaContentRole;
    };
  };
}

export interface NovaAudioOutputEvent {
  event: {
    audioOutput: {
      sessionId: string;
      promptName: string;
      completionId: string;
      contentId: string;
      content: string; // base64 PCM16
    };
  };
}

export interface NovaTextOutputEvent {
  event: {
    textOutput: {
      sessionId: string;
      promptName: string;
      completionId: string;
      contentId: string;
      content: string;
    };
  };
}

export interface NovaContentEndOutput {
  event: {
    contentEnd: {
      sessionId: string;
      promptName: string;
      completionId: string;
      contentId: string;
      type: 'AUDIO' | 'TEXT' | 'TOOL';
      stopReason?: string;
    };
  };
}

export interface NovaCompletionEndEvent {
  event: {
    completionEnd: {
      sessionId: string;
      promptName: string;
      completionId: string;
      stopReason: string;
    };
  };
}

export interface NovaUsageEvent {
  event: {
    usageEvent: {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
    };
  };
}

// ─── Session State ────────────────────────────────────────────────────────────

export type NovaSessionState =
  | 'idle'
  | 'session-starting'
  | 'session-active'
  | 'prompt-active'
  | 'receiving-response'
  | 'closed'
  | 'error';

export interface NovaSessionInfo {
  novaSessionId: string;
  currentPromptName: string;
  state: NovaSessionState;
  createdAt: number;
  lastEventAt: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface NovaClientConfig {
  modelId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  voiceId: string;
  /** Sample rate of caller audio we SEND to Nova (audioInputConfiguration). */
  sampleRate: number;
  /** Sample rate Nova produces its speech OUTPUT at (audioOutputConfiguration). */
  outputSampleRate: number;
  // Nova 2 only — omit entirely for Nova 1 (v1 rejects this field)
  endpointingSensitivity?: 'HIGH' | 'MEDIUM' | 'LOW';
}
