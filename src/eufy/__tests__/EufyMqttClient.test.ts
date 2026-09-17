import { describe, expect, it, vi } from 'vitest';

import {
  buildEnvelope,
  EufyMqttClient,
  parseDpsMessage,
  type MqttConnectOptions,
  type MqttLike,
} from '../EufyMqttClient';
import type { MqttCredentials } from '../types';

const credentials: MqttCredentials = {
  endpointAddr: 'broker.example.com',
  thingName: 'thing-1',
  certificatePem: 'CERT',
  privateKey: 'KEY',
  userId: 'user-1',
  appName: 'eufy_home',
};

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type Listener = (...args: never[]) => void;

/** Minimal stand-in for mqtt.MqttClient that records what was sent. */
class FakeMqttClient implements MqttLike {
  readonly subscriptions: string[] = [];
  readonly published: { topic: string; message: string }[] = [];
  ended = false;
  private readonly listeners = new Map<string, Listener[]>();

  subscribe(topic: string): void {
    this.subscriptions.push(topic);
  }

  publishError?: Error;

  publish(topic: string, message: string, callback: (error?: Error) => void): void {
    this.published.push({ topic, message });
    callback(this.publishError);
  }

  end(_force: boolean, _options: object, callback: () => void): void {
    this.ended = true;
    callback();
  }

  on(event: string, listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  off(event: string, listener: Listener): void {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== listener));
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
}

const connectClient = async () => {
  const fake = new FakeMqttClient();
  let connectOptions: MqttConnectOptions | undefined;
  let connectUrl = '';

  const client = new EufyMqttClient({
    deviceId: 'SN123',
    model: 'T2277',
    openudid: 'udid-1',
    credentials,
    log,
    refreshCredentials: () => Promise.resolve(credentials),
    connectFn: (url, options) => {
      connectUrl = url;
      connectOptions = options;
      queueMicrotask(() => fake.emit('connect'));
      return fake;
    },
  });

  await client.connect();
  return { client, fake, connectUrl, connectOptions };
};

describe('buildEnvelope', () => {
  it('wraps dps in the head/stringified-payload shape the broker expects', () => {
    const envelope = buildEnvelope({
      sessionId: 'android-eufy_home-eufy_android_udid-1_user-1',
      accountId: 'user-1',
      deviceId: 'SN123',
      dps: { '152': 'base64data' },
      timestamp: 1_700_000_000_000,
    });

    expect(envelope.head).toEqual({
      client_id: 'android-eufy_home-eufy_android_udid-1_user-1',
      cmd: 65537,
      cmd_status: 1,
      msg_seq: 2,
      seed: '',
      sess_id: 'android-eufy_home-eufy_android_udid-1_user-1',
      sign_code: 0,
      timestamp: 1_700_000_000_000,
      version: '1.0.0.1',
    });
    expect(JSON.parse(envelope.payload)).toEqual({
      account_id: 'user-1',
      data: { '152': 'base64data' },
      device_sn: 'SN123',
      protocol: 2,
      t: 1_700_000_000_000,
    });
  });
});

describe('parseDpsMessage', () => {
  it('reads dps from a stringified payload', () => {
    const message = JSON.stringify({
      head: {},
      payload: JSON.stringify({ data: { '163': 87 }, device_sn: 'SN123' }),
    });

    expect(parseDpsMessage(Buffer.from(message))).toEqual({ '163': 87 });
  });

  it('reads dps from an object payload', () => {
    const message = JSON.stringify({ payload: { data: { '153': 'blob' } } });

    expect(parseDpsMessage(message)).toEqual({ '153': 'blob' });
  });

  it('ignores malformed or dataless messages', () => {
    expect(parseDpsMessage('not json')).toBeUndefined();
    expect(parseDpsMessage(JSON.stringify({ payload: 'not json either' }))).toBeUndefined();
    expect(parseDpsMessage(JSON.stringify({ payload: { t: 1 } }))).toBeUndefined();
  });
});

