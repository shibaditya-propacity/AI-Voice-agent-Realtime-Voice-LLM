import type { TelephonyProvider, CallOptions, CallResult } from './provider.interface';

export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly phoneNumber: string,
  ) {}

  async initiateCall(_options: CallOptions): Promise<CallResult> {
    // TODO: integrate with existing TwilioService.initiateOutboundCall()
    throw new Error('TwilioProvider.initiateCall: not yet wired to SaaS API layer');
  }

  async terminateCall(_callId: string): Promise<void> {
    // TODO: implement via Twilio REST API
  }

  sendAudio(_callId: string, _audioBase64: string): boolean {
    return false;
  }

  clearAudio(_callId: string): void {
    // TODO: delegate to TwilioStreamHandler.clearAudio()
  }
}
