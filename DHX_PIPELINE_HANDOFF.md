# DH-X Telemetry → Splunk Pipeline — Implementation Handoff

**Audience:** a Claude instance working on the **producer side** (the Delft Hyperloop
DH-X ground-station / Rust producer that feeds Kafka). You have no prior context;
this document is self-contained. Goal: make the producer emit telemetry in the
**canonical naming contract** below so the Splunk "Hyperloop Analysis"
visualization renders it correctly with **no remapping in Splunk**.

---

## ⭐ Source of truth (read first)

**`splunk_index_classification.md` is, from now on, the authoritative classification
the producer MUST follow when emitting telemetry.** It is shipped alongside this
handoff (same folder). For every datapoint it decides:

- which **index** it goes to — `metrics` vs `events`;
- which **department** it belongs to (one of the six canonical tokens);
- (with the role rules in §5.4) its **role** — `sp | act | gain | out`.

`GVL_GS_IDS.TcGVL` remains the raw enumeration of IDs / wire-types / units, but it
does **not** decide index or department — `splunk_index_classification.md` does.
If the two ever disagree, the classification markdown wins for routing decisions;
update it (not ad-hoc code) and regenerate `dp_classification.csv` from it. Keep
the classification markdown in lockstep with the GVL and the ground station
`config/dataflow.yaml`.

Note: the markdown still uses the human subsystem labels (System / FSM,
Localization, Levitation, Propulsion, Thermal, Powertrain) and CamelCase signal
names — map those to the canonical tokens/lowercase per §5 when emitting.

---

## 0. TL;DR of what to change

Today the producer emits names like `levitation.LeviZ`, `sense_and_control.ThermEMS0`
(long department names, CamelCase signals, a catch-all `sense_and_control`
department, no role suffix). The Splunk viz expects a strict contract and currently
needs a messy translation query to bridge the gap.

**Change the producer to emit the canonical contract directly:**

```
metric_name = "{dept}.{signal}.{role}"      # lowercase
```
- `dept` ∈ **exactly** one of: `sys loc lev prop therm pwr`
- `role` ∈ `sp | act | gain | out`
- `signal` = lowercase, no dots, digits ok (e.g. `realcurrent0`)

Examples: `lev.z.sp`, `lev.z.act`, `lev.realcurrent0.out`, `therm.motorlf0.out`,
`pwr.dclink.act`, `prop.velocity.sp`.

Do the same classification for the **events** index. Eliminate the
`sense_and_control` catch-all by assigning each of its datapoints to a real
department. Drive all of this from a single generated table
(`dp_classification.csv`) so it stays in lockstep with the source of truth.

---

## 1. System architecture (end to end)

```
DH-X pod (TwinCAT/CAN)
  → ground station (Rust producer)   ← YOU ARE HERE
    → Kafka broker (2 topics: telemetry_events, telemetry_metrics)
      → Kafka Connect (confluentinc/cp-kafka-connect + splunk/kafka-connect-splunk)
        → Splunk HEC
          → Splunk indexes: telemetry_metrics (metrics-type), telemetry_events (events-type)
            → Dashboard panel using the "Hyperloop Analysis" custom visualization
```

Kafka/Connect/HEC specifics live in the user's `KafkaTest/` directory
(`docker-compose.yml`, `splunk-sink-events.json`, `splunk-sink-metrics.json`,
`.env`). **Do not hardcode the HEC token** — read it from `KafkaTest/.env`
(`SPLUNK_HEC_TOKEN`, `SPLUNK_HEC_HOST`, `SPLUNK_HEC_PORT`). Splunk Enterprise
appears to run in Docker (the C:\Program Files\Splunk path does not exist on the host).

### Topic / sink behavior (important for payload shape)
- **`telemetry_metrics`** sink: `StringConverter` + `splunk.hec.json.event.formatted=true`.
  → The connector passes your Kafka message **verbatim** to HEC. **You must
  serialize the full HEC metric envelope yourself** (multi-metric format, below).
- **`telemetry_events`** sink: `JsonConverter`.
  → The connector **wraps** your JSON object in a HEC envelope automatically. Send
  a plain JSON object; just include the fields described below.

---

## 2. The visualization contract (NON-NEGOTIABLE)

