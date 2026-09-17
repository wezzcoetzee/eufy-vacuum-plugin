import mqtt from 'mqtt';

import type { DpsValue, Logger, MqttCredentials, VacuumTransport } from './types';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** How long a connection must hold before the backoff counts as recovered. */
const STABLE_CONNECTION_MS = 60_000;

/** The subset of mqtt.MqttClient this transport uses, so tests can fake it. */
export interface MqttLike {
  subscribe(topic: string): void;
  publish(topic: string, message: string, callback: (error?: Error) => void): void;
  end(force: boolean, options: object, callback: () => void): void;
  on(event: 'connect' | 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'message', listener: (topic: string, payload: Buffer) => void): void;
  off(event: 'connect' | 'close', listener: () => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  off(event: 'message', listener: (topic: string, payload: Buffer) => void): void;
}

export interface MqttConnectOptions {
  clientId: string;
  username: string;
  cert: Buffer;
  key: Buffer;
  /** Reconnection is driven by this class, not by mqtt.js. */
  reconnectPeriod: 0;
}

export type MqttConnectFn = (url: string, options: MqttConnectOptions) => MqttLike;

export interface EufyMqttClientOptions {
  deviceId: string;
  /** Five-character model code, e.g. T2277; part of the command topic. */
  model: string;
  /** Stable per-install identifier, shared with the cloud API. */
  openudid: string;
  credentials: MqttCredentials;
  log: Logger;
  /** Called when the broker refuses the certificate, to obtain a fresh bundle. */
  refreshCredentials: () => Promise<MqttCredentials>;
  connectFn?: MqttConnectFn;
}

/** Envelope Eufy's Android app wraps every command in. Shape is load bearing. */
export interface CommandEnvelope {
  head: {
    client_id: string;
    cmd: 65537;
    cmd_status: 1;
    msg_seq: 2;
    seed: '';
    sess_id: string;
    sign_code: 0;
    timestamp: number;
    version: '1.0.0.1';
  };
  /** JSON string, not an object; the broker rejects a nested object. */
  payload: string;
}

export const buildEnvelope = (params: {
  sessionId: string;
  accountId: string;
  deviceId: string;
  dps: Record<string, DpsValue>;
  timestamp: number;
}): CommandEnvelope => ({
  head: {
    client_id: params.sessionId,
    cmd: 65537,
    cmd_status: 1,
    msg_seq: 2,
    seed: '',
    sess_id: params.sessionId,
    sign_code: 0,
    timestamp: params.timestamp,
    version: '1.0.0.1',
  },
  payload: JSON.stringify({
    account_id: params.accountId,
    data: params.dps,
    device_sn: params.deviceId,
    protocol: 2,
    t: params.timestamp,
  }),
});

/**
 * Pull the dps map out of an inbound broker message. Anything that is not a
 * well-formed envelope carrying `payload.data` yields undefined rather than
 * throwing, because the broker also carries messages meant for the phone app.
 */
export const parseDpsMessage = (raw: string | Buffer): Record<string, unknown> | undefined => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw.toString());
  } catch {
    return undefined;
  }

  if (!isRecord(envelope)) {
    return undefined;
  }

  const payload = typeof envelope.payload === 'string' ? safeParse(envelope.payload) : envelope.payload;
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return undefined;
  }

  return payload.data;
};

/**
 * mTLS MQTT transport for one Eufy device. Subscribes to the device's two
 * inbound topics, publishes commands to their outbound counterparts, and
 * reconnects with exponential backoff, re-logging in when the broker rejects
 * the client certificate.
 */
