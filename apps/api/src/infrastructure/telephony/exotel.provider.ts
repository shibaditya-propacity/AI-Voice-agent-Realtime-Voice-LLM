import type { TelephonyProvider, CallOptions, CallResult } from './provider.interface';

export class ExotelProvider implements TelephonyProvider {
  readonly name = 'exotel';

  constructor(
    private readonly apiKey: string,
    private readonly apiToken: string,
    private readonly accountSid: string,
    private readonly phoneNumber: string,
    private readonly apiSubdomain: string,
  ) {}

  async initiateCall(_options: CallOptions): Promise<CallResult> {
    // TODO: integrate with ExotelService.initiateOutboundCall()
    throw new Error('ExotelProvider.initiateCall: not yet wired to SaaS API layer');
  }

  async terminateCall(_callId: string): Promise<void> {
    // TODO: implement via Exotel REST API
  }

  sendAudio(_callId: string, _audioBase64: string): boolean {
    return false;
  }

  clearAudio(_callId: string): void {
    // TODO: implement
  }
}
