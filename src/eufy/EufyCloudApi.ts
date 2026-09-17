import { createHash } from 'node:crypto';

import type { DeviceConnection, EufyDeviceInfo, EufySession, Logger, MqttCredentials } from './types';

const HOME_API = 'https://home-api.eufylife.com';
const API = 'https://api.eufylife.com';
const AIOT_API = 'https://aiot-clean-api-pr.eufylife.com';

const USER_AGENT = 'EufyHome-Android-3.1.3-753';

/**
 * Eufy accepts two app identities. The unified "Eufy" app (v2) is tried first;
 * accounts still on the legacy "Eufy Clean" app only answer on v1.
 */
const LOGIN_TARGETS = [
  {
    label: 'v2 (Eufy app)',
    url: `${HOME_API}/v1/user/v2/email/login`,
    clientId: 'eufy-app',
    clientSecret: '8FHf22gaTKu7MZXqz5zytw',
    category: 'Health',
  },
  {
    label: 'v1 (Eufy Clean app)',
    url: `${HOME_API}/v1/user/email/login`,
    clientId: 'eufyhome-app',
    clientSecret: 'GQCpr9dSp3uQpsOMgJ4xQ',
    category: 'Home',
  },
] as const;

interface LoginResponse {
  access_token?: string;
  user_id?: string;
}

interface UserCenterInfo {
  user_center_id?: string;
  user_center_token?: string;
}

interface MqttInfoResponse {
  data?: {
    endpoint_addr?: string;
    thing_name?: string;
    certificate_pem?: string;
    private_key?: string;
    user_id?: string;
    app_name?: string;
  };
}

/** /v1/device/v2 entry. Carries the human-facing name and the product code. */
interface CloudDevice {
  id?: string;
  name?: string;
  alias_name?: string;
  device_name?: string;
  device_model?: string;
  dps?: Record<string, unknown>;
  /** 2 means Tuya-connected. */
  connect_type?: number;
  product?: { product_code?: string; name?: string; tuya_pid?: string };
}

/**
 * Outcome of a device-list lookup. `lookupFailed` separates "this account has
 * no vacuums" from "Eufy did not answer", so callers never treat an outage as
 * a device that has gone away.
 */
export interface DeviceListing {
  devices: EufyDeviceInfo[];
  lookupFailed: boolean;
}

/** devicerelation entry, the MQTT-capable ("novel API") device list. */
interface AiotDevice {
  device_sn?: string;
  device_model?: string;
  alias_name?: string;
  device_name?: string;
  dps?: Record<string, unknown>;
}

/**
 * connect_type 2 is Eufy's per-device marker for Tuya onboarding. The product's
 * tuya_pid is not used: it describes the model, not how this unit connects.
 */
const isTuyaConnected = (device: CloudDevice): boolean => device.connect_type === 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** Eufy wraps some responses in `{ data: ... }` and returns others bare. */
const unwrap = (body: unknown): Record<string, unknown> => {
  if (!isRecord(body)) {
    return {};
  }
  return isRecord(body.data) ? body.data : body;
};

/**
 * HTTP client for Eufy's cloud: email login, user-centre token, MQTT
 * certificate bundle and the device list. Ported from eufy-clean's EufyApi and
 * Login controllers; the header sets are reproduced verbatim because these
 * endpoints reject requests that deviate from the Android app's.
 */
export class EufyCloudApi {
  private accessToken?: string;
  private userCenterToken?: string;
  private gtoken?: string;
  private cloudDevices: CloudDevice[] = [];
  /** Set by the device-list getters when a request failed rather than came back empty. */
  private lookupFailed = false;

  constructor(
    private readonly email: string,
    private readonly password: string,
    /** Stable per-install device id; a new one would fight the phone app's session. */
    private readonly openudid: string,
    private readonly log: Logger,
  ) {}

