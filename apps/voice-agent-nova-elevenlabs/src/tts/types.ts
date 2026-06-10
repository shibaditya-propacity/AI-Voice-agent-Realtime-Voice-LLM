/** ElevenLabs WebSocket streaming TTS types */

// ─── Outbound (Server → ElevenLabs) ──────────────────────────────────────────

export interface ElevenLabsInitMessage {
  text: string;                      // Must be " " (space) for the first message
  voice_settings: {
    stability: number;
    similarity_boost: number;
    speed?: number;
  };
  generation_config?: {
    chunk_length_schedule?: number[];
  };
  xi_api_key: string;
}

export interface ElevenLabsTextMessage {
  text: string;                      // Text chunk to speak
  flush?: boolean;                   // true to force immediate generation
}

export interface ElevenLabsCloseMessage {
  text: '';                          // Empty string signals end of input
}

// ─── Inbound (ElevenLabs → Server) ───────────────────────────────────────────

export interface ElevenLabsAudioResponse {
  audio: string;                     // base64-encoded ulaw_8000 audio
  isFinal: boolean;
  normalizedAlignment?: unknown;
  alignment?: unknown;
}

export interface ElevenLabsErrorResponse {
  message?: string;
  error?: string;
}

export type ElevenLabsResponse = ElevenLabsAudioResponse | ElevenLabsErrorResponse;

export type OnAudioChunk = (audioBase64: string) => void;
export type OnTTSComplete = () => void;
export type OnTTSError   = (err: Error) => void;
