import type { API, Logging, MatterAccessory } from 'homebridge';

import { describeEufyError } from '../eufy/errors';
import type { CleanSpeed, VacuumController, VacuumState } from '../eufy/types';
import type { DeviceConfig, RoomTarget } from '../settings';
import { PLUGIN_NAME } from '../settings';

const RVC_RUN_MODE = {
  Idle: 0,
  Cleaning: 1,
} as const;

const RVC_RUN_MODE_TAGS = {
  Idle: 0x4000,
  Cleaning: 0x4001,
} as const;

const RVC_CLEAN_MODE_TAGS = {
  Quiet: 2,
  Auto: 0,
  Quick: 1,
  Max: 7,
  Vacuum: 0x4001,
} as const;

const RVC_OPERATIONAL_STATES = {
  Stopped: 0,
  Running: 1,
  Paused: 2,
  Error: 3,
  SeekingCharger: 64,
  Charging: 65,
  Docked: 66,
} as const;

const RVC_ERROR_STATES = {
  NoError: 0,
  UnableToCompleteOperation: 2,
  FailedToFindChargingDock: 64,
  Stuck: 65,
  DustBinMissing: 66,
  WaterTankEmpty: 68,
  WaterTankMissing: 69,
  MopCleaningPadMissing: 71,
} as const;

/** Eufy error codes (see src/eufy/errors.ts) that have a specific Matter error state. */
const MATTER_ERROR_BY_EUFY_CODE: Readonly<Record<number, number>> = {
  1: RVC_ERROR_STATES.Stuck,
  2: RVC_ERROR_STATES.Stuck,
  3: RVC_ERROR_STATES.Stuck,
  4: RVC_ERROR_STATES.Stuck,
  5: RVC_ERROR_STATES.Stuck,
  6: RVC_ERROR_STATES.Stuck,
  7: RVC_ERROR_STATES.Stuck,
  13: RVC_ERROR_STATES.Stuck,
  14: RVC_ERROR_STATES.DustBinMissing,
  21: RVC_ERROR_STATES.FailedToFindChargingDock,
  40: RVC_ERROR_STATES.MopCleaningPadMissing,
  52: RVC_ERROR_STATES.Stuck,
  55: RVC_ERROR_STATES.FailedToFindChargingDock,
  72: RVC_ERROR_STATES.WaterTankEmpty,
  74: RVC_ERROR_STATES.WaterTankEmpty,
  75: RVC_ERROR_STATES.WaterTankMissing,
};

const POWER_SOURCE_STATUS_ACTIVE = 1;

const BATTERY_CHARGE_LEVEL = {
  Ok: 0,
  Warning: 1,
  Critical: 2,
} as const;

const BATTERY_CHARGE_STATE = {
  IsCharging: 1,
  IsAtFullCharge: 2,
  IsNotCharging: 3,
} as const;

/** How long an optimistic state survives before the device's own reports win. */
const OPTIMISTIC_STATE_WINDOW_MS = 25_000;

const CLEAN_MODES = [
  { mode: 0, label: 'Quiet', speed: 'quiet', tag: RVC_CLEAN_MODE_TAGS.Quiet },
  { mode: 1, label: 'Standard', speed: 'standard', tag: RVC_CLEAN_MODE_TAGS.Auto },
  { mode: 2, label: 'Turbo', speed: 'turbo', tag: RVC_CLEAN_MODE_TAGS.Quick },
  { mode: 3, label: 'Max', speed: 'max', tag: RVC_CLEAN_MODE_TAGS.Max },
] as const satisfies ReadonlyArray<{ mode: number; label: string; speed: CleanSpeed; tag: number }>;

type OperationalStateId = (typeof RVC_OPERATIONAL_STATES)[keyof typeof RVC_OPERATIONAL_STATES];

/**
 * A paused vacuum keeps its cleaning/go-home status and reports the pause in a
 * sub-message (`state.paused`). Older firmware drops to standby instead, so
 * `pausedHint` — what we last asked the vacuum to do — covers that case.
 */
