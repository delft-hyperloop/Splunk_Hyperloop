# Hyperloop Analysis — Splunk Custom Visualization

Run-analysis workbench for the Delft Hyperloop DH-X prototype. A superset of the Hyperloop Data dashboard: same schema-driven browsing, plus time-navigation (zoom, replay, dual cursors) and an Analysis Lab for on-the-fly correlation, spectrum (FFT), and signal statistics. Read-only — it displays data, it does not change anything.

## Time navigation

A control strip sits at the top of the charts column:

- **Range menu** — a `Range` dropdown windows the data to a recent interval (All time / Last 5 min / 30 min / 1 hour / 6 hours / 24 hours). It drives **both** the charts and the Analysis Lab, computed relative to the latest sample. Available in the control strip and in the Lab header.
- **Brush-to-zoom** — drag horizontally across the charts to zoom every chart (and the time axis) to that window. The `⟲ reset zoom` button (appears when zoomed) restores the full run; the Range menu shows "Custom (brushed)" while a brush window is active.
- **Pin / Δ cursor** — single-click on the charts pins a cyan reference cursor; while hovering, the tooltip then shows the **delta** of every graphed signal between the pinned point and the cursor. Click again to unpin.
- **Double-click to maximize** — double-click any chart to expand it to fill the column for a clearer view (with its own axis and cursors); double-click again, or use `✕ back`, to restore the stack.

## Analysis Lab

Click **⚗ Lab** in the control strip to open a full-panel overlay (the in-viz stand-in for a separate window). Nothing is hardcoded — pick the variables with the dropdowns:

- **Operation** — choose signal **A**, an **operation**, and signal **B**. `correlation` draws an X-vs-Y scatter with the Pearson `r` and a regression line; the arithmetic operations (`A − B`, `A + B`, `A × B`, `A ÷ B`) compute the elementwise result and draw it as a derived time-series. New operations are easy to add — append one entry to the `LAB_OPS` table in `visualization_source.js` (a `key`, `label`, `kind`, and for series ops a `fn(a, b)`); rendering is generic.
- **Spectrum** — choose a signal → magnitude spectrum (DFT) with the dominant frequency marked (Hz when `_time` spacing is known, else cycles/sample).
- **Signal stats** — choose a signal → time plot with a moving average, a ±σ band, and μ / σ / min / max.

Every Lab plot has the same cursors as the main charts: a **hover crosshair** (vertical for the line plots, nearest-point highlight for the scatter) with a value tooltip, and a **pinned cursor** (click) that adds a delta readout. Each plot also supports **brush-to-zoom** — drag to magnify a region of the plot (a frequency band, a time window, or an X×Y box for the scatter); **double-click resets** the zoom. The Lab analyses whatever the `Range` menu selects. `✕ close` returns to the dashboard. Range, zoom, pins, focus, and lab selections are session-only (not persisted across reload).

## Browsing (built for large parameter counts)

- **Filter box** — type to narrow the parameter list by name, subsystem, or role.
- **Sort / quick-filters** — chips to sort the list worst-error-first, cycle the role filter (`all` → `pair` → `gain` → `out`), and show only unstable loops.
- **Per-department on/off** — each department header in the parameter list carries an `◉ all` toggle (◉ all on · ◐ some on · ○ none): click the header to graph or hide that whole department's signals at once. (Clicking a pod hotspot does the same spatially.)
- **Per-row previews** — each list row shows a status dot and a mini sparkline so you can judge a signal before graphing it.
- **Overview heatmap** — a grid of every parameter (coloured by status) sits above the graphs; click a cell to graph that signal.
- **Hover crosshair** — hovering the charts draws a synchronized vertical cursor with a tooltip of each graphed signal's value and the timestamp at that instant.
- **Stats footer** — each chart shows min / max / avg when tall enough.
- **CSV export** — the `⭳ CSV` button in the control strip downloads the currently-graphed signals over the current time window (separator `;`, decimal `.`, ISO timestamps, full header). If the browser blocks the download (e.g. a sandboxed iframe) it falls back to copying the CSV to the clipboard.
- **Persistent layout** — selection, collapsed sections, sort/role/unstable chips, and the active Range are saved to the browser and restored on reload (`localStorage` key `hyperloop_analysis.viewstate.v1`).
- **Auto-decimation** — charts cap at ~3000 drawn points so long accumulating runs stay smooth; zooming into a window restores full detail, and CSV export always uses the un-thinned data.

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

The departments `sys`, `loc`, `lev`, `prop`, `therm`, `pwr` get friendly labels (System / FSM, Localization, Levitation, Propulsion, Thermal, Powertrain) — the six sections of `splunk_index_classification.md` — each with its own accent colour shared consistently across the section header, the chart line, the parameter-list label/dots, the overview cells, and the pod hotspot.

**Strict classification:** the viz charts **only** these six departments. Any `tune_*` column whose leading token is not one of them (e.g. an unlisted `tune_sense_and_control_*` subsystem) is **dropped entirely** — it will not appear as a stray department. To chart a new subsystem, add it to the `KNOWN_LABELS`/`ACCENTS` maps in `visualization_source.js` (and to the classification markdown). Adding a column within a known department adds to the view; removing it removes it.

