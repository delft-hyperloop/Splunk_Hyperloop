# Hyperloop Tuning — Splunk Custom Visualization

Schema-driven results monitor for the Delft Hyperloop DH-X prototype. Reads whatever tuning columns your search produces, groups them by subsystem into a collapsible accordion, pairs setpoint and actual signals into comparison charts, and draws an orbitable wireframe pod whose hotspots focus a subsystem on click. Read-only — it displays results, it does not change anything.

## Column Convention

Every tuning column follows the pattern `tune_{subsystem}_{name}_{role}`:

| Token | Meaning |
| --- | --- |
| `tune_` | Marks the column as tuning data. All other columns (e.g. `_time`) are ignored. |
| `{subsystem}` | Groups columns into one accordion section and one 3D hotspot. Any token works. |
| `{name}` | Free-text signal or gain label. May contain underscores. |
| `{role}` | One of `sp`, `act`, `gain`, `out`. |

Roles render as:

| Role | Render |
| --- | --- |
| `sp` + `act` (same name) | A setpoint-vs-actual chart: dashed setpoint, solid actual, shaded error band, relative-error badge. |
| `gain` | A readout chip: current value plus a drift sparkline. |
| `out` | A plain output trace. A `sp` or `act` with no partner also falls back to an output trace. |

The four subsystems `lev`, `lat`, `prop`, `therm` get friendly labels (Levitation, Lateral guidance, Propulsion, Thermal); any other token is auto-title-cased. Adding a column adds to the view; removing it removes it. No code changes required.

## Required Columns

At least one `tune_*` column. The viz adapts to whatever is present; nothing is mandatory beyond the naming convention. `_time` is used to order samples.

## Notes

- Subsystem status (stable / tuning / unstable) is derived from the worst *relative* error `mean(|actual − setpoint|) / mean(|setpoint|)` across its pairs, so a single threshold pair works regardless of units. Sections with no pairs show a neutral "monitor" status.
- The bottom-right panel is a scrollable list of **every** discovered parameter; only the parameters you select are graphed on the left. This keeps the view readable as the parameter count grows. Click a row to toggle it; scroll the list with the mouse wheel. On first load all setpoint/actual pairs are selected (or everything, if a schema has no pairs).
- Clicking a hotspot on the pod **bulk-toggles** all of that subsystem's parameters (spatial select). Clicking an accordion header collapses/expands that section.
- Selection, collapse state, and model orientation live in the browser session; they are not persisted across a dashboard reload.
- Because the schema is generic, axis values are unit-less. Bake the unit into the name if you need it (e.g. `tune_lev_airgap_mm_act`).

## Search

```spl
| makeresults count=40
| streamstats count as n
| eval _time=now()-(40-n)*2,
    tune_lev_airgap_sp=8.5, tune_lev_airgap_act=round(8.5+sin(n*0.5)*0.15,2),
    tune_lev_kp_gain=120, tune_lev_kd_gain=round(4.2+sin(n*0.2)*0.3,2),
    tune_lev_coilcurrent_out=round(40+sin(n*0.4)*6,1),
    tune_lat_offset_sp=0.5, tune_lat_offset_act=round(0.55+sin(n*0.4)*0.08,2),
    tune_lat_kp_gain=85, tune_lat_damping_out=round(0.6+sin(n*0.3)*0.1,2),
    tune_prop_thrust_sp=1200, tune_prop_thrust_act=round(1200+sin(n*0.6)*15,0),
    tune_prop_current_out=round(72+sin(n*0.3)*8,1), tune_prop_slip_out=round(0.04+sin(n*0.5)*0.01,3),
    tune_therm_motorl7_out=round(118+n*0.25,0), tune_therm_hemslb2_out=round(80+n*0.2,0)
| fields - n
```

## Configuration

| Setting | Description | Default |
| --- | --- | --- |
| `errWarnPct` | Relative error (%) above which a loop is flagged "tuning" | `5` |
| `errCritPct` | Relative error (%) above which a loop is flagged "unstable" | `15` |
| `modelAutoRotate` | Slowly spin the 3D pod (dragging overrides) | `true` |
| `partMap` | Optional JSON mapping subsystem to a `[x, y, z]` hotspot position, e.g. `{"lev":[0.8,0,0.4]}`. Unmapped subsystems auto-arrange. | _(empty)_ |
| `colorScheme` | `dark` (muted purple/teal) or `neon` (vivid electrics) | `dark` |

## Time Range

`-2m` to `now` (historical). Do NOT use real-time (`rt-2m` to `rt`) — Splunk Cloud vetting rejects real-time saved searches (`check_for_real_time_saved_searches_for_cloud`).

## Build

From the repo root:

```bash
./build.sh hyperloop_tuning
```

The tarball is output to `dist/hyperloop_tuning-1.0.0.tar.gz`.