export function toOperationalState(state: VacuumState, pausedHint = false): OperationalStateId {
  if (state.errorCode !== 0 || state.status === 'fault') {
    return RVC_OPERATIONAL_STATES.Error;
  }

  if (state.paused) {
    return RVC_OPERATIONAL_STATES.Paused;
  }

  switch (state.status) {
    case 'cleaning':
    case 'fast_mapping':
    case 'remote_ctrl':
    case 'cruising':
      return RVC_OPERATIONAL_STATES.Running;
    case 'go_home':
      return RVC_OPERATIONAL_STATES.SeekingCharger;
    case 'charging':
      return state.battery >= 100 ? RVC_OPERATIONAL_STATES.Docked : RVC_OPERATIONAL_STATES.Charging;
    case 'standby':
    case 'sleep':
      if (pausedHint) {
        return RVC_OPERATIONAL_STATES.Paused;
      }
      return state.docked ? RVC_OPERATIONAL_STATES.Docked : RVC_OPERATIONAL_STATES.Stopped;
  }
}

// Homebridge's Matter command argument types come from @matter/main, which
// this project's CommonJS module resolution cannot see; these mirror the
// fields the RoboticVacuumCleaner commands actually carry.
interface ModeRequest { newMode: number }
interface IdentifyRequest { identifyTime?: number }
interface SelectAreasRequest { newAreas: number[] }
interface SkipAreaRequest { skippedArea: number }

interface MatterVacuumDevice {
  deviceId: string;
  name: string;
  model: string;
}

interface VacuumContext extends Record<string, unknown> {
  deviceId: string;
  selectedAreaIds: number[];
}

/** One Matter RoboticVacuumCleaner endpoint backed by a single EufyVacuum. */
export class MatterVacuum {
  readonly UUID: string;

