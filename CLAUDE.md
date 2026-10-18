# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (Modbus TCP goes through our own client on `node:net`).
It reads a STIEBEL ELTRON heat pump through the Modbus interface of its ISG
(no cloud, no account, no authentication) and shows it as one Gladys device;
the operating mode and two setpoints can be changed behind an
off-by-default option, the hot water capped. Never tested with a real ISG,
not affiliated with STIEBEL ELTRON.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js                  SDK bootstrap only
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                StiebelApp: polling, failures, device, states, badge,
                          status, the test button, the commands, guards
src/isg.js                registers by variant, blocks, decoding, modes (pystiebeleltron)
src/modbus/client.js      Modbus TCP client (functions 3, 4, 6), the Gate, error kinds
src/devices.js            -> the Gladys device and its states (pure), kept features
src/publisher.js          states within 300/min
src/config.js             config_schema normalized (address, allow_commands,
                          dhw_max_temperature, poll_interval, language)
src/constants.js          feature roles, limits, timings, the hot water ceiling
src/i18n.js               runtime texts, feature and mode names (en/fr)
test/fixtures/fakeIsg.js  the fake ISG behind the socket factory; Gladys is the SDK's fake
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: device `stiebel-eltron:<family>` (`wpm` or
  `lwz`), features `mode`, `operating-mode`, `heating-setpoint`,
  `heating-setpoint-eco`, `dhw-setpoint`, `dhw-setpoint-eco`, `dhw-target`,
  `temperature-outdoor`, `temperature-flow`, `temperature-return`,
  `temperature-dhw`, `temperature-room`, `temperature-room-fe7`,
  `temperature-room-fek`, `humidity`, `compressor`, `booster`, `fault` and
  the `energy-*` roles of `src/constants.js`. A republished device never
  loses a feature (`keepCreatedFeatures`).
- Manifest keys (`address`, `allow_commands`, `dhw_max_temperature`,
  `poll_interval`, `language`, the action `test_connection`) are frozen.
- **Modbus**: one request at a time (the Gate); every answer matched to its
  request; a timeout or a stray byte drops the connection; `sent` is true
  as soon as the bytes may have left.
- **The commands**: never a switch or a writable binary (a "turn everything
  off" must not reach them); refused unless `allow_commands` (checked on
  arrival and again right before the bytes leave); decided on a fresh read
  only, refused when a value is missing; never sent after 3.5 s; a write
  without its echo is "sent, without confirmation"; never retried; one at a
  time; the ack never waits for Gladys. Never the emergency or manual mode.
- **Hot water**: never above the configured ceiling (55 °C by default) nor
  60 °C, whole degrees only.
- **Energy**: never an `energy-sensor` index nor `publishEnergyConsumption`
  until a real ISG shows the totals are cumulative and reliable.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network (the loopback server of `test/client.test.js` aside).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