The custom viz (`hyperloop_analysis`) discovers its schema purely from **column
names** in the Splunk search results. A column is graphed only if it matches:

```
tune_{dept}_{name}_{role}
```

Parsing rule (in the viz): split the column on `_`; **first token after `tune_`
is the department**, **last token is the role**, **everything between is the name**.

| Element | Rule |
| --- | --- |
| `dept` | **Must** be one of `sys loc lev prop therm pwr`. Any other leading token → the entire column is **dropped** (strict whitelist — this is intentional). |
| `role` | `sp`, `act`, `gain`, or `out`. |
| `name` | free text; lowercase; may contain digits. Avoid extra underscores if possible (they become part of the name, which is fine, but keep it clean). |

Role rendering:
- `sp` + `act` with the **same `{dept}` + `{name}`** → setpoint-vs-actual chart with shaded error band.
- `gain` → a value chip with a drift sparkline.
- `out` → a plain trace.
- An `sp` or `act` with **no partner** automatically falls back to an `out` trace (safe default).

The six departments and their labels (defined in the viz; do not invent others):

| token | label |
| --- | --- |
| `sys` | System / FSM |
| `loc` | Localization |
| `lev` | Levitation |
| `prop` | Propulsion |
| `therm` | Thermal |
| `pwr` | Powertrain |

> The viz lives at
> `examples/hyperloop_analysis/appserver/static/visualizations/hyperloop_analysis/src/visualization_source.js`
> (ES5, webpack-bundled). The strict whitelist is enforced in `formatData`
> (`if (!KNOWN_LABELS[sub]) continue;`). **You do not need to edit the viz** —
> your job is to make the data match the contract.

---

## 3. metrics index vs events index (Splunk semantics)

Confirmed from Splunk docs during this session:
- **Metrics index** = continuous numeric **measurements** (queried with `mstats`;
  ~500× faster, ~50% less storage). Values must be numeric.
- **Events index** = discrete **states / faults / enums / flags / heartbeats / logs**
  (you search them and care *when they changed*).

