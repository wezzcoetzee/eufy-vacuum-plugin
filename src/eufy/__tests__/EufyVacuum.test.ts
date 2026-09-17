import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decode } from '../codec';
import { NOVEL_DPS, mapDpsToState } from '../dps';
import { EufyVacuum } from '../EufyVacuum';
import type { DpsValue, EufyDeviceInfo, Logger, VacuumState, VacuumTransport } from '../types';
import { CLEAN_PARAM_RESPONSE, ERROR_CODE, TUYA_CAPTURE, WORK_STATUS } from './fixtures/dps';

const device: EufyDeviceInfo = { deviceId: 'T2277TEST', model: 'T2277', name: 'Test Vacuum', connection: 'mqtt', dps: {} };

const silentLog: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function createTransport() {
  const sent: Array<Record<string, DpsValue>> = [];
  let push: (dps: Record<string, unknown>) => void = () => {};

  const transport: VacuumTransport = {
    connect: async () => {},
    disconnect: async () => {},
    sendDps: async (dps) => {
      sent.push(dps);
    },
    onDps: (handler) => {
      push = handler;
    },
  };

  return { transport, sent, push: (dps: Record<string, unknown>) => push(dps) };
}

function lastCommand(sent: Array<Record<string, DpsValue>>) {
  const value = sent[sent.length - 1]?.[NOVEL_DPS.PLAY_PAUSE];
  if (typeof value !== 'string') throw new Error('expected an encoded command on dp 152');
  return decode('ModeCtrlRequest', value);
}