export class EufyMqttClient implements VacuumTransport {
  private client?: MqttLike;
  /** Listeners attached to `client`, kept so teardown detaches only our own. */
  private detach: Array<() => void> = [];
  private connected = false;
  private credentials: MqttCredentials;
  private readonly connectFn: MqttConnectFn;
  private readonly handlers: ((dps: Record<string, unknown>) => void)[] = [];
  private backoffMs = INITIAL_BACKOFF_MS;
  private retryTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly options: EufyMqttClientOptions) {
    this.credentials = options.credentials;
    this.connectFn = options.connectFn ?? defaultConnect;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    await this.open();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.closeClient();
  }

  async sendDps(dps: Record<string, DpsValue>): Promise<void> {
    const client = this.client;
    if (client === undefined || !this.connected) {
      throw new Error(`Cannot send to ${this.options.deviceId}: MQTT is not connected`);
    }

    const envelope = buildEnvelope({
      sessionId: this.sessionId(),
      accountId: this.credentials.userId,
      deviceId: this.options.deviceId,
      dps,
      timestamp: Date.now(),
    });
    const message = JSON.stringify(envelope);

    this.options.log.debug(`Publishing dps to ${this.options.deviceId}: ${envelope.payload}`);
    await Promise.all(this.publishTopics().map((topic) => new Promise<void>((resolve, reject) => {
      client.publish(topic, message, (error) => (error ? reject(error) : resolve()));
    })));
  }

  onDps(handler: (dps: Record<string, unknown>) => void): void {
    this.handlers.push(handler);
  }

  private async open(): Promise<void> {
    await this.closeClient();

    const { log, deviceId } = this.options;
    const client = this.connectFn(`mqtt://${this.credentials.endpointAddr}`, {
      clientId: `${this.sessionId()}-${Date.now()}`,
      username: this.credentials.thingName,
      cert: Buffer.from(this.credentials.certificatePem, 'utf8'),
      key: Buffer.from(this.credentials.privateKey, 'utf8'),
      reconnectPeriod: 0,
    });
    this.client = client;

    const onMessage = (topic: string, payload: Buffer): void => {
      const dps = parseDpsMessage(payload);
      if (dps === undefined) {
        log.debug(`Ignoring non-dps message on ${topic}`);
        return;
      }
      for (const handler of this.handlers) {
        handler(dps);
      }
    };
    client.on('message', onMessage);
    this.detach.push(() => client.off('message', onMessage));

    // Until the first CONNACK, failures belong to the caller of open(); after
    // it, they are handled here by the backoff loop.
    await new Promise<void>((resolve, reject) => {
      let pending = true;

      const onConnect = (): void => {
        pending = false;
        this.connected = true;
        // A broker that accepts and then drops us must not reset the backoff,
        // or a rejected subscription becomes a one-per-second reconnect loop.
        this.stableTimer = setTimeout(() => {
          this.backoffMs = INITIAL_BACKOFF_MS;
        }, STABLE_CONNECTION_MS);
        this.stableTimer.unref?.();
        log.info(`MQTT connected for ${deviceId}`);
        for (const topic of this.subscribeTopics()) {
          client.subscribe(topic);
          log.debug(`Subscribed to ${topic}`);
        }
        resolve();
      };

      const onError = (error: Error): void => {
        this.connected = false;
        log.error(`MQTT error for ${deviceId}: ${error.message}`);
        if (pending) {
          pending = false;
          reject(error);
          return;
        }
        this.scheduleRetry(isCertificateRejection(error));
      };

      const onClose = (): void => {
        this.connected = false;
        this.clearStableTimer();
        if (pending || this.stopped) {
          return;
        }
        log.warn(`MQTT connection to ${deviceId} closed`);
        this.scheduleRetry(false);
      };

      client.on('connect', onConnect);
      client.on('error', onError);
      client.on('close', onClose);
      this.detach.push(() => {
        client.off('connect', onConnect);
        client.off('error', onError);
        client.off('close', onClose);
      });
    });
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  private scheduleRetry(refreshCredentials: boolean): void {
    if (this.stopped || this.retryTimer !== undefined) {
      return;
    }

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.options.log.info(`Reconnecting to MQTT for ${this.options.deviceId} in ${delay}ms`);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retry(refreshCredentials);
    }, delay);
    this.retryTimer.unref?.();
  }

  private async retry(refreshCredentials: boolean): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      if (refreshCredentials) {
        this.options.log.info('Broker rejected the client certificate, logging in again');
        this.credentials = await this.options.refreshCredentials();
      }
      await this.open();
    } catch (error) {
      this.options.log.error(
        `MQTT reconnect failed for ${this.options.deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.scheduleRetry(error instanceof Error && isCertificateRejection(error));
    }
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    if (client === undefined) {
      return;
    }
    this.client = undefined;
    this.connected = false;
    this.clearStableTimer();
    for (const detach of this.detach) {
      detach();
    }
    this.detach = [];
    // Our own 'error' listener is gone, and mqtt.js re-emits socket errors on
    // the client during teardown; without one, Node throws ERR_UNHANDLED_ERROR.
    const swallow = (): void => {};
    client.on('error', swallow);
    await new Promise<void>((resolve) => client.end(true, {}, resolve));
    client.off('error', swallow);
  }

  /** `android-<app>-eufy_android_<openudid>_<userId>`, exactly as the app sends it. */
  private sessionId(): string {
    const { appName, userId } = this.credentials;
    return `android-${appName}-eufy_android_${this.options.openudid}_${userId}`;
  }

  private subscribeTopics(): string[] {
    return [this.commandTopic('res'), `smart/mb/in/${this.options.deviceId}`];
  }

  private publishTopics(): string[] {
    return [this.commandTopic('req'), `smart/mb/out/${this.options.deviceId}`];
  }

  private commandTopic(suffix: 'req' | 'res'): string {
    return `cmd/eufy_home/${this.options.model}/${this.options.deviceId}/${suffix}`;
  }
}

const defaultConnect: MqttConnectFn = (url, options) => mqtt.connect(url, options);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** AWS IoT closes the socket with a TLS alert rather than a CONNACK refusal. */
const isCertificateRejection = (error: Error): boolean =>
  /certificate|handshake|unauthorized|not authorized|ECONNRESET/i.test(error.message);
