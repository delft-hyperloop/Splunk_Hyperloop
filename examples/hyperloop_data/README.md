# Hyperloop Data — Splunk Custom Visualization

Schema-driven telemetry data dashboard for the Delft Hyperloop DH-X prototype. Reads whatever telemetry columns your search produces, groups them by subsystem, and lets you browse, filter, preview, and graph any signal. It pairs setpoint and actual signals into comparison charts, shows an all-parameters overview heatmap, a synchronized hover crosshair, optional run-phase bands and event markers, and an orbitable wireframe pod whose hotspots bulk-select a subsystem. Read-only — it displays data, it does not change anything.

## Browsing (built for large parameter counts)

- **Filter box** — type to narrow the parameter list by name, subsystem, or role.
- **Sort / quick-filters** — chips to sort the list worst-error-first, cycle the role filter (`all` → `pair` → `gain` → `out`), and show only unstable loops.
- **Per-row previews** — each list row shows a status dot and a mini sparkline so you can judge a signal before graphing it.
- **Overview heatmap** — a grid of every parameter (coloured by status) sits above the graphs; click a cell to graph that signal.
- **Hover crosshair** — hovering the charts draws a synchronized vertical cursor with a tooltip of each graphed signal's value and the timestamp at that instant.
- **Phase bands & event markers** — optional `phase` and `event` columns shade run phases behind the charts and annotate moments on the time axis.
- **Stats footer** — each chart shows min / max / avg when tall enough.

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

## Optional Columns

| Column | Type | Description |
| --- | --- | --- |
| `phase` | string | Run phase per sample (e.g. `accel`, `cruise`, `brake`). Contiguous equal values render as a shaded band behind every chart. |
| `event` | string | Non-empty values draw a vertical marker with the label on the time axis. |
| `event_type` | string | Optional category for an event (reserved for future styling). |

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
    tune_therm_motorl7_out=round(118+n*0.25,0), tune_therm_hemslb2_out=round(80+n*0.2,0),
    phase=case(n<=13,"accel",n<=27,"cruise",1=1,"brake"),
    event=case(n=14,"top speed",n=28,"brake start",1=1,""),
    event_type=case(n=14 OR n=28,"mark",1=1,"")
| fields - n
```

## Configuration

| Setting | Description | Default |
| --- | --- | --- |
| `errWarnPct` | Relative error (%) above which a loop is flagged "tuning" | `5` |
| `errCritPct` | Relative error (%) above which a loop is flagged "unstable" | `15` |
| `showOverview` | Show the all-parameters overview heatmap above the graphs | `true` |
| `showRowPreview` | Show mini sparklines in the parameter-list rows | `true` |
| `modelAutoRotate` | Slowly spin the 3D pod (dragging overrides) | `true` |
| `partMap` | Optional JSON mapping subsystem to a `[x, y, z]` hotspot position, e.g. `{"lev":[0.8,0,0.4]}`. Unmapped subsystems auto-arrange. | _(empty)_ |
| `colorScheme` | `dark` (muted purple/teal) or `neon` (vivid electrics) | `dark` |

## Time Range

`-2m` to `now` (historical). Do NOT use real-time (`rt-2m` to `rt`) — Splunk Cloud vetting rejects real-time saved searches (`check_for_real_time_saved_searches_for_cloud`).

## Build

From the repo root:

```bash
./build.sh hyperloop_data
```

The tarball is output to `dist/hyperloop_data-1.0.0.tar.gz`.
