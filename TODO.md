# TODO — STIEBEL ELTRON v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (post #275, lot 8) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-18): Modbus TCP read of one ISG
      (WPM 3, WPM 3i, WPMsystem, LWZ/LWA), one device, temperatures,
      setpoints, mode, compressor, booster, fault, energy as plain values,
      three commands behind `allow_commands` (off), hot water ceiling
      (55 °C, 40–60, never above 60), polling and backoff, test button,
      docs en/fr, cover. Tested against a fake ISG only.
- [ ] **Milestone 2 — real ISG**: run against a real ISG (see "To check"),
      turn the register dumps (no address) into fixtures.
- [ ] **Milestone 3 — more**: heating circuits 2 to 5, cooling setpoints,
      LWZ ventilation stages, the individual heat pumps of a WPMsystem,
      SG Ready (read only first), COP figures of the extended blocks, and an
      opt-in energy index once the totals are proven cumulative (with the
      approved guard of gladys-p1-monitor: hold, bounded acceptance button,
      never 0).

## To check on a real ISG

- **WPM operating mode numbers** (holding 1500, manual 1501): 0 emergency,
  1 standby, 2 program, 3 comfort, 4 eco, 5 hot water. pystiebeleltron gives
  the register and its range 0–5 but no names for the WPM: the names come
  from the STIEBEL ELTRON Modbus manual as transcribed here, not from code.
  A wrong mapping would select a wrong mode: check each value against the
  ISG web page before trusting the select.
- **Operating status bits** (WPM input 2500 = manual 2501; LWZ 2000 = 2001):
  WPM bit 6 compressor, bit 3 booster stages; LWZ bit 1 compressor, bit 5
  electric reheating (pystiebeleltron only uses LWZ bits 2, 3, 8, 12, 13,
  consistent with this map). Compare with the ISG web page.
- **Energy totals**: does the total (kWh below 1000 + MWh) include the
  current day or move at midnight only? Does it ever go back or jump? Only
  then an index (milestone 3).
- The LWZ R290 (551) read with the WPM map (pystiebeleltron dc160a5 and
  d5386c1, after v0.9.2): confirm on a real one, its modes included.
- The WPMsystem compressor (2541–2546) and booster (2524–2526) registers:
  0/1 as the manual says?
- Room temperatures: which of FE7 (500), FEK (502) and the WPMsystem room
  sensor (583) a given installation fills; humidity 504 on a FEK only?
- Whether the ISG keeps a TCP connection open between polls, and how many
  Modbus clients it accepts at once (Home Assistant and Gladys together?).
- The delay before a written setpoint shows in a read (pystiebeleltron's
  example waits 3 s): the follow-up reads are at 5 and 20 s.
