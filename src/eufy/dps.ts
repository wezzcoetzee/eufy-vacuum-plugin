/**
 * Novel-API data point map and the raw dps -> VacuumState projection.
 *
 * Everything here is pure: MQTT hands us an untyped record, this module turns
 * the parts we understand into a partial state patch and silently ignores the
 * rest (a dps frame usually carries only the points that changed).
 */
import { decode, type CleanParam, type CleanParamResponse } from './codec';
import type { CleanSpeed, DpsMap, VacuumMode, VacuumState, VacuumStatus } from './types';

export const NOVEL_DPS: DpsMap = {
  PLAY_PAUSE: '152',
  WORK_STATUS: '153',
  CLEANING_PARAMETERS: '154',
  CLEAN_SPEED: '158',
  FIND_ROBOT: '160',
  BATTERY_LEVEL: '163',
  CLEANING_STATISTICS: '167',
  ACCESSORIES_STATUS: '168',
  GO_HOME: '173',
  ERROR_CODE: '177',
};

/** Index order of dp 158, and of proto.cloud.Fan.Suction below MAX_PLUS. */
export const CLEAN_SPEEDS: readonly CleanSpeed[] = ['quiet', 'standard', 'turbo', 'max'];

const STATUS_BY_WORK_STATE: Record<string, VacuumStatus> = {
  STANDBY: 'standby',
  SLEEP: 'sleep',
  FAULT: 'fault',
  CHARGING: 'charging',
  FAST_MAPPING: 'fast_mapping',
  CLEANING: 'cleaning',
  REMOTE_CTRL: 'remote_ctrl',
  GO_HOME: 'go_home',
  CRUISIING: 'cruising',
};

const MODE_BY_WORK_MODE: Record<string, VacuumMode> = {
  AUTO: 'auto',
  SELECT_ROOM: 'select_room',
  SELECT_ZONE: 'select_zone',
  SPOT: 'spot',
  FAST_MAPPING: 'fast_mapping',
  GLOBAL_CRUISE: 'global_cruise',
  ZONES_CRUISE: 'zones_cruise',
  POINT_CRUISE: 'point_cruise',
  SCENE: 'scene',
  SMART_FOLLOW: 'smart_follow',
};

export const INITIAL_STATE: VacuumState = {
  status: 'standby',
  paused: false,
  mode: 'auto',
  battery: 0,
  charging: false,
  docked: false,
  errorCode: 0,
  cleanSpeed: 'standard',
};

/** MAX_PLUS has no distinct Matter clean mode; it collapses onto max. */
function speedFromSuction(suction: string | undefined): CleanSpeed | undefined {
  if (!suction) return undefined;
  if (suction === 'MAX_PLUS') return 'max';
  return CLEAN_SPEEDS.find((speed) => speed.toUpperCase() === suction);
}

/** dp 158 is an index into CLEAN_SPEEDS on some firmware and a name ("Standard") on others. */
function speedFromDp(value: unknown): CleanSpeed | undefined {
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    return CLEAN_SPEEDS.find((speed) => speed === value.toLowerCase());
  }
  const index = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(index) ? CLEAN_SPEEDS[index] : undefined;
}

function firstCleanParam(response: CleanParamResponse): CleanParam | undefined {
  return response.runningCleanParam ?? response.cleanParam ?? response.areaCleanParam;
}

/**
 * dp 177 is normally a base64 ErrorCode message, but some firmwares report a
 * bare integer instead — observed as -2147483647, which means "no error".
 *
 * Only ErrorCode.error counts: ErrorCode.warn carries routine advisories such
 * as "clean the dust collector", which must not stop the vacuum in Home.
 */
function readErrorCode(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return raw > 0 ? raw : 0;
  }
  if (typeof raw !== 'string') return undefined;
  const decoded = tryDecode(() => decode('ErrorCode', raw));
  if (!decoded) return undefined;
  return decoded.error?.[0] ?? 0;
}

function tryDecode<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Project a raw dps frame onto the fields of VacuumState it determines. */
export function mapDpsToState(dps: Record<string, unknown>): Partial<VacuumState> {
  const patch: Partial<VacuumState> = {};

  const workStatusRaw = dps[NOVEL_DPS.WORK_STATUS];
  if (typeof workStatusRaw === 'string') {
    const workStatus = tryDecode(() => decode('WorkStatus', workStatusRaw));
    const status = workStatus && STATUS_BY_WORK_STATE[workStatus.state ?? 'STANDBY'];
    if (workStatus && status) {
      patch.status = status;
      patch.paused = workStatus.cleaning?.state === 'PAUSED' || workStatus.goHome?.state === 'PAUSED';
      patch.docked = status === 'charging';
      // The charging sub-message is absent once the battery is full; when it is
      // present its default (omitted) state is DOING.
      patch.charging = patch.docked && (workStatus.charging?.state ?? 'DOING') === 'DOING';
      const mode = MODE_BY_WORK_MODE[workStatus.mode?.value ?? 'AUTO'];
      if (mode) patch.mode = mode;
    }
  }

  const battery = dps[NOVEL_DPS.BATTERY_LEVEL];
  if (typeof battery === 'number') {
    patch.battery = Math.max(0, Math.min(100, Math.round(battery)));
  }

  const cleanParamsRaw = dps[NOVEL_DPS.CLEANING_PARAMETERS];
  if (typeof cleanParamsRaw === 'string') {
    const response = tryDecode(() => decode('CleanParamResponse', cleanParamsRaw));
    const speed = response && speedFromSuction(firstCleanParam(response)?.fan?.suction);
    if (speed) patch.cleanSpeed = speed;
  }

  if (patch.cleanSpeed === undefined && NOVEL_DPS.CLEAN_SPEED in dps) {
    const speed = speedFromDp(dps[NOVEL_DPS.CLEAN_SPEED]);
    if (speed) patch.cleanSpeed = speed;
  }

  if (NOVEL_DPS.ERROR_CODE in dps) {
    const errorCode = readErrorCode(dps[NOVEL_DPS.ERROR_CODE]);
    if (errorCode !== undefined) patch.errorCode = errorCode;
  }

  return patch;
}
