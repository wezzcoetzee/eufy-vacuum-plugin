import { describe, expect, it } from 'vitest';
import { decode, encode } from '../codec';
import { CLEAN_PARAM_RESPONSE, ERROR_CODE, MODE_CTRL_REQUEST, WORK_STATUS } from './fixtures/dps';

describe('codec round-trips', () => {
  it('encodes a ModeCtrlRequest with its oneof param', () => {
    const value = encode('ModeCtrlRequest', {
      method: 'START_AUTO_CLEAN',
      seq: 1,
      autoClean: { cleanTimes: 1 },
    });

    expect(value).toBe(MODE_CTRL_REQUEST.startAutoClean);
    expect(decode('ModeCtrlRequest', value)).toMatchObject({
      method: 'START_AUTO_CLEAN',
      seq: 1,
      autoClean: { cleanTimes: 1 },
    });
  });

  it('encodes room ids into SelectRoomsClean', () => {
    const value = encode('ModeCtrlRequest', {
      method: 'START_SELECT_ROOMS_CLEAN',
      selectRoomsClean: { rooms: [{ id: 3, order: 1 }], cleanTimes: 1, mode: 'GENERAL' },
    });

    expect(decode('ModeCtrlRequest', value).selectRoomsClean?.rooms).toEqual([{ id: 3, order: 1 }]);
  });

  it('decodes WorkStatus enums as names', () => {
    expect(decode('WorkStatus', WORK_STATUS.cleaningRooms)).toMatchObject({
      state: 'CLEANING',
      mode: { value: 'SELECT_ROOM' },
      cleaning: { state: 'DOING' },
    });
    expect(decode('WorkStatus', WORK_STATUS.chargingDone).charging).toEqual({ state: 'DONE' });
  });

  it('decodes ErrorCode repeated fields', () => {
    expect(decode('ErrorCode', ERROR_CODE.wheelStuck).error).toEqual([2]);
    expect(decode('ErrorCode', ERROR_CODE.warnOnly).warn).toEqual([70]);
    expect(decode('ErrorCode', ERROR_CODE.none).error ?? []).toEqual([]);
  });

  it('round-trips CleanParamRequest and CleanParamResponse', () => {
    const request = encode('CleanParamRequest', {
      cleanParam: { cleanType: { value: 'SWEEP_AND_MOP' }, fan: { suction: 'QUIET' }, cleanTimes: 1 },
    });

    expect(decode('CleanParamRequest', request).cleanParam).toMatchObject({
      cleanType: { value: 'SWEEP_AND_MOP' },
      fan: { suction: 'QUIET' },
    });
    expect(decode('CleanParamResponse', CLEAN_PARAM_RESPONSE.turbo).cleanParam?.fan?.suction).toBe('TURBO');
  });
});