The authoritative per-datapoint classification is in
**`splunk_index_classification.md`** (the project's source of truth). Key resolved
decisions from that file:
- Control **targets** (LeviZTarget, …) and **PropTargetVelocity** → **METRIC**, role `sp`,
  paired with their actual (`act`).
- **PID gains** (Kp/Ki/Kd/Kf/Ki_initial) → **EVENT**, role `gain`.
- **Position limits / max thrust** and **diagnostic counters** → **EVENT**.
- **HV/BMS low/high** (`HvVLow/High`, `BmsTemperatureLow/High`) → **EVENT**
  (threshold **breach flags**, not measurements).
- Opaque signals (hashes, raw CAN log, the `DefaultDatatype` sentinel) → **omit**
  (not chartable).

---

## 4. Current producer output (the problem)

Captured live from the running Splunk during this session.

**Metrics** (`telemetry_metrics`): `metric_name = {department}.{Signal}` — long
department names, CamelCase signal, **no role suffix**, and a catch-all
`sense_and_control` department. Observed departments:
`levitation, powertrain, propulsion, sense_and_control, thermal`.
Examples:
```
levitation.LeviZ            levitation.LeviZTarget       levitation.LeviPitch
propulsion.PropVelocity     propulsion.PropTargetVelocity propulsion.PropIaLeft
powertrain.HvVHigh          powertrain.PTDCLinkVoltage    powertrain.ISORes
thermal.TempLeviFL1         thermal.FlowPropL1
sense_and_control.ThermEMS0 sense_and_control.ThermMotorLeftFront0
sense_and_control.BarcodePosition  sense_and_control.FlowArray0  sense_and_control.PropDutyCycle
```

**Events** (`telemetry_events`): long/EAV format — one event per reading with
fields: `department`, `datapoint`, `value`, `kind`, `pod_time_us` (+ standard
Splunk fields).

### Why this breaks the viz
- `levitation` ≠ `lev`, `propulsion` ≠ `prop`, etc. → dropped by the whitelist.
- `sense_and_control` is not a department in the markdown → dropped, but it holds
  real data (all motor/EMS/HEMS temps, flows, overheats, duty cycle, barcode).
- CamelCase + no role suffix → no setpoint/actual pairing.

---

## 5. Target: the canonical contract (what to implement)

### 5.1 Naming
- **Metrics:** `metric_name = "{dept}.{signal}.{role}"` (all lowercase).
  Splunk turns this into the column `tune_{dept}_{signal}_{role}` via a trivial
  pivot (dots→underscores). No translation logic needed on either side.
- **Events:** include a field **`name` = "{dept}.{signal}.{role}"** (preferred), or
  keep `department`/`datapoint` but add a `role` field and use the canonical
  tokens. `value` must be numeric.

### 5.2 Department remap (apply in the producer)
| current | canonical |
| --- | --- |
| `levitation` | `lev` |
| `propulsion` | `prop` |
| `powertrain` | `pwr` |
| `thermal` | `therm` |
| `sense_and_control` | **resolve per-signal** (see 5.3) |
| (localization datapoints) | `loc` |
| (system/FSM datapoints) | `sys` |

### 5.3 Resolve the `sense_and_control` catch-all
Assign each of its datapoints to a real department:
| signal pattern | → department |
| --- | --- |
| `Therm*`, `Temp*`, `Flow*`, `Overheat*` | `therm` |
| `PropDutyCycle` | `prop` |
| `Ibus2`, `Word1`, `PtcErrorEmergency` | `pwr` (or `sys` for FSM-ish) |
| `BarcodePosition`, `FlowArray*` | **`loc`** *(OPEN — confirm with user: `loc` vs drop)* |

> ⚠️ **Open decision for the user:** should `BarcodePosition` / `FlowArray*` go to
> `loc` or be dropped? Confirm before finalizing.

### 5.4 Role assignment rules
- Signal name ends in `Target` → role `sp`; its actual counterpart → role `act`
  with the **same** `{dept}.{signalbase}` (e.g. `LeviZTarget`→`lev.z.sp`,
  `LeviZ`→`lev.z.act`). **Watch the inconsistent infix forms**:
  `PropTargetVelocity` and `LeviYTargetAirgap` — map these explicitly
  (`prop.velocity.sp`, `lev.airgap.sp`) so they pair with `prop.velocity.act` /
  `lev.y...act`.
- PID gains (Kp/Ki/Kd/Kf/Ki_initial) → role `gain`, **events** index.
- Discrete states/faults/flags/enums/counters → role `out`, **events** index.
- Everything else numeric → role `act` if it has a setpoint partner, else `out`,
  **metrics** index.

### 5.5 Signal name normalization
Lowercase; strip the redundant subsystem prefix where it duplicates the dept
(e.g. `LeviZ` under `lev` → `z`; `PropVelocity` under `prop` → `velocity`); keep
trailing array indices (`realcurrent0`). Keep names unique within a department.

### 5.6 Metrics HEC multi-metric payload (because of `json.event.formatted=true`)
One Kafka message can carry many metrics; encode each as a `metric_name:<name>`
field:
```json
{
  "time": 1750448243.123,
  "event": "metric",
  "index": "telemetry_metrics",
  "fields": {
    "metric_name:lev.z.sp": 0.012,
    "metric_name:lev.z.act": 0.0118,
    "metric_name:therm.motorlf0.out": 61.2,
    "run_id": "dhx-2026-06-20-run07"
  }
}
```
(`run_id` with no `metric_name:` prefix is a shared dimension.)

### 5.7 Events payload (JsonConverter auto-wraps)
Plain JSON object; the connector adds the HEC envelope:
```json
{
  "time": 1750448243.123,
  "name": "sys.fsmstate.out",
  "department": "sys",
  "datapoint": "fsmstate",
  "role": "out",
  "value": 4,
  "run_id": "dhx-2026-06-20-run07"
}
```

---

## 6. Single source of truth

Generate **`dp_classification.csv`** from `splunk_index_classification.md`
(+ the full `GVL_GS_IDS.TcGVL` for the array families). Columns:

```
dp_id, department, signal, role, index
```
- `department` = one of the 6 canonical tokens (with `sense_and_control` resolved).
- `index` = `metrics` | `events`.

Both sides consume this one file:
- **Producer:** loads it (or a generated `dp_map.rs`) → `DP_ID → (dept, signal, role, index)` → emits canonical names to the correct topic.
- **Splunk (already handled in the viz repo):** can use it as a lookup during the
  transition; once the producer is canonical, no lookup is needed.

A starter exists in the viz repo:
`examples/hyperloop_analysis/README/index_membership.csv`
(`column, subsystem, role, index` for the reference 438-column schema, 207 metric /
231 event). Extend it to the `dp_id, department, signal, role, index` shape above.

---

## 7. Producer-side task list

1. **Build `dp_classification.csv`** from `splunk_index_classification.md` +
   `GVL_GS_IDS.TcGVL`, using the 6 tokens, resolving `sense_and_control`, applying
   the role rules (§5.4), and the index split (§3).
2. **Load it in the ground station** as `DP_ID → (dept, signal, role, index)`.
3. **Emit metrics** to `telemetry_metrics` as the multi-metric HEC payload (§5.6)
   with `metric_name = {dept}.{signal}.{role}`.
4. **Emit events** to `telemetry_events` (§5.7) with `name = {dept}.{signal}.{role}`.
5. **Delete** the `levitation/propulsion/...` long names, the CamelCase, and the
   `sense_and_control` catch-all.
6. Confirm the `BarcodePosition`/`FlowArray` decision (§5.3) with the user.

When done, the Splunk dashboard query is just a trivial pivot (below) — no
`split`/`case`/regex remapping.

---

## 8. Splunk side (reference — handled in the viz repo, shown for alignment)

Once the producer emits canonical names, the dashboard panel query becomes:

```spl
| mstats avg(_value) AS v WHERE index=telemetry_metrics AND metric_name="*" BY metric_name span=1s
| eval col="tune_".replace(metric_name,"\.","_")
| xyseries _time col v
| append
    [ search index=telemetry_events
    | eval col="tune_".replace(name,"\.","_")
    | bin _time span=1s
    | stats last(value) AS v by _time col
    | xyseries _time col v ]
| stats values(*) AS * by _time
| sort 0 _time
```
- Time range `earliest=0 / latest=now` + `refresh=5s` = accumulate + auto-compress.
- (If you put any `<`, `>`, `&` in a Simple-XML `<query>`, wrap it in
  `<![CDATA[ … ]]>`. The query above is XML-safe.)
- The viz whitelist (6 tokens) is already enforced; non-canonical columns are
  silently dropped.

---

## 9. Session context (history that produced this plan)

- Built the `hyperloop_analysis` Splunk custom viz (run-analysis workbench:
  schema-driven charts, 3D pod model with per-subsystem hotspots, analysis lab,
  brushing/zoom, per-department on/off toggles).
- Rebuilt its demo schema **from `splunk_index_classification.md`** as the sole
  source: 6 departments (`sys loc lev prop therm pwr`), all array families
  expanded to per-channel columns, both metric- and event-class datapoints shown
  under the same departments (438 demo columns: 207 metric / 231 event).
- Added a **strict whitelist**: the viz now charts only the 6 markdown departments
  and drops anything else (this is why the live `sense_and_control` / `levitation`
  data disappeared — token mismatch).
- Diagnosed the live data shape (§4) from user-exported CSVs and confirmed the
  metrics-vs-events Splunk semantics from the official docs.
- Current Splunk-side workaround is an inline remap query (split/case/role-regex)
  — functional but messy; this handoff replaces it by fixing naming at the source.
- App is at version **1.0.1** (bump was needed to force Splunk to overwrite the
  cached `visualization.js`; reinstalling the same version silently skips the
  overwrite — relevant if you redeploy).

---

## 10. Acceptance criteria

- `telemetry_metrics` contains `metric_name` values of the form
  `{dept}.{signal}.{role}` with `dept` ∈ the 6 tokens; **no** `levitation`/
  `sense_and_control`/CamelCase remain.
- `telemetry_events` events carry a canonical `name` (or dept/datapoint/role) using
  the 6 tokens.
- The dashboard query in §8 (no remapping) renders all departments, with
  `*Target`/actual pairs forming setpoint-vs-actual charts.
- `dp_classification.csv` exists and both sides are generated from it.
