export interface CallOptions {
  to: string;
  from: string;
  webhookUrl: string;
  statusCallbackUrl?: string;
  metadata?: Record<string, string>;
}

export interface CallResult {
  callId: string;
  status: 'queued' | 'initiated' | 'failed';
  message?: string;
}

export interface TelephonyProvider {
  readonly name: string;
  initiateCall(options: CallOptions): Promise<CallResult>;
  terminateCall(callId: string): Promise<void>;
  sendAudio(callId: string, audioBase64: string): boolean;
  clearAudio(callId: string): void;
}