  private readonly areas: ReadonlyMap<number, RoomTarget>;
  private accessory?: MatterAccessory<VacuumContext>;
  private selectedAreaIds: number[] = [];
  private pausedHint = false;
  private optimisticState?: OperationalStateId;
  private optimisticExpiresAt = 0;

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    private readonly device: MatterVacuumDevice,
    private readonly config: DeviceConfig | undefined,
    private readonly controller: VacuumController,
  ) {
    this.UUID = api.matter!.uuid.generate(`${PLUGIN_NAME}:${device.deviceId}`);
    this.areas = new Map((config?.rooms ?? []).map((room, index) => [index + 1, room]));
  }

  buildAccessory(): MatterAccessory<VacuumContext> {
    const accessory: MatterAccessory<VacuumContext> = {
      UUID: this.UUID,
      displayName: this.config?.name ?? this.device.name,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- @matter/main's EndpointType is unresolvable under CommonJS resolution.
      deviceType: this.api.matter!.deviceTypes.RoboticVacuumCleaner,
      serialNumber: this.device.deviceId,
      manufacturer: 'Eufy',
      model: this.device.model,
      context: { deviceId: this.device.deviceId, selectedAreaIds: this.selectedAreaIds },
      clusters: {
        rvcRunMode: {
          currentMode: this.runMode(this.controller.state),
          supportedModes: [
            { label: 'Idle', mode: RVC_RUN_MODE.Idle, modeTags: [{ value: RVC_RUN_MODE_TAGS.Idle }] },
            { label: 'Clean', mode: RVC_RUN_MODE.Cleaning, modeTags: [{ value: RVC_RUN_MODE_TAGS.Cleaning }] },
          ],
        },
        rvcCleanMode: {
          currentMode: cleanModeFor(this.controller.state.cleanSpeed),
          supportedModes: CLEAN_MODES.map(({ label, mode, tag }) => ({
            label,
            mode,
            modeTags: [{ value: RVC_CLEAN_MODE_TAGS.Vacuum }, { value: tag }],
          })),
        },
        rvcOperationalState: {
          operationalStateList: Object.values(RVC_OPERATIONAL_STATES).map((operationalStateId) => ({ operationalStateId })),
          operationalState: toOperationalState(this.controller.state),
          operationalError: toOperationalError(this.controller.state),
        },
        identify: { identifyTime: 0, identifyType: 3 },
        powerSource: toPowerSourceState(this.controller.state),
        ...this.serviceAreaCluster(),
      },
      handlers: {
        rvcRunMode: {
          changeToMode: (request: ModeRequest) => this.changeRunMode(request.newMode),
        },
        rvcCleanMode: {
          changeToMode: (request: ModeRequest) => this.changeCleanMode(request.newMode),
        },
        rvcOperationalState: {
          pause: () => this.run('pause', () => this.controller.pause(), RVC_OPERATIONAL_STATES.Paused),
          resume: () => this.run('resume', () => this.controller.resume(), RVC_OPERATIONAL_STATES.Running),
          goHome: () => this.run('dock', () => this.controller.dock(), RVC_OPERATIONAL_STATES.SeekingCharger),
        },
        identify: {
          identify: (request: IdentifyRequest) => (request.identifyTime === 0 ? Promise.resolve() : this.run('locate', () => this.controller.locate())),
        },
        ...this.serviceAreaHandlers(),
      },
    };

    this.accessory = accessory;
    return accessory;
  }

  /** Restores the Home app's room selection from the cached accessory context. */
  restoreSelectedAreaIds(cached: unknown): void {
    if (!Array.isArray(cached)) {
      return;
    }

    this.selectedAreaIds = [...new Set(cached)].filter(
      (areaId): areaId is number => typeof areaId === 'number' && this.areas.has(areaId),
    );
  }

  /** Starts mirroring the controller's state onto the Matter endpoint. */
  start(): void {
    void this.publish(this.controller.state).catch((error: unknown) => {
      this.log.warn(`Could not publish state for ${this.device.name}: ${String(error)}`);
    });

    this.controller.on('change', (state) => {
      void this.publish(state).catch((error: unknown) => {
        this.log.warn(`Could not publish state for ${this.device.name}: ${String(error)}`);
      });
    });
  }

  private async changeRunMode(newMode: number): Promise<void> {
    if (newMode === RVC_RUN_MODE.Idle) {
      await this.run('pause', () => this.controller.pause(), RVC_OPERATIONAL_STATES.Paused);
      return;
    }

    if (newMode !== RVC_RUN_MODE.Cleaning) {
      throw new Error(`Unsupported run mode ${newMode}.`);
    }

    await this.run('start cleaning', () => this.startCleaning(), RVC_OPERATIONAL_STATES.Running);
  }

  private startCleaning(): Promise<void> {
    const selected = this.selectedAreaIds
      .map((areaId) => this.areas.get(areaId))
      .filter((room): room is RoomTarget => room !== undefined);

    if (selected.length === 0) {
      return this.controller.start();
    }

    const roomIds = selected.flatMap((room) => ('roomId' in room ? [room.roomId] : []));
    if (roomIds.length > 0) {
      return this.controller.cleanRooms(roomIds);
    }

    const [scene] = selected;
    if (selected.length === 1 && scene !== undefined && 'sceneId' in scene) {
      return this.controller.cleanScene(scene.sceneId);
    }

    throw new Error('Select a single scene, or one or more rooms, but not several scenes at once.');
  }

  private async changeCleanMode(newMode: number): Promise<void> {
    const cleanMode = CLEAN_MODES.find((mode) => mode.mode === newMode);
    if (!cleanMode) {
      throw new Error(`Unsupported clean mode ${newMode}.`);
    }

    await this.run(`set ${cleanMode.label} clean mode`, () => this.controller.setCleanSpeed(cleanMode.speed));
  }

  private async run(action: string, command: () => Promise<void>, optimistic?: OperationalStateId): Promise<void> {
    try {
      await command();
    } catch (error) {
      this.log.error(`Failed to ${action} on ${this.device.name}: ${String(error)}`);
      throw new Error(`Failed to ${action}.`, { cause: error });
    }

    if (optimistic === undefined) {
      return;
    }

    this.pausedHint = optimistic === RVC_OPERATIONAL_STATES.Paused;
    this.optimisticState = optimistic;
    this.optimisticExpiresAt = Date.now() + OPTIMISTIC_STATE_WINDOW_MS;
    await this.publish(this.controller.state, optimistic);
  }

  private async publish(state: VacuumState, override?: OperationalStateId): Promise<void> {
    const matter = this.api.matter;
    if (!matter) {
      return;
    }

    // Eufy reports standby for both "paused" and "stopped"; once the vacuum
    // moves out of standby the pause hint no longer applies. An optimistic
    // publish reports what we just asked for, so it can never clear the hint.
    const raw = toOperationalState(state);
    if (override === undefined && raw !== RVC_OPERATIONAL_STATES.Stopped && raw !== RVC_OPERATIONAL_STATES.Docked) {
      this.pausedHint = false;
    }

    const operationalState = override ?? this.reconcile(toOperationalState(state, this.pausedHint));

    await matter.updateAccessoryState(this.UUID, 'rvcRunMode', {
      currentMode: operationalState === RVC_OPERATIONAL_STATES.Running ? RVC_RUN_MODE.Cleaning : RVC_RUN_MODE.Idle,
    });
    await matter.updateAccessoryState(this.UUID, 'rvcCleanMode', { currentMode: cleanModeFor(state.cleanSpeed) });
    await matter.updateAccessoryState(this.UUID, 'rvcOperationalState', {
      operationalState,
      operationalError: toOperationalError(state),
    });
    await matter.updateAccessoryState(this.UUID, 'powerSource', toPowerSourceState(state));
  }

  /** Keeps the optimistic state visible until the vacuum agrees with it or it expires. */
  private reconcile(reported: OperationalStateId): OperationalStateId {
    if (this.optimisticState === undefined) {
      return reported;
    }

    const settled = reported === this.optimisticState
      || (this.optimisticState === RVC_OPERATIONAL_STATES.SeekingCharger
        && (reported === RVC_OPERATIONAL_STATES.Charging || reported === RVC_OPERATIONAL_STATES.Docked));

    if (settled || Date.now() > this.optimisticExpiresAt) {
      this.optimisticState = undefined;
      return reported;
    }

    return this.optimisticState;
  }

  private runMode(state: VacuumState): number {
    return toOperationalState(state) === RVC_OPERATIONAL_STATES.Running ? RVC_RUN_MODE.Cleaning : RVC_RUN_MODE.Idle;
  }

  private serviceAreaCluster(): Pick<NonNullable<MatterAccessory['clusters']>, 'serviceArea'> | Record<string, never> {
    if (this.areas.size === 0) {
      return {};
    }

    return {
      serviceArea: {
        supportedAreas: [...this.areas].map(([areaId, room]) => ({
          areaId,
          mapId: 1,
          areaInfo: { locationInfo: { locationName: room.name } },
        })),
        supportedMaps: [{ mapId: 1, name: `${this.device.name} Map` }],
        selectedAreas: this.selectedAreaIds,
      },
    };
  }

  private serviceAreaHandlers(): Pick<NonNullable<MatterAccessory['handlers']>, 'serviceArea'> | Record<string, never> {
    if (this.areas.size === 0) {
      return {};
    }

    return {
      serviceArea: {
        selectAreas: async (request: SelectAreasRequest) => {
          const requested = [...new Set(request.newAreas)];
          if (requested.some((areaId) => !this.areas.has(areaId))) {
            throw new Error('Unknown service area selected.');
          }

          this.selectedAreaIds = requested;
          await this.persistSelectedAreas();
        },
        skipArea: async (request: SkipAreaRequest) => {
          this.selectedAreaIds = this.selectedAreaIds.filter((areaId) => areaId !== request.skippedArea);
          await this.persistSelectedAreas();
        },
      },
    };
  }

  private async persistSelectedAreas(): Promise<void> {
    await this.api.matter?.updateAccessoryState(this.UUID, 'serviceArea', { selectedAreas: this.selectedAreaIds });

    if (!this.accessory) {
      return;
    }

    this.accessory.context.selectedAreaIds = this.selectedAreaIds;
    await this.api.matter?.updatePlatformAccessories([this.accessory]).catch((error: unknown) => {
      this.log.debug(`Could not persist room selection for ${this.device.name}: ${String(error)}`);
    });
  }
}