  /**
   * Runs the whole login chain per app identity. A v2 login can succeed while
   * its user-centre token is rejected by the AIOT endpoints ("token error"),
   * so falling back only on a failed login is not enough.
   */
  async login(): Promise<EufySession> {
    const failures: string[] = [];

    for (const target of LOGIN_TARGETS) {
      this.log.debug(`Attempting ${target.label} login`);
      try {
        const session = await this.authenticate(target);
        this.accessToken = session.access_token;
        await this.loadUserCentre();
        const mqtt = await this.getMqttCredentials();
        this.log.debug(`${target.label} login successful`);
        return { accessToken: session.access_token, userId: session.user_id, mqtt };
      } catch (error) {
        failures.push(`${target.label}: ${describeError(error)}`);
      }
    }

    throw new Error(`Eufy login failed (${failures.join('; ')})`);
  }

  /**
   * Devices from the devicerelation (AIOT) endpoint are MQTT devices. A cloud
   * device missing from it is either Tuya-connected (connect_type 2 / a Tuya
   * product id) or, per eufy-clean, an MQTT device Eufy periodically omits
   * from devicerelation for accounts registered through the modern app.
   */
  async listDevices(): Promise<DeviceListing> {
    this.lookupFailed = false;
    this.cloudDevices = await this.getCloudDeviceList();

    const aiotDevices = await this.getAiotDeviceList();
    const aiotIds = new Set(aiotDevices.map((device) => device.device_sn));
    const cloudOnly = this.cloudDevices.filter(
      (device): device is CloudDevice & { id: string } => typeof device.id === 'string' && !aiotIds.has(device.id),
    );

    return {
      devices: [
        ...aiotDevices.map((device) => this.describe(device, 'mqtt')),
        ...cloudOnly.map((device) =>
          this.describe({ device_sn: device.id, dps: device.dps }, isTuyaConnected(device) ? 'tuya' : 'mqtt'),
        ),
      ].filter((device): device is EufyDeviceInfo => device !== undefined),
      lookupFailed: this.lookupFailed,
    };
  }

  private describe(device: AiotDevice, connection: DeviceConnection): EufyDeviceInfo | undefined {
    const deviceId = device.device_sn;
    if (deviceId === undefined) {
      return undefined;
    }

    const cloud = this.cloudDevices.find((candidate) => candidate.id === deviceId);
    const model = (
      cloud?.product?.product_code ??
      cloud?.device_model ??
      device.device_model ??
      ''
    ).substring(0, 5);

    if (model === '') {
      this.log.warn(`Skipping device ${deviceId}: no model code in either device list`);
      return undefined;
    }

    const name =
      cloud?.alias_name ??
      cloud?.device_name ??
      cloud?.name ??
      device.alias_name ??
      device.device_name ??
      'Eufy Robovac';

    return { deviceId, model, name, connection, dps: device.dps ?? {} };
  }

  private async authenticate(
    target: (typeof LOGIN_TARGETS)[number],
  ): Promise<{ access_token: string; user_id: string }> {
    const body = await this.request<LoginResponse>(target.url, {
      method: 'POST',
      headers: {
        category: target.category,
        Accept: '*/*',
        openudid: this.openudid,
        'Accept-Language': 'nl-NL;q=1, uk-DE;q=0.9, en-NL;q=0.8',
        'Content-Type': 'application/json',
        clientType: '1',
        language: 'nl',
        'User-Agent': USER_AGENT,
        timezone: 'Europe/Berlin',
        country: 'NL',
        Connection: 'keep-alive',
      },
      body: JSON.stringify({
        email: this.email,
        password: this.password,
        client_id: target.clientId,
        client_secret: target.clientSecret,
      }),
    });

    if (body.access_token === undefined || body.user_id === undefined) {
      throw new Error('no access token in response');
    }
    return { access_token: body.access_token, user_id: body.user_id };
  }

  /**
   * The AIOT endpoints authenticate with the user-centre token plus a gtoken,
   * which is the md5 of the user-centre id.
   */
  private async loadUserCentre(): Promise<void> {
    const info = await this.request<UserCenterInfo>(`${API}/v1/user/user_center_info`, {
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'user-agent': USER_AGENT,
        timezone: 'Europe/Berlin',
        category: 'Home',
        token: this.requireAccessToken(),
        openudid: this.openudid,
        clienttype: '2',
        language: 'de',
        country: 'DE',
      },
    });

    if (info.user_center_id === undefined || info.user_center_token === undefined) {
      throw new Error('Eufy user_center_info returned no user centre id or token');
    }

