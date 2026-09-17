import { afterEach, describe, expect, it, vi } from 'vitest';

import { EufyCloudApi } from '../EufyCloudApi';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Minimal Eufy cloud: login, user centre, MQTT bundle and the two device lists. */
function stubEufy(lists: { aiot: unknown[]; cloud: unknown[] }) {
  const replies: Record<string, unknown> = {
    '/v1/user/v2/email/login': { access_token: 'token', user_id: 'user-1' },
    '/v1/user/user_center_info': { user_center_id: 'centre-1', user_center_token: 'centre-token' },
    '/app/devicemanage/get_user_mqtt_info': {
      data: { endpoint_addr: 'e', thing_name: 't', certificate_pem: 'c', private_key: 'k', user_id: 'user-1', app_name: 'a' },
    },
    '/app/devicerelation/get_device_list': { code: 0, data: { devices: lists.aiot.map((device) => ({ device })) } },
    '/v1/device/v2': { devices: lists.cloud },
  };
  vi.stubGlobal('fetch', (input: string) => {
    const body = replies[new URL(input).pathname];
    return Promise.resolve(new Response(JSON.stringify(body), { status: body === undefined ? 404 : 200 }));
  });
}

const cloudDevice = (id: string, connectType: number) => ({
  id,
  alias_name: id,
  connect_type: connectType,
  product: { product_code: 'T2277', tuya_pid: 'ojbb3pwrgkkrsqhk' },
});

async function listDevices() {
  const api = new EufyCloudApi('me@example.com', 'secret', 'udid', log);
  await api.login();
  return (await api.listDevices()).devices.map(({ deviceId, connection }) => ({ deviceId, connection }));
}

describe('EufyCloudApi.listDevices', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('routes devicerelation devices to MQTT, whatever their product metadata says', async () => {
    stubEufy({ aiot: [{ device_sn: 'mqtt-1' }], cloud: [cloudDevice('mqtt-1', 2)] });

    expect(await listDevices()).toEqual([{ deviceId: 'mqtt-1', connection: 'mqtt' }]);
  });

  it('routes cloud-only devices by connect_type, so a Tuya vacuum is never sent MQTT commands', async () => {
    stubEufy({ aiot: [], cloud: [cloudDevice('tuya-1', 2), cloudDevice('mqtt-2', 1)] });

    expect(await listDevices()).toEqual([
      { deviceId: 'tuya-1', connection: 'tuya' },
      { deviceId: 'mqtt-2', connection: 'mqtt' },
    ]);
  });
});
