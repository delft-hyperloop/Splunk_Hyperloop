# Hyperloop Endurance — Splunk Custom Visualization

Endurance and performance telemetry monitor for the Delft Hyperloop DH-X prototype. Presents every signal in historical time-series form across three columns — run dynamics, battery, and thermal — so trends and correlations are visible at a glance over a full run.

## Install

1. Copy or symlink the `hyperloop_endurance/` directory into `$SPLUNK_HOME/etc/apps/`
2. Restart Splunk: `splunk restart`
3. The "Hyperloop Endurance" visualization appears in the viz picker.

## Required Columns

| Column | Type | Description |
| --- | --- | --- |
| `_time` | number | Unix timestamp of each telemetry sample |
| `speed` | number | Pod speed (m/s) |
| `position` | number | Distance covered along the track (m) |
| `hv_soc` | number | High-voltage pack state of charge (%) |
| `hv_voltage` | number | High-voltage pack voltage (V) |
| `hv_current` | number | High-voltage pack current (A) |
| `hv_power` | number | High-voltage power draw (kW) |
| `lv_soc` | number | Low-voltage pack state of charge (%) |
| `lv_voltage` | number | Low-voltage pack voltage (V) |
| `lv_current` | number | Low-voltage pack current (A) |
| `lv_power` | number | Low-voltage power draw (W) |
| `hems_vf1`, `hems_vf2`, `hems_vb1`, `hems_vb2` | number | HEMS vertical temperatures (°C) |
| `hems_lf1`, `hems_lf2`, `hems_lb1`, `hems_lb2` | number | HEMS lateral temperatures (°C) |
| `ems_vf1`, `ems_vf2`, `ems_vb1`, `ems_vb2` | number | EMS vertical temperatures (°C) |
| `ems_lf1`, `ems_lf2`, `ems_lb1`, `ems_lb2` | number | EMS lateral temperatures (°C) |
| `motor_l1` … `motor_l8` | number | Motor left-side temperatures (°C) |
| `motor_r1` … `motor_r8` | number | Motor right-side temperatures (°C) |

## Notes

- All rows are sorted by `_time` ascending; line charts plot the full result window and current values are read from the latest row.
- Battery power charts use filled areas; voltage and current use plain lines. Each Y-axis auto-scales to its own channel with min/max hints.
- Thermal data is shown as ribbons: one horizontal strip per channel, with colour encoding temperature over time (blue → teal → orange → red). A dashed divider separates the motor LEFT and RIGHT banks.
- HEMS/EMS strips and motor strips use independent warning/critical thresholds.

## Search

```spl
| makeresults count=60
| streamstats count as n
| eval _time=now()-(60-n)*2,
    speed=round(13+sin(n*0.25)*3,2), position=round(n*2.8,1),
    hv_voltage=round(560-n*0.25+sin(n*0.5)*2,1),
    hv_current=round(70+sin(n*0.3)*10,1),
    hv_power=round(hv_voltage*hv_current/1000,1),
    hv_soc=round(87-n*0.4,1),
    lv_voltage=round(25.4+sin(n*0.4)*0.6,2),
    lv_current=round(10+sin(n*0.35)*2,1),
    lv_power=round(lv_voltage*lv_current,0),
    lv_soc=round(96-n*0.1,1),
    hems_vf1=round(50+sin(n*0.3)*6,0), hems_vf2=round(66+sin(n*0.25)*5,0),
    hems_vb1=round(73+sin(n*0.2)*5,0), hems_vb2=round(60+sin(n*0.3)*5,0),
    hems_lf1=round(47+sin(n*0.35)*4,0), hems_lf2=round(45+sin(n*0.3)*4,0),
    hems_lb1=round(62+sin(n*0.25)*5,0), hems_lb2=round(85+n*0.15,0),
    ems_vf1=round(54+sin(n*0.3)*5,0), ems_vf2=round(70+sin(n*0.25)*5,0),
    ems_vb1=round(82+n*0.1,0), ems_vb2=round(57+sin(n*0.3)*4,0),
    ems_lf1=round(66+sin(n*0.3)*5,0), ems_lf2=round(52+sin(n*0.35)*4,0),
    ems_lb1=round(78+sin(n*0.2)*4,0), ems_lb2=round(63+sin(n*0.3)*4,0),
    motor_l1=round(64+n*0.1,0), motor_l2=round(80+sin(n*0.3)*5,0),
    motor_l3=round(95+n*0.15,0), motor_l4=round(92+n*0.12,0),
    motor_l5=round(73+sin(n*0.3)*5,0), motor_l6=round(58+sin(n*0.35)*4,0),
    motor_l7=round(120+n*0.25,0), motor_l8=round(81+sin(n*0.25)*5,0),
    motor_r1=round(75+sin(n*0.3)*5,0), motor_r2=round(92+sin(n*0.25)*5,0),
    motor_r3=round(60+sin(n*0.3)*4,0), motor_r4=round(128+n*0.3,0),
    motor_r5=round(76+sin(n*0.3)*5,0), motor_r6=round(58+sin(n*0.35)*4,0),
    motor_r7=round(118+n*0.25,0), motor_r8=round(81+sin(n*0.25)*5,0)
| fields - n
```

## Configuration

| Setting | Description | Default |
| --- | --- | --- |
| `trackLength` | Reference track length in metres for distance context | `100` |
| `tempWarnHems` | HEMS/EMS warning temperature (°C) | `70` |
| `tempCritHems` | HEMS/EMS critical temperature (°C) | `90` |
| `tempWarnMotor` | Motor warning temperature (°C) | `100` |
| `tempCritMotor` | Motor critical temperature (°C) | `130` |
| `colorScheme` | `dark` (muted purple/teal) or `neon` (vivid electrics) | `dark` |

## Time Range

`-2m` to `now` (historical). Do NOT use real-time (`rt-2m` to `rt`) — Splunk Cloud vetting rejects real-time saved searches (`check_for_real_time_saved_searches_for_cloud`).

## Build

From the repo root:

```bash
./build.sh hyperloop_endurance
```

The tarball is output to `dist/hyperloop_endurance-1.0.0.tar.gz`.
