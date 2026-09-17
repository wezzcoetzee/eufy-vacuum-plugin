# CLAUDE.md

Instructions for agents working in this repo. See README.md for user-facing
docs and ARCHITECTURE.md for how the pieces fit together.

## Layout

```
src/
  index.ts                registerPlatform entry point
  platform.ts              DynamicPlatformPlugin: config, login, discovery, accessory lifecycle
  settings.ts              PLUGIN_NAME/PLATFORM_NAME, zod config schema, inferred config types
  eufy/
    types.ts               shared contract: Logger, VacuumState, VacuumController, VacuumTransport, ...
    EufyCloudApi.ts         HTTP login, device list, MQTT credentials
    EufyMqttClient.ts       mTLS MQTT transport, envelope, reconnect/backoff
    TuyaCloudApi.ts         Tuya mobile-cloud client: signing, uid login, device list, dp publish
    TuyaCloudTransport.ts   polling VacuumTransport for Tuya-connected (connect_type 2) vacuums
    codec.ts                protobufjs load + typed encode/decode
    dps.ts                  novel DPS map, raw dps -> VacuumState projection
    EufyVacuum.ts           VacuumController implementation (state + commands)
    __tests__/              vitest specs + fixtures
  accessories/
    MatterVacuum.ts          Matter RoboticVacuumCleaner clusters + handlers
proto/cloud/*.proto          vendored, unmodified protobuf schemas
scripts/discover.ts           Phase 0 CLI, not shipped, run on Node (tsx) against a real account
docs/PHASE0.md                 how to run discover.ts and what to expect
docs/plan.html                  the original implementation plan (reference, not maintained)
```

## Commands

- `bun install` — install dependencies.
- `bun run build` — `tsc`, CommonJS output to `dist/` (what Homebridge loads).
- `bun run test` — `vitest run`, no network, no real credentials. (Not bare
  `bun test`: that is Bun's own runner, which lacks vitest's timer helpers.)
- `bun run discover` — runs `scripts/discover.ts` against a **real** Eufy
  account and vacuum. Never run this in CI or as an agent; it needs live
  credentials and talks to a real device. See docs/PHASE0.md.

## Rules

- No `console.*` anywhere in `src/`. Everything takes a `Logger` (see
  `src/eufy/types.ts`) so Homebridge's own logger is what actually prints.
- Code against `src/eufy/types.ts`, not against a concrete class. The
  protocol layer, `EufyVacuum`, and the Matter accessory only see
  `VacuumTransport` / `VacuumController` / `VacuumState`, which is what makes
  each layer testable without the others.
- Keep `NOTICE` accurate. `proto/cloud/*.proto` are unmodified copies from
  eufy-clean and must stay that way — do not edit them; if a field is
  missing, that is a signal to check the upstream proto, not to hand-patch
  the vendored one. `src/eufy/` is a from-scratch, TypeScript-strict port of
  eufy-clean's protocol logic, not a copy; that is also part of what NOTICE
  documents, so keep its description of what's copied vs. rewritten correct
  as the code changes.
- Tests use fixtures (`src/eufy/__tests__/fixtures/`), never live
  credentials or a live MQTT broker. `scripts/discover.ts --dump` is how new
  fixtures get captured, by a human running it against a real account, not
  by an agent.
- TypeScript strict, no `any`; prefer inferred types (e.g. `z.infer<...>` in
  `settings.ts`) over hand-written duplicate interfaces.

## Reference implementations

Not vendored into this repo, but the protocol and Homebridge behavior of this
plugin were derived by reading these locally:

- `/tmp/eufy-clean/src` — working Eufy protocol client. Key files:
  `api/EufyApi.ts` (HTTP login + device lists), `controllers/Login.ts`,
  `controllers/MqttConnect.ts`, `controllers/SharedConnect.ts` (commands and
  decoding), `controllers/Base.ts` (DPS maps), `constants/state.constants.ts`
  (enums), `lib/utils.ts` (protobuf encode/decode helpers).
- `/tmp/hrmv/src` — homebridge-roborock-matter-vacuum, a working Homebridge 2
  Matter Robotic Vacuum plugin. Key files: `platform.ts` (`api.matter`
  registration), `matterVacuum.ts` (clusters, handlers, state mapping),
  `settings.ts`.

When behavior here looks odd, check whether it traces back to one of those
two before assuming it's a bug.
