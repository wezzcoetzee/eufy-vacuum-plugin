import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TuyaDevice } from '../TuyaCloudApi';
import { COMMAND_REFRESH_DELAY_MS, TuyaCloudTransport } from '../TuyaCloudTransport';
import { TUYA_CAPTURE } from './fixtures/dps';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function createTransport(devices: () => TuyaDevice[]) {
  const api = {
    listDevices: vi.fn(() => Promise.resolve(devices())),
    sendDps: vi.fn(() => Promise.resolve()),
  };
  const transport = new TuyaCloudTransport({ deviceId: 'dev-1', api, pollIntervalMs: 60_000, log });
  const received: Array<Record<string, unknown>> = [];
  transport.onDps((dps) => received.push(dps));
  return { api, transport, received };
}

describe('TuyaCloudTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads state on connect and on every poll', async () => {
    const { api, transport, received } = createTransport(() => [
      { devId: 'other', dps: {} },
      { devId: 'dev-1', dps: TUYA_CAPTURE.chargingDone },
    ]);

    await transport.connect();
    expect(received).toEqual([TUYA_CAPTURE.chargingDone]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.listDevices).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(2);

    await transport.disconnect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.listDevices).toHaveBeenCalledTimes(2);
  });

  it('publishes commands and re-reads state shortly after', async () => {
    const { api, transport } = createTransport(() => [{ devId: 'dev-1', dps: TUYA_CAPTURE.chargingDone }]);
    await transport.connect();

    await transport.sendDps({ '152': 'AggG' });

    expect(api.sendDps).toHaveBeenCalledWith('dev-1', { '152': 'AggG' });
    await vi.advanceTimersByTimeAsync(COMMAND_REFRESH_DELAY_MS);
    expect(api.listDevices).toHaveBeenCalledTimes(2);
  });

  it('keeps polling through a failed read or a missing device', async () => {
    const { api, transport, received } = createTransport(() => []);
    api.listDevices.mockRejectedValueOnce(new Error('network down'));

    await expect(transport.connect()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(api.listDevices).toHaveBeenCalledTimes(2);
    expect(received).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('Tuya cloud no longer lists device dev-1');
  });
});
