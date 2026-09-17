import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { DpsValue, Logger } from './types';

/**
 * Eufy's Android app credentials for Tuya's mobile API, as used by eufy-clean.
 * Requests are signed with HMAC-SHA256 keyed on `certSign_secret2_secret`.
 */
const CLIENT_ID = 'yx5v9uc3ef9wg3v9atje';
const HMAC_KEY = 'A_cepev5pfnhua4dkqkdpmnrdxx378mpjr_s8x78u7xwymasd9kqa7a73pjhxqsedaj';

/** Fixed AES key/iv the app uses to derive the uid "password". */
const UID_AES_KEY = Buffer.from([36, 78, 109, 138, 86, 172, 135, 145, 36, 67, 45, 139, 108, 188, 162, 196]);
const UID_AES_IV = Buffer.from([119, 36, 86, 242, 167, 102, 76, 243, 57, 44, 53, 151, 233, 62, 87, 71]);

export const TUYA_REGIONS = {
  EU: 'https://a1.tuyaeu.com/api.json',
  US: 'https://a1.tuyaus.com/api.json',
} as const;

export type TuyaRegion = keyof typeof TUYA_REGIONS;

/** Only these request params take part in the signature, in sorted-key order. */
const SIGNED_KEYS = new Set([
  'a', 'v', 'lat', 'lon', 'lang', 'deviceId', 'imei', 'imsi', 'appVersion', 'ttid', 'isH5',
  'h5Token', 'os', 'clientId', 'postData', 'time', 'requestId', 'n4h5', 'sid', 'sp', 'et',
]);

export interface TuyaDevice {
  devId: string;
  name?: string;
  productId?: string;
  dps?: Record<string, DpsValue>;
}

interface TuyaResponse<T> {
  success?: boolean;
  errorCode?: string;
  errorMsg?: string;
  result?: T;
}

interface LoginToken {
  token: string;
  publicKey: string;
  exponent: string;
}

interface LoginResult {
  sid: string;
  domain?: { mobileApiUrl?: string; regionCode?: string };
}

export class TuyaRequestError extends Error {
  constructor(
    action: string,
    readonly code: string,
    detail?: string,
  ) {
    super(`Tuya ${action} failed: ${code}${detail ? ` ${detail}` : ''}`);
  }
}

const md5 = (data: string): string => createHash('md5').update(data).digest('hex');

/** Tuya's reordered md5, used to hash postData before signing. */
const mobileHash = (data: string): string => {
  const hash = md5(data);
  return hash.slice(8, 16) + hash.slice(0, 8) + hash.slice(24, 32) + hash.slice(16, 24);
};

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
  let result = 1n;
  let b = base % modulus;
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
  }
  return result;
};

/**
 * Raw ("no padding") RSA, which node:crypto refuses for short messages: the
 * app left-pads with zeros to the modulus size, which is numerically a no-op.
 * Tuya sends the modulus as a decimal string.
 */
const rsaNoPadding = (message: Buffer, modulusDecimal: string, exponent: bigint): string => {
  const modulus = BigInt(modulusDecimal);
  const cipher = modPow(BigInt(`0x${message.toString('hex')}`), exponent, modulus);
  return cipher.toString(16).padStart(Math.ceil(modulus.toString(16).length / 2) * 2, '0');
};

/**
 * Tuya mobile-cloud client for Eufy vacuums that are Tuya-connected
 * (`connect_type: 2`, no entry in the AIOT devicerelation list). These never
 * see commands published to Eufy's MQTT broker. Ported from eufy-clean's
 * TuyaCloudApi and lib/TuyaCloud, trimmed to login, device list and publish.
 */
export class TuyaCloudApi {
  private readonly deviceId = randomBytes(22).toString('hex');
  private endpoint: string;
  private sid?: string;

  constructor(
    private readonly eufyUserId: string,
    private readonly region: TuyaRegion,
    private readonly log: Logger,
  ) {
    this.endpoint = TUYA_REGIONS[region];
  }

