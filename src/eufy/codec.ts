/**
 * protobuf codec for the Eufy "novel API" data points.
 *
 * Every payload on the wire is a length-delimited protobuf message, base64
 * encoded, carried as a Tuya dps string. The .proto files are vendored under
 * proto/cloud/ and loaded once at first use; their imports are written as
 * "proto/cloud/x.proto", so the resolve root is the package root rather than
 * the directory the protos live in.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Root, type Type } from 'protobufjs';
import type { VacuumCommandName } from './types';

/** Shapes of the messages this plugin encodes or decodes. */
export interface ModeCtrlRequest {
  method: VacuumCommandName;
  seq?: number;
  autoClean?: { cleanTimes?: number };
  selectRoomsClean?: {
    rooms?: Array<{ id: number; order?: number }>;
    cleanTimes?: number;
    mapId?: number;
    mode?: 'GENERAL' | 'CUSTOMIZE';
  };
  spotClean?: { cleanTimes?: number };
  sceneClean?: { sceneId: number };
}

export interface WorkStatus {
  mode?: { value?: string };
  state?: string;
  charging?: { state?: string };
  cleaning?: { state?: string; mode?: string };
  goHome?: { state?: string; mode?: string };
}

export interface ErrorCode {
  lastTime?: string;
  error?: number[];
  warn?: number[];
}

export interface CleanParam {
  cleanType?: { value?: string };
  cleanExtent?: { value?: string };
  mopMode?: { level?: string; cornerClean?: string };
  fan?: { suction?: string };
  cleanTimes?: number;
}

export interface CleanParamRequest {
  cleanParam?: CleanParam;
  areaCleanParam?: CleanParam;
}

export interface CleanParamResponse extends CleanParamRequest {
  runningCleanParam?: CleanParam;
}

/** Message name (within package proto.cloud) to its TypeScript shape. */
interface MessageShapes {
  ModeCtrlRequest: ModeCtrlRequest;
  WorkStatus: WorkStatus;
  ErrorCode: ErrorCode;
  CleanParamRequest: CleanParamRequest;
  CleanParamResponse: CleanParamResponse;
}

export type MessageName = keyof MessageShapes;

const PROTO_ENTRY_POINTS = [
  'proto/cloud/control.proto',
  'proto/cloud/work_status.proto',
  'proto/cloud/clean_param.proto',
  'proto/cloud/error_code.proto',
];

/** Walk up from this module until the vendored protos are in view. */
function findPackageRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (existsSync(path.join(dir, 'proto', 'cloud', 'common.proto'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('Could not locate proto/cloud relative to ' + __dirname);
    }
    dir = parent;
  }
}

let root: Root | undefined;

function lookup(name: MessageName): Type {
  if (!root) {
    const packageRoot = findPackageRoot();
    const loaded = new Root();
    loaded.resolvePath = (_origin, target) => path.resolve(packageRoot, target);
    root = loaded.loadSync(PROTO_ENTRY_POINTS);
  }
  return root.lookupType(`proto.cloud.${name}`);
}

/** Encode a message to the base64, length-delimited form the device expects. */
export function encode<K extends MessageName>(name: K, value: MessageShapes[K]): string {
  const type = lookup(name);
  // fromObject (not create) so enum names in the input resolve to their numbers.
  const message = type.fromObject(value);
  const error = type.verify(message);
  if (error) {
    throw new TypeError(`Invalid ${name}: ${error}`);
  }
  return Buffer.from(type.encodeDelimited(message).finish()).toString('base64');
}

/** Decode a base64, length-delimited message. Enums come back as their names. */
export function decode<K extends MessageName>(name: K, base64Value: string): MessageShapes[K] {
  const type = lookup(name);
  const message = type.decodeDelimited(Buffer.from(base64Value, 'base64'));
  return type.toObject(message, { longs: String, enums: String, bytes: String }) as MessageShapes[K];
}
