/** Deepgram STT event types */

export interface DeepgramTranscript {
  transcript: string;
  confidence: number;
  words: Array<{ word: string; start: number; end: number; confidence: number }>;
}

export interface DeepgramResult {
  type: 'Results';
  channel: { alternatives: DeepgramTranscript[] };
  is_final: boolean;
  speech_final: boolean;
  from_finalize: boolean;
  start: number;
  duration: number;
}

export interface DeepgramSpeechStarted {
  type: 'SpeechStarted';
  channel: number[];
  timestamp: number;
}

export interface DeepgramUtteranceEnd {
  type: 'UtteranceEnd';
  last_word_end: number;
  channel: number[];
}

export interface DeepgramMetadata {
  type: 'Metadata';
  request_id: string;
  model_info: { name: string; version: string; arch: string };
}

export type DeepgramMessage =
  | DeepgramResult
  | DeepgramSpeechStarted
  | DeepgramUtteranceEnd
  | DeepgramMetadata;

export type OnFinalTranscript = (text: string, confidence: number) => void;
export type OnSpeechStarted   = () => void;
export type OnSTTError        = (err: Error) => void;