  /** Logs in on the first region that accepts the account (EU, then US). */
  static async connect(eufyUserId: string, log: Logger): Promise<TuyaCloudApi> {
    const failures: string[] = [];
    for (const region of Object.keys(TUYA_REGIONS) as TuyaRegion[]) {
      const api = new TuyaCloudApi(eufyUserId, region, log);
      try {
        await api.login();
        return api;
      } catch (error) {
        failures.push(`${region}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Tuya cloud login failed (${failures.join('; ')})`);
  }

  /** Logs in as `eh-<eufy user id>`; no Tuya password exists, it is derived. */
  async login(): Promise<void> {
    const uid = `eh-${this.eufyUserId}`;
    const token = await this.request<LoginToken>('tuya.m.user.uid.token.create', {
      data: { countryCode: this.region, uid },
    });

    const cipher = createCipheriv('aes-128-cbc', UID_AES_KEY, UID_AES_IV);
    const padded = uid.padStart(16 * Math.ceil(uid.length / 16), '0');
    // Matches the app: only update(), the block-aligned input needs no final().
    const encryptedUid = cipher.update(padded, 'utf8', 'hex').toUpperCase();
    const passwd = rsaNoPadding(Buffer.from(md5(encryptedUid)), token.publicKey, BigInt(token.exponent));

    const result = await this.request<LoginResult>('tuya.m.user.uid.password.login', {
      data: {
        countryCode: this.region,
        uid,
        createGroup: true,
        passwd,
        ifencrypt: 1,
        options: { group: 1 },
        token: token.token,
      },
    });

    // The session is only valid on the endpoint the login response names.
    if (result.domain?.mobileApiUrl !== undefined) {
      this.endpoint = `${result.domain.mobileApiUrl}/api.json`;
    }
    this.sid = result.sid;
    this.log.debug(`Tuya ${this.region} login successful (endpoint ${this.endpoint})`);
  }

  listDevices(): Promise<TuyaDevice[]> {
    return this.withSession(async () => {
      const groups = await this.request<Array<{ groupId: number }>>('tuya.m.location.list');
      const shared = await this.request<TuyaDevice[]>('tuya.m.my.shared.device.list');
      const owned = await Promise.all(
        groups.map((group) =>
          this.request<TuyaDevice[]>('tuya.m.my.group.device.list', { gid: String(group.groupId) }),
        ),
      );
      return [...owned.flat(), ...shared];
    });
  }

  async sendDps(deviceId: string, dps: Record<string, DpsValue>): Promise<void> {
    await this.withSession(() =>
      this.request('tuya.m.device.dp.publish', { data: { devId: deviceId, gwId: deviceId, dps } }),
    );
  }

  /** Sessions expire after a while; log in again once and retry. */
  private async withSession<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TuyaRequestError) || !/SESSION/i.test(error.code)) throw error;
      this.log.info('Tuya cloud session expired, logging in again');
      await this.login();
      return operation();
    }
  }

  private async request<T>(action: string, options: { data?: object; gid?: string } = {}): Promise<T> {
    const loggingIn = action.startsWith('tuya.m.user.uid.');
    if (!loggingIn && this.sid === undefined) {
      throw new Error('Not logged in: call login() first');
    }

    const params: Record<string, string> = {
      a: action,
      deviceId: this.deviceId,
      sdkVersion: '3.0.0cAnker',
      os: 'Android',
      lang: 'en',
      v: '1.0',
      clientId: CLIENT_ID,
      time: String(Math.round(Date.now() / 1000)),
      et: '0.0.1',
      ttid: 'android',
      appVersion: '3.8.5',
      appRnVersion: '5.11',
      platform: 'Android',
      requestId: randomUUID(),
    };
    if (options.data !== undefined) params.postData = JSON.stringify(options.data);
    if (options.gid !== undefined) params.gid = options.gid;
    if (!loggingIn && this.sid !== undefined) params.sid = this.sid;

    const toSign = Object.keys(params)
      .sort()
      .filter((key) => SIGNED_KEYS.has(key) && params[key] !== '')
      .map((key) => `${key}=${key === 'postData' ? mobileHash(params[key]) : params[key]}`)
      .join('||');
    params.sign = createHmac('sha256', HMAC_KEY).update(toSign).digest('hex');

    const response = await fetch(`${this.endpoint}?${new URLSearchParams(params).toString()}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as TuyaResponse<T>;
    if (body.success === false || body.result === undefined) {
      throw new TuyaRequestError(action, body.errorCode ?? String(response.status), body.errorMsg);
    }
    return body.result;
  }
}
