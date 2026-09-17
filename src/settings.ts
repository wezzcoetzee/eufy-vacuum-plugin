import { z } from 'zod';

export const PLUGIN_NAME = 'homebridge-eufy-clean';
export const PLATFORM_NAME = 'EufyClean';

/** Kept in step with config.schema.json's pollIntervalSeconds minimum. */
const MIN_POLL_INTERVAL_SECONDS = 10;

/**
 * A room target is either a map room id or an Eufy app scene index, never
 * both: strict objects make a room carrying both ids fail rather than be
 * silently reduced to one of them.
 */
const roomTargetSchema = z.union([
  z.strictObject({ name: z.string(), roomId: z.number().int() }),
  z.strictObject({ name: z.string(), sceneId: z.number().int() }),
]);

const deviceConfigSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  rooms: z.array(roomTargetSchema).optional(),
});

export const eufyCleanPlatformConfigSchema = z.object({
  platform: z.literal(PLATFORM_NAME),
  name: z.string().optional(),
  email: z.string().email(),
  password: z.string(),
  pollIntervalSeconds: z.number().int().min(MIN_POLL_INTERVAL_SECONDS).default(60),
  devices: z.array(deviceConfigSchema).optional(),
});

export type RoomTarget = z.infer<typeof roomTargetSchema>;
export type DeviceConfig = z.infer<typeof deviceConfigSchema>;
export type EufyCleanPlatformConfig = z.infer<typeof eufyCleanPlatformConfigSchema>;