describe('EufyMqttClient', () => {
  it('connects with mTLS options and subscribes to both inbound topics', async () => {
    const { fake, connectUrl, connectOptions } = await connectClient();

    expect(connectUrl).toBe('mqtt://broker.example.com');
    expect(connectOptions?.username).toBe('thing-1');
    expect(connectOptions?.cert.toString()).toBe('CERT');
    expect(connectOptions?.key.toString()).toBe('KEY');
    expect(connectOptions?.clientId).toMatch(/^android-eufy_home-eufy_android_udid-1_user-1-\d+$/);
    expect(fake.subscriptions).toEqual(['cmd/eufy_home/T2277/SN123/res', 'smart/mb/in/SN123']);
  });

  it('publishes the same envelope to both outbound topics', async () => {
    const { client, fake } = await connectClient();

    await client.sendDps({ '152': 'cmd' });

    expect(fake.published.map((entry) => entry.topic)).toEqual([
      'cmd/eufy_home/T2277/SN123/req',
      'smart/mb/out/SN123',
    ]);
    const [first, second] = fake.published;
    expect(first?.message).toBe(second?.message);
    expect(parseDpsMessage(first?.message ?? '')).toEqual({ '152': 'cmd' });
  });

  it('emits dps from inbound messages and skips unrelated ones', async () => {
    const { client, fake } = await connectClient();
    const seen: Record<string, unknown>[] = [];
    client.onDps((dps) => seen.push(dps));

    fake.emit('message', 'smart/mb/in/SN123', Buffer.from(JSON.stringify({ hello: 'world' })));
    fake.emit(
      'message',
      'smart/mb/in/SN123',
      Buffer.from(JSON.stringify({ payload: JSON.stringify({ data: { '163': 42 } }) })),
    );

    expect(seen).toEqual([{ '163': 42 }]);
  });

  it('refuses to send while disconnected', async () => {
    const { client } = await connectClient();
    await client.disconnect();

    await expect(client.sendDps({ '152': 'cmd' })).rejects.toThrow(/not connected/);
  });

  it('refuses to send once the broker has dropped the connection', async () => {
    vi.useFakeTimers();
    const { client, fake } = await connectClient();

    fake.emit('close');

    await expect(client.sendDps({ '152': 'cmd' })).rejects.toThrow(/not connected/);
    await client.disconnect();
    vi.useRealTimers();
  });

  it('reports a failed publish instead of silently dropping it', async () => {
    const { client, fake } = await connectClient();
    fake.publishError = new Error('broker refused');

    await expect(client.sendDps({ '152': 'cmd' })).rejects.toThrow(/broker refused/);
  });

  it('detaches its own listeners when closing', async () => {
    const { client, fake } = await connectClient();
    await client.disconnect();

    expect(fake.listenerCount('message')).toBe(0);
    expect(fake.listenerCount('error')).toBe(0);
    expect(fake.ended).toBe(true);
  });

  it('re-logs in and reconnects when the broker rejects the certificate', async () => {
    vi.useFakeTimers();
    const clients = [new FakeMqttClient(), new FakeMqttClient()];
    const refreshed: MqttCredentials = { ...credentials, certificatePem: 'FRESH' };
    const refreshCredentials = vi.fn(() => Promise.resolve(refreshed));
    let attempt = 0;

    const client = new EufyMqttClient({
      deviceId: 'SN123',
      model: 'T2277',
      openudid: 'udid-1',
      credentials,
      log,
      refreshCredentials,
      connectFn: () => {
        const fake = clients[attempt++];
        queueMicrotask(() => fake.emit('connect'));
        return fake;
      },
    });

    await client.connect();
    clients[0]?.emit('error', new Error('unauthorized: certificate rejected'));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(clients[1]?.subscriptions.length).toBe(2));

    expect(refreshCredentials).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