## Required Columns

At least one `tune_*` column. The viz adapts to whatever is present; nothing is mandatory beyond the naming convention. `_time` is used to order samples.

## Notes

- Subsystem status (stable / tuning / unstable) is derived from the worst *relative* error `mean(|actual − setpoint|) / mean(|setpoint|)` across its pairs, so a single threshold pair works regardless of units. Sections with no pairs show a neutral "monitor" status.
- The bottom-right panel is a scrollable list of **every** discovered parameter; only the parameters you select are graphed on the left. This keeps the view readable as the parameter count grows. Click a row to toggle it; scroll the list with the mouse wheel. On first load all setpoint/actual pairs are selected (or everything, if a schema has no pairs).
- Clicking a hotspot on the pod **bulk-toggles** all of that subsystem's parameters (spatial select). Clicking an accordion header collapses/expands that section.
- Selection, collapse state, and model orientation live in the browser session; they are not persisted across a dashboard reload.
- Because the schema is generic, axis values are unit-less. Bake the unit into the name if you need it (e.g. `tune_lev_airgap_mm_act`).

## Datapoints (DH-X schema)

The columns are the **complete** DH-X datapoint set from
`splunk_index_classification.md` (the sole source of truth). **Both** METRIC- and
EVENT-class datapoints are shown, grouped under the **same six subdepartments**
as the doc — the metrics/events index split only governs the Splunk pipeline, not
which subdepartment a signal appears under. Per-column index membership is listed
in `README/index_membership.csv` (438 columns: 207 metrics, 231 events).

Subdepartments (doc order): `sys` System / FSM · `loc` Localization · `lev`
Levitation · `prop` Propulsion · `therm` Thermal (its own department) · `pwr`
Powertrain. **Every array family is expanded to one column per channel** (real
currents 0–23, DC-bus voltages 0–23, drive status/diagnostics/control words 0–23,
motor temps FL1–BR4, flows L1–R6, …).

Rendering of event-class signals: states/enums/faults/flags/counters render as
plain `out` step traces; PID gains render as `gain` chips. Opaque signals
(hashes, raw CAN log, the unused DefaultDatatype sentinel) are omitted — they are
not chartable. DECIDE items follow the doc's recommendations: control targets and
prop target-velocity → METRIC `sp` (paired with actual); PID gains, position
limits / max thrust, diagnostic counters → EVENT; HV/BMS low/high → EVENT
(threshold breach flags).

## Search

The demo generator in `default/savedsearches.conf` (`[Hyperloop Analysis - Demo]`)
reproduces the full 438-column schema with `| makeresults`. For live data, the
viz needs both indexes pivoted into one `tune_*` table. Pull the numeric metrics
with `mstats`, the discrete states with a `stats`-pivot of the events index, then
join on `_time`:

```spl
| mstats avg(_value) WHERE index=telemetry_metrics BY metric_name span=1s
| eval col = "tune_" . replace(metric_name, "\.", "_") . "_out"
| xyseries _time col "avg(_value)"
| append
    [ search index=telemetry_events
    | timechart span=1s
        last(lev.state) as tune_lev_state_out
        last(sys.fsmstate) as tune_sys_fsmstate_out
        /* …one clause per event signal you want charted… */ ]
| stats values(*) as * by _time
```

Map the metric name to match the column convention `tune_{sub}_{name}_{role}`
(e.g. emit `lev.z.act` so it becomes `tune_lev_z_act`; the setpoint/actual pairs
then auto-chart with an error band). `README/index_membership.csv` lists every
column and which index it comes from, so you can script the two halves of the
query from it.

## Configuration

| Setting | Description | Default |
| --- | --- | --- |
| `errWarnPct` | Relative error (%) above which a loop is flagged "tuning" | `5` |
| `errCritPct` | Relative error (%) above which a loop is flagged "unstable" | `15` |
| `showOverview` | Show the all-parameters overview heatmap above the graphs | `true` |
| `showRowPreview` | Show mini sparklines in the parameter-list rows | `true` |
| `sampleIntervalMs` | Keep at most one data point per this many milliseconds (0 = all). Decimates the data for the charts and the Lab. | `0` |
| `sampleOffsetMs` | Phase offset (ms) for the sampling interval — shifts which point is kept in each bucket. | `0` |
| `modelAutoRotate` | Slowly spin the 3D pod (dragging overrides) | `true` |
| `partMap` | Optional JSON mapping subsystem to a `[x, y, z]` hotspot position, e.g. `{"lev":[0.8,0,0.4]}`. Unmapped subsystems auto-arrange. | _(empty)_ |
| `colorScheme` | `dark` (muted purple/teal) or `neon` (vivid electrics) | `dark` |

## Time Range

`-2m` to `now` (historical). Do NOT use real-time (`rt-2m` to `rt`) — Splunk Cloud vetting rejects real-time saved searches (`check_for_real_time_saved_searches_for_cloud`).

## Build

From the repo root:

```bash
./build.sh hyperloop_analysis
```

The tarball is output to `dist/hyperloop_analysis-1.0.0.tar.gz`.