describe('mapDpsToState', () => {
  it('derives charging and docked from WorkStatus', () => {
    expect(mapDpsToState({ [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.charging })).toMatchObject({
      status: 'charging',
      docked: true,
      charging: true,
      mode: 'auto',
    });

    expect(mapDpsToState({ [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.chargingDone })).toMatchObject({
      docked: true,
      charging: false,
    });

    expect(mapDpsToState({ [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.cleaningRooms })).toMatchObject({
      status: 'cleaning',
      mode: 'select_room',
      docked: false,
      charging: false,
    });

    expect(mapDpsToState({ [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.goHome }).status).toBe('go_home');

    expect(mapDpsToState({ [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.cleaningPaused })).toMatchObject({
      status: 'cleaning',
      paused: true,
    });
    expect(mapDpsToState({ [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.cleaningRooms }).paused).toBe(false);
  });

  it('only reports the points present in the frame', () => {
    expect(mapDpsToState({ [NOVEL_DPS.BATTERY_LEVEL]: 42 })).toEqual({ battery: 42 });
    expect(mapDpsToState({})).toEqual({});
  });

  it('prefers the clean param suction over the dp 158 index', () => {
    expect(mapDpsToState({ [NOVEL_DPS.CLEAN_SPEED]: 0 }).cleanSpeed).toBe('quiet');
    expect(
      mapDpsToState({
        [NOVEL_DPS.CLEAN_SPEED]: 0,
        [NOVEL_DPS.CLEANING_PARAMETERS]: CLEAN_PARAM_RESPONSE.turbo,
      }).cleanSpeed,
    ).toBe('turbo');
    expect(
      mapDpsToState({ [NOVEL_DPS.CLEANING_PARAMETERS]: CLEAN_PARAM_RESPONSE.maxPlus }).cleanSpeed,
    ).toBe('max');
  });

  it('handles both error code encodings', () => {
    expect(mapDpsToState({ [NOVEL_DPS.ERROR_CODE]: ERROR_CODE.wheelStuck }).errorCode).toBe(2);
    // Warnings ("clean the dust collector") are advisories, not faults.
    expect(mapDpsToState({ [NOVEL_DPS.ERROR_CODE]: ERROR_CODE.warnOnly }).errorCode).toBe(0);
    expect(mapDpsToState({ [NOVEL_DPS.ERROR_CODE]: ERROR_CODE.none }).errorCode).toBe(0);
    // Firmware quirk: a bare negative integer instead of a base64 message.
    expect(mapDpsToState({ [NOVEL_DPS.ERROR_CODE]: -2147483647 }).errorCode).toBe(0);
    expect(mapDpsToState({ [NOVEL_DPS.ERROR_CODE]: 21 }).errorCode).toBe(21);
  });
});

describe('EufyVacuum', () => {
  let harness: ReturnType<typeof createTransport>;
  let vacuum: EufyVacuum;

  beforeEach(() => {
    harness = createTransport();
    vacuum = new EufyVacuum(harness.transport, device, silentLog);
  });

  it('seeds its state from the device list snapshot', () => {
    const seeded = new EufyVacuum(
      createTransport().transport,
      { ...device, dps: { [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.charging, [NOVEL_DPS.BATTERY_LEVEL]: 64 } },
      silentLog,
    );

    expect(seeded.state).toMatchObject({ status: 'charging', charging: true, battery: 64 });
  });

  it('encodes each command onto dp 152', async () => {
    await vacuum.start();
    expect(lastCommand(harness.sent)).toMatchObject({
      method: 'START_AUTO_CLEAN',
      autoClean: { cleanTimes: 1 },
    });

    await vacuum.pause();
    expect(lastCommand(harness.sent).method).toBe('PAUSE_TASK');

    await vacuum.resume();
    expect(lastCommand(harness.sent).method).toBe('RESUME_TASK');

    await vacuum.stop();
    expect(lastCommand(harness.sent).method).toBe('STOP_TASK');

    await vacuum.dock();
    expect(lastCommand(harness.sent).method).toBe('START_GOHOME');
  });

  it('offsets scene ids by three and stops first', async () => {
    await vacuum.cleanScene(1);

    expect(harness.sent).toHaveLength(2);
    expect(lastCommand(harness.sent)).toMatchObject({
      method: 'START_SCENE_CLEAN',
      sceneClean: { sceneId: 4 },
    });
  });

  it('sends room ids with a cleaning order', async () => {
    await vacuum.cleanRooms([5, 2]);

    expect(lastCommand(harness.sent)).toMatchObject({
      method: 'START_SELECT_ROOMS_CLEAN',
      selectRoomsClean: {
        rooms: [
          { id: 5, order: 1 },
          { id: 2, order: 2 },
        ],
      },
    });
  });

  it('writes plain dps for speed and locate', async () => {
    await vacuum.setCleanSpeed('max');
    expect(harness.sent.at(-1)).toEqual({ [NOVEL_DPS.CLEAN_SPEED]: 3 });

    await vacuum.locate();
    expect(harness.sent.at(-1)).toEqual({ [NOVEL_DPS.FIND_ROBOT]: true });
  });

  it('emits change only when state actually differs', () => {
    const changes: VacuumState[] = [];
    vacuum.on('change', (state) => changes.push(state));

    harness.push({ [NOVEL_DPS.BATTERY_LEVEL]: 80 });
    harness.push({ [NOVEL_DPS.BATTERY_LEVEL]: 80 });
    harness.push({ [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.charging });
    harness.push({ [NOVEL_DPS.WORK_STATUS]: WORK_STATUS.charging });

    expect(changes).toHaveLength(2);
    expect(vacuum.state).toMatchObject({ battery: 80, status: 'charging', charging: true });
  });
});

describe('real L60 SES frames', () => {
  it('maps a docked, fully charged vacuum', () => {
    expect(mapDpsToState(TUYA_CAPTURE.chargingDone)).toMatchObject({
      status: 'charging',
      docked: true,
      charging: false,
      battery: 100,
      errorCode: 0,
      cleanSpeed: 'standard',
    });
  });

  it('maps a vacuum returning to the dock', () => {
    expect(mapDpsToState(TUYA_CAPTURE.goHome)).toMatchObject({ status: 'go_home', docked: false, battery: 100 });
  });
});
