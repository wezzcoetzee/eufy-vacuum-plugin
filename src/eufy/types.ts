/**
 * Shared contract for the Eufy protocol layer. Nothing outside this file
 * should invent its own shape for MQTT credentials, device info or vacuum
 * state — implementers of src/eufy/* and src/accessories/* code against
 * these types so the three layers (protocol, EufyVacuum, Matter) stay
 * independently testable.
 */

/** Structured logger passed in by Homebridge; nothing may call console directly. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Per-account AWS IoT MQTT credentials returned by Eufy's
 * `/v1/user/mqtt_info` endpoint (see EufyApi.getMqttCredentials in
 * /tmp/eufy-clean/src/api/EufyApi.ts).
 */
export interface MqttCredentials {
  endpointAddr: string;
  thingName: string;
  certificatePem: string;
  privateKey: string;
  userId: string;
  appName: string;
}

/** Combined result of EufyApi.login(): HTTP session, user info and MQTT credentials. */
export interface EufySession {
  accessToken: string;
  userId: string;
  mqtt: MqttCredentials;
}

export type DeviceConnection = 'mqtt' | 'tuya';

/** One entry from the Eufy device list, merged with its last known dps snapshot. */
export interface EufyDeviceInfo {
  /** device_sn */
  deviceId: string;
  /** e.g. T2277 */
  model: string;
  name: string;
  /**
   * How commands reach the device. Both carry the same novel-API protobuf dps:
   * `mqtt` is Eufy's AWS IoT broker, `tuya` is Tuya's mobile cloud, used by
   * vacuums Eufy onboarded through Tuya (connect_type 2). A Tuya device ignores
   * MQTT publishes without any error, so this must never be guessed wrong.
   */
  connection: DeviceConnection;
  dps: Record<string, unknown>;
}

/**
 * Normalised vacuum status, derived from proto.cloud.WorkStatus.State
 * (proto/cloud/work_status.proto) plus the charging/go-home sub-messages.
 */
export type VacuumStatus =
  | 'standby'
  | 'sleep'
  | 'fault'
  | 'charging'
  | 'fast_mapping'
  | 'cleaning'
  | 'remote_ctrl'
  | 'go_home'
  | 'cruising';

/** proto.cloud.WorkStatus.Mode.Value */
export type VacuumMode =
  | 'auto'
  | 'select_room'
  | 'select_zone'
  | 'spot'
  | 'fast_mapping'
  | 'global_cruise'
  | 'zones_cruise'
  | 'point_cruise'
  | 'scene'
  | 'smart_follow';

export type CleanSpeed = 'quiet' | 'standard' | 'turbo' | 'max';

export interface VacuumState {
  status: VacuumStatus;
  /** The vacuum is mid-task but halted: WorkStatus.cleaning/go_home state PAUSED. */
  paused: boolean;
  mode: VacuumMode;
  battery: number;
  charging: boolean;
  docked: boolean;
  errorCode: number;
  cleanSpeed: CleanSpeed;
}

/** Names of the control.proto ModeCtrlRequest commands this plugin issues. */
export type VacuumCommandName =
  | 'START_AUTO_CLEAN'
  | 'PAUSE_TASK'
  | 'RESUME_TASK'
  | 'STOP_TASK'
  | 'START_GOHOME'
  | 'START_SPOT_CLEAN'
  | 'START_SELECT_ROOMS_CLEAN'
  | 'START_SCENE_CLEAN';

/** Novel-API dps key map (dp id as string), mirroring Base.ts novelDPSMap. */
export interface DpsMap {
  readonly PLAY_PAUSE: string;
  readonly WORK_STATUS: string;
  readonly CLEANING_PARAMETERS: string;
  readonly CLEANING_STATISTICS: string;
  readonly ACCESSORIES_STATUS: string;
  readonly GO_HOME: string;
  readonly CLEAN_SPEED: string;
  readonly FIND_ROBOT: string;
  readonly BATTERY_LEVEL: string;
  readonly ERROR_CODE: string;
}

export type DpsValue = string | number | boolean;

/** Transport for a single device (MQTT or Tuya cloud): raw dps in, raw dps out. */
export interface VacuumTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendDps(dps: Record<string, DpsValue>): Promise<void>;
  onDps(handler: (dps: Record<string, unknown>) => void): void;
}

/** Typed façade over a single vacuum's state and commands. */
export interface VacuumController {
  readonly state: VacuumState;
  /** Feed a raw dps frame in from outside the transport, e.g. a cloud poll. */
  applyDps(dps: Record<string, unknown>): void;
  on(event: 'change', handler: (state: VacuumState) => void): void;

  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  dock(): Promise<void>;
  locate(): Promise<void>;
  setCleanSpeed(speed: CleanSpeed): Promise<void>;
  cleanRooms(roomIds: number[]): Promise<void>;
  cleanScene(sceneId: number): Promise<void>;
}
