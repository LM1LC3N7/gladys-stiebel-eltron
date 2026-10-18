# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## pystiebeleltron (python-stiebel-eltron)

<https://github.com/ThyMYthOS/python-stiebel-eltron> (package
`pystiebeleltron`, the library of Home Assistant's STIEBEL ELTRON
integration), by Martin Fuchs and contributors. MIT License (`LICENSE` of
the repository, version 0.9.2, tag `v0.9.2`). Its notice:

```
MIT License

Copyright (c) 2018 Martin Fuchs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ported in `src/isg.js` and `src/constants.js`: the Modbus TCP access to the
ISG (port 502, unit 1); the controller identification (input register 5001)
and the model ids (103, 104, 551 for LWZ/LWA; 390 WPM 3, 391 WPM 3i, 449
WPMsystem); the register addresses (zero-based, the manual minus one) of the
temperatures, setpoints, operating mode, operating status, fault status and
energy counters of the WPM and LWZ tables (`api/*.csv`, `wpm.py`, `wpm3.py`,
`wpm3i.py`, `lwz.py`); the register ranges each variant serves; the data
types (tenths of °C, unsigned counters) and the unavailable value 0x8000
(and 0x9000 on some WPM 3i registers); the energy totals split into kWh
below 1000 and MWh; the LWZ operating modes (`OperatingMode`) and status
bits; the write ranges of the setpoints and the mode. From Home Assistant's
STIEBEL ELTRON integration (which uses the library): the room setpoint of
an LWZ is its day temperature of heating circuit 1, and the 30 s refresh.

Changed: the Modbus client is our own (`src/modbus/client.js`, function
codes 3, 4 and 6 only), with one request at a time and every answer checked
against its request; only the registers shown are read, in blocks inside
the ranges every variant serves; a value out of its plausible range is
unknown; the energy counters are shown as plain values, the day and the
total apart (pystiebeleltron's running "day and total" maximum is not
used); the WPM operating modes are numbered from the manual; the emergency
and LWZ manual modes are never selected nor left; the hot water setpoint is
capped (55 °C by default, 60 °C at most) and each command re-reads the
parameters right before writing.
