# Hyperloop Dynamics — Splunk Custom Visualization

Full-panel telemetry monitor for the Delft Hyperloop DH-X prototype. Displays laser offset sensor sparklines, pod position and airgap, HEMS/EMS/motor temperature grids, and HV/LV battery status in a single canvas panel.

## Install

1. Copy or symlink the `hyperloop_dynamics/` directory into `$SPLUNK_HOME/etc/apps/`
2. Restart Splunk: `splunk restart`
3. The "Hyperloop Dynamics" visualization appears in the viz picker.

## Required Columns

| Column | Type | Description |
| --- | --- | --- |
| `_time` | number | Unix timestamp of each telemetry sample |
| `vfl`, `vfr`, `vml`, `vmr`, `vbl`, `vbr` | number | Vertical laser offsets (mm): Front/Middle/Back × Left/Right |
| `lfl`, `lfr`, `lml`, `lmr`, `lbl`, `lbr` | number | Lateral laser offsets (mm): Front/Middle/Back × Left/Right |
| `position` | number | Pod position along track (m) |
| `speed` | number | Pod speed (m/s) |
| `airgap_current` | number | Current levitation airgap (mm) |
| `airgap_target` | number | Target levitation airgap (mm) |
| `hems_vf1`, `hems_vf2`, `hems_vb1`, `hems_vb2` | number | HEMS vertical temperatures (°C) |
| `hems_lf1`, `hems_lf2`, `hems_lb1`, `hems_lb2` | number | HEMS lateral temperatures (°C) |
| `ems_vf1`, `ems_vf2`, `ems_vb1`, `ems_vb2` | number | EMS vertical temperatures (°C) |
| `ems_lf1`, `ems_lf2`, `ems_lb1`, `ems_lb2` | number | EMS lateral temperatures (°C) |
| `motor_l1` … `motor_l8` | number | Motor left-side temperatures (°C) |
| `motor_r1` … `motor_r8` | number | Motor right-side temperatures (°C) |
| `hv_soc` | number | High-voltage battery state of charge (%) |
| `hv_power` | number | High-voltage power draw (kW) |
| `lv_soc` | number | Low-voltage battery state of charge (%) |
| `lv_power` | number | Low-voltage power draw (W) |

## Notes

- All rows are sorted by `_time` ascending; the latest row is shown in position/airgap/battery readouts.
- Sparklines plot all rows in the result set over time (up to the `count` limit in `getInitialDataParams`).
- Clicking the HV/LV battery tabs switches the battery panel display.
- Temperature cells are colour-coded: blue (cool) → teal (warn) → orange (critical) → red (above critical).
- Airgap `CURRENT` bar colour indicates deviation from target: teal < 0.5 mm, orange < 1.5 mm, red ≥ 1.5 mm.

## Search

```spl
| makeresults count=30
| streamstats count as n
| eval _time=now()-(30-n)*2,
    vfl=round(sin(n*0.4)*4,2), vfr=round(sin(n*0.4+0.3)*4,2),
    vml=round(sin(n*0.35)*3,2), vmr=round(sin(n*0.35+0.2)*3,2),
    vbl=round(sin(n*0.3)*4,2), vbr=round(sin(n*0.3+0.4)*4,2),
    lfl=round(sin(n*0.5)*5,2), lfr=round(sin(n*0.5+0.5)*5,2),
    lml=round(sin(n*0.45)*4,2), lmr=round(sin(n*0.45+0.3)*4,2),
    lbl=round(sin(n*0.4)*5,2), lbr=round(sin(n*0.4+0.6)*5,2),
    position=round(n*2.8,1), speed=12.0,
    airgap_current=round(8.5+sin(n*0.7)*0.3,2), airgap_target=8.5,
    hems_vf1=52, hems_vf2=68, hems_vb1=75, hems_vb2=61,
    hems_lf1=48, hems_lf2=45, hems_lb1=63, hems_lb2=91,
    ems_vf1=55, ems_vf2=71, ems_vb1=85, ems_vb2=58,
    ems_lf1=67, ems_lf2=53, ems_lb1=79, ems_lb2=64,
    motor_l1=68, motor_l2=82, motor_l3=101, motor_l4=98,
    motor_l5=75, motor_l6=59, motor_l7=132, motor_l8=83,
    motor_r1=77, motor_r2=94, motor_r3=61, motor_r4=138,
    motor_r5=78, motor_r6=59, motor_r7=128, motor_r8=83,
    hv_soc=round(87-n*0.5,1), hv_power=round(18+sin(n*0.6)*4,1),
    lv_soc=95, lv_power=round(95+sin(n*0.8)*20,0)
| fields - n
```

## Configuration

| Setting | Description | Default |
| --- | --- | --- |
| `offsetRange` | Y-axis range for laser sparklines in ±mm | `15` |
| `trackLength` | Full track length in metres for the position bar | `100` |
| `airgapMin` | Lower bound of the airgap bar scale (mm) | `5` |
| `airgapMax` | Upper bound of the airgap bar scale (mm) | `15` |
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
./build.sh hyperloop_dynamics
```

The tarball is output to `dist/hyperloop_dynamics-1.0.0.tar.gz`.
