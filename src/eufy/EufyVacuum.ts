/**
 * Typed façade over one vacuum: raw dps in from the transport, normalised
 * state out, commands encoded as protobuf on the way back down.
 */
import { encode, type ModeCtrlRequest } from './codec';
import { CLEAN_SPEEDS, INITIAL_STATE, mapDpsToState, NOVEL_DPS } from './dps';
import type {
  CleanSpeed,
  EufyDeviceInfo,
  Logger,
  VacuumCommandName,
  VacuumController,
  VacuumState,
  VacuumTransport,
} from './types';

export class EufyVacuum implements VacuumController {
  private current: VacuumState = { ...INITIAL_STATE };
  private readonly listeners = new Set<(state: VacuumState) => void>();
  private seq = 0;

  constructor(
    private readonly transport: VacuumTransport,
    private readonly device: EufyDeviceInfo,
    private readonly log: Logger,
  ) {
    this.transport.onDps((dps) => this.applyDps(dps));
    // The device list carries a dps snapshot; without it an idle docked vacuum
    // would read as 0% and Stopped until it next pushes a change.
    this.applyDps(device.dps);
  }

  get state(): VacuumState {
    return this.current;
  }

  on(event: 'change', handler: (state: VacuumState) => void): void {
    if (event === 'change') this.listeners.add(handler);
  }

  start(): Promise<void> {
    return this.control('START_AUTO_CLEAN', { autoClean: { cleanTimes: 1 } });
  }

  pause(): Promise<void> {
    return this.control('PAUSE_TASK');
  }

  resume(): Promise<void> {
    return this.control('RESUME_TASK');
  }

  stop(): Promise<void> {
    return this.control('STOP_TASK');
  }

  dock(): Promise<void> {
    return this.control('START_GOHOME');
  }

  locate(): Promise<void> {
    return this.transport.sendDps({ [NOVEL_DPS.FIND_ROBOT]: true });
  }

  async setCleanSpeed(speed: CleanSpeed): Promise<void> {
    await this.transport.sendDps({ [NOVEL_DPS.CLEAN_SPEED]: CLEAN_SPEEDS.indexOf(speed) });
  }

  /**
   * eufy-clean only ever sends the bare START_SELECT_ROOMS_CLEAN with no room
   * list, so the shape the L60 actually honours is unproven. control.proto
   * declares SelectRoomsClean.rooms, so we populate it; if the device ignores
   * the ids and cleans everything, fall back to scene cleaning.
   */
  cleanRooms(roomIds: number[]): Promise<void> {
    return this.control('START_SELECT_ROOMS_CLEAN', {
      selectRoomsClean: {
        rooms: roomIds.map((id, index) => ({ id, order: index + 1 })),
        cleanTimes: 1,
        mode: 'GENERAL',
      },
    });
  }

  /** Scene 1 in the Eufy app is scene_id 4 on the wire. */
  async cleanScene(sceneId: number): Promise<void> {
    await this.stop();
    await this.control('START_SCENE_CLEAN', { sceneClean: { sceneId: sceneId + SCENE_ID_OFFSET } });
  }

  private async control(
    method: VacuumCommandName,
    params: Omit<ModeCtrlRequest, 'method' | 'seq'> = {},
  ): Promise<void> {
    this.seq = (this.seq + 1) % 0xffff;
    const value = encode('ModeCtrlRequest', { method, seq: this.seq, ...params });
    this.log.debug(`[${this.device.name}] ${method} -> dp ${NOVEL_DPS.PLAY_PAUSE}`);
    await this.transport.sendDps({ [NOVEL_DPS.PLAY_PAUSE]: value });
  }

  applyDps(dps: Record<string, unknown>): void {
    const patch = mapDpsToState(dps);
    const next = { ...this.current, ...patch };
    if (!hasChanged(this.current, next)) return;

    this.current = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

const SCENE_ID_OFFSET = 3;

function hasChanged(previous: VacuumState, next: VacuumState): boolean {
  return (Object.keys(next) as Array<keyof VacuumState>).some((key) => previous[key] !== next[key]);
}