    this.userCenterToken = info.user_center_token;
    this.gtoken = createHash('md5').update(info.user_center_id).digest('hex');
  }

  private async getMqttCredentials(): Promise<MqttCredentials> {
    const body = await this.request<MqttInfoResponse>(
      `${AIOT_API}/app/devicemanage/get_user_mqtt_info`,
      { method: 'POST', headers: this.aiotHeaders() },
    );

    const data = body.data;
    if (
      data?.endpoint_addr === undefined ||
      data.thing_name === undefined ||
      data.certificate_pem === undefined ||
      data.private_key === undefined ||
      data.user_id === undefined ||
      data.app_name === undefined
    ) {
      throw new Error('Eufy get_user_mqtt_info returned an incomplete credential bundle');
    }

    return {
      endpointAddr: data.endpoint_addr,
      thingName: data.thing_name,
      certificatePem: data.certificate_pem,
      privateKey: data.private_key,
      userId: data.user_id,
      appName: data.app_name,
    };
  }

  private async getAiotDeviceList(): Promise<AiotDevice[]> {
    try {
      const body = await this.request<unknown>(`${AIOT_API}/app/devicerelation/get_device_list`, {
        method: 'POST',
        headers: { ...this.aiotHeaders(), 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ attribute: 3 }),
      });

      const devices = asArray<{ device?: AiotDevice }>(unwrap(body).devices)
        .map((entry) => entry.device)
        .filter((device): device is AiotDevice => device !== undefined);
      if (devices.length === 0) {
        // An empty list usually carries a code/msg explaining why (ownership, region).
        this.log.debug(`devicerelation returned no devices: ${JSON.stringify(body).slice(0, 500)}`);
      }
      return devices;
    } catch (error) {
      this.lookupFailed = true;
      this.log.warn(`devicerelation device list failed: ${describeError(error)}`);
      return [];
    }
  }

  private async getCloudDeviceList(): Promise<CloudDevice[]> {
    try {
      const data = unwrap(
        await this.request<unknown>(`${API}/v1/device/v2`, {
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'user-agent': USER_AGENT,
            timezone: 'Europe/Berlin',
            category: 'Home',
            token: this.requireAccessToken(),
            openudid: this.openudid,
            clienttype: '2',
            language: 'nl',
            country: 'NL',
          },
        }),
      );

      const devices = asArray<CloudDevice>(data.devices);
      for (const device of devices) {
        this.log.debug(
          `cloud device ${device.id ?? '?'}: model ${device.product?.product_code ?? '?'}, `
          + `connect_type ${device.connect_type ?? '?'}, tuya_pid ${device.product?.tuya_pid || 'none'}`,
        );
      }
      if (devices.length > 0) {
        return devices;
      }
    } catch (error) {
      this.lookupFailed = true;
      this.log.warn(`cloud device list failed: ${describeError(error)}`);
    }

    return this.getHouseDeviceList();
  }

  /** home-api list used by the unified Eufy app. Best effort; shape varies. */
  private async getHouseDeviceList(): Promise<CloudDevice[]> {
    try {
      const body = await this.request<unknown>(`${AIOT_API}/app/house/get_devs_list`, {
        headers: {
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
          token: this.requireAccessToken(),
          openudid: this.openudid,
        },
      });

      const data = unwrap(body);
      return asArray<CloudDevice>(data.devices ?? body);
    } catch (error) {
      this.lookupFailed = true;
      this.log.warn(`home-api device list failed: ${describeError(error)}`);
      return [];
    }
  }

  private aiotHeaders(): Record<string, string> {
    if (this.userCenterToken === undefined || this.gtoken === undefined) {
      throw new Error('Not logged in: call login() before using the AIOT endpoints');
    }

    return {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      timezone: 'Europe/Berlin',
      openudid: this.openudid,
      language: 'de',
      country: 'DE',
      'os-version': 'Android',
      'model-type': 'PHONE',
      'app-name': 'eufy_home',
      'x-auth-token': this.userCenterToken,
      gtoken: this.gtoken,
    };
  }

  private requireAccessToken(): string {
    if (this.accessToken === undefined) {
      throw new Error('Not logged in: call login() first');
    }
    return this.accessToken;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      // Eufy explains most rejections (expired token, wrong region) in the body.
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`${init.method ?? 'GET'} ${url} returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
