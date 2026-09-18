import { mapDpsToState } from './dps';
import type { TuyaCloudApi } from './TuyaCloudApi';
import type { DpsValue, Logger, VacuumStatus, VacuumTransport } from './types';

/** How soon after a command to re-read state, so Home reflects it without waiting a full poll. */
export const COMMAND_REFRESH_DELAY_MS = 3_000;

/** Poll interval while the vacuum is moving, so arriving at the dock shows up within seconds. */
export const ACTIVE_POLL_INTERVAL_MS = 10_000;

/** Consecutive failed polls before the failure is logged as a warning rather than debug. */
export const POLL_FAILURE_WARN_THRESHOLD = 3;

const ACTIVE_STATUSES: ReadonlySet<VacuumStatus> = new Set([
  'cleaning',
  'go_home',
  'fast_mapping',
  'remote_ctrl',
  'cruising',
]);

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
 * being pushed: every `pollIntervalMs` while idle, faster while the vacuum is
 * moving, and once shortly after each command.
 */
export class TuyaCloudTransport implements VacuumTransport {
  private handler?: (dps: Record<string, unknown>) => void;
  private pollTimer?: NodeJS.Timeout;
  private connected = false;
  private active = false;
  private failedPolls = 0;

  constructor(private readonly options: TuyaCloudTransportOptions) {}

  async connect(): Promise<void> {
    this.connected = true;
    await this.poll();
  }

  disconnect(): Promise<void> {
    this.connected = false;
    clearTimeout(this.pollTimer);
    return Promise.resolve();
  }

  async sendDps(dps: Record<string, DpsValue>): Promise<void> {
    await this.options.api.sendDps(this.options.deviceId, dps);
    this.schedule(COMMAND_REFRESH_DELAY_MS);
  }

  onDps(handler: (dps: Record<string, unknown>) => void): void {
    this.handler = handler;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.pollTimer);
    if (!this.connected) return;
    this.pollTimer = setTimeout(() => void this.poll(), delayMs);
    this.pollTimer.unref?.();
  }

  private async poll(): Promise<void> {
    const { api, deviceId, log, pollIntervalMs } = this.options;
    try {
      const device = (await api.listDevices()).find((candidate) => candidate.devId === deviceId);
      this.recordSuccess();
      if (device === undefined) {
        log.warn(`Tuya cloud no longer lists device ${deviceId}`);
      } else {
        const dps = device.dps ?? {};
        const { status } = mapDpsToState(dps);
        if (status !== undefined) this.active = ACTIVE_STATUSES.has(status);
        this.handler?.(dps);
      }
    } catch (error) {
      this.recordFailure(error);
    }

    this.schedule(this.active ? Math.min(ACTIVE_POLL_INTERVAL_MS, pollIntervalMs) : pollIntervalMs);
  }

  private recordSuccess(): void {
    if (this.failedPolls >= POLL_FAILURE_WARN_THRESHOLD) {
      this.options.log.info(`Tuya state polls for ${this.options.deviceId} are working again`);
    }
    this.failedPolls = 0;
  }

  /** Warns once per outage; Home keeps showing the last known state until polls recover. */
  private recordFailure(error: unknown): void {
    const { deviceId, log } = this.options;
    this.failedPolls += 1;
    const message = `Tuya state poll for ${deviceId} failed: ${String(error)}`;
    if (this.failedPolls === POLL_FAILURE_WARN_THRESHOLD) {
      log.warn(`${message} (${this.failedPolls} in a row; Home will show stale state until this recovers)`);
    } else {
      log.debug(message);
    }
  }
}
