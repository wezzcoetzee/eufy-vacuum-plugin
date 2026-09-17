import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig } from 'homebridge';
import { APIEvent } from 'homebridge';

import { MatterVacuum } from './accessories/MatterVacuum';
import { EufyCloudApi } from './eufy/EufyCloudApi';
import { EufyMqttClient } from './eufy/EufyMqttClient';
import { EufyVacuum } from './eufy/EufyVacuum';
import { TuyaCloudApi } from './eufy/TuyaCloudApi';
import { TuyaCloudTransport } from './eufy/TuyaCloudTransport';
import type { EufyDeviceInfo, VacuumTransport } from './eufy/types';
import type { DeviceConfig, EufyCleanPlatformConfig } from './settings';
import { eufyCleanPlatformConfigSchema, PLATFORM_NAME, PLUGIN_NAME } from './settings';

const OPENUDID_FILE = `${PLUGIN_NAME}-openudid`;

/** Escalating delays for a discovery attempt that failed, mirroring the Roborock plugin. */
const DISCOVERY_RETRY_DELAYS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000] as const;

export class EufyCleanPlatform implements DynamicPlatformPlugin {
  private readonly config?: EufyCleanPlatformConfig;
  private readonly cachedAccessories = new Map<string, MatterAccessory>();
  private readonly transports: VacuumTransport[] = [];
  private readonly controllers = new Map<string, EufyVacuum>();
  private retryTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    const parsed = eufyCleanPlatformConfigSchema.safeParse(config);

    if (!parsed.success) {
      this.log.error(`Invalid ${PLATFORM_NAME} configuration; the platform will not start. ${describeIssues(parsed.error.issues)}`);
      return;
    }

