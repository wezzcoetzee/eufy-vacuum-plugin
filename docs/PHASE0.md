# Phase 0: discovery

`scripts/discover.ts` is a throwaway CLI, not part of the published plugin. It
exercises `src/eufy/*` against a real account and a real L60 to answer the
open questions in `docs/plan.html` section 6-7 before Phase 1 is written
against assumptions.

## Running it

1. Copy `.env.example` to `.env` (gitignored) in the repo root and fill it in
   (or export the variables):

   ```
   EUFY_EMAIL=you@example.com
   EUFY_PASSWORD=...
   ```

   `EUFY_OPENUDID` is optional; a random one is generated per run if unset.
   Reusing a fixed value across runs is closer to how the real plugin will
   behave (one openudid per install) and avoids relogin creating a new "app
   session" every time.

2. Run it on Node via `tsx` (`bun run discover` does this), not directly with
   Bun. Bun's TLS layer returns an empty peer certificate, so the MQTT
   handshake to `aiot-mqtt-eu.anker.com` fails with
   `ERR_TLS_CERT_ALTNAME_INVALID` even though the broker's `*.anker.com`
   certificate is valid. Homebridge runs on Node, so the plugin is unaffected:

   ```
   bun run discover                             # first MQTT device, no command sent
   bun run discover T2277XXXXXXXXXXXX           # a specific device
   bun run discover --start                     # also send START_AUTO_CLEAN
   bun run discover --dock                      # also send START_GOHOME
   bun run discover --resume                    # also send RESUME_TASK
   bun run discover --dump ./fixtures/raw       # write JSON fixtures for Phase 1 tests
   ```

   `--start`, `--dock` and `--resume` are mutually exclusive; if none is passed, step
   5 sends nothing and only observes.

   Tuya-connected vacuums (the device table shows `connection: tuya`, from
   the cloud device's `connect_type: 2`) get step 6 instead of steps 4-5: they
   silently ignore MQTT. Step 6 logs in to Tuya's mobile cloud as
   `eh-<eufy user id>` (EU, then US), prints the device's dps, sends the
   chosen command via `tuya.m.device.dp.publish`, and re-reads dps 10s later.

3. Type-check without running it (this script talks to the real internet and
   a real vacuum, so CI/agents should never execute it):

   ```
   bunx tsc --noEmit -p tsconfig.eslint.json
   ```

   (The shipped build, `bun run build`, compiles `src/` only — scripts ship to
   nobody — so the lint/type-check project is what covers `scripts/`.)

## What a healthy L60 should show

- **Step 1 (Login)**: account id printed masked (e.g. `ab******f2`), `mqtt
  credentials returned: yes`. If it says `no`, the account has no MQTT-capable
  device and nothing past step 2 will work.
- **Step 2 (Device list)**: a table with one row per device. The L60 row's
  `model` should be one of `T2267` (L60), `T2268` (L60 Hybrid), `T2277` (L60
  SES) or `T2278` (L60 Hybrid SES), `mqtt: true`, and `modelName` resolved
  (not `unknown` — if it is, the model table in `discover.ts` needs the real
  code added).
- **Step 3 (Raw + decoded dps)**: raw dps object with keys at least `153`
  (work status), `163` (battery), `177` (error code); `154` (clean params) is
  common but not guaranteed to be present if the vacuum has never run a job
  since power-on. `WorkStatus` decodes to an object with a `state` string
  (one of `STANDBY`/`SLEEP`/`FAULT`/`CHARGING`/`FAST_MAPPING`/`CLEANING`/
  `REMOTE_CTRL`/`GO_HOME`/`CRUISIING`) and usually a `mode.value`.
  `ErrorCode` decodes with empty `error`/`warn` arrays when healthy.
- **Step 4 (Live MQTT)**: at minimum a periodic battery/heartbeat update
  within 30s while idle; every update while the vacuum is doing something
  (docking, cleaning) should include a decodable `WorkStatus`.
- **Step 5 (Commands)**: with `--dock`, the next `WorkStatus` update should
  transition towards `state: GO_HOME` and eventually `CHARGING`. With
  `--resume`, a paused vacuum should return to `CLEANING`.
- **Step 7 (Map/room data)**: most likely "nothing decoded" — eufy-clean never
  observes map data on a plain dp, only over a separate p2p channel this
  script does not implement. That is an expected, useful result: it tells
  Phase 3 to plan on scene-based cleaning, not room selection.

## Checklist to fill in after a real run

- [ ] Exact model code observed: `_______`
- [ ] Model name resolved correctly by the table in `discover.ts`? yes / no
- [ ] `WorkStatus.state` values observed while idle: `_______`
- [ ] `WorkStatus.state` values observed while cleaning: `_______`
- [ ] `WorkStatus.state` observed during `--dock`: `_______`
- [ ] `ErrorCode.error` / `.warn` non-empty at any point, and what they were: `_______`
- [ ] Clean speed dp (`158`) present, or only inside `CleanParamResponse.fan.suction`?
- [ ] Any dp id decoded successfully in step 7 (map/room data)? yes / no — if yes, which dp and message type: `_______`
- [ ] Region/login target that succeeded (`v2 (Eufy app)` vs `v1 (Eufy Clean app)`): `_______`
- [ ] Did the AIOT (devicerelation) device list return devices directly, or did it need the cloud-device-list fallback?
