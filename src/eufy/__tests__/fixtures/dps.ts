/**
 * Synthetic dps payloads: base64 protobuf produced by encoding known values
 * with src/eufy/codec.ts, not captured from a device.
 *
 * Real device frames live in TUYA_CAPTURE at the bottom of this file; add
 * captures there as more states are observed.
 */
export const WORK_STATUS = {
  charging: 'CgoCCAAQAxoCCAA=',
  chargingDone: 'CgoCCAAQAxoCCAE=',
  cleaningRooms: 'CgoCCAEQBTICCAA=',
  goHome: 'CgoCCAAQB0ICCAA=',
  cleaningPaused: 'BhAFMgIIAQ==',
} as const;

export const ERROR_CODE = {
  none: 'AA==',
  wheelStuck: 'AxIBAg==',
  warnOnly: 'AxoBRg==',
} as const;

export const CLEAN_PARAM_RESPONSE = {
  turbo: 'CAoGMgIIAjgB',
  maxPlus: 'BiIEMgIIBA==',
} as const;

export const MODE_CTRL_REQUEST = {
  startAutoClean: 'CAgAEAEaAggB',
} as const;

/**
 * Real frames captured from an L60 SES (T2277, firmware 1.4.5) over the Tuya
 * cloud with `discover --dump`. Identifying dps (169: device info with MAC and
 * account id) are left out; the rest is verbatim.
 */
export const TUYA_CAPTURE = {
  chargingDone: {
    '152': 'AhBl',
    '153': 'BhADGgIIAQ==',
    '154': 'DgoKCgAaAggBIgIIARIA',
    '158': 'Standard',
    '163': 100,
    '177': 'DAiB++b/pZDyzgFSAA==',
  },
  goHome: {
    '152': 'AA==',
    '153': 'BBAHQgA=',
    '154': 'DgoKCgAaAggBIgIIARIA',
    '158': 'Standard',
    '163': 100,
    '177': 'DAjny8GS/P3yzgFSAA==',
  },
} as const;
