import type { ControlSessionEvent, ControlTrustContext } from '../control/ControlSession';
import type { AnyControlMessage, ControlMessageType, ControlPayloadMap } from '../protocol/ControlMessage';
import type { SessionControlChannel } from '../session/SessionController';

export interface AvailabilityInvalidator {
  markPartnerUnreachable(endpoint: { host: string; port: number }): Promise<void>;
}

export class AvailabilityAwareControlChannel implements SessionControlChannel {
  constructor(private readonly control: SessionControlChannel, private readonly availability: AvailabilityInvalidator) {}
  subscribe(listener: (event: ControlSessionEvent) => void): () => void { return this.control.subscribe(listener); }
  activate(context: ControlTrustContext): Promise<void> { return this.control.activate(context); }
  deactivate(): Promise<void> { return this.control.deactivate(); }
  async connect(endpoint: { host: string; port: number }): Promise<string> {
    try {
      return await this.control.connect(endpoint);
    } catch (error) {
      await this.availability.markPartnerUnreachable(endpoint).catch(() => undefined);
      throw error;
    }
  }
  updateReconnectEndpoint(endpoint: { host: string; port: number }): void { this.control.updateReconnectEndpoint?.(endpoint); }
  send<T extends ControlMessageType>(type: T, payload: ControlPayloadMap[T]): Promise<AnyControlMessage> { return this.control.send(type, payload); }
  close(): Promise<void> { return this.control.close(); }
}