function cleanModeFor(speed: CleanSpeed): number {
  return CLEAN_MODES.find((mode) => mode.speed === speed)?.mode ?? RVC_RUN_MODE.Idle;
}

function toOperationalError(state: VacuumState): { errorStateId: number; errorStateDetails?: string } {
  if (state.errorCode === 0) {
    return { errorStateId: RVC_ERROR_STATES.NoError };
  }

  return {
    errorStateId: MATTER_ERROR_BY_EUFY_CODE[state.errorCode] ?? RVC_ERROR_STATES.UnableToCompleteOperation,
    errorStateDetails: describeEufyError(state.errorCode),
  };
}

function toPowerSourceState(state: VacuumState) {
  const battery = Math.max(0, Math.min(100, Math.round(state.battery)));

  return {
    status: POWER_SOURCE_STATUS_ACTIVE,
    order: 0,
    description: 'Rechargeable battery',
    batPresent: true,
    batPercentRemaining: battery * 2,
    batChargeLevel: battery <= 10 ? BATTERY_CHARGE_LEVEL.Critical : battery <= 20 ? BATTERY_CHARGE_LEVEL.Warning : BATTERY_CHARGE_LEVEL.Ok,
    batChargeState: !state.charging
      ? BATTERY_CHARGE_STATE.IsNotCharging
      : battery >= 100
        ? BATTERY_CHARGE_STATE.IsAtFullCharge
        : BATTERY_CHARGE_STATE.IsCharging,
    batFunctionalWhileCharging: false,
  };
}
