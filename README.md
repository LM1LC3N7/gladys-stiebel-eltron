# gladys-stiebel-eltron

[Gladys Assistant](https://gladysassistant.com) external integration for
**STIEBEL ELTRON** heat pumps through the **ISG** (Internet Service
Gateway) and its local **Modbus TCP** interface: temperatures, setpoints,
operating mode, compressor and booster, energy, and three commands (mode,
heating setpoint, hot water setpoint capped at 55 °C by default) behind an
off-by-default option. **Never tested with a real ISG. Not affiliated with
STIEBEL ELTRON.** Modbus has no authentication: keep the ISG on a trusted
network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (StiebelApp)
                                  ├─ src/isg.js            registers, blocks, decoding (pystiebeleltron)
                                  ├─ src/modbus/client.js  Modbus TCP: functions 3, 4, 6, one request at a time
                                  ├─ src/devices.js        the device and its states (pure)
                                  └─ src/publisher.js      states within 300/min
```

- **Reads**: the controller identification (input 5001) then a few blocks
  of input and holding registers, every 30 s (10 s – 10 min). WPM 3, WPM 3i
  and WPMsystem share one register map (`wpm`), the LWZ/LWA controllers
  another (`lwz`); the blocks stay inside the ranges each variant serves. A
  block refused with "illegal data address" before it ever answered is not
  read again; a secondary block failing never blocks the main values.
  Failures retried after 30 s, 1, 2, 5 min, never under the interval.
- **Modbus client** (own, `node:net`): one request in flight; an answer
  must match the transaction id, the protocol id, the unit and the
  function, have the byte count asked (a write: its exact echo), and fit in
  260 bytes; anything else, data arriving with no request, or a timeout
  drops the connection, so a late answer is never taken for another
  request's.
- **Device**: `ext:<selector>:stiebel-eltron:<family>`; features appear once
  their register gave a value and are never lost on a republication.
  Temperatures `temperature-sensor` (`probe` for water, outside and
  setpoints), heating setpoint `thermostat/target-temperature`, hot water
  setpoint `water-heater/target-temperature`, mode `text/select`, compressor,
  booster and fault `unknown/binary`, energy `unknown/decimal` (never an
  index: the ISG totals are not known to be cumulative and reliable).
- **Commands** (`allow_commands`, off by default): never a switch. The
  command holds the Modbus connection from a fresh read of the parameters
  to the end of the write, decides on that read only, checks the option and
  the hot water ceiling again right before the bytes leave, leaves within
  3.5 s of the click or is refused unsent, and is answered by 4.3 s; a
  write without its echo is "sent, without confirmation", followed by reads
  5 s and 20 s later. Emergency and LWZ manual modes are never selected nor
  left. Hot water: whole degrees, ceiling 55 °C by default, configurable
  40–60 °C, never above 60 °C.
- **Guards**: after a write, until a read shows it (or 90 s), the same
  setting is sent again even when the read shows the wanted value; a read
  equal to the start value lifts nothing.

## Credits

The register map, the controller ids, the data types and the LWZ modes are
ported from
[pystiebeleltron](https://github.com/ThyMYthOS/python-stiebel-eltron)
(Martin Fuchs and contributors, MIT, 0.9.2), the library of Home
Assistant's STIEBEL ELTRON integration. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the sibling
integration [gladys-duco](https://github.com/LM1LC3N7/gladys-duco) (local,
commands behind an option).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: the ISG is a fake behind the injected socket
factory (`test/fixtures/fakeIsg.js`), Gladys is the SDK's fake;
`test/client.test.js` also runs the real transport against a loopback
server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