- Latency of a read: commands refuse when the parameters cannot be read and
  the write sent within 3.5 s.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-stiebel-eltron:0.1.0`); the first patch release
  gives 0.1.1. `test/manifest.test.js` checks the four agree.
- **Reference**: pystiebeleltron 0.9.2 (MIT, the library of Home
  Assistant's STIEBEL ELTRON integration), cloned read only in
  `_ref/pystiebeleltron` (tag v0.9.2, 8c03d84); Home Assistant's
  `homeassistant/components/stiebel_eltron` read for the climate mapping.
  Credited in README, docs and `THIRD_PARTY_NOTICES.md` (full MIT notice),
  shipped in the image with `LICENSE` (the standard Apache-2.0 text without
  any name).
- **Own Modbus client, no dependency**: the ISG needs three function codes
  (3, 4, 6) over TCP. The npm clients are either large with optional native
  serial-port dependencies (`modbus-serial`, ISC) or barely maintained
  (`jsmodbus`); neither enforces the rules this module needs (one request
  at a time, answers attributed to their request, bounded frames, `sent`
  exact for a write). About 300 lines on `node:net`, tested with a scripted
  socket and a loopback server. Runtime dependency: the SDK only.
- **Blocks**: only the registers shown, in blocks inside the ranges
  pystiebeleltron lists for every variant (a WPM 3 does not serve 508, a
  WPM 3i not 527–531); checked by `test/isg.test.js`. `values` blocks are
  core (the poll fails without them); the others are secondary: a Modbus
  exception drops their values for that poll (noted in the status, logged
  once), an "illegal data address" on a block never answered marks it
  absent until a restart (pystiebeleltron's `ControllerComponents`). A
  connection-level error (timeout, closed, unreachable, protocol) fails the
  poll.
- **Values**: 0x8000 unavailable; every value has a plausibility range
  (temperatures −60–120 °C, setpoints 0–90 °C), which also rejects the
  0x9000 of some WPM 3i registers. Unknown values are never published.
- **One ISG per integration, one device per family**: Modbus gives no serial
  nor MAC, the IP may change: device id `stiebel-eltron:wpm` or
  `stiebel-eltron:lwz` (the register maps differ). The controller id is
  read at every poll; another variant answering drops what was read.
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): water,
  outside temperatures and read-only setpoints `temperature-sensor/probe`
  °C (kept out of the room temperature, as gladys-quatt); room temperatures
  `temperature-sensor/decimal`; humidity `humidity-sensor/decimal` %;
  heating setpoint `thermostat/target-temperature` °C (5–30 WPM, 10–30
  LWZ); hot water setpoint `water-heater/target-temperature` °C (10–60,
  integers as the core's water-heater convention; category since Gladys
  4.85); mode `text/select` with fixed options and a read-only
  `text/text` that also shows emergency, manual and unknown codes;
  compressor, booster, fault `unknown/binary` read only (lot 6 lesson: no
  switch). A feature appears once its register gave a value.
- **Energy as plain values** (wave 2 / lot 6 lessons, brief): the ISG gives
  a day counter and a total said to exclude the day; pystiebeleltron sums
  them and keeps the running maximum, a sign the sum is not monotonic. Not
  proven cumulative and reliable: `unknown/decimal` with the unit in the
  name, today and total apart, never `energy-sensor/index`, never
  `publishEnergyConsumption`. Hence no index guard here; milestone 3 would
  reuse the approved guard of gladys-p1-monitor (`src/guard.js`).
- **No lost feature** (lot 6 lesson): the features of the created device
  (`gladys.devices`) that a new build lacks are republished as they are;
  the roles a family reported once are remembered while the integration
  runs.
- **Commands** (`allow_commands`, off by default, only `true` allows):
  mode, heating setpoint (comfort HC1 on a WPM, day HC1 on an LWZ as Home
  Assistant), hot water setpoint (comfort on a WPM, day on an LWZ). Values
  checked strictly: a mode is one exact key of the list; a setpoint a
  finite number or a plain decimal text (`''`, `null`, `'1e2'`, `true` are
  refused), a tenth of a degree for heating, whole degrees for hot water,
  within the manual's range.
- **Hot water ceiling**: `dhw_max_temperature`, 55 °C by default, 40–60 °C
  (a typed value outside is clamped, never above 60; rounded down;
  anything not a number gives 55). Refused on arrival above it, and the
  ceiling (with the option) checked again right before the bytes leave: a
  ceiling lowered during a command stops it. The eco setpoint, the
  anti-legionella program and the LWZ manual setpoint are never written.
- **Protected modes**: never select emergency (the installer's when the
  compressor fails) nor the LWZ manual (service) mode, and never leave
  them, nor an unknown mode code: refused, the controller keeps control.
- **Command rules** (lot 6 and waves 2/3 lessons): one Modbus session holds
  the Gate from the fresh read of the parameter block to the end of the
  write (no other request in between), passes before queued poll reads,
  and is refused LATE if still queued at its deadline. Decided on that read
  only; refused when the value is missing; not sent when already in place
  (unless a guard holds). Sent within 3.5 s of the click or refused
  unsent; answered by 4.3 s. Outcomes: exact echo → success; Modbus
  exception → "refused by the ISG"; nothing sent (unreachable, late,
  `beforeSend`) → "not sent"; a timeout, a dropped connection or an answer
  that is not the echo after the bytes may have left → **"sent, without
  confirmation"**, guard set. Polls 5 s and 20 s after every command. One
  command at a time. The ack never waits for Gladys: the fresh read is
  published in the background.
- **Guards** (waves 2/3 lessons): per family and role, the start value and
  the wanted one; while it holds (until a read shows a move then the wanted
  value, or 90 s), the command is always sent, never answered "already
  so". A read equal to the start value or unknown lifts nothing.
- **Polling**: 30 s by default (Home Assistant's), 10 s – 10 min; failures
  30 s, 1, 2, 5 min, never shorter than the interval; an unknown controller
  every 30 min. No 429 nor pause on Modbus: nothing kept in `/data`.
- **Reconnection to Gladys** (`connected`): republishes status, Discovery,
  states (published-state memory forgotten) and badge, as the core keeps
  them in memory (lot 6 lesson); never clears the client nor the blocks; a
  new address or interval restarts the polling.
- **Trusted network**: Modbus has no authentication: said in the manifest,
  the docs (fr/en) and the README.
- **Review round 1 (2026-10-18)**:
  - B1: the LWZ R290 (551) serves the WPM registers (reference commits
    dc160a5 "compliant to the WPM registers" and d5386c1, where the query
    script reads it with the generic WPM API): family `wpm`, the
    WPMsystem blocks (generic WPM map), WPM modes and write addresses
    (1500/1501/1509), never the LWZ ones. Docs, README, notices updated;
    test.
  - I1: pystiebeleltron's ReadStartRetry ported (`readWithRetry` in
    `src/isg.js`, issue #722): on an "illegal data address", a block is
    read once more from the highest start answered directly in the same
    poll and space, below it, within 125 registers, keeping only its words;
    a recovered start is never an anchor; a failed retry is handled as
    before (core → poll fails; secondary never answered → absent). Tests:
    a WPM 3 refusing the starts 509 and 2503.
  - I2: on a write, only Modbus exceptions 1, 2, 3, 6 and 10 are a refusal
    ("refused by the ISG"); 4, 5, 11 and unknown codes may have been
    applied: "sent, without confirmation", guard and follow-up reads.
    Test: exception 11 then a late apply.
  - m1: a controller id of 0x8000 is a passing failure (normal backoff,
    "controller unavailable"), not an unknown controller for 30 min.
  - m2: the controller is set only after its blocks were read; a device
    without any feature is never published to Discovery.
  - m3: documented (fr/en): in emergency, manual or an unknown mode the
    select keeps its last value; "Operating mode (read)" shows the real one.
  - m4: after a write that may have left, a new command is refused "still
    running" for 3 s (`commandSpacing`): never two settings back to back.
- **gladys_version >= 5.1.0** (as the sibling local modules); **categories
  `climate`, `energy`**, transport `local`.
- **Template demo files** (devices, scenes, widgets, weather and their
  tests) removed without trouble.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved
  (post #275). No Docker on this PC: the image was not built locally. The
  store validator runs at publication (main session).
