# Donut Chart — Splunk Custom Visualization

Renders search results as a proportional donut chart with a configurable center
label and colour-coded legend. Each row in the search result becomes one segment;
segment size is proportional to its `value`. Segments are sorted largest-first and
coloured using one of three built-in palettes.

## Install

1. Copy or symlink the `donut_chart/` directory into `$SPLUNK_HOME/etc/apps/`
2. Restart Splunk: `splunk restart`
3. The "Donut Chart" visualization appears in the viz picker.

## Required Columns

| Column | Type | Description |
| --- | --- | --- |
| `label` | string | Segment label shown in the legend |
| `value` | number | Segment size (must be positive; zero/negative rows are skipped) |

## Notes

- Rows with non-positive or non-numeric `value` are silently skipped.
- Segments are sorted by value descending before drawing.
- When `centerLabel` is empty, the formatted sum of all values is shown in the center.
- The legend switches to two columns automatically when there are more than six segments and the panel is wider than 300 px.

## Search

```spl
index=_internal
| stats count by sourcetype
| rename sourcetype as label, count as value
```

## Configuration

| Setting | Description | Default |
| --- | --- | --- |
| `colorScheme` | Colour palette: `splunk`, `vibrant`, or `pastel` | `splunk` |
| `innerRadius` | Donut hole size: `thin` (40%), `medium` (60%), `thick` (75%) | `medium` |
| `showGlow` | Adds a colour glow behind each segment | `true` |
| `showLegend` | Shows a colour-coded legend below the chart | `true` |
| `centerLabel` | Custom text in the center hole. Empty = display total value | _(empty)_ |

## Time Range

`-1h` to `now` (historical). Do NOT use real-time (`rt-1h` to `rt`) — Splunk Cloud
vetting rejects real-time saved searches (`check_for_real_time_saved_searches_for_cloud`).

## Build

From the repo root:

```bash
./build.sh donut_chart
```

The tarball is output to `dist/donut_chart-1.0.0.tar.gz`.
