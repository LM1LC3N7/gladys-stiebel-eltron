# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- STIEBEL ELTRON heat pumps read through the Modbus TCP interface of the ISG
  (no cloud, no account), by its IP address: WPM 3, WPM 3i, WPMsystem and
  LWZ/LWA controllers, recognised by their identification; the LWZ R290
  is read with the WPM registers it serves.
- A block whose start the ISG refuses is read once more from a start it
  answered in the same poll (as pystiebeleltron's read retry).
- One device with the outside, flow, return, hot water and room
  temperatures, room humidity, the heating and hot water setpoints (comfort
  and eco), the hot water target in effect, the operating mode, compressor,
  electric booster and fault states, and the energy counters (electricity
  used and heat produced, today and total, heating and hot water, booster
  heat) as plain values, never an energy index.
- Three commands behind "Allow the commands" (off by default): the
  operating mode (a list, never a switch), the heating setpoint (comfort,
  heating circuit 1) and the hot water setpoint (comfort). The emergency
  and LWZ manual modes are never selected nor left.
- Hot water ceiling: 55 °C by default, configurable from 40 to 60 °C, never
  above 60 °C; checked on arrival and again right before the write.
- Each command reads the parameters again and writes in the same turn of
  the Modbus connection (no other request in between); one that cannot
  leave within 3.5 s is refused unsent; a write the ISG does not echo (or
  answers with a Modbus error that does not say it was rejected) is "sent,
  without confirmation", read again 5 and 20 s later; at least 3 s between
  two writes.
- Own Modbus TCP client: one request at a time, every answer matched to its
  request (transaction, unit, function, size, exact echo), 260 bytes at
  most, the connection dropped on a timeout or a stray answer.
- Reads every 30 s (configurable); failures retried after 30 s to 5
  minutes; a register block the controller does not serve is dropped, a
  secondary block failing never blocks the main values.
- A republished device never loses a feature; status, Discovery and badge
  sent again at every reconnection to Gladys.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-stiebel-eltron/commits/main
