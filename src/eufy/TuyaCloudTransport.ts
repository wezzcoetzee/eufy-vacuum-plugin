import type { TuyaCloudApi } from './TuyaCloudApi';
import type { DpsValue, Logger, VacuumTransport } from './types';

/** How soon after a command to re-read state, so Home reflects it without waiting a full poll. */
export const COMMAND_REFRESH_DELAY_MS = 3_000;

export interface TuyaCloudTransportOptions {
  deviceId: string;
  /** One logged-in client per account, shared by every Tuya device on it. */
  api: Pick<TuyaCloudApi, 'listDevices' | 'sendDps'>;
  pollIntervalMs: number;
  log: Logger;
}

/**
 * Transport for Tuya-connected vacuums. Tuya's mobile cloud is
 * request/response, so state arrives by polling the device list instead of
 * being pushed; commands are published immediately and followed by one early
 * re-read.
 */
export class TuyaCloudTransport implements VacuumTransport {
  private handler?: (dps: Record<string, unknown>) => void;
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly options: TuyaCloudTransportOptions) {}

  async connect(): Promise<void> {
    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.options.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  disconnect(): Promise<void> {
    clearInterval(this.pollTimer);
    clearTimeout(this.refreshTimer);
    return Promise.resolve();
  }

  async sendDps(dps: Record<string, DpsValue>): Promise<void> {
    await this.options.api.sendDps(this.options.deviceId, dps);

    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.poll(), COMMAND_REFRESH_DELAY_MS);
    this.refreshTimer.unref?.();
  }

  onDps(handler: (dps: Record<string, unknown>) => void): void {
    this.handler = handler;
  }

  private async poll(): Promise<void> {
    const { api, deviceId, log } = this.options;
    try {
      const device = (await api.listDevices()).find((candidate) => candidate.devId === deviceId);
      if (device === undefined) {
        log.warn(`Tuya cloud no longer lists device ${deviceId}`);
        return;
      }
      this.handler?.(device.dps ?? {});
    } catch (error) {
      log.debug(`Tuya state poll for ${deviceId} failed: ${String(error)}`);
    }
  }
}