    this.config = parsed.data;
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => this.scheduleDiscovery(0));
    this.api.on(APIEvent.SHUTDOWN, () => void this.shutdown());
  }

  configureAccessory(_accessory: PlatformAccessory): void {
    // This plugin publishes Matter accessories only.
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private scheduleDiscovery(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.discover();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private async discover(): Promise<void> {
    const config = this.config;
    if (!config || this.stopped) {
      return;
    }

    if (!this.api.isMatterEnabled() || !this.api.matter) {
      this.log.warn(
        `${PLATFORM_NAME} publishes vacuums over Matter only. Enable Matter on this bridge, or move the plugin to a child bridge with `
        + 'Matter enabled, then restart Homebridge.',
      );
      return;
    }

    try {
      await this.publishVacuums(config);
      this.retryAttempt = 0;
    } catch (error) {
      this.onDiscoveryFailure(error);
    }
  }

  /** A boot that races the network, or an Eufy 5xx, must not disable the platform for good. */
  private onDiscoveryFailure(error: unknown): void {
    if (this.stopped) {
      return;
    }

    const delayMs = DISCOVERY_RETRY_DELAYS_MS[Math.min(this.retryAttempt, DISCOVERY_RETRY_DELAYS_MS.length - 1)] ?? 0;
    this.retryAttempt += 1;

    const message = `Could not publish Eufy vacuums: ${String(error)}`;
    if (this.retryAttempt === 1) {
      this.log.error(message);
    } else {
      this.log.warn(message);
    }

    this.log.info(`Retrying Eufy discovery in ${Math.round(delayMs / 1000)} seconds.`);
    this.scheduleDiscovery(delayMs);
  }

  private async publishVacuums(config: EufyCleanPlatformConfig): Promise<void> {
    const matter = this.api.matter!;
    const openudid = this.openudid();
    const cloud = new EufyCloudApi(config.email, config.password, openudid, this.log);
    const session = await cloud.login();
    const listing = await cloud.listDevices();
    const devices = selectDevices(listing.devices, config.devices);

    if (devices.length === 0) {
      this.log.warn(
        listing.lookupFailed
          ? 'Eufy did not return a usable device list; keeping the existing accessories and retrying.'
          : 'No Eufy vacuums were found on this account.',
      );

      if (listing.lookupFailed) {
        throw new Error('Eufy device list lookup failed');
      }

      // An empty but successful lookup still must not unregister a live
      // accessory: a mistyped deviceId in the config would be enough.
      return;
    }

    const published = new Set<string>();
    // Logged in lazily, once per account, and only if a Tuya-connected vacuum exists.
    let tuya: Promise<TuyaCloudApi> | undefined;

    for (const device of devices) {
      const deviceConfig = config.devices?.find((entry) => entry.deviceId === device.deviceId);
      let transport: VacuumTransport;
      if (device.connection === 'tuya') {
        tuya ??= TuyaCloudApi.connect(session.userId, this.log);
        transport = new TuyaCloudTransport({
          deviceId: device.deviceId,
          api: await tuya,
          pollIntervalMs: config.pollIntervalSeconds * 1_000,
          log: this.log,
        });
      } else {
        transport = new EufyMqttClient({
          deviceId: device.deviceId,
          model: device.model,
          openudid,
          credentials: session.mqtt,
          log: this.log,
          refreshCredentials: async () => (await cloud.login()).mqtt,
        });
      }
      const controller = new EufyVacuum(transport, device, this.log);
      const vacuum = new MatterVacuum(this.api, this.log, device, deviceConfig, controller);

      await transport.connect();
      this.transports.push(transport);

      vacuum.restoreSelectedAreaIds(this.cachedAccessories.get(vacuum.UUID)?.context.selectedAreaIds);
      const accessory = vacuum.buildAccessory();

      if (this.cachedAccessories.has(vacuum.UUID)) {
        await matter.updatePlatformAccessories([accessory]);
        this.log.info(`Updated Eufy vacuum: ${accessory.displayName}`);
      } else {
        await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Registered Eufy vacuum: ${accessory.displayName}`);
      }

      this.cachedAccessories.set(vacuum.UUID, accessory);
      this.controllers.set(device.deviceId, controller);
      published.add(vacuum.UUID);
      vacuum.start();
    }

    await this.removeStaleAccessories(published);
    this.startPolling(cloud, config.pollIntervalSeconds);
  }

  /**
   * MQTT is push-based, but a vacuum that never changes state never pushes.
   * Re-reading the cloud device list keeps battery and status honest. Tuya
   * devices poll through their own transport; their entries here carry no dps.
   */
  private startPolling(cloud: EufyCloudApi, intervalSeconds: number): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void cloud.listDevices()
        .then(({ devices }) => {
          for (const device of devices) {
            this.controllers.get(device.deviceId)?.applyDps(device.dps);
          }
        })
        .catch((error: unknown) => {
          this.log.debug(`Eufy state poll failed: ${String(error)}`);
        });
    }, intervalSeconds * 1_000);
    this.pollTimer.unref?.();
  }

  private async removeStaleAccessories(published: Set<string>): Promise<void> {
    const stale = [...this.cachedAccessories.values()].filter((accessory) => !published.has(accessory.UUID));

    if (stale.length === 0) {
      return;
    }

    await this.api.matter!.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    for (const accessory of stale) {
      this.cachedAccessories.delete(accessory.UUID);
    }
    this.log.info(`Removed ${stale.length} stale Eufy vacuum accessory record(s).`);
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    await Promise.all(this.transports.map((transport) => transport.disconnect().catch((error: unknown) => {
      this.log.debug(`Could not close an Eufy vacuum connection: ${String(error)}`);
    })));
    this.transports.length = 0;
  }

  /**
   * Eufy ties an MQTT session to the device id that logged in, so the plugin
   * keeps one of its own for the life of the install rather than racing the app.
   */
  private openudid(): string {
    const file = path.join(this.api.user.persistPath(), OPENUDID_FILE);

    try {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing) {
        return existing;
      }
    } catch {
      // No stored id yet; fall through and mint one.
    }

    const openudid = randomBytes(16).toString('hex');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, openudid, 'utf8');
    return openudid;
  }
}

function selectDevices(devices: EufyDeviceInfo[], configured: DeviceConfig[] | undefined): EufyDeviceInfo[] {
  const wanted = configured?.length ? new Set(configured.map((device) => device.deviceId)) : undefined;
  return devices.filter((device) => !wanted || wanted.has(device.deviceId));
}

function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ');
}
