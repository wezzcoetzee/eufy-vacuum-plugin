#!/usr/bin/env -S npx tsx
/**
 * Phase 0 discovery script (see docs/PHASE0.md).
 *
 * Logs in to a real Eufy account, lists devices, decodes the dps a chosen
 * vacuum is currently reporting, watches live MQTT traffic for 30s, and
 * (optionally) pokes at commands and map data. Nothing here talks to
 * Homebridge; it only exercises src/eufy/*.
 *
 * Run: bun run discover -- [deviceId] [--start | --dock | --resume] [--dump <dir>]
 * Requires EUFY_EMAIL / EUFY_PASSWORD in the environment or a gitignored .env.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Root } from 'protobufjs';
import { EufyMqttClient } from '../src/eufy/EufyMqttClient';
import { NOVEL_DPS as DP } from '../src/eufy/dps';
import type { ModeCtrlRequest } from '../src/eufy/codec';
import type { EufySession, Logger, VacuumTransport } from '../src/eufy/types';

// ---------------------------------------------------------------------------
// .env loading (no dependency on dotenv; keeps this script self-contained)
// ---------------------------------------------------------------------------

function loadDotEnv(): void {
  const path = join(__dirname, '..', '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

// ---------------------------------------------------------------------------
// Logger — this script is the only place that gets to touch stdout directly.
// ---------------------------------------------------------------------------

const logger: Logger = {
  debug: (message, ...args) => console.debug(`[debug] ${message}`, ...args),
  info: (message, ...args) => console.log(`[info] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[warn] ${message}`, ...args),
  error: (message, ...args) => console.error(`[error] ${message}`, ...args),
};

function header(step: number, title: string): void {
  console.log(`\n=== Step ${step}: ${title} ===`);
}

function mask(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;
}

function createMqttClient(
  session: EufySession,
  device: { deviceId: string; model: string },
  openudid: string,
  refreshCredentials: () => Promise<EufySession['mqtt']>,
): VacuumTransport {
  return new EufyMqttClient({
    deviceId: device.deviceId,
    model: device.model,
    openudid,
    credentials: session.mqtt,
    log: logger,
    refreshCredentials,
  });
}

// ---------------------------------------------------------------------------
// Model table — L-series and SES models only, copied from
// /tmp/eufy-clean/src/constants/devices.constants.ts (EUFY_CLEAN_DEVICES).
// ---------------------------------------------------------------------------

const KNOWN_MODELS: Record<string, string> = {
  T2190: 'RoboVac L70 Hybrid',
  T2267: 'RoboVac L60',
  T2268: 'RoboVac L60 Hybrid',
  T2272: 'RoboVac G30+ SES',
  T2276: 'RoboVac X8 Pro SES',
  T2277: 'RoboVac L60 SES',
  T2278: 'RoboVac L60 Hybrid SES',
};

const KNOWN_DP_IDS = new Set<string>(Object.values(DP));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dumpIndex = args.indexOf('--dump');
const dumpDir = dumpIndex !== -1 ? args[dumpIndex + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--dump');
const requestedDeviceId = positional[0];

if (dumpDir) mkdirSync(dumpDir, { recursive: true });

let dumpCounter = 0;
function dump(label: string, data: unknown): void {
  if (!dumpDir) return;
  dumpCounter += 1;
  const file = join(dumpDir, `${String(dumpCounter).padStart(3, '0')}-${label}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
}

/** The command selected by --start / --dock / --resume, if any. */
function requestedCommand(): ModeCtrlRequest | undefined {
  if (flags.has('--start')) return { method: 'START_AUTO_CLEAN', autoClean: { cleanTimes: 1 } };
  if (flags.has('--dock')) return { method: 'START_GOHOME' };
  if (flags.has('--resume')) return { method: 'RESUME_TASK' };
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 3/4 decoding via src/eufy/codec.ts, which only covers the message
// names it actually needs (ModeCtrlRequest, WorkStatus, ErrorCode,
// CleanParamRequest, CleanParamResponse) rather than an arbitrary proto path.
// ---------------------------------------------------------------------------

async function decodeKnownDps(dps: Record<string, unknown>): Promise<void> {
  const codec = await import('../src/eufy/codec');

  const workStatusRaw = dps[DP.WORK_STATUS];
  if (typeof workStatusRaw === 'string') {
    const decoded = codec.decode('WorkStatus', workStatusRaw);
    console.log('WorkStatus (153):', decoded);
    dump('decoded-work-status', decoded);
  } else {
    console.log('WorkStatus (153): not present in this dps snapshot');
  }

  const errorCodeRaw = dps[DP.ERROR_CODE];
  if (typeof errorCodeRaw === 'string') {
    const decoded = codec.decode('ErrorCode', errorCodeRaw);
    console.log('ErrorCode (177):', decoded);
    dump('decoded-error-code', decoded);
  } else {
    console.log('ErrorCode (177): not present in this dps snapshot');
  }

  const cleanParamRaw = dps[DP.CLEANING_PARAMETERS];
  if (typeof cleanParamRaw === 'string') {
    // Firmware reports either CleanParamRequest or CleanParamResponse on this
    // dp; try the richer response shape (includes fan/suction) then fall back.
    try {
      const decoded = codec.decode('CleanParamResponse', cleanParamRaw);
      console.log('CleanParam (154, response):', decoded);
      dump('decoded-clean-param', decoded);
    } catch {
      const decoded = codec.decode('CleanParamRequest', cleanParamRaw);
      console.log('CleanParam (154, request):', decoded);
      dump('decoded-clean-param', decoded);
    }
  } else {
    console.log('CleanParam (154): not present in this dps snapshot');
  }

  console.log('Battery (163):', dps[DP.BATTERY_LEVEL]);
}

// ---------------------------------------------------------------------------
// Step 7: map / room data is the project's main unknown. codec.ts does not
// (yet) cover map_manage.proto / multi_maps.proto, so this loads them
// directly with protobufjs, the same way eufy-clean's utils.ts does, and
// tries every non-novel-API dp against every top-level message in both files.
// ---------------------------------------------------------------------------

function loadMapProtoRoot(): Root {
  const packageRoot = join(__dirname, '..');
  const root = new Root();
  root.resolvePath = (_origin, target) => join(packageRoot, target);
  return root.loadSync(['proto/cloud/map_manage.proto', 'proto/cloud/multi_maps.proto']);
}

const MAP_CANDIDATE_MESSAGES = [
  'proto.cloud.MapEntity',
  'proto.cloud.MapExtras',
  'proto.cloud.MultiMapsManageRequest',
  'proto.cloud.MultiMapsManageResponse',
] as const;

async function attemptMapDiscovery(dps: Record<string, unknown>): Promise<void> {
  console.log('Studied proto/cloud/map_manage.proto (MapEntity/MapExtras) and multi_maps.proto');
  console.log('(MultiMapsManageRequest/Response). In eufy-clean, MAP_GET_ALL/MAP_GET_ONE responses');
  console.log('are documented as p2p traffic, not a plain dp — so this is a long shot by design.');

  const candidates = Object.entries(dps).filter(([dp]) => !KNOWN_DP_IDS.has(dp));
  if (candidates.length === 0) {
    console.log('No dps outside the known novel-API map were present to try.');
    return;
  }

  const root = loadMapProtoRoot();
  let decodedAnything = false;

  for (const [dp, raw] of candidates) {
    if (typeof raw !== 'string') {
      console.log(`  dp ${dp}: not a string, skipping (${typeof raw})`);
      continue;
    }
    for (const messageName of MAP_CANDIDATE_MESSAGES) {
      try {
        const type = root.lookupType(messageName);
        const buffer = Buffer.from(raw, 'base64');
        const message = type.decodeDelimited(buffer);
        const decoded = type.toObject(message, { longs: String, enums: String, bytes: String });
        console.log(`  dp ${dp} decoded as ${messageName}:`, decoded);
        dump(`map-candidate-${dp}-${messageName}`, decoded);
        decodedAnything = true;
      } catch {
        // Not this message type — expected for the vast majority of tries.
      }
    }
  }

  if (!decodedAnything) {
    console.log('Nothing decoded. Room ids are not reachable over dp/MQTT with this account;');
    console.log('Phase 3 must fall back to scene-based cleaning (see docs/plan.html section 6).');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const email = process.env.EUFY_EMAIL;
  const password = process.env.EUFY_PASSWORD;
  if (!email || !password) {
    console.error('EUFY_EMAIL and EUFY_PASSWORD must be set (env or .env).');
    process.exitCode = 1;
    return;
  }

  // --- Step 1: login ---
  header(1, 'Login');
  const { EufyCloudApi } = await import('../src/eufy/EufyCloudApi');
  const openudid = process.env.EUFY_OPENUDID ?? `discover-${Date.now()}`;
  const api = new EufyCloudApi(email, password, openudid, logger);

  const session: EufySession = await api.login();
  console.log(`account id: ${mask(session.userId)}`);
  console.log(`mqtt credentials returned: ${session.mqtt ? 'yes' : 'no'}`);
  console.log(`mqtt user id: ${mask(session.mqtt.userId)} (app: ${session.mqtt.appName}, thing: ${mask(session.mqtt.thingName)})`);
  dump('login-session', { userId: mask(session.userId), hasMqtt: !!session.mqtt });

  // --- Step 2: device list ---
  header(2, 'Device list');
  const { devices } = await api.listDevices();
  console.table(
    devices.map((d) => ({
      deviceId: mask(d.deviceId),
      model: d.model,
      modelName: KNOWN_MODELS[d.model] ?? 'unknown',
      connection: d.connection,
    })),
  );
  dump('device-list', devices);

  const chosen = requestedDeviceId
    ? devices.find((d) => d.deviceId === requestedDeviceId)
    : devices[0];
  if (!chosen) {
    console.error('No matching device found; nothing further to do.');
    return;
  }
  console.log(`using device ${mask(chosen.deviceId)} (${chosen.model}, ${chosen.connection})`);

  // --- Step 3: raw + decoded dps snapshot ---
  header(3, 'Raw + decoded dps');
  console.log('raw dps:', chosen.dps);
  dump('raw-dps', chosen.dps);
  await decodeKnownDps(chosen.dps);

  if (chosen.connection === 'tuya') {
    await tuyaCloud(session.userId, chosen.deviceId);
    return;
  }

  // --- Step 4: live MQTT for 30s ---
  header(4, 'Live MQTT (30s)');
  const transport = createMqttClient(session, { deviceId: chosen.deviceId, model: chosen.model }, openudid, () =>
    api.login().then((s) => s.mqtt),
  );
  await transport.connect();

  const codec = await import('../src/eufy/codec');
  transport.onDps((dps) => {
    console.log('dps update:', dps);
    dump('live-dps', dps);
    const workStatusRaw = dps[DP.WORK_STATUS];
    if (typeof workStatusRaw === 'string') {
      try {
        console.log('  decoded WorkStatus:', codec.decode('WorkStatus', workStatusRaw));
      } catch (err) {
        console.log('  failed to decode WorkStatus:', err);
      }
    }
    const errorCodeRaw = dps[DP.ERROR_CODE];
    if (typeof errorCodeRaw === 'string') {
      try {
        console.log('  decoded ErrorCode:', codec.decode('ErrorCode', errorCodeRaw));
      } catch (err) {
        console.log('  failed to decode ErrorCode:', err);
      }
    }
  });

  // --- Step 5: optional commands ---
  const command = requestedCommand();
  if (command) {
    header(5, `Sending ${command.method}`);
    await transport.sendDps({ [DP.PLAY_PAUSE]: codec.encode('ModeCtrlRequest', command) });
  } else {
    header(5, 'No command flag given, sending nothing');
  }

  await new Promise((resolve) => setTimeout(resolve, 30_000));
  await transport.disconnect();

  // --- Step 7: map / room data ---
  header(7, 'Map / room data (unproven — see docs/PHASE0.md)');
  await attemptMapDiscovery(chosen.dps);
}

// ---------------------------------------------------------------------------
// Step 6: Tuya cloud, replacing steps 4-5 for Tuya-connected vacuums
// (connect_type 2), which ignore MQTT.
// ---------------------------------------------------------------------------

async function tuyaCloud(eufyUserId: string, deviceId: string): Promise<void> {
  header(6, 'Tuya cloud');
  const { TuyaCloudApi } = await import('../src/eufy/TuyaCloudApi');
  const codec = await import('../src/eufy/codec');

  let tuya: InstanceType<typeof TuyaCloudApi>;
  try {
    tuya = await TuyaCloudApi.connect(eufyUserId, logger);
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
    return;
  }

  const readDps = async (): Promise<Record<string, unknown> | undefined> => {
    const devices = await tuya.listDevices();
    const device = devices.find((d) => d.devId === deviceId);
    if (!device) {
      console.log(`device not in Tuya list; saw: ${devices.map((d) => `${mask(d.devId)} (${d.name ?? '?'})`).join(', ') || 'none'}`);
      return undefined;
    }
    console.log('tuya dps:', device.dps);
    dump('tuya-dps', device.dps);
    await decodeKnownDps(device.dps ?? {});
    return device.dps;
  };

  if (!(await readDps())) return;

  const command = requestedCommand();
  if (!command) {
    console.log('No command flag given, sending nothing');
    return;
  }

  console.log(`\nSending ${command.method} via Tuya`);
  await tuya.sendDps(deviceId, { [DP.PLAY_PAUSE]: codec.encode('ModeCtrlRequest', command) });
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  console.log('\nState 10s later:');
  await readDps();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
