# Hyperloop Analysis — release history

Build artifacts live in `dist/hyperloop_analysis-<version>.tar.gz` (not committed —
regenerate with `./build.sh hyperloop_analysis`). **Always install the latest** —
each version is cumulative and supersedes the one before it. Every release is
logic-verified (headless render harness), but not yet QA'd visually in a live
browser, so eyeball the newest in Splunk after installing.

Install: `$SPLUNK_HOME/bin/splunk install app dist/hyperloop_analysis-<version>.tar.gz && splunk restart`

| Version | Build | Headline |
|---|---|---|
| 1.1.0 | 7 | Reschema to the ground-station handoff (399 datapoints) + enum renderers |
| 1.1.1 | 8 | Ships two dashboards + app nav |
| 1.1.2 | 9 | Removes the Overview heatmap band |
| 1.1.3 | 10 | Readability pass: calmer palette, semantic zoom, units, search, minimap |
| 1.1.4 | 11 | Crosshair fixes: time Δ vs pin, stop the clock "ticking" |

---

## 1.1.0 — Reschema to the GS handoff
The big one. Realigned the whole app to what the ground station actually emits
(`docs/splunk/splunk_app_handoff.md`).
- **Schema:** 399 datapoints (223 metric / 176 event), down/over from the old 438.
  Regenerated the demo search, the harness sample data, and `index_membership.csv`
  together. Removed not-forwarded families (old sys FSM/heartbeat/checks except
  `podstate`, laser offsets, body attitude, PID gains, legacy thermal, HV/BMS
  thresholds); added the new thermal block (EMS/HEMS/motor quadrants/flow/flowarray)
  and the renamed signals (`realcurrents`, `dclinkvoltage`, `pwr.state`, …).
- **Groups:** preset multi-series groups remodeled to the 30 current array families.
- **Enums:** discrete signals now render as a **state-timeline band** (pwr.state,
  podstate, …) or a **bit-lane grid** (pwr.errorstatus, pwr.imdwarnings) instead of
  meaningless line traces, driven by a decode registry from handoff §5.
- `sys` label → "System / S&C"; `loc` recognised but unused.

## 1.1.1 — Dashboards
- Added two classic Simple XML dashboards: **Hyperloop Analysis (Live)** (time
  picker, colour-scheme + decimation inputs, 5 s refresh, the metrics+events pivot)
  and **Demo** (self-contained `| makeresults`, no data source needed).
- Added an app nav so both appear in the app menu.
- Fixed a stale `visualizations.conf` `search_fragment` that referenced the removed
  `airgap` signal.

## 1.1.2 — Remove the Overview heatmap
- Removed the top "Overview" cell grid and its `showOverview` setting everywhere
  (renderer, hit-testing, formatter, spec, conf, harness, docs). The lower-right
  parameter list (with per-department `◉ all` toggles + the GROUPS section) is now
  the sole way to add/remove graphs; the reclaimed space goes to the charts.

## 1.1.3 — Readability pass
Five presentation changes (data layer untouched):
- **Calmer standard palette:** muted, low-saturation department/series colours so
  24-channel overlays read as calm shapes, not noise. Now the default.
- **Semantic zoom:** a small chart shows just a sparkline + a prominent current
  value; the Y-axis appears as it grows, the min/max/avg footer only when tall.
- **Units on axes:** chart headers/tooltips/maximize now show real units (`mm/s`,
  `°C`, `A`, `V`, `rad`, …) sourced verbatim from the producer's `config/dataflow.yaml`.
- **Type-to-focus search:** the parameter filter is now a search box — match count,
  **Enter** graphs every match, **Esc** clears.
- **Full-run minimap:** while zoomed, a thin strip shows where the current window
  sits in the whole run; **click to slide** the window.

## 1.1.4 — Crosshair fixes
- The crosshair tooltip's **time row now shows a signed Δ vs the pinned cursor**
  (e.g. `+8.00s`), consistent with the value deltas.
- Fixed the time **"ticking" with the wall clock**: the auto-rotate timer no longer
  re-renders while you're hovering a tooltip, have a chart maximized, or have the Lab
  open — so the crosshair time stays fixed on the sample under it. (In live Splunk the
  window still legitimately advances on each 5 s data refresh; the Δt is the stable
  reading during analysis.)
