/*
 * Hyperloop Analysis — Splunk Custom Visualization
 *
 * Schema-driven results monitor for the Delft Hyperloop DH-X.
 * Columns follow the convention:  tune_{subsystem}_{name}_{role}
 *   role = sp | act | gain | out
 * The viz discovers columns, groups them into a collapsible accordion of
 * subsystems, pairs sp/act into setpoint-vs-actual charts, shows gains as
 * readout chips, and draws an orbitable wireframe pod whose hotspots focus
 * a subsystem on click. Read-only — no controls write back to Splunk.
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    var ROLES = { sp: 1, act: 1, gain: 1, out: 1 };
    // Departments (subsystem token → friendly label + accent colour).
    var KNOWN_LABELS = { sys: 'System / FSM', loc: 'Localization', lev: 'Levitation', prop: 'Propulsion', therm: 'Thermal', pwr: 'Powertrain' };
    var ACCENTS = { sys: '#ADB5BD', loc: '#00B4D8', lev: '#6C5CE7', prop: '#2DC653', therm: '#E63946', pwr: '#F4A261' };
    var CYCLE = ['#6C5CE7', '#2DC653', '#F4A261', '#00B4D8', '#E63946', '#B5179E'];

    // ── Colour helpers ──────────────────────────────────────────────

    function hexToRgb(hex) {
        return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }
    function rgbaStr(hex, a) {
        var c = hexToRgb(hex);
        return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
    }

    // Write only the style props that actually changed, so re-renders don't disturb
    // (and snap shut) an HTML <select> the user is interacting with.
    function styleSet(el, props) {
        if (!el) return;
        for (var k in props) {
            if (props.hasOwnProperty(k) && el.style[k] !== props[k]) el.style[k] = props[k];
        }
    }

    // Splunk may hand a custom viz `_time` as epoch seconds OR as a formatted date
    // string (e.g. "2026-06-22T01:33:46.000+02:00"). parseFloat() on the latter
    // returns the leading year and collapses every row to the same instant — which
    // breaks range-windowing and the time axis. Normalise to epoch seconds.
    function toEpochSeconds(v) {
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        var s = String(v);
        if (/^-?\d+(\.\d+)?$/.test(s)) { var n = parseFloat(s); return isNaN(n) ? 0 : n; }
        var d = Date.parse(s);
        return isNaN(d) ? 0 : d / 1000;
    }

    function buildPalette(scheme) {
        if (scheme === 'neon') {
            return { setpoint: 'rgba(255,255,255,0.5)', stable: '#00FF88', warn: '#FF9900',
                     crit: '#FF0055', neutral: '#7a7a8c', model: '#B400FF' };
        }
        return { setpoint: 'rgba(255,255,255,0.5)', stable: '#2EC4B6', warn: '#F4A261',
                 crit: '#E63946', neutral: '#6b7280', model: '#6C5CE7' };
    }

    function subAccent(sub, idx, scheme) {
        if (scheme === 'neon') {
            var neon = { sys: '#C8D0D9', loc: '#00FFFF', lev: '#B400FF', prop: '#00FF88', therm: '#FF3B30', pwr: '#FF9900' };
            if (neon[sub]) return neon[sub];
        } else if (ACCENTS[sub]) {
            return ACCENTS[sub];
        }
        return CYCLE[idx % CYCLE.length];
    }

    function subLabel(sub) {
        if (KNOWN_LABELS[sub]) return KNOWN_LABELS[sub];
        return sub.charAt(0).toUpperCase() + sub.slice(1);
    }

    function statusColour(pct, warn, crit, pal) {
        if (pct === null || isNaN(pct)) return pal.neutral;
        if (pct < warn) return pal.stable;
        if (pct < crit) return pal.warn;
        return pal.crit;
    }
    function statusWord(pct, warn, crit) {
        if (pct === null || isNaN(pct)) return 'monitor';
        if (pct < warn) return 'stable';
        if (pct < crit) return 'tuning';
        return 'unstable';
    }

    // Stable identity for a graphable parameter (used by the select list).
    function paramId(sub, kind, name) { return sub + '|' + kind + '|' + name; }

    // Flatten a subsystem's schema entry into graphable items.
    function secItems(sec) {
        var items = [], i;
        for (i = 0; i < sec.pairs.length; i++)
            items.push({ id: paramId(sec.sub, 'pair', sec.pairs[i].name), kind: 'pair', name: sec.pairs[i].name, d: sec.pairs[i] });
        for (i = 0; i < sec.gains.length; i++)
            items.push({ id: paramId(sec.sub, 'gain', sec.gains[i].name), kind: 'gain', name: sec.gains[i].name, d: sec.gains[i] });
        for (i = 0; i < sec.outs.length; i++)
            items.push({ id: paramId(sec.sub, 'out', sec.outs[i].name), kind: 'out', name: sec.outs[i].name, d: sec.outs[i] });
        return items;
    }

    // min / avg / max / last for a field across rows.
    function fieldStats(rows, field) {
        var mn = Infinity, mx = -Infinity, sum = 0, n = 0, last = NaN, i, v;
        for (i = 0; i < rows.length; i++) {
            v = rows[i][field]; if (isNaN(v)) continue;
            if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++; last = v;
        }
        if (n === 0) return null;
        return { min: mn, max: mx, avg: sum / n, last: last };
    }

    // Pearson correlation coefficient between two fields over rows.
    function pearson(rows, fa, fb) {
        var n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, i, a, b;
        for (i = 0; i < rows.length; i++) {
            a = rows[i][fa]; b = rows[i][fb];
            if (isNaN(a) || isNaN(b)) continue;
            n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
        }
        if (n < 2) return null;
        var cov = sab - sa * sb / n;
        var va = saa - sa * sa / n, vb = sbb - sb * sb / n;
        if (va <= 0 || vb <= 0) return null;
        return cov / Math.sqrt(va * vb);
    }

    // Magnitude spectrum via a direct DFT (sample counts here are small, so O(n^2)
    // is fine). Returns { freq:[], mag:[] } where freq is in cycles per sample.
    function spectrum(samples, dt) {
        var n = samples.length;
        if (n < 4) return null;
        // remove DC / mean
        var mean = 0, i, k;
        for (i = 0; i < n; i++) mean += samples[i];
        mean /= n;
        var half = Math.floor(n / 2);
        var freq = [], mag = [];
        for (k = 1; k < half; k++) {
            var re = 0, im = 0;
            for (i = 0; i < n; i++) {
                var ang = -2 * Math.PI * k * i / n;
                var s = samples[i] - mean;
                re += s * Math.cos(ang); im += s * Math.sin(ang);
            }
            mag.push(2 * Math.sqrt(re * re + im * im) / n);
            freq.push(dt > 0 ? (k / (n * dt)) : (k / n));   // Hz if dt seconds, else cyc/sample
        }
        return { freq: freq, mag: mag };
    }

    // Nice round tick values spanning [lo, hi].
    function niceTicks(lo, hi, n) {
        if (!(hi > lo)) { hi = lo + 1; }
        var range = hi - lo;
        var raw = range / Math.max(1, n);
        var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
        var err = raw / mag;
        var step = mag;
        if (err >= 7.5) step = mag * 10; else if (err >= 3.5) step = mag * 5; else if (err >= 1.5) step = mag * 2;
        var ticks = [], start = Math.ceil(lo / step) * step, v;
        for (v = start; v <= hi + step * 1e-6; v += step) ticks.push(v);
        return ticks;
    }

    // Format a tick value with precision derived from the tick step, so closely
    // spaced ticks on a large baseline (e.g. 1185, 1195) stay distinguishable.
    function tickLabel(v, step) {
        if (Math.abs(v) >= 1e6) return v.toExponential(1);
        var dec = 0;
        if (step && step > 0) dec = Math.max(0, Math.min(4, -Math.floor(Math.log(step) / Math.LN10)));
        else { var a = Math.abs(v); dec = a >= 100 ? 0 : a >= 1 ? 1 : 2; }
        return v.toFixed(dec);
    }

    // Draw an axis frame with auto-scaled numeric ticks; returns the inner plot rect.
    function drawPlotAxes(ctx, x, y, w, h, xmin, xmax, ymin, ymax, xtitle, ytitle) {
        var ML = 44, MB = 24, MT = 16, MR = 10;
        var ix = x + ML, iy = y + MT, iw = w - ML - MR, ih = h - MT - MB;
        if (iw < 10 || ih < 10) return { x: x, y: y, w: w, h: h, ix: x, iy: y, iw: w, ih: h };
        // titles
        ctx.font = '8px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        if (ytitle) ctx.fillText(ytitle, x + 2, y + 2);
        if (xtitle) { ctx.textAlign = 'center'; ctx.fillText(xtitle, ix + iw / 2, y + h - 10); }
        // axis lines
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ix, iy); ctx.lineTo(ix, iy + ih); ctx.lineTo(ix + iw, iy + ih); ctx.stroke();
        // Y ticks
        var yt = niceTicks(ymin, ymax, 4), i, ty, tx;
        var yStep = yt.length > 1 ? yt[1] - yt[0] : 0;
        ctx.font = '7px monospace'; ctx.textBaseline = 'middle';
        for (i = 0; i < yt.length; i++) {
            if (yt[i] < ymin - 1e-9 || yt[i] > ymax + 1e-9) continue;
            ty = iy + ih - (yt[i] - ymin) / (ymax - ymin || 1) * ih;
            ctx.strokeStyle = 'rgba(255,255,255,0.07)';
            ctx.beginPath(); ctx.moveTo(ix, ty); ctx.lineTo(ix + iw, ty); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.textAlign = 'right';
            ctx.fillText(tickLabel(yt[i], yStep), ix - 4, ty);
        }
        // X ticks
        var xt = niceTicks(xmin, xmax, 5);
        var xStep = xt.length > 1 ? xt[1] - xt[0] : 0;
        ctx.textBaseline = 'top';
        for (i = 0; i < xt.length; i++) {
            if (xt[i] < xmin - 1e-9 || xt[i] > xmax + 1e-9) continue;
            tx = ix + (xt[i] - xmin) / (xmax - xmin || 1) * iw;
            ctx.strokeStyle = 'rgba(255,255,255,0.07)';
            ctx.beginPath(); ctx.moveTo(tx, iy); ctx.lineTo(tx, iy + ih); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.textAlign = 'center';
            ctx.fillText(tickLabel(xt[i], xStep), tx, iy + ih + 4);
        }
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        return { ix: ix, iy: iy, iw: iw, ih: ih };
    }

    // Auto-scaled Y-axis ticks (labels in a left gutter + faint gridlines) for a chart.
    function drawChartYAxis(ctx, plotX, plotW, plotY, plotH, vmin, vmax, pBot, range) {
        var ticks = niceTicks(vmin, vmax, 3), i, ty, tv;
        var step = ticks.length > 1 ? ticks[1] - ticks[0] : 0;
        ctx.font = '7px monospace'; ctx.textBaseline = 'middle';
        for (i = 0; i < ticks.length; i++) {
            tv = ticks[i];
            if (tv < vmin - 1e-9 || tv > vmax + 1e-9) continue;
            ty = plotY + plotH - ((tv - pBot) / range) * plotH;
            ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(plotX, ty); ctx.lineTo(plotX + plotW, ty); ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.textAlign = 'right';
            ctx.fillText(tickLabel(tv, step), plotX - 3, ty);
        }
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // ── Drawing primitives ──────────────────────────────────────────

    function roundRect(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2); if (r < 0) r = 0;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function fmtNum(v, abs) {
        if (isNaN(v)) return '--';
        var a = Math.abs(v);
        if (a >= 1000) return v.toFixed(0);
        if (a >= 100) return v.toFixed(1);
        if (a >= 1) return v.toFixed(2);
        return v.toFixed(3);
    }

    function fmtSign(v) { return (v >= 0 ? '+' : '') + fmtNum(v); }

    // Two-signal operations for the Lab "Operation" view.
    // kind 'scatter' → X/Y scatter + a scalar (e.g. correlation r).
    // kind 'series'  → elementwise A op B, drawn as a derived time-series.
    // Add a new operation by appending one entry here — rendering is generic.
    var LAB_OPS = [
        { key: 'corr', label: 'correlation', kind: 'scatter' },
        { key: 'sub', label: 'A − B', kind: 'series', fn: function(a, b) { return a - b; } },
        { key: 'add', label: 'A + B', kind: 'series', fn: function(a, b) { return a + b; } },
        { key: 'mul', label: 'A × B', kind: 'series', fn: function(a, b) { return a * b; } },
        { key: 'div', label: 'A ÷ B', kind: 'series', fn: function(a, b) { return (b === 0 || isNaN(b)) ? NaN : a / b; } }
    ];
    function labOp(key) { for (var i = 0; i < LAB_OPS.length; i++) if (LAB_OPS[i].key === key) return LAB_OPS[i]; return LAB_OPS[0]; }

    // Time-based decimation: keep the first row in each interval bucket (with offset).
    function decimateRows(rows, intervalMs, offsetMs) {
        if (!intervalMs || intervalMs <= 0 || rows.length < 2) return rows;
        var intervalS = intervalMs / 1000, offS = (offsetMs || 0) / 1000, t0 = rows[0]._time;
        var out = [], last = null, i, bucket;
        for (i = 0; i < rows.length; i++) {
            bucket = Math.floor((rows[i]._time - t0 - offS) / intervalS);
            if (bucket !== last) { out.push(rows[i]); last = bucket; }
        }
        return out.length ? out : rows;
    }

    // #6 Automatic point cap for chart drawing. Strides the row set down to at most
    // `max` points (always keeping the first and last) so very long windows stay
    // smooth; zooming in shrinks the window below the cap and full detail returns.
    var MAX_DRAW_POINTS = 3000;
    function capPoints(rows, max) {
        var n = rows.length;
        if (n <= max) return rows;
        var step = Math.ceil(n / max), out = [], i;
        for (i = 0; i < n; i += step) out.push(rows[i]);
        if (out[out.length - 1] !== rows[n - 1]) out.push(rows[n - 1]);
        return out;
    }

    // Relative error % between an sp and act field over all rows.
    function relErrorPct(rows, spField, actField) {
        var sumErr = 0, sumSp = 0, n = 0, maxAct = 0, i, sp, act;
        for (i = 0; i < rows.length; i++) {
            sp = rows[i][spField]; act = rows[i][actField];
            if (isNaN(sp) || isNaN(act)) continue;
            sumErr += Math.abs(act - sp);
            sumSp += Math.abs(sp);
            if (Math.abs(act) > maxAct) maxAct = Math.abs(act);
            n++;
        }
        if (n === 0) return null;
        var denom = (sumSp / n);
        if (denom < 1e-6) denom = maxAct > 1e-6 ? maxAct : 1;
        return (sumErr / n) / denom * 100;
    }

    // Compact min/avg/max footer drawn inside a chart's plot region.
    function drawStatsFooter(ctx, rows, field, plotX, plotY, plotW, plotH) {
        if (plotH < 42) return;
        var st = fieldStats(rows, field);
        if (!st) return;
        ctx.font = '7px monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText('▼' + fmtNum(st.min) + '  ▲' + fmtNum(st.max) + '  ~' + fmtNum(st.avg),
            plotX + 2, plotY + plotH - 2);
        ctx.textBaseline = 'alphabetic';
    }

    // Setpoint-vs-actual chart with shaded error band + relErr badge.
    function pairChart(ctx, rows, spField, actField, name, x, y, w, h, accent, pal, warnPct, critPct) {
        roundRect(ctx, x, y, w, h, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fill();

        var n = rows.length, i, v;
        if (n === 0) return;   // empty window → draw just the frame, never crash the render
        var minV = Infinity, maxV = -Infinity;
        for (i = 0; i < n; i++) {
            v = rows[i][spField]; if (!isNaN(v)) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
            v = rows[i][actField]; if (!isNaN(v)) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
        }
        if (minV === Infinity) { minV = 0; maxV = 1; }
        var span = maxV - minV;
        if (span < 1e-6) span = Math.abs(maxV) > 1e-6 ? Math.abs(maxV) * 0.1 : 1;
        var pTop = maxV + span * 0.2, pBot = minV - span * 0.2, range = pTop - pBot;

        var headerH = Math.min(15, Math.max(10, h * 0.22));
        var pad = Math.min(3, h * 0.05);
        var axisW = (h >= 40 && w >= 90) ? 28 : 0;
        var plotX = x + pad + axisW, plotW = w - pad * 2 - axisW;
        var plotY = y + headerH, plotH = h - headerH - pad;
        if (plotH < 4) plotH = 4;

        function px(idx) { return plotX + (n > 1 ? (idx / (n - 1)) * plotW : plotW / 2); }
        function py(val) { return plotY + plotH - ((val - pBot) / range) * plotH; }

        if (axisW) drawChartYAxis(ctx, plotX, plotW, plotY, plotH, minV, maxV, pBot, range);

        ctx.save();
        roundRect(ctx, plotX, plotY, plotW, plotH, 0);
        ctx.clip();

        // error band (between sp and act)
        if (n > 1) {
            ctx.beginPath();
            for (i = 0; i < n; i++) ctx.lineTo(px(i), py(isNaN(rows[i][actField]) ? pBot : rows[i][actField]));
            for (i = n - 1; i >= 0; i--) ctx.lineTo(px(i), py(isNaN(rows[i][spField]) ? pBot : rows[i][spField]));
            ctx.closePath();
            ctx.fillStyle = rgbaStr(accent, 0.10);
            ctx.fill();
        }

        // setpoint (dashed)
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = pal.setpoint;
        ctx.lineWidth = 1;
        ctx.beginPath();
        var started = false;
        for (i = 0; i < n; i++) { v = rows[i][spField]; if (isNaN(v)) continue;
            if (!started) { ctx.moveTo(px(i), py(v)); started = true; } else ctx.lineTo(px(i), py(v)); }
        ctx.stroke();
        ctx.setLineDash([]);

        // actual (solid)
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        started = false;
        for (i = 0; i < n; i++) { v = rows[i][actField]; if (isNaN(v)) continue;
            if (!started) { ctx.moveTo(px(i), py(v)); started = true; } else ctx.lineTo(px(i), py(v)); }
        ctx.stroke();
        drawStatsFooter(ctx, rows, actField, plotX, plotY, plotW, plotH);
        ctx.restore();

        // header: name + current actual + relErr badge
        var labelFont = Math.min(9, Math.max(7, headerH * 0.62));
        ctx.font = labelFont + 'px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(name, x + 4, y + 3);

        var curAct = rows[n - 1][actField];
        ctx.font = 'bold ' + Math.min(10, Math.max(8, headerH * 0.66)) + 'px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(fmtNum(curAct), x + w - 4, y + 2);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // Plain output trace (no setpoint).
    function outChart(ctx, rows, field, name, x, y, w, h, accent) {
        roundRect(ctx, x, y, w, h, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fill();
        var n = rows.length, i, v, minV = Infinity, maxV = -Infinity;
        if (n === 0) return;   // empty window → draw just the frame, never crash the render
        for (i = 0; i < n; i++) { v = rows[i][field]; if (!isNaN(v)) { if (v < minV) minV = v; if (v > maxV) maxV = v; } }
        if (minV === Infinity) { minV = 0; maxV = 1; }
        var span = maxV - minV; if (span < 1e-6) span = Math.abs(maxV) > 1e-6 ? Math.abs(maxV) * 0.1 : 1;
        var pTop = maxV + span * 0.2, pBot = minV - span * 0.2, range = pTop - pBot;
        var headerH = Math.min(15, Math.max(10, h * 0.22));
        var pad = Math.min(3, h * 0.05);
        var axisW = (h >= 40 && w >= 90) ? 28 : 0;
        var plotX = x + pad + axisW, plotW = w - pad * 2 - axisW, plotY = y + headerH, plotH = h - headerH - pad;
        if (plotH < 4) plotH = 4;
        function px(idx) { return plotX + (n > 1 ? (idx / (n - 1)) * plotW : plotW / 2); }
        function py(val) { return plotY + plotH - ((val - pBot) / range) * plotH; }
        if (axisW) drawChartYAxis(ctx, plotX, plotW, plotY, plotH, minV, maxV, pBot, range);
        ctx.save();
        roundRect(ctx, plotX, plotY, plotW, plotH, 0); ctx.clip();
        ctx.beginPath();
        ctx.moveTo(px(0), plotY + plotH);
        for (i = 0; i < n; i++) ctx.lineTo(px(i), py(isNaN(rows[i][field]) ? pBot : rows[i][field]));
        ctx.lineTo(px(n - 1), plotY + plotH); ctx.closePath();
        ctx.fillStyle = rgbaStr(accent, 0.10); ctx.fill();
        ctx.beginPath();
        var started = false;
        for (i = 0; i < n; i++) { v = rows[i][field]; if (isNaN(v)) continue;
            if (!started) { ctx.moveTo(px(i), py(v)); started = true; } else ctx.lineTo(px(i), py(v)); }
        ctx.strokeStyle = accent; ctx.lineWidth = 1.4; ctx.stroke();
        drawStatsFooter(ctx, rows, field, plotX, plotY, plotW, plotH);
        ctx.restore();
        var labelFont = Math.min(9, Math.max(7, headerH * 0.62));
        ctx.font = labelFont + 'px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(name, x + 4, y + 3);
        var cur = rows[n - 1][field];
        ctx.font = 'bold ' + Math.min(10, Math.max(8, headerH * 0.66)) + 'px monospace';
        ctx.fillStyle = '#ffffff'; ctx.textAlign = 'right';
        ctx.fillText(fmtNum(cur), x + w - 4, y + 2);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // Gain readout chip: name, big current value, tiny drift sparkline.
    function gainChip(ctx, rows, field, name, x, y, w, h, accent) {
        roundRect(ctx, x, y, w, h, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fill();
        if (rows.length === 0) return;   // empty window → never crash the render
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(name, x + 6, y + 4);
        var cur = rows[rows.length - 1][field];
        ctx.font = 'bold 14px monospace';
        ctx.fillStyle = accent;
        ctx.textBaseline = 'top';
        ctx.fillText(fmtNum(cur), x + 6, y + 15);
        // sparkline bottom strip
        var n = rows.length, i, v, minV = Infinity, maxV = -Infinity;
        for (i = 0; i < n; i++) { v = rows[i][field]; if (!isNaN(v)) { if (v < minV) minV = v; if (v > maxV) maxV = v; } }
        if (minV !== Infinity && n > 1) {
            var span = maxV - minV; if (span < 1e-6) span = 1;
            var sx = x + 6, sw = w - 12, sy = y + h - 10, sh = 7;
            ctx.beginPath();
            for (i = 0; i < n; i++) {
                v = rows[i][field]; if (isNaN(v)) continue;
                var pxx = sx + (i / (n - 1)) * sw;
                var pyy = sy + sh - ((v - minV) / span) * sh;
                if (i === 0) ctx.moveTo(pxx, pyy); else ctx.lineTo(pxx, pyy);
            }
            ctx.strokeStyle = rgbaStr(accent, 0.7); ctx.lineWidth = 1; ctx.stroke();
        }
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // ── 3D wireframe pod ────────────────────────────────────────────

    // Low-poly lofted outer shell generated from STL pod/3D model pod.stl.
    // Cross-sections along the body's long axis; outer boundary per slice.
    // Coordinates: x = length (-1..1), y = width, z = height. Edges index verts.
    function podGeometry() {
        // Decimated from STL pod/pod_aeroshell_hires.stl (quadric ~700 tris) for shaded solid render.
        var v = [[-0.878,-0.465,-0.006],[-0.864,-0.511,0.109],[-0.847,-0.453,0.164],[-0.705,-0.474,0.083],[-0.413,-0.5,0.152],[-0.44,-0.503,0.079],[0.056,-0.501,0.148],[0.057,-0.451,0.163],[0.054,-0.468,0.01],[0.121,-0.493,0.078],[0.522,-0.504,0.135],[0.499,-0.473,0.003],[-0.412,-0.464,0.01],[-0.44,-0.46,0.165],[0.123,-0.468,0.078],[-0.808,-0.467,-0.159],[-0.695,-0.46,-0.171],[-0.182,-0.473,0.002],[-0.168,-0.468,-0.126],[0.452,-0.45,0.161],[0.402,-0.478,-0.098],[-0.846,-0.396,0.189],[0.516,-0.399,0.177],[-0.4,-0.426,0.048],[0.305,-0.451,-0.188],[-0.993,-0.436,-0.308],[-1.0,-0.43,-0.032],[-0.399,-0.462,0.304],[-0.819,-0.426,0.303],[0.037,-0.439,0.294],[0.449,-0.45,0.303],[0.65,-0.442,-0.068],[0.692,-0.427,-0.302],[-0.399,-0.433,0.294],[0.057,-0.417,0.044],[0.537,-0.412,-0.368],[0.062,-0.389,-0.398],[-0.413,-0.394,-0.392],[-0.858,-0.427,-0.303],[-0.852,-0.422,-0.04],[-0.761,-0.385,-0.391],[0.794,-0.378,-0.064],[-0.926,-0.359,-0.352],[-0.844,-0.26,-0.205],[-0.99,-0.362,0.166],[-0.857,-0.372,0.032],[-0.849,-0.265,0.01],[0.434,-0.382,-0.388],[0.061,-0.327,0.301],[0.063,-0.261,0.305],[0.669,-0.329,0.229],[0.844,-0.355,-0.212],[-0.414,-0.366,-0.372],[0.518,-0.27,0.305],[-0.774,-0.372,-0.237],[-0.406,-0.381,-0.239],[-0.437,-0.503,0.303],[0.049,-0.38,-0.236],[0.414,-0.375,-0.236],[-0.866,-0.265,0.3],[-0.409,-0.319,-0.243],[-0.85,-0.358,0.158],[-0.825,-0.289,-0.387],[-0.116,-0.355,-0.362],[0.603,0.417,-0.344],[0.804,0.373,-0.237],[-0.989,-0.304,0.232],[-0.996,0.423,-0.318],[-0.862,-0.122,0.242],[-0.247,-0.324,-0.366],[-0.037,-0.274,-0.363],[0.454,-0.303,-0.241],[0.483,-0.286,-0.387],[-0.844,-0.303,0.23],[-0.809,-0.294,-0.225],[0.047,-0.302,-0.309],[0.989,-0.242,0.009],[-0.325,-0.272,-0.302],[-0.396,-0.303,0.283],[0.066,-0.316,-0.231],[-0.401,-0.329,0.015],[-0.262,-0.312,-0.296],[-0.034,-0.317,0.197],[-0.376,-0.304,0.167],[-0.083,-0.141,-0.36],[-0.041,-0.281,-0.303],[0.063,-0.308,0.147],[-0.42,-0.292,-0.209],[-0.447,-0.292,-0.001],[-0.357,-0.202,0.197],[-0.079,-0.132,-0.289],[0.016,-0.218,0.185],[0.044,-0.42,-0.02],[0.098,-0.289,-0.22],[0.478,-0.111,-0.381],[-0.459,-0.275,-0.219],[-0.396,-0.113,-0.002],[-0.033,-0.301,0.271],[-0.26,-0.126,-0.293],[0.082,-0.125,-0.23],[0.996,-0.225,-0.097],[-0.986,-0.149,0.264],[-0.398,-0.141,0.3],[-0.313,-0.273,-0.361],[0.036,-0.143,0.278],[0.093,-0.258,-0.01],[0.497,-0.292,-0.212],[-0.827,-0.087,-0.386],[-0.486,-0.261,-0.039],[-0.4,-0.105,-0.224],[0.039,-0.101,0.135],[-0.409,-0.269,0.318],[0.103,-0.089,-0.183],[0.117,-0.245,-0.181],[0.499,-0.095,-0.176],[-0.878,-0.135,0.299],[-0.835,-0.267,0.384],[-0.424,-0.257,0.384],[-0.454,-0.118,-0.214],[-0.316,-0.098,-0.303],[-0.081,-0.088,-0.341],[0.484,-0.264,0.398],[0.042,-0.242,0.383],[-0.495,-0.103,-0.027],[-0.383,-0.094,0.134],[0.196,-0.263,0.006],[0.339,-0.26,-0.174],[0.277,-0.199,-0.037],[0.91,0.311,-0.164],[-0.845,0.03,0.209],[-0.852,-0.08,-0.003],[-0.866,-0.159,0.382],[-0.551,-0.252,-0.031],[-0.546,-0.21,0.024],[-0.412,-0.151,0.392],[0.133,-0.147,0.38],[0.337,-0.106,0.005],[0.521,-0.152,0.381],[0.863,-0.116,0.141],[0.112,-0.087,0.003],[0.534,-0.139,0.3],[-0.282,-0.123,-0.364],[-0.854,-0.091,-0.199],[0.478,0.286,-0.392],[-0.821,-0.114,-0.265],[-0.827,-0.108,-0.198],[-0.436,-0.089,-0.242],[-0.825,0.301,-0.391],[-0.885,0.139,0.301],[-0.855,0.281,-0.202],[-0.21,0.205,0.209],[0.68,-0.035,0.259],[-0.845,0.398,-0.308],[-0.824,-0.009,0.038],[-0.544,-0.028,0.024],[0.058,-0.135,0.307],[0.673,0.436,-0.309],[-0.818,-0.166,0.26],[-0.827,-0.157,0.079],[-0.638,-0.161,0.264],[-0.644,-0.155,0.08],[-0.639,0.136,0.08],[-0.188,-0.1,-0.367],[0.34,-0.106,-0.175],[0.517,0.137,0.302],[-0.636,0.15,0.265],[-0.328,0.284,0.192],[0.053,0.131,0.304],[-0.992,0.136,0.257],[-0.819,0.013,0.072],[-0.169,-0.095,-0.3],[0.443,-0.106,-0.247],[-0.788,-0.097,-0.245],[-0.487,-0.092,-0.206],[-0.394,-0.078,-0.084],[0.053,0.098,0.135],[0.275,-0.094,-0.228],[-0.38,-0.075,-0.325],[0.836,0.091,0.162],[-0.192,0.091,-0.362],[-0.119,0.108,-0.366],[-0.171,0.095,-0.295],[0.07,0.279,-0.003],[0.06,0.333,-0.257],[0.102,0.087,0.016],[-0.824,0.102,-0.381],[-0.831,0.093,-0.203],[-0.379,0.089,-0.358],[0.26,0.082,-0.22],[0.479,0.101,-0.215],[-0.824,0.137,0.256],[-0.543,0.005,0.002],[-0.496,0.085,-0.206],[-0.487,0.092,-0.042],[-0.405,0.088,-0.248],[-0.396,0.076,-0.081],[-0.395,0.092,0.104],[0.079,0.292,-0.195],[0.059,0.109,-0.245],[-0.376,0.093,-0.299],[0.111,0.103,-0.206],[-0.002,0.209,0.191],[0.998,0.231,-0.003],[-0.843,0.016,0.043],[1.0,0.188,-0.09],[0.48,0.102,-0.383],[-0.855,0.176,0.044],[-0.75,0.022,0.038],[-0.527,0.015,0.037],[-0.541,0.253,-0.045],[0.72,0.297,0.22],[-0.746,0.144,0.083],[-0.749,0.185,0.023],[-0.394,0.138,0.304],[-0.866,0.189,0.242],[-0.393,0.106,-0.248],[-0.838,0.099,-0.014],[-0.787,0.102,-0.236],[-0.389,0.112,-0.207],[-0.407,0.104,0.158],[-0.307,0.103,-0.33],[-0.254,0.13,-0.303],[-0.038,0.096,-0.304],[0.276,0.095,0.017],[0.275,0.111,-0.204],[-0.469,0.118,-0.216],[-0.477,0.251,-0.045],[-0.419,0.104,-0.011],[0.27,0.244,0.019],[-0.844,0.111,-0.198],[-0.824,0.184,0.03],[-0.311,0.283,-0.304],[-0.264,0.126,-0.368],[-0.091,0.125,-0.306],[0.004,0.289,-0.362],[-0.059,0.311,-0.298],[-0.85,0.319,0.026],[-0.467,0.263,-0.223],[-0.436,0.139,-0.164],[-0.821,0.26,-0.223],[-0.428,0.291,-0.005],[-0.401,0.315,-0.254],[-0.419,0.31,-0.188],[0.28,0.361,-0.178],[0.5,0.311,-0.185],[-0.855,0.148,0.376],[-0.444,0.134,0.385],[-0.34,0.31,0.159],[-0.326,0.124,0.273],[0.035,0.145,0.279],[0.053,0.146,0.389],[0.503,0.141,0.377],[-0.394,0.298,0.289],[-0.235,0.308,-0.314],[-0.093,0.322,-0.37],[-0.841,0.271,0.393],[-0.751,0.168,0.222],[0.508,0.255,0.389],[0.095,0.242,0.385],[-0.993,0.289,0.236],[-0.41,0.252,0.382],[0.277,0.368,-0.007],[0.534,0.348,0.265],[-0.618,0.247,0.025],[0.06,0.316,0.146],[0.04,0.291,0.282],[0.102,0.296,-0.235],[0.277,0.282,-0.208],[0.513,0.26,0.308],[-0.858,0.269,0.305],[-0.412,0.26,0.307],[-0.405,0.282,0.155],[0.033,0.384,0.283],[-0.025,0.307,0.164],[-0.851,0.357,0.161],[0.067,0.266,0.303],[0.274,0.248,-0.007],[-0.837,0.273,-0.135],[-0.627,0.259,-0.114],[-0.621,0.32,0.032],[-0.296,0.297,-0.378],[-0.618,0.318,-0.125],[-0.782,0.449,0.305],[-0.397,0.302,-0.332],[-0.404,0.382,-0.24],[0.46,0.297,-0.229],[0.046,0.387,-0.236],[0.493,0.383,0.31],[-0.858,0.42,-0.041],[-0.868,0.364,0.024],[-0.777,0.37,-0.242],[-0.413,0.379,-0.383],[0.109,0.345,-0.178],[0.813,0.354,0.001],[0.426,0.379,-0.391],[-0.998,0.368,0.121],[-0.863,0.345,0.3],[-0.762,0.397,-0.382],[0.058,0.378,-0.391],[0.102,0.369,-0.014],[0.42,0.372,-0.235],[-0.874,0.402,0.154],[0.512,0.4,0.171],[0.687,0.424,-0.067],[-0.995,0.421,-0.022],[0.441,0.446,0.299],[-0.801,0.446,0.164],[-0.393,0.431,0.302],[0.515,0.506,0.149],[-0.945,0.451,-0.277],[0.32,0.45,-0.197],[0.048,0.424,0.302],[-0.896,0.453,-0.024],[-0.405,0.459,0.151],[-0.407,0.419,0.038],[0.047,0.431,0.044],[0.437,0.455,0.162],[-0.413,0.471,0.01],[0.055,0.456,0.164],[0.06,0.505,0.106],[0.521,0.465,-0.011],[-0.64,0.454,-0.187],[0.39,0.464,-0.147],[0.526,0.499,0.069],[-0.879,0.496,0.056],[-0.771,0.476,0.072],[-0.208,0.472,-0.059],[-0.466,0.494,0.081],[-0.414,0.5,0.151],[0.111,0.476,0.008],[0.125,0.46,0.08],[-0.826,0.511,0.142]];
        var e = [[0,1],[0,3],[0,15],[0,16],[0,21],[0,26],[1,2],[1,3],[1,4],[1,5],[1,21],[2,4],[2,13],[2,21],[2,27],[2,28],[3,5],[3,12],[3,16],[3,18],[4,5],[4,12],[4,13],[4,23],[4,27],[4,33],[5,12],[6,7],[6,8],[6,9],[6,10],[6,19],[7,8],[7,19],[7,29],[7,30],[8,9],[8,16],[8,17],[8,18],[8,20],[8,23],[8,24],[8,29],[8,34],[9,10],[9,14],[9,20],[10,11],[10,14],[10,19],[10,22],[11,14],[11,20],[11,22],[11,31],[12,17],[12,18],[12,23],[13,27],[14,20],[15,16],[15,25],[15,26],[16,18],[16,24],[16,25],[16,36],[16,37],[17,18],[17,23],[19,22],[19,30],[20,24],[20,31],[20,32],[20,35],[21,26],[21,28],[21,44],[21,59],[21,66],[22,30],[22,31],[22,50],[22,53],[23,33],[23,34],[24,35],[24,36],[25,26],[25,37],[25,38],[25,39],[25,40],[25,42],[25,67],[25,152],[26,39],[26,44],[26,45],[27,28],[27,33],[28,29],[28,30],[28,33],[28,48],[28,56],[28,59],[28,111],[29,30],[29,33],[29,34],[30,48],[30,49],[30,53],[31,32],[31,41],[31,50],[32,35],[32,41],[32,51],[32,64],[32,65],[32,156],[33,34],[35,36],[35,47],[35,64],[35,72],[35,94],[35,143],[35,205],[36,37],[36,47],[36,52],[36,57],[36,58],[36,63],[36,70],[36,75],[37,40],[37,52],[38,39],[38,43],[38,46],[38,142],[38,149],[38,152],[39,45],[39,46],[40,42],[40,52],[40,54],[40,55],[40,62],[41,50],[41,51],[41,76],[42,62],[42,67],[42,107],[42,147],[43,46],[43,62],[43,74],[43,95],[43,142],[43,145],[44,45],[44,61],[44,66],[44,73],[45,46],[45,61],[45,68],[45,129],[45,130],[46,95],[46,130],[46,132],[46,133],[46,153],[47,58],[47,71],[47,72],[48,49],[48,56],[48,78],[48,97],[48,104],[49,53],[49,104],[49,121],[49,122],[50,53],[50,76],[50,138],[50,140],[50,151],[51,65],[51,76],[51,100],[51,128],[52,55],[52,60],[52,63],[52,69],[52,77],[52,103],[53,121],[53,140],[54,55],[54,60],[54,62],[54,74],[55,60],[56,78],[56,111],[57,58],[57,71],[57,75],[57,79],[58,71],[59,66],[59,101],[59,111],[59,115],[59,116],[59,117],[59,131],[60,63],[60,74],[60,77],[60,80],[60,81],[60,82],[60,87],[60,95],[60,109],[60,146],[61,68],[61,73],[62,74],[62,107],[62,144],[62,145],[63,69],[63,70],[63,75],[63,79],[63,81],[63,82],[63,84],[63,85],[63,86],[63,90],[64,143],[64,156],[64,294],[64,297],[64,298],[64,310],[65,128],[65,156],[65,293],[65,303],[66,73],[66,101],[67,147],[67,152],[67,288],[67,297],[67,304],[67,309],[68,73],[68,101],[68,129],[68,214],[69,81],[69,98],[69,103],[69,141],[70,75],[70,84],[70,85],[70,120],[71,72],[71,79],[71,93],[71,106],[72,94],[72,106],[72,114],[73,101],[74,95],[75,79],[75,85],[76,100],[76,138],[76,178],[76,202],[77,81],[77,103],[77,119],[78,97],[78,102],[78,104],[78,111],[79,86],[79,92],[79,93],[79,99],[79,105],[79,112],[79,113],[79,183],[79,197],[80,82],[80,83],[80,87],[80,88],[80,96],[81,98],[81,119],[82,83],[82,86],[82,89],[82,91],[82,150],[82,201],[83,89],[83,96],[83,124],[84,90],[84,120],[84,141],[84,162],[85,90],[85,120],[86,91],[86,92],[86,110],[87,88],[87,95],[87,109],[87,118],[88,95],[88,96],[88,108],[88,123],[89,124],[89,150],[89,166],[90,98],[90,120],[90,141],[90,170],[91,110],[91,201],[92,105],[92,110],[92,139],[92,175],[92,182],[93,99],[93,106],[93,114],[94,114],[94,171],[94,189],[94,205],[95,108],[95,118],[95,132],[95,146],[96,109],[96,123],[96,124],[96,173],[96,174],[97,104],[98,119],[98,141],[98,170],[99,114],[99,171],[99,176],[99,183],[99,198],[100,128],[100,202],[100,204],[101,115],[101,168],[101,214],[102,104],[102,111],[102,115],[102,134],[102,148],[102,155],[102,167],[102,213],[103,119],[103,141],[104,122],[104,155],[105,113],[105,125],[105,139],[106,114],[107,144],[107,145],[107,147],[107,172],[107,185],[107,186],[108,123],[108,132],[109,118],[109,146],[109,173],[109,174],[109,194],[109,195],[110,175],[110,201],[111,117],[111,134],[112,113],[112,126],[112,136],[112,139],[112,163],[112,184],[112,197],[112,200],[113,125],[113,126],[114,171],[115,131],[115,134],[115,148],[115,168],[116,117],[116,131],[117,131],[117,134],[118,144],[118,145],[118,146],[118,173],[119,141],[119,162],[119,170],[120,162],[120,170],[120,180],[120,181],[121,122],[121,135],[121,137],[121,140],[122,135],[122,155],[123,132],[123,154],[123,173],[123,191],[123,192],[123,193],[123,209],[124,166],[124,174],[124,196],[124,219],[125,126],[125,127],[125,139],[126,127],[126,136],[126,163],[127,136],[127,139],[128,202],[128,204],[128,293],[129,130],[129,157],[129,158],[129,169],[129,190],[129,203],[129,214],[130,142],[130,145],[130,153],[130,186],[130,203],[130,206],[130,216],[130,236],[131,134],[132,133],[132,154],[133,153],[133,154],[135,137],[135,140],[135,155],[136,139],[136,163],[137,140],[138,151],[138,178],[139,182],[139,184],[140,151],[140,155],[140,164],[140,167],[141,162],[142,145],[142,149],[142,186],[143,205],[143,244],[143,285],[143,294],[144,145],[144,146],[144,172],[145,146],[145,153],[145,172],[145,173],[145,186],[146,172],[146,173],[146,192],[146,194],[147,185],[147,239],[147,297],[148,168],[148,213],[148,245],[148,246],[148,255],[148,259],[148,269],[149,152],[149,186],[149,239],[149,277],[149,288],[150,166],[150,201],[150,272],[151,164],[151,178],[151,210],[152,288],[153,154],[153,186],[153,191],[153,203],[153,216],[154,191],[155,167],[156,303],[156,310],[156,320],[156,322],[157,158],[157,159],[157,190],[158,159],[158,160],[158,169],[159,160],[159,161],[159,165],[159,190],[160,161],[160,169],[160,211],[161,165],[161,211],[162,170],[162,179],[162,180],[164,167],[164,210],[164,250],[164,251],[164,257],[164,262],[164,268],[165,190],[165,211],[165,256],[166,219],[166,247],[166,272],[167,213],[167,249],[167,250],[168,214],[168,259],[169,203],[169,207],[169,211],[170,179],[170,181],[171,176],[171,189],[173,192],[174,195],[174,196],[175,182],[175,201],[175,264],[176,188],[176,189],[176,198],[177,187],[177,194],[177,199],[178,202],[178,210],[179,180],[179,181],[179,220],[179,232],[180,181],[180,222],[180,232],[180,233],[180,234],[180,254],[181,220],[181,221],[181,222],[181,233],[182,183],[182,184],[182,197],[182,223],[182,228],[182,261],[182,264],[182,276],[182,299],[183,197],[183,198],[183,234],[183,235],[183,264],[183,266],[183,286],[183,298],[184,200],[184,223],[185,186],[185,217],[185,229],[185,239],[186,192],[186,216],[186,217],[186,225],[186,229],[186,239],[187,194],[187,199],[187,215],[188,189],[188,198],[189,198],[189,200],[189,205],[189,224],[189,244],[190,214],[190,256],[191,203],[191,208],[191,209],[192,193],[192,194],[192,217],[192,225],[193,209],[193,225],[193,226],[193,237],[194,195],[194,199],[194,215],[194,217],[194,218],[194,225],[194,237],[195,196],[195,218],[196,218],[196,219],[196,227],[196,238],[197,200],[197,266],[197,267],[197,292],[197,299],[198,200],[198,266],[199,215],[199,218],[200,223],[200,224],[200,266],[201,264],[201,272],[201,273],[202,204],[202,210],[202,293],[203,206],[203,207],[203,208],[203,216],[203,230],[205,244],[206,214],[206,230],[206,236],[206,256],[207,208],[207,211],[207,212],[208,209],[208,212],[208,236],[208,263],[209,226],[209,237],[209,263],[209,278],[210,262],[210,293],[211,212],[211,256],[212,230],[212,236],[212,256],[213,246],[213,248],[213,249],[213,252],[213,260],[213,270],[214,236],[214,256],[214,259],[214,274],[215,218],[215,237],[215,241],[216,230],[216,236],[217,225],[217,229],[218,238],[218,241],[218,242],[219,227],[219,247],[219,271],[220,221],[220,231],[220,232],[220,280],[221,231],[221,232],[221,233],[221,253],[222,233],[222,234],[222,235],[223,224],[223,228],[223,243],[223,261],[223,276],[224,243],[224,244],[224,267],[225,229],[225,237],[226,237],[227,238],[227,240],[227,271],[228,276],[229,239],[230,236],[230,256],[231,241],[231,253],[231,280],[231,283],[232,233],[232,253],[232,280],[233,235],[233,254],[234,235],[234,254],[234,298],[235,253],[235,254],[235,264],[236,263],[236,274],[236,277],[236,279],[236,281],[236,289],[237,239],[237,241],[237,278],[237,284],[237,290],[238,240],[238,242],[239,277],[239,278],[239,290],[239,297],[240,242],[240,271],[241,242],[241,253],[241,272],[241,283],[241,284],[242,247],[242,271],[242,272],[243,261],[243,267],[243,292],[243,299],[244,267],[244,285],[245,246],[245,255],[246,255],[246,260],[247,271],[247,272],[248,249],[248,252],[248,265],[249,250],[249,265],[250,251],[250,258],[250,265],[250,275],[251,257],[251,258],[252,265],[252,270],[252,282],[252,287],[253,254],[253,264],[253,272],[253,273],[253,280],[254,280],[254,291],[254,298],[255,260],[255,269],[257,258],[257,268],[257,275],[258,275],[259,269],[259,274],[259,295],[260,269],[260,270],[261,276],[261,299],[262,268],[262,287],[262,293],[262,302],[263,278],[263,279],[264,273],[265,275],[265,287],[266,267],[266,285],[266,286],[267,285],[267,292],[268,275],[268,287],[269,270],[269,282],[269,295],[269,296],[269,301],[270,282],[272,273],[274,289],[274,295],[275,287],[277,278],[277,281],[277,288],[277,289],[278,279],[278,281],[279,281],[280,283],[280,291],[282,287],[282,296],[282,301],[282,306],[282,307],[282,313],[283,284],[283,291],[284,290],[284,291],[285,286],[285,294],[285,300],[286,298],[286,300],[287,302],[287,305],[287,307],[287,311],[288,289],[288,304],[289,295],[289,304],[290,291],[290,297],[291,297],[291,298],[292,299],[293,302],[293,303],[294,298],[294,300],[295,301],[295,304],[296,301],[297,298],[297,309],[297,310],[297,321],[298,300],[301,304],[301,306],[301,312],[301,324],[301,331],[302,303],[302,305],[302,308],[302,316],[302,320],[302,323],[303,320],[304,309],[304,312],[305,311],[305,316],[305,318],[306,313],[306,328],[306,331],[307,311],[307,313],[307,314],[308,316],[308,318],[308,319],[308,323],[309,312],[309,321],[309,325],[310,321],[310,322],[310,326],[310,329],[311,314],[311,315],[311,318],[312,324],[312,325],[313,314],[313,317],[313,328],[314,315],[314,317],[315,317],[315,318],[315,319],[315,326],[315,329],[316,318],[317,321],[317,325],[317,326],[317,327],[317,328],[318,319],[319,323],[319,329],[319,330],[320,322],[320,323],[320,330],[321,325],[321,326],[322,329],[322,330],[323,330],[324,325],[324,327],[324,331],[325,327],[326,329],[327,328],[327,331],[328,331],[329,330]];
        var f = [[0,3,1],[5,4,1],[6,8,9],[9,10,6],[2,1,4],[5,1,3],[10,9,14],[15,16,0],[0,16,3],[10,19,6],[20,11,14],[14,11,10],[21,1,2],[12,4,5],[16,18,3],[13,2,4],[12,5,3],[18,12,3],[18,17,12],[18,16,8],[18,8,17],[8,16,24],[8,24,20],[20,9,8],[19,7,6],[9,20,14],[11,22,10],[0,26,15],[2,27,28],[2,13,27],[13,4,27],[12,23,4],[7,8,6],[29,7,30],[7,19,30],[10,22,19],[20,31,11],[20,32,31],[25,15,26],[1,21,0],[27,4,33],[23,12,17],[17,8,23],[35,32,20],[16,15,25],[21,2,28],[33,28,27],[23,33,4],[23,8,34],[8,7,29],[35,24,36],[24,35,20],[16,36,24],[22,11,31],[39,25,26],[38,25,39],[37,16,25],[36,16,37],[23,34,33],[34,29,33],[34,8,29],[19,22,30],[26,0,21],[29,28,33],[41,31,32],[37,25,40],[44,26,21],[42,40,25],[26,45,39],[29,30,28],[47,35,36],[45,46,39],[30,48,28],[30,49,48],[50,22,31],[31,41,50],[41,32,51],[52,37,40],[45,26,44],[55,40,54],[52,40,55],[28,48,56],[36,57,58],[47,36,58],[60,55,54],[22,53,30],[61,45,44],[36,37,52],[52,63,36],[44,21,66],[68,45,61],[63,52,69],[70,36,63],[71,58,57],[71,47,58],[35,64,32],[59,21,28],[42,62,40],[62,54,40],[65,51,32],[44,73,61],[39,46,38],[47,72,35],[44,66,73],[21,59,66],[74,60,54],[60,52,55],[75,57,36],[22,50,53],[60,77,52],[57,75,79],[41,76,50],[46,43,38],[82,60,80],[56,48,78],[81,77,60],[63,81,60],[80,83,82],[63,60,82],[63,69,81],[85,63,75],[75,63,79],[86,63,82],[86,79,63],[79,71,57],[76,41,51],[62,74,54],[60,87,80],[87,88,80],[89,82,83],[63,85,90],[92,79,86],[93,71,79],[71,72,47],[35,72,94],[73,68,61],[95,60,74],[80,88,96],[96,83,80],[69,98,81],[48,97,78],[93,79,99],[76,51,100],[87,95,88],[103,69,52],[91,86,82],[75,36,70],[92,105,79],[71,93,106],[106,72,71],[59,101,66],[62,43,74],[95,74,43],[95,108,88],[60,109,87],[86,110,92],[28,111,59],[28,56,111],[103,52,77],[70,63,84],[75,70,85],[113,79,105],[30,53,49],[106,114,72],[59,117,116],[59,111,117],[87,118,95],[81,119,77],[49,121,122],[49,53,121],[108,123,88],[78,111,56],[124,83,96],[90,84,63],[85,70,120],[49,104,48],[113,125,126],[127,126,125],[114,106,93],[128,100,51],[129,130,45],[95,43,46],[117,131,116],[132,95,46],[133,132,46],[108,95,132],[117,134,131],[121,135,122],[136,126,127],[121,137,135],[101,73,66],[132,123,108],[113,105,125],[50,140,53],[138,50,76],[59,115,101],[123,96,88],[78,104,102],[69,103,141],[90,85,120],[122,104,49],[112,79,113],[126,112,113],[139,125,105],[53,140,121],[43,142,38],[68,129,45],[42,107,62],[89,83,124],[114,93,99],[130,46,45],[107,144,62],[62,145,43],[102,111,78],[97,104,78],[48,104,97],[92,139,105],[147,107,42],[95,146,60],[134,117,111],[121,140,137],[116,131,59],[59,131,115],[142,149,38],[150,82,89],[110,86,91],[127,125,139],[138,151,50],[111,102,134],[136,127,139],[114,94,72],[151,140,50],[109,118,87],[68,73,101],[38,152,25],[144,145,62],[130,153,46],[153,133,46],[154,123,132],[155,104,122],[154,133,153],[98,119,81],[160,158,159],[159,158,157],[135,155,122],[67,42,25],[141,98,69],[102,104,155],[129,157,158],[134,115,131],[133,154,132],[102,115,134],[141,90,98],[141,162,84],[141,84,90],[135,140,155],[140,135,137],[102,148,115],[118,146,95],[146,109,60],[166,150,89],[155,167,102],[115,168,101],[168,115,148],[145,142,43],[169,129,158],[144,118,145],[98,170,119],[98,90,170],[136,163,126],[171,114,99],[171,94,114],[64,156,32],[118,144,146],[119,141,103],[119,103,77],[84,120,70],[172,146,144],[118,173,145],[118,109,173],[109,174,96],[110,175,92],[126,163,112],[176,171,99],[145,130,142],[173,96,123],[173,109,96],[162,141,119],[162,119,170],[120,84,162],[90,120,170],[139,112,136],[112,163,136],[172,107,145],[144,107,172],[146,172,145],[173,146,145],[161,160,159],[96,174,124],[179,162,170],[162,180,120],[120,181,170],[182,92,175],[183,99,79],[107,186,145],[145,153,130],[184,112,139],[189,171,176],[190,159,157],[123,154,191],[192,173,123],[194,109,146],[195,174,109],[174,196,124],[197,79,112],[197,183,79],[160,169,158],[159,165,161],[194,187,177],[198,99,183],[189,94,171],[187,199,177],[157,129,190],[192,146,173],[201,91,82],[140,167,155],[147,42,67],[100,202,76],[129,203,130],[153,191,154],[138,178,151],[204,202,100],[176,99,198],[203,206,130],[203,207,208],[191,153,203],[208,191,203],[203,129,169],[145,186,153],[207,203,169],[209,191,208],[209,123,191],[138,76,178],[152,67,25],[147,185,107],[211,212,207],[211,207,169],[208,207,212],[194,195,109],[140,151,164],[130,186,142],[160,211,169],[148,102,213],[195,196,174],[181,179,170],[197,112,200],[140,164,167],[205,35,94],[150,201,82],[214,129,68],[193,123,209],[177,199,194],[185,186,107],[193,192,123],[192,194,146],[200,112,184],[188,189,176],[189,205,94],[202,178,76],[216,186,130],[186,216,153],[153,216,203],[185,217,186],[217,192,186],[217,194,192],[199,218,194],[194,218,195],[180,162,179],[180,181,120],[198,188,176],[187,194,215],[199,215,218],[195,218,196],[221,220,181],[179,181,220],[180,222,181],[223,200,184],[224,200,223],[168,214,101],[214,68,101],[225,194,217],[192,225,186],[193,225,192],[196,227,219],[187,215,199],[219,124,196],[182,223,184],[228,223,182],[198,189,188],[230,203,216],[225,229,186],[232,179,220],[180,179,232],[234,222,180],[222,235,233],[142,186,149],[214,190,129],[236,230,216],[185,229,217],[225,217,229],[226,237,193],[196,238,227],[218,238,196],[102,167,213],[222,233,181],[189,198,200],[189,200,224],[186,229,239],[160,161,211],[237,225,193],[225,237,194],[238,240,227],[215,241,218],[241,242,218],[223,243,224],[244,189,224],[244,205,189],[151,210,164],[148,246,245],[246,148,213],[249,248,213],[233,232,221],[181,233,221],[180,232,233],[167,249,213],[164,250,167],[164,251,250],[206,236,130],[236,216,130],[185,239,229],[165,159,190],[218,242,238],[248,252,213],[232,253,221],[254,180,233],[190,256,165],[211,165,256],[246,255,245],[211,161,165],[201,175,110],[110,91,201],[209,226,193],[254,234,180],[251,258,250],[256,212,211],[221,231,220],[256,190,214],[230,206,203],[242,240,238],[250,249,167],[206,256,214],[230,256,206],[230,212,256],[246,213,260],[261,243,223],[257,251,164],[210,151,178],[148,245,255],[236,208,212],[219,166,124],[89,124,166],[253,231,221],[264,175,201],[128,204,100],[148,259,168],[236,206,214],[236,212,230],[237,215,194],[247,166,219],[92,182,139],[182,184,139],[259,214,168],[208,263,209],[250,265,249],[264,182,175],[266,198,183],[224,243,267],[257,164,268],[263,208,236],[271,247,219],[272,201,150],[201,272,273],[164,262,268],[274,236,214],[270,260,213],[266,200,198],[210,262,164],[259,148,269],[255,269,148],[246,260,255],[228,276,223],[149,152,38],[252,270,213],[249,265,248],[273,264,201],[258,275,250],[182,276,228],[267,244,224],[261,223,276],[202,210,178],[239,278,277],[239,237,278],[237,209,278],[278,209,263],[209,237,226],[227,271,219],[280,232,220],[231,280,220],[275,265,250],[251,257,258],[279,263,236],[240,271,227],[239,149,186],[269,255,260],[279,278,263],[279,281,278],[270,269,260],[275,258,257],[268,275,257],[149,239,277],[147,239,185],[235,254,233],[234,235,222],[197,200,266],[261,276,182],[143,35,205],[269,270,282],[241,215,237],[280,231,283],[234,183,235],[197,266,267],[244,143,205],[51,65,128],[204,128,202],[284,241,237],[248,265,252],[266,285,267],[285,244,267],[285,143,244],[231,241,283],[286,266,183],[287,268,262],[274,214,259],[288,149,277],[289,277,236],[290,237,239],[242,271,240],[291,280,283],[280,253,232],[183,197,182],[278,281,277],[271,242,247],[241,272,242],[242,272,247],[272,166,247],[272,150,166],[253,241,231],[253,272,241],[254,235,253],[253,273,272],[235,264,253],[235,183,264],[253,264,273],[264,183,182],[267,292,197],[285,294,143],[202,128,293],[277,281,236],[147,297,239],[297,290,239],[281,279,236],[284,283,241],[253,280,254],[234,298,183],[292,267,243],[202,293,210],[259,295,274],[270,252,282],[298,286,183],[286,285,266],[293,128,65],[152,149,288],[284,291,283],[268,287,275],[269,282,296],[265,275,287],[197,299,182],[299,261,182],[285,286,300],[156,65,32],[269,295,259],[269,301,295],[296,301,269],[274,289,236],[298,234,254],[143,64,35],[210,293,262],[289,274,295],[291,254,280],[291,298,254],[265,287,252],[292,299,197],[294,285,300],[290,284,237],[292,243,299],[299,243,261],[297,291,290],[290,291,284],[287,282,252],[298,300,286],[294,300,298],[143,294,64],[262,302,287],[262,293,302],[303,293,65],[301,304,295],[301,296,282],[67,297,147],[288,277,289],[64,294,298],[302,305,287],[304,289,295],[288,289,304],[297,298,291],[287,307,282],[297,64,298],[303,302,293],[65,156,303],[64,297,310],[287,311,307],[304,67,288],[67,152,288],[306,301,282],[313,307,314],[311,314,307],[315,314,311],[305,311,287],[302,316,305],[312,304,301],[67,309,297],[315,317,314],[318,315,311],[310,156,64],[321,297,309],[303,320,302],[309,67,304],[309,304,312],[317,313,314],[310,297,321],[156,310,322],[302,308,316],[308,302,323],[320,323,302],[303,156,320],[325,309,312],[282,313,306],[307,313,282],[326,317,315],[318,319,315],[305,316,318],[311,305,318],[301,324,312],[325,312,324],[325,321,309],[313,328,306],[326,321,317],[317,321,325],[317,325,327],[328,313,317],[310,321,326],[329,310,326],[329,326,315],[322,329,330],[322,310,329],[316,308,318],[320,156,322],[315,319,329],[320,322,330],[320,330,323],[328,331,306],[327,325,324],[329,319,330],[319,323,330],[306,331,301],[318,308,319],[301,331,324],[327,324,331],[328,327,331],[328,317,327],[323,319,308]];
        return { v: v, e: e, f: f };
    }

    function rot3(p, yaw, pitch) {
        var cy = Math.cos(yaw), sy = Math.sin(yaw);
        var x1 = p[0] * cy - p[1] * sy;
        var y1 = p[0] * sy + p[1] * cy;
        var z1 = p[2];
        var cp = Math.cos(pitch), sp = Math.sin(pitch);
        var y2 = y1 * cp - z1 * sp;
        var z2 = y1 * sp + z1 * cp;
        return [x1, y2, z2];   // y2 = depth (toward viewer = negative)
    }

    // Default hotspot anchor per subsystem index (spread along the hull).
    function autoAnchor(idx, total) {
        var t = total <= 1 ? 0.5 : idx / (total - 1);
        var lx = -0.7 + t * 1.4;
        var side = (idx % 2 === 0) ? 1 : -1;
        var lz = (idx % 2 === 0) ? 0.32 : -0.32;
        return [lx, side * 0.2, lz];
    }

    function drawModel(ctx, x, y, w, h, subs, statusBySub, yaw, pitch, pal, partMap, hotOut, scheme) {
        var geo = podGeometry();
        var cx = x + w / 2, cyc = y + h * 0.5;
        var scale = Math.min(w, h) * 0.42;

        // rotate all vertices once
        var i, rv = [];
        for (i = 0; i < geo.v.length; i++) rv.push(rot3(geo.v[i], yaw, pitch));

        // Shaded solid render: backface-cull, painter-sort front faces far→near,
        // flat-shade each by its normal against a fixed light. Reads as a solid pod.
        if (geo.f && geo.f.length) {
            var faces = geo.f, j;
            var base = hexToRgb(pal.model);
            // light direction (toward light) in view space: upper-front-left
            var Lx = -0.35, Ly = -0.55, Lz = 0.75;
            var Ln = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
            Lx /= Ln; Ly /= Ln; Lz /= Ln;
            var order = [];
            for (j = 0; j < faces.length; j++) {
                var A0 = rv[faces[j][0]], B0 = rv[faces[j][1]], C0 = rv[faces[j][2]];
                var ux = B0[0] - A0[0], uy = B0[1] - A0[1], uz = B0[2] - A0[2];
                var vx = C0[0] - A0[0], vy = C0[1] - A0[1], vz = C0[2] - A0[2];
                var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                if (ny >= 0) continue;   // backface (normal points away from viewer)
                var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
                var diff = (nx * Lx + ny * Ly + nz * Lz) / nl;
                if (diff < 0) diff = 0;
                var shade = 0.32 + 0.68 * diff;     // ambient + diffuse
                order.push({ j: j, depth: (A0[1] + B0[1] + C0[1]) / 3, shade: shade });
            }
            order.sort(function(p, q) { return q.depth - p.depth; });
            for (i = 0; i < order.length; i++) {
                var o = order[i], fc = faces[o.j];
                var p0 = rv[fc[0]], p1 = rv[fc[1]], p2 = rv[fc[2]];
                var r = Math.round(base[0] * o.shade), g = Math.round(base[1] * o.shade), bb = Math.round(base[2] * o.shade);
                var col = 'rgb(' + r + ',' + g + ',' + bb + ')';
                ctx.beginPath();
                ctx.moveTo(cx + p0[0] * scale, cyc - p0[2] * scale);
                ctx.lineTo(cx + p1[0] * scale, cyc - p1[2] * scale);
                ctx.lineTo(cx + p2[0] * scale, cyc - p2[2] * scale);
                ctx.closePath();
                ctx.fillStyle = col;
                ctx.fill();
                ctx.strokeStyle = col;     // seal hairline seams between facets
                ctx.lineWidth = 0.6;
                ctx.stroke();
            }
        } else {
            // fallback: plain see-through wireframe
            var a, b, depth;
            for (i = 0; i < geo.e.length; i++) {
                a = rv[geo.e[i][0]]; b = rv[geo.e[i][1]];
                depth = (a[1] + b[1]) / 2;
                var alpha = 0.25 + 0.45 * (1 - (depth + 1.4) / 2.8);
                if (alpha < 0.12) alpha = 0.12; if (alpha > 0.7) alpha = 0.7;
                ctx.strokeStyle = rgbaStr(pal.model, alpha);
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(cx + a[0] * scale, cyc - a[2] * scale);
                ctx.lineTo(cx + b[0] * scale, cyc - b[2] * scale);
                ctx.stroke();
            }
        }

        // hotspots, depth-sorted (far first)
        hotOut.length = 0;
        var spots = [];
        for (i = 0; i < subs.length; i++) {
            var sub = subs[i].sub;
            var anchor = (partMap && partMap[sub]) ? partMap[sub] : autoAnchor(i, subs.length);
            var r = rot3(anchor, yaw, pitch);
            spots.push({ sub: sub, sx: cx + r[0] * scale, sy: cyc - r[2] * scale, depth: r[1], col: subAccent(sub, i, scheme) });
        }
        spots.sort(function(p, q) { return q.depth - p.depth; });
        for (i = 0; i < spots.length; i++) {
            var s = spots[i];
            var near = s.depth < 0;
            var col = s.col || pal.neutral;
            var rad = near ? 7 : 5;
            ctx.globalAlpha = near ? 1 : 0.45;
            ctx.beginPath();
            ctx.arc(s.sx, s.sy, rad + 3, 0, Math.PI * 2);
            ctx.fillStyle = rgbaStr(col, 0.18); ctx.fill();
            ctx.beginPath();
            ctx.arc(s.sx, s.sy, rad, 0, Math.PI * 2);
            ctx.fillStyle = col; ctx.fill();
            ctx.globalAlpha = 1;
            hotOut.push({ sub: s.sub, x: s.sx, y: s.sy, r: rad + 4 });
        }
    }

    // ── Visualization Class ─────────────────────────────────────────

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('hyperloop-analysis-viz');
            this.canvas = document.createElement('canvas');
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.canvas.style.display = 'block';
            this.el.appendChild(this.canvas);

            this._lastGoodData = null;
            this._collapsed = {};
            this._yaw = 0.6;
            this._pitch = 0.5;
            this._rotTimer = null;
            this._headerRects = [];
            this._hotspots = [];
            this._modelRect = null;
            this._schema = [];
            this._selected = {};
            this._selInit = false;
            this._listRects = [];
            this._listGroupRects = [];
            this._listRect = null;
            this._listScroll = 0;
            this._listMaxScroll = 0;
            this._filter = '';
            this._sortMode = 'group';     // 'group' | 'error'
            this._roleFilter = 'all';      // 'all' | 'pair' | 'gain' | 'out'
            this._onlyUnstable = false;
            this._chipRects = [];
            this._overviewRects = [];
            this._chartRects = [];
            this._chartArea = null;
            this._hoverIdx = -1;
            this._hoverActive = false;
            this._modelFocus = false;
            this._modelBtnRect = null;
            // time navigation
            this._zoom = null;          // {i0,i1} absolute row indices, or null
            this._pinIdx = -1;          // pinned cursor (view index), or -1
            this._brushing = false; this._brush = null;
            this._scrubbing = false;
            this._playing = false; this._playTimer = null;
            this._ctrlRects = []; this._scrubRect = null;
            this._viewLen = 0;
            // analysis lab
            this._labOpen = false; this._labMode = 'op';
            this._labRects = []; this._labSelects = null;
            this._labCursor = null; this._labPin = null;
            this._labPlotRect = null; this._labData = null;
            this._labZoom = null; this._labBrush = null; this._labBrushing = false;
            // single-chart focus (double-click a chart to maximize it)
            this._focusChart = null; this._focusBackRect = null;
            // CSV export
            this._exportRows = null; this._toast = ''; this._toastUntil = 0; this._toastTimer = null;
            // persisted view state (#5)
            this._STATE_KEY = 'hyperloop_analysis.viewstate.v1';
            this._pendingRange = null; this._lastSavedState = null;
            this._loadState();

            var self = this;
            function pos(e) {
                var r = self.el.getBoundingClientRect();
                return { x: e.clientX - r.left, y: e.clientY - r.top };
            }

            // Real text input overlaid on the canvas for the parameter filter.
            try { if (!this.el.style.position) this.el.style.position = 'relative'; } catch (e0) {}
            this._filterInput = document.createElement('input');
            this._filterInput.type = 'text';
            this._filterInput.setAttribute('placeholder', 'Filter parameters');
            var fi = this._filterInput.style;
            fi.position = 'absolute'; fi.display = 'none'; fi.zIndex = '5';
            fi.font = '11px sans-serif'; fi.boxSizing = 'border-box'; fi.padding = '1px 6px';
            fi.border = '1px solid rgba(255,255,255,0.2)'; fi.borderRadius = '4px';
            fi.background = 'rgba(20,20,30,0.85)'; fi.color = '#fff'; fi.outline = 'none';
            this.el.appendChild(this._filterInput);
            this._filterInput.addEventListener('input', function() {
                self._filter = self._filterInput.value || '';
                self._listScroll = 0;
                self.invalidateUpdateView();
            });

            // Range menu: quickly window the data to a recent interval (drives both views).
            this._rangeSelect = document.createElement('select');
            var rs = this._rangeSelect.style;
            rs.position = 'absolute'; rs.display = 'none'; rs.zIndex = '6';
            rs.font = '10px sans-serif'; rs.background = 'rgba(20,20,30,0.92)'; rs.color = '#fff';
            rs.border = '1px solid rgba(255,255,255,0.25)'; rs.borderRadius = '4px'; rs.padding = '1px 4px';
            var rngOpts = [['all', 'All time'], ['10s', 'Last 10 sec'], ['30s', 'Last 30 sec'],
                ['1m', 'Last 1 min'], ['2m', 'Last 2 min'], ['5m', 'Last 5 min'], ['30m', 'Last 30 min'],
                ['1h', 'Last 1 hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours'], ['custom', 'Custom (brushed)']];
            for (var ri = 0; ri < rngOpts.length; ri++) {
                var ro = document.createElement('option'); ro.value = rngOpts[ri][0]; ro.textContent = rngOpts[ri][1];
                this._rangeSelect.appendChild(ro);
            }
            this.el.appendChild(this._rangeSelect);
            this._rangeSelect.addEventListener('change', function() {
                if (self._rangeSelect.value === 'custom') return;   // display-only state
                self._applyRange(self._rangeSelect.value);
                self.invalidateUpdateView();
            });

            this._onDown = function(e) {
                var p = pos(e);
                self._ptrDown = true; self._moved = false;
                self._downX = p.x; self._downY = p.y;
                self._startYaw = self._yaw; self._startPitch = self._pitch;
                self._dragInModel = false; self._brushing = false; self._labBrushing = false;
                if (self._labOpen) {
                    var lpd = self._labPlotRect;
                    if (lpd && p.x >= lpd.ix && p.x <= lpd.ix + lpd.iw && p.y >= lpd.iy && p.y <= lpd.iy + lpd.ih) {
                        self._labBrushing = true; self._labBrush = null;
                    }
                    return;   // lab clicks/brush resolve in _onUp
                }
                var ca = self._chartArea;
                if (ca && p.x >= ca.x && p.x <= ca.x + ca.w && p.y >= ca.y && p.y <= ca.y + ca.h) {
                    self._brushing = true; return;
                }
                self._dragInModel = self._modelRect &&
                    p.x >= self._modelRect.x && p.x <= self._modelRect.x + self._modelRect.w &&
                    p.y >= self._modelRect.y && p.y <= self._modelRect.y + self._modelRect.h;
            };
            this._onMove = function(e) {
                var p = pos(e);
                if (self._ptrDown) {
                    var dx = p.x - self._downX, dy = p.y - self._downY;
                    if (Math.abs(dx) + Math.abs(dy) > 4) self._moved = true;
                    if (self._labBrushing) {
                        self._labBrush = { x0: self._downX, y0: self._downY, x1: p.x, y1: p.y };
                        self.invalidateUpdateView();
                        return;
                    }
                    if (self._brushing) {
                        self._brush = { x0: self._downX, x1: p.x };
                        self.invalidateUpdateView();
                        return;
                    }
                    if (self._dragInModel && self._moved) {
                        self._yaw = self._startYaw + dx * 0.01;
                        self._pitch = Math.max(-1.2, Math.min(1.2, self._startPitch - dy * 0.01));
                        self.invalidateUpdateView();
                    }
                    return;
                }
                if (self._labOpen) {
                    var lp = self._labPlotRect;
                    var inLp = lp && p.x >= lp.ix && p.x <= lp.ix + lp.iw && p.y >= lp.iy && p.y <= lp.iy + lp.ih;
                    if (inLp) { self._labCursor = { x: p.x, y: p.y }; self.invalidateUpdateView(); }
                    else if (self._labCursor) { self._labCursor = null; self.invalidateUpdateView(); }
                    return;
                }
                // hover crosshair over the chart area
                var ca = self._chartArea;
                if (ca && p.x >= ca.x && p.x <= ca.x + ca.w && p.y >= ca.y && p.y <= ca.y + ca.h && ca.n > 1) {
                    var idx = Math.round((p.x - ca.x) / ca.w * (ca.n - 1));
                    idx = Math.max(0, Math.min(ca.n - 1, idx));
                    if (!self._hoverActive || idx !== self._hoverIdx) {
                        self._hoverActive = true; self._hoverIdx = idx;
                        self.invalidateUpdateView();
                    }
                } else if (self._hoverActive) {
                    self._hoverActive = false;
                    self.invalidateUpdateView();
                }
            };
            this._onUp = function(e) {
                var pp = pos(e), ci;
                // Analysis Lab buttons / plot cursor / brush-zoom
                if (self._labOpen) {
                    if (self._labBrushing && self._moved && self._labBrush) {
                        self._applyLabZoom(self._labBrush);           // drag → zoom the plot
                    } else if (self._ptrDown && !self._moved) {
                        var hitRect = false;
                        for (ci = 0; ci < self._labRects.length; ci++) {
                            var lr = self._labRects[ci];
                            if (pp.x >= lr.x && pp.x <= lr.x + lr.w && pp.y >= lr.y && pp.y <= lr.y + lr.h) {
                                hitRect = true;
                                if (lr.act === 'close') { self._labOpen = false; self._labCursor = null; self._labPin = null; }
                                else if (lr.act.indexOf('mode:') === 0) {
                                    self._labMode = lr.act.slice(5);
                                    self._labPin = null; self._labCursor = null; self._labZoom = null;
                                }
                                self.invalidateUpdateView();
                                break;
                            }
                        }
                        // click inside the plot → toggle the pinned cursor
                        if (!hitRect) {
                            var lp = self._labPlotRect;
                            if (lp && pp.x >= lp.ix && pp.x <= lp.ix + lp.iw && pp.y >= lp.iy && pp.y <= lp.iy + lp.ih) {
                                self._labPin = self._labPin ? null : { x: pp.x, y: pp.y };
                            }
                        }
                    }
                    self._labBrush = null; self._labBrushing = false;
                    self._ptrDown = false; self._brushing = false;
                    self.invalidateUpdateView();
                    return;
                }
                // single-chart focus: "back" button
                if (self._ptrDown && !self._moved && self._focusBackRect) {
                    var fb = self._focusBackRect;
                    if (pp.x >= fb.x && pp.x <= fb.x + fb.w && pp.y >= fb.y && pp.y <= fb.y + fb.h) {
                        self._focusChart = null;
                        self.invalidateUpdateView();
                        self._ptrDown = false; return;
                    }
                }
                // control strip buttons
                if (self._ptrDown && !self._moved) {
                    for (ci = 0; ci < self._ctrlRects.length; ci++) {
                        var c = self._ctrlRects[ci];
                        if (pp.x >= c.x && pp.x <= c.x + c.w && pp.y >= c.y && pp.y <= c.y + c.h) {
                            if (c.act === 'lab') { self._labOpen = true; self._labCursor = null; self._labPin = null; }
                            else if (c.act === 'csv') { self._exportCSV(); }
                            else if (c.act === 'reset') { self._zoom = null; self._pinIdx = -1; if (self._rangeSelect) self._rangeSelect.value = 'all'; }
                            self.invalidateUpdateView();
                            self._ptrDown = false; return;
                        }
                    }
                }
                // brush → zoom, or plain click in chart → toggle pin
                if (self._brushing) {
                    var ca = self._chartArea;
                    if (ca && ca.n > 1) {
                        if (self._brush && Math.abs(self._brush.x1 - self._brush.x0) > 6) {
                            var f0 = (Math.min(self._brush.x0, self._brush.x1) - ca.x) / ca.w;
                            var f1 = (Math.max(self._brush.x0, self._brush.x1) - ca.x) / ca.w;
                            f0 = Math.max(0, Math.min(1, f0)); f1 = Math.max(0, Math.min(1, f1));
                            // Map the brush fraction onto the current window's UNCAPPED row span
                            // (_viewLen), not the capped point count (ca.n) — otherwise on long
                            // runs the zoom lands on the wrong rows.
                            var span = (self._viewLen || ca.n) - 1;
                            var vi0 = Math.round(f0 * span), vi1 = Math.round(f1 * span);
                            if (vi1 - vi0 >= 2) {
                                var b0 = self._zoom ? self._zoom.i0 : 0;
                                self._zoom = { i0: b0 + vi0, i1: b0 + vi1 };
                                self._pinIdx = -1;
                                if (self._rangeSelect) self._rangeSelect.value = 'custom';
                            }
                        } else if (!self._moved) {
                            var fr = (pp.x - ca.x) / ca.w; fr = Math.max(0, Math.min(1, fr));
                            var pidx = Math.round(fr * (ca.n - 1));
                            self._pinIdx = (self._pinIdx === pidx) ? -1 : pidx;
                        }
                    }
                    self._brush = null; self._brushing = false;
                    self.invalidateUpdateView();
                    self._ptrDown = false; return;
                }

                if (self._ptrDown && !self._moved) {
                    var p = pos(e), i;
                    // model focus toggle button
                    var mb = self._modelBtnRect;
                    if (mb && p.x >= mb.x && p.x <= mb.x + mb.w && p.y >= mb.y && p.y <= mb.y + mb.h) {
                        self._modelFocus = !self._modelFocus;
                        self.invalidateUpdateView();
                        self._ptrDown = false; return;
                    }
                    // accordion header → collapse/expand
                    for (i = 0; i < self._headerRects.length; i++) {
                        var hr = self._headerRects[i];
                        if (p.x >= hr.x && p.x <= hr.x + hr.w && p.y >= hr.y && p.y <= hr.y + hr.h) {
                            self._collapsed[hr.sub] = !self._collapsed[hr.sub];
                            self.invalidateUpdateView();
                            self._ptrDown = false; return;
                        }
                    }
                    // control chips (sort / role / unstable)
                    for (i = 0; i < self._chipRects.length; i++) {
                        var cr = self._chipRects[i];
                        if (p.x >= cr.x && p.x <= cr.x + cr.w && p.y >= cr.y && p.y <= cr.y + cr.h) {
                            if (cr.act === 'sort') self._sortMode = (self._sortMode === 'group') ? 'error' : 'group';
                            else if (cr.act === 'role') {
                                var seq = ['all', 'pair', 'gain', 'out'];
                                self._roleFilter = seq[(seq.indexOf(self._roleFilter) + 1) % seq.length];
                            } else if (cr.act === 'unstable') self._onlyUnstable = !self._onlyUnstable;
                            self._listScroll = 0;
                            self.invalidateUpdateView();
                            self._ptrDown = false; return;
                        }
                    }
                    // overview heatmap cell → toggle that parameter
                    for (i = 0; i < self._overviewRects.length; i++) {
                        var ov = self._overviewRects[i];
                        if (p.x >= ov.x && p.x <= ov.x + ov.w && p.y >= ov.y && p.y <= ov.y + ov.h) {
                            self._selected[ov.id] = !self._selected[ov.id];
                            self.invalidateUpdateView();
                            self._ptrDown = false; return;
                        }
                    }
                    // parameter list row → toggle that parameter
                    for (i = 0; i < self._listRects.length; i++) {
                        var lr = self._listRects[i];
                        if (p.x >= lr.x && p.x <= lr.x + lr.w && p.y >= lr.y && p.y <= lr.y + lr.h) {
                            self._selected[lr.id] = !self._selected[lr.id];
                            self.invalidateUpdateView();
                            self._ptrDown = false; return;
                        }
                    }
                    // parameter list group header → bulk toggle that whole department on/off
                    for (i = 0; i < self._listGroupRects.length; i++) {
                        var gr = self._listGroupRects[i];
                        if (p.x >= gr.x && p.x <= gr.x + gr.w && p.y >= gr.y && p.y <= gr.y + gr.h) {
                            self._toggleSubsystem(gr.sub);
                            self.invalidateUpdateView();
                            self._ptrDown = false; return;
                        }
                    }
                    // pod hotspot → bulk toggle all of that subsystem's params
                    for (i = 0; i < self._hotspots.length; i++) {
                        var hs = self._hotspots[i];
                        if (Math.abs(p.x - hs.x) <= hs.r + 3 && Math.abs(p.y - hs.y) <= hs.r + 3) {
                            self._toggleSubsystem(hs.sub);
                            self.invalidateUpdateView();
                            break;
                        }
                    }
                }
                self._ptrDown = false;
            };
            this._onWheel = function(e) {
                if (!self._listRect) return;
                var p = pos(e);
                if (p.x >= self._listRect.x && p.x <= self._listRect.x + self._listRect.w &&
                    p.y >= self._listRect.y && p.y <= self._listRect.y + self._listRect.h) {
                    if (self._listMaxScroll <= 0) return;
                    e.preventDefault();
                    self._listScroll = Math.max(0, Math.min(self._listMaxScroll, self._listScroll + e.deltaY));
                    self.invalidateUpdateView();
                }
            };
            this._onLeave = function(e) {
                self._onUp(e);
                if (self._hoverActive) { self._hoverActive = false; self.invalidateUpdateView(); }
                if (self._labCursor) { self._labCursor = null; self.invalidateUpdateView(); }
            };
            // double-click a chart → maximize it for a clearer view; again → restore
            this._onDblClick = function(e) {
                if (self._labOpen) {   // double-click resets the lab view-zoom
                    if (self._labZoom) { self._labZoom = null; self.invalidateUpdateView(); }
                    return;
                }
                var p = pos(e);
                if (self._focusChart) { self._focusChart = null; self.invalidateUpdateView(); return; }
                for (var i = 0; i < self._chartRects.length; i++) {
                    var cr = self._chartRects[i];
                    if (cr.cx != null && p.x >= cr.cx && p.x <= cr.cx + cr.cw && p.y >= cr.y && p.y <= cr.y + cr.h) {
                        self._focusChart = { kind: cr.kind, name: cr.name, sub: cr.sub,
                            sp: cr.sp, act: cr.act, field: cr.field, accent: cr.accent };
                        self._pinIdx = -1; self._hoverActive = false;
                        self.invalidateUpdateView();
                        return;
                    }
                }
            };
            this.el.addEventListener('mousedown', this._onDown);
            this.el.addEventListener('mousemove', this._onMove);
            this.el.addEventListener('mouseup', this._onUp);
            this.el.addEventListener('mouseleave', this._onLeave);
            this.el.addEventListener('dblclick', this._onDblClick);
            this.el.addEventListener('wheel', this._onWheel, { passive: false });
        },

        // Toggle every graphable param of a subsystem: if all are on, turn off;
        // otherwise turn them all on.
        _toggleSubsystem: function(sub) {
            var i, sec = null;
            for (i = 0; i < this._schema.length; i++) if (this._schema[i].sub === sub) sec = this._schema[i];
            if (!sec) return;
            var items = secItems(sec), allOn = true;
            for (i = 0; i < items.length; i++) if (!this._selected[items[i].id]) { allOn = false; break; }
            for (i = 0; i < items.length; i++) this._selected[items[i].id] = !allOn;
        },

        getInitialDataParams: function() {
            return { outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE, count: 10000 };
        },

        formatData: function(data, config) {
            if (!data || !data.rows || data.rows.length === 0) {
                if (this._lastGoodData) return this._lastGoodData;
                return { _status: 'Awaiting tuning telemetry' };
            }
            var fields = data.fields, colIdx = {}, i;
            for (i = 0; i < fields.length; i++) colIdx[fields[i].name] = i;

            // Discover tune_ schema from field names (no config — safe in formatData).
            var subs = {};      // sub -> { pairs:{}, gains:[], outs:[] }
            var order = [];
            for (i = 0; i < fields.length; i++) {
                var fn = fields[i].name;
                if (fn.indexOf('tune_') !== 0) continue;
                var rest = fn.slice(5).split('_');
                if (rest.length < 2) continue;
                var sub = rest[0];
                // Strict classification: only the departments defined in the classification
                // markdown (KNOWN_LABELS) are charted. Any other leading token (e.g. an
                // unlisted "sense_and_control" subsystem) is dropped entirely.
                if (!KNOWN_LABELS[sub]) continue;
                var role = rest[rest.length - 1];
                var name;
                if (ROLES[role]) { name = rest.slice(1, rest.length - 1).join('_'); }
                else { role = 'out'; name = rest.slice(1).join('_'); }
                if (!name) name = role;
                if (!subs[sub]) { subs[sub] = { sub: sub, pairs: {}, gains: [], outs: [] }; order.push(sub); }
                if (role === 'sp' || role === 'act') {
                    if (!subs[sub].pairs[name]) subs[sub].pairs[name] = { name: name };
                    subs[sub].pairs[name][role] = fn;
                } else if (role === 'gain') {
                    subs[sub].gains.push({ name: name, field: fn });
                } else {
                    subs[sub].outs.push({ name: name, field: fn });
                }
            }
            // Normalise: pairs missing a partner become outs.
            var schema = [];
            for (i = 0; i < order.length; i++) {
                var s = subs[order[i]];
                var pairs = [];
                for (var pn in s.pairs) {
                    if (!s.pairs.hasOwnProperty(pn)) continue;
                    var pr = s.pairs[pn];
                    if (pr.sp && pr.act) pairs.push(pr);
                    else s.outs.push({ name: pn, field: pr.sp || pr.act });
                }
                schema.push({ sub: s.sub, pairs: pairs, gains: s.gains, outs: s.outs });
            }

            var parsed = [];
            for (var row = 0; row < data.rows.length; row++) {
                var r2 = data.rows[row], obj = {};
                for (var f = 0; f < fields.length; f++) {
                    var nm = fields[f].name;
                    obj[nm] = (nm === '_time') ? toEpochSeconds(r2[f]) : parseFloat(r2[f]);
                }
                parsed.push(obj);
            }
            parsed.sort(function(a, b) { return a._time - b._time; });

            var result = { rows: parsed, schema: schema };
            this._lastGoodData = result;
            return result;
        },

        updateView: function(data, config) {
            if (data && data._status) {
                if (this._filterInput) this._filterInput.style.display = 'none';
                if (this._rangeSelect) this._rangeSelect.style.display = 'none';
                this._ensureCanvas(); this._drawStatusMessage(data._status); return;
            }
            if (!data) { if (this._lastGoodData) data = this._lastGoodData; else return; }

            var ns = this.getPropertyNamespaceInfo().propertyNamespace;
            var warnPct = parseFloat(config[ns + 'errWarnPct']) || 5;
            var critPct = parseFloat(config[ns + 'errCritPct']) || 15;
            var scheme = config[ns + 'colorScheme'] || 'dark';
            var autoRot = (config[ns + 'modelAutoRotate'] || 'true') === 'true';
            var showOverview = (config[ns + 'showOverview'] || 'true') === 'true';
            var showRowPreview = (config[ns + 'showRowPreview'] || 'true') === 'true';
            var sampleIntervalMs = parseFloat(config[ns + 'sampleIntervalMs']) || 0;
            var sampleOffsetMs = parseFloat(config[ns + 'sampleOffsetMs']) || 0;
            var partMap = null;
            var pmRaw = config[ns + 'partMap'];
            if (pmRaw) { try { partMap = JSON.parse(pmRaw); } catch (err) { partMap = null; } }

            var pal = buildPalette(scheme);
            // Optional global decimation: keep one point per interval (with offset).
            var rows = decimateRows(data.rows, sampleIntervalMs, sampleOffsetMs);
            var schema = data.schema;
            this._schema = schema;
            // #5 Apply a restored Range preset once, on the first render after reload.
            if (this._pendingRange) {
                var pend = this._pendingRange; this._pendingRange = null;
                if (pend !== 'all' && pend !== 'custom') {
                    if (this._rangeSelect) this._rangeSelect.value = pend;
                    this._applyRange(pend);
                }
            }
            // Apply the zoom window: charts/crosshair use viewRows; list/overview use full rows.
            // Clamp FIRST, then validate — otherwise a refresh that changes the row count
            // can leave i1 < i0 and produce an empty slice (which blanks every chart).
            if (this._zoom) {
                var zi0 = Math.max(0, Math.min(this._zoom.i0, rows.length - 1));
                var zi1 = Math.max(0, Math.min(this._zoom.i1, rows.length - 1));
                if (zi1 - zi0 >= 1 && (zi0 > 0 || zi1 < rows.length - 1)) {
                    this._zoom = { i0: zi0, i1: zi1 };
                } else {
                    this._zoom = null;   // window collapsed or covers everything → show all
                }
            }
            var viewRows = this._zoom ? rows.slice(this._zoom.i0, this._zoom.i1 + 1) : rows;
            this._viewLen = viewRows.length;
            // #6 Auto-decimation: cap the points actually drawn so very long / accumulating
            // runs stay smooth. Zooming in reduces the window below the cap → full detail
            // returns. List sparklines/overview keep using the full `rows`.
            this._exportRows = viewRows;   // CSV export uses the unthinned current window
            viewRows = capPoints(viewRows, MAX_DRAW_POINTS);
            this._chartRects = [];
            this._chartArea = null;
            this._chartPlotX = null; this._chartPlotW = null;

            // Default selection on first render: show all setpoint/actual pairs.
            // If a schema has no pairs at all, fall back to selecting everything.
            if (!this._selInit && schema.length) {
                var anyPair = false, ii, jj, it;
                for (ii = 0; ii < schema.length; ii++) {
                    for (jj = 0; jj < schema[ii].pairs.length; jj++) {
                        this._selected[paramId(schema[ii].sub, 'pair', schema[ii].pairs[jj].name)] = true;
                        anyPair = true;
                    }
                }
                if (!anyPair) {
                    for (ii = 0; ii < schema.length; ii++) {
                        var items0 = secItems(schema[ii]);
                        for (jj = 0; jj < items0.length; jj++) this._selected[items0[jj].id] = true;
                    }
                }
                this._selInit = true;
            }

            this._ensureCanvas();
            var rect = this.el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
            var ctx = this.canvas.getContext('2d');
            if (!ctx) return;
            ctx.scale(dpr, dpr);
            var w = rect.width, h = rect.height;
            ctx.clearRect(0, 0, w, h);

            // Per-subsystem status (worst relErr across its pairs).
            var statusBySub = {};   // sub -> { pct, _col }
            this._allSubs = [];
            var si, pi;
            for (si = 0; si < schema.length; si++) {
                var sub = schema[si].sub;
                this._allSubs.push(sub);
                var worst = null;
                for (pi = 0; pi < schema[si].pairs.length; pi++) {
                    var pc = relErrorPct(rows, schema[si].pairs[pi].sp, schema[si].pairs[pi].act);
                    if (pc !== null && (worst === null || pc > worst)) worst = pc;
                }
                var col = statusColour(worst, warnPct, critPct, pal);
                statusBySub[sub] = { pct: worst, _col: col };
            }

            var pad = 10;
            var accW = (w - pad * 3) * 0.55;
            var modelX = pad + accW + pad;
            var modelW = w - modelX - pad;

            // ── Analysis Lab overlay takes over the whole panel when open ──
            if (this._labOpen) {
                this._drawLab(ctx, viewRows, schema, w, h, scheme, pal);
                this._manageRotation(false);
                return;
            }
            if (this._rangeSelect) this._positionRangeSelect(pad, accW);

            // ── Control strip (top of left column): Lab · play · scrubber · zoom ──
            var stripH = this._drawControlStrip(ctx, viewRows, pad, pad, accW);
            var topY = pad + stripH + 6;

            // ── Overview heatmap band ──
            var accY = topY;
            if (showOverview && schema.length) {
                var ovH = this._drawOverview(ctx, schema, statusBySub, pad, topY, accW, h - pad - topY, scheme, pal);
                accY = topY + ovH + 8;
            } else {
                this._overviewRects = [];
            }
            var accH = h - pad - accY;

            // ── Accordion (left) — charts use the zoomed view window ──
            this._drawAccordion(ctx, viewRows, schema, statusBySub, pad, accY, accW, accH,
                warnPct, critPct, scheme, pal);

            // ── Crosshair overlay (over the charts) ──
            this._drawCrosshairAndEvents(ctx, viewRows);

            // ── Brush selection rectangle (while dragging to zoom) ──
            if (this._brush && this._chartArea) {
                var bx0 = Math.min(this._brush.x0, this._brush.x1);
                var bx1 = Math.max(this._brush.x0, this._brush.x1);
                var ca = this._chartArea;
                bx0 = Math.max(bx0, ca.x); bx1 = Math.min(bx1, ca.x + ca.w);
                ctx.fillStyle = 'rgba(108,92,231,0.18)';
                ctx.fillRect(bx0, ca.y, bx1 - bx0, ca.h);
                ctx.strokeStyle = 'rgba(108,92,231,0.6)';
                ctx.lineWidth = 1;
                ctx.strokeRect(bx0, ca.y, bx1 - bx0, ca.h);
            }

            // divider
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(modelX - pad / 2, pad);
            ctx.lineTo(modelX - pad / 2, h - pad);
            ctx.stroke();

            // ── Model (right) ──
            this._drawModelPanel(ctx, rows, schema, statusBySub, modelX, pad, modelW, h - pad * 2,
                warnPct, critPct, scheme, pal, partMap, showRowPreview);

            // Transient toast (e.g. CSV export result), drawn on top of everything
            this._drawToast(ctx, w, h);

            // #5 Persist view state (selection / collapse / sort / range) across reloads
            this._saveState();

            // Auto-rotate timer management
            this._manageRotation(autoRot);
        },

        // Overview heatmap: one cell per parameter, coloured by status. Returns its height.
        _drawOverview: function(ctx, schema, statusBySub, x, y, w, h, scheme, pal) {
            this._overviewRects = [];
            var items = [], si, k, sub;
            for (si = 0; si < schema.length; si++) {
                var its = secItems(schema[si]);
                for (k = 0; k < its.length; k++) items.push({ it: its[k], sub: schema[si].sub, subIdx: si });
            }
            if (!items.length) return 0;

            ctx.font = 'bold 9px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.fillText('Overview', x, y);
            ctx.textAlign = 'right';
            ctx.font = '8px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.fillText('click to graph', x + w, y + 1);
            ctx.textAlign = 'left';

            var gy = y + 14;
            var cell = 13, gap = 3;
            var cols = Math.max(1, Math.floor((w + gap) / (cell + gap)));
            var rowsN = Math.ceil(items.length / cols);
            var maxRows = 4;
            if (rowsN > maxRows) { rowsN = maxRows; }       // cap height; cells shrink to fit width only
            for (k = 0; k < items.length; k++) {
                var ci = k % cols, ri = Math.floor(k / cols);
                if (ri >= maxRows) break;
                var cx = x + ci * (cell + gap), cy = gy + ri * (cell + gap);
                var rec = items[k];
                var on = !!this._selected[rec.it.id];
                var col = subAccent(rec.sub, rec.subIdx, scheme);   // colour = subsystem accent (matches line)
                roundRect(ctx, cx, cy, cell, cell, 2);
                ctx.fillStyle = on ? col : rgbaStr(col, 0.22);
                ctx.fill();
                if (on) { ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1; ctx.stroke(); }
                this._overviewRects.push({ id: rec.it.id, x: cx, y: cy, w: cell, h: cell });
            }
            var usedRows = Math.min(rowsN, Math.ceil(items.length / cols));
            return 14 + usedRows * (cell + gap);
        },

        // Vertical hover line across all charts + a value tooltip.
        _drawCrosshairAndEvents: function(ctx, rows) {
            var ca = this._chartArea;
            if (!ca) return;
            var i;

            // pinned cursor (cyan) for delta comparison
            var pin = this._pinIdx;
            if (pin >= 0 && pin < ca.n && ca.n > 1) {
                var pxp = ca.x + (pin / (ca.n - 1)) * ca.w;
                ctx.save();
                ctx.setLineDash([3, 2]);
                ctx.strokeStyle = 'rgba(0,200,255,0.8)';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(pxp, ca.y); ctx.lineTo(pxp, ca.y + ca.h); ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();
            }

            if (!this._hoverActive || this._hoverIdx < 0 || ca.n < 2) return;
            var idx = Math.min(ca.n - 1, this._hoverIdx);
            var hx = ca.x + (idx / (ca.n - 1)) * ca.w;
            var hasPin = (pin >= 0 && pin < ca.n && pin !== idx);

            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(hx, ca.y); ctx.lineTo(hx, ca.y + ca.h); ctx.stroke();

            // tooltip: timestamp + each visible chart's value (and Δ vs the pin)
            var lines = [];
            var t = rows[idx] ? rows[idx]._time : null;
            if (t) { lines.push({ k: 'time', v: new Date(t * 1000).toLocaleTimeString(), d: '' }); }
            for (i = 0; i < this._chartRects.length; i++) {
                var cr = this._chartRects[i];
                var val = cr.kind === 'pair' ? rows[idx][cr.act] : rows[idx][cr.field];
                var dtxt = '';
                if (hasPin) {
                    var pv = cr.kind === 'pair' ? rows[pin][cr.act] : rows[pin][cr.field];
                    if (!isNaN(val) && !isNaN(pv)) { var dd = val - pv; dtxt = (dd >= 0 ? '+' : '') + fmtNum(dd); }
                }
                lines.push({ k: cr.name, v: fmtNum(val), d: dtxt, col: cr.accent });
            }
            if (!lines.length) return;
            ctx.font = '8px monospace';
            var tw = 0, j;
            for (j = 0; j < lines.length; j++) {
                var lw = ctx.measureText(lines[j].k + '  ' + lines[j].v + '  ' + lines[j].d).width;
                if (lw > tw) tw = lw;
            }
            tw += 14;
            var th = lines.length * 12 + 6 + (hasPin ? 11 : 0);
            var tx = hx + 8; if (tx + tw > ca.x + ca.w) tx = hx - 8 - tw;
            var ty = ca.y + 2;
            roundRect(ctx, tx, ty, tw, th, 4);
            ctx.fillStyle = 'rgba(15,15,22,0.92)'; ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 0.5; ctx.stroke();
            var oy = ty + 6;
            if (hasPin) {
                ctx.font = '7px sans-serif'; ctx.fillStyle = 'rgba(0,200,255,0.9)';
                ctx.textAlign = 'right'; ctx.textBaseline = 'top';
                ctx.fillText('Δ vs pin', tx + tw - 6, oy); oy += 11;
            }
            ctx.font = '8px monospace'; ctx.textBaseline = 'middle';
            for (j = 0; j < lines.length; j++) {
                var ly = oy + j * 12 + 3;
                ctx.fillStyle = lines[j].col || 'rgba(255,255,255,0.55)';
                ctx.textAlign = 'left';
                ctx.fillText(lines[j].k, tx + 6, ly);
                ctx.fillStyle = '#ffffff'; ctx.textAlign = 'right';
                ctx.fillText(lines[j].v + (lines[j].d ? '  ' + lines[j].d : ''), tx + tw - 6, ly);
                ctx.textAlign = 'left';
            }
            ctx.textBaseline = 'alphabetic';
        },

        // Window the data to a recent interval; sets the shared _zoom (row range).
        _applyRange: function(val) {
            this._labZoom = null;
            if (val === 'all') { this._zoom = null; return; }
            var rows = this._lastGoodData && this._lastGoodData.rows;
            if (!rows || rows.length < 2) { this._zoom = null; return; }
            var secs = { '10s': 10, '30s': 30, '1m': 60, '2m': 120, '5m': 300, '30m': 1800, '1h': 3600, '6h': 21600, '24h': 86400 }[val];
            if (!secs) { this._zoom = null; return; }
            var tmax = rows[rows.length - 1]._time, tmin = tmax - secs, i0 = rows.length - 1, i;
            for (i = 0; i < rows.length; i++) { if (rows[i]._time >= tmin) { i0 = i; break; } }
            if (rows.length - 1 - i0 < 1) this._zoom = null;   // not enough data in window → all
            else this._zoom = { i0: i0, i1: rows.length - 1 };
        },

        // Position the HTML range <select> at the right of a strip (x..x+w).
        _positionRangeSelect: function(x, w, yTop) {
            var s = this._rangeSelect; if (!s) return;
            var sw = 110, y = (yTop != null) ? yTop : 10;
            styleSet(s, { display: 'block', left: (x + w - sw) + 'px', top: y + 'px', width: sw + 'px', height: '17px' });
            // reflect current window state in the menu when not a preset
            if (!this._zoom && s.value !== 'all' && s.value !== 'custom') s.value = 'all';
        },

        // Top control strip: Lab · reset-zoom · hint. Returns height.
        _drawControlStrip: function(ctx, viewRows, x, y, w) {
            this._hideLabSelects();
            this._ctrlRects = []; this._scrubRect = null;
            var self = this, h = 16, cxp = x;
            function btn(label, act, active) {
                ctx.font = '8px sans-serif';
                var bw = ctx.measureText(label).width + 12;
                roundRect(ctx, cxp, y, bw, h, h / 2);
                ctx.fillStyle = active ? 'rgba(108,92,231,0.35)' : 'rgba(255,255,255,0.07)';
                ctx.fill();
                ctx.fillStyle = active ? '#ffffff' : 'rgba(255,255,255,0.6)';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(label, cxp + bw / 2, y + h / 2);
                self._ctrlRects.push({ act: act, x: cxp, y: y, w: bw, h: h });
                cxp += bw + 4;
            }
            btn('⚗ Lab', 'lab', this._labOpen);
            btn('⭳ CSV', 'csv', false);
            if (this._zoom) btn('⟲ reset zoom', 'reset', false);

            // "Range:" label sits just left of the HTML range <select> (drawn on the right)
            ctx.font = '8px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText('Range', x + w - 116, y + h / 2);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            return h;
        },

        // #3 Export the currently-graphed signals over the current time window as CSV
        // (separator ';', decimal '.', full header). Downloads, with a clipboard fallback
        // if the browser blocks the download (e.g. a sandboxed iframe).
        _exportCSV: function() {
            var rows = this._exportRows || (this._lastGoodData && this._lastGoodData.rows) || [];
            var schema = this._schema || [];
            if (!rows.length || !schema.length) { this._toastNow('Nothing to export'); return; }
            var cols = [], si, k;
            for (si = 0; si < schema.length; si++) {
                var sub = schema[si].sub, items = secItems(schema[si]);
                for (k = 0; k < items.length; k++) {
                    var it = items[k];
                    if (!this._selected[it.id]) continue;
                    var base = subLabel(sub).split(' ')[0] + '.' + it.name;
                    if (it.kind === 'pair') {
                        cols.push({ header: base + '.sp', field: it.d.sp });
                        cols.push({ header: base + '.act', field: it.d.act });
                    } else {
                        cols.push({ header: base + '.' + it.kind, field: it.d.field });
                    }
                }
            }
            if (!cols.length) { this._toastNow('No graphs selected to export'); return; }
            var SEP = ';', NL = '\r\n', i, c, head = ['time'];
            for (c = 0; c < cols.length; c++) head.push(cols[c].header);
            var lines = [head.join(SEP)];
            for (i = 0; i < rows.length; i++) {
                var r = rows[i], cells = [new Date(r._time * 1000).toISOString()];
                for (c = 0; c < cols.length; c++) {
                    var v = r[cols[c].field];
                    cells.push((v == null || isNaN(v)) ? '' : String(v));
                }
                lines.push(cells.join(SEP));
            }
            var csv = lines.join(NL);
            var name = 'hyperloop_' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
            var self = this;
            try {
                var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url; a.download = name;
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
                this._toastNow('Exported ' + cols.length + ' signals · ' + rows.length + ' rows');
            } catch (e) {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(csv).then(
                        function() { self._toastNow('Download blocked — CSV copied to clipboard'); },
                        function() { self._toastNow('Export failed: ' + e.message); });
                } else { this._toastNow('Export failed: ' + e.message); }
            }
        },

        _toastNow: function(msg) {
            this._toast = msg; this._toastUntil = Date.now() + 2600;
            this.invalidateUpdateView();
        },

        _drawToast: function(ctx, w, h) {
            if (!this._toast || Date.now() > this._toastUntil) return;
            ctx.save();
            ctx.font = '10px sans-serif';
            var pad = 10, tw = ctx.measureText(this._toast).width, bw = tw + pad * 2, bh = 22;
            var bx = (w - bw) / 2, by = h - bh - 12;
            roundRect(ctx, bx, by, bw, bh, 5);
            ctx.fillStyle = 'rgba(20,20,30,0.94)'; ctx.fill();
            ctx.strokeStyle = 'rgba(108,92,231,0.75)'; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(this._toast, w / 2, by + bh / 2);
            ctx.restore();
            // ensure one more redraw so the toast clears even when not auto-rotating
            var self = this;
            if (!this._toastTimer) {
                this._toastTimer = setTimeout(function() {
                    self._toastTimer = null; self.invalidateUpdateView();
                }, 250);
            }
        },

        // #5 Persist/restore the view layout (selection, collapse, sort/role/unstable, range).
        _saveState: function() {
            try {
                if (!window.localStorage) return;
                var sel = [], col = [], k;
                for (k in this._selected) if (this._selected.hasOwnProperty(k) && this._selected[k]) sel.push(k);
                for (k in this._collapsed) if (this._collapsed.hasOwnProperty(k) && this._collapsed[k]) col.push(k);
                var st = { sel: sel, col: col, sort: this._sortMode, role: this._roleFilter,
                           uns: !!this._onlyUnstable, range: this._rangeSelect ? this._rangeSelect.value : 'all' };
                var s = JSON.stringify(st);
                if (s === this._lastSavedState) return;   // only write on actual change
                this._lastSavedState = s;
                localStorage.setItem(this._STATE_KEY, s);
            } catch (e) {}
        },

        _loadState: function() {
            try {
                if (!window.localStorage) return;
                var s = localStorage.getItem(this._STATE_KEY);
                if (!s) return;
                var st = JSON.parse(s), i;
                if (st.sel && st.sel.length) {
                    this._selected = {};
                    for (i = 0; i < st.sel.length; i++) this._selected[st.sel[i]] = true;
                    this._selInit = true;   // skip the first-load auto-select
                }
                this._collapsed = {};
                if (st.col) for (i = 0; i < st.col.length; i++) this._collapsed[st.col[i]] = true;
                if (st.sort) this._sortMode = st.sort;
                if (st.role) this._roleFilter = st.role;
                this._onlyUnstable = !!st.uns;
                this._pendingRange = st.range || null;
                this._lastSavedState = s;
            } catch (e) {}
        },

        _labVars: function(schema) {
            var out = [], si, k;
            for (si = 0; si < schema.length; si++) {
                var sub = schema[si].sub, its = secItems(schema[si]);
                for (k = 0; k < its.length; k++) {
                    var it = its[k];
                    out.push({ field: it.kind === 'pair' ? it.d.act : it.d.field,
                               label: subLabel(sub).split(' ')[0] + '·' + it.name });
                }
            }
            return out;
        },

        _ensureLabSelects: function() {
            if (this._labSelects) return;
            var self = this;
            function mk() {
                var s = document.createElement('select');
                var st = s.style;
                st.position = 'absolute'; st.display = 'none'; st.zIndex = '6';
                st.font = '11px sans-serif'; st.background = 'rgba(20,20,30,0.95)';
                st.color = '#fff'; st.border = '1px solid rgba(255,255,255,0.25)';
                st.borderRadius = '4px'; st.padding = '1px 4px';
                s.addEventListener('change', function() { self._labPin = null; self._labCursor = null; self._labZoom = null; self.invalidateUpdateView(); });
                self.el.appendChild(s);
                return s;
            }
            this._labSelects = { x: mk(), y: mk(), sig: mk(), op: mk() };
            // populate the operation picker once
            var opSel = this._labSelects.op;
            for (var oi = 0; oi < LAB_OPS.length; oi++) {
                var oo = document.createElement('option'); oo.value = LAB_OPS[oi].key; oo.textContent = LAB_OPS[oi].label;
                opSel.appendChild(oo);
            }
            opSel._n = -1;   // exempt from _fillSelect signal repopulation
        },

        _hideLabSelects: function() {
            if (!this._labSelects) return;
            var s = this._labSelects;
            [s.x, s.y, s.sig, s.op].forEach(function(e) { if (e && e.style.display !== 'none') e.style.display = 'none'; });
        },

        _fillSelect: function(sel, vars, dfltIdx) {
            if (sel._n === vars.length) return;
            sel.innerHTML = '';
            for (var i = 0; i < vars.length; i++) {
                var o = document.createElement('option');
                o.value = vars[i].field; o.textContent = vars[i].label;
                sel.appendChild(o);
            }
            sel._n = vars.length;
            if (dfltIdx != null && vars[dfltIdx]) sel.value = vars[dfltIdx].field;
        },

        // Full-panel modal: pick variables on the fly for Correlation / Spectrum / Signal.
        _drawLab: function(ctx, rows, schema, w, h, scheme, pal) {
            if (this._filterInput) this._filterInput.style.display = 'none';
            this._labRects = [];
            this._ensureLabSelects();
            var vars = this._labVars(schema);
            var rect = this.el.getBoundingClientRect();

            // backdrop
            ctx.fillStyle = 'rgba(10,12,18,0.97)';
            ctx.fillRect(0, 0, w, h);

            var pad = 14;
            ctx.font = 'bold 13px sans-serif';
            ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.fillText('Analysis Lab', pad, pad);

            // close button
            ctx.font = '11px sans-serif';
            var clw = 46;
            roundRect(ctx, w - pad - clw, pad - 2, clw, 18, 4);
            ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
            ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('✕ close', w - pad - clw / 2, pad + 7);
            this._labRects.push({ act: 'close', x: w - pad - clw, y: pad - 2, w: clw, h: 18 });

            // Range menu on the top row, left of close — windows the analysed data
            var selW = 110, selX = w - pad - clw - 10 - selW;
            ctx.font = '8px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText('Range', selX - 4, pad + 7);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            this._positionRangeSelect(selX, selW, pad - 3);

            // mode tabs
            var modes = [['op', 'Operation'], ['fft', 'Spectrum'], ['stat', 'Signal stats']];
            var tx = pad, tyy = pad + 26;
            ctx.textBaseline = 'middle';
            for (var m = 0; m < modes.length; m++) {
                ctx.font = '10px sans-serif';
                var tw = ctx.measureText(modes[m][1]).width + 16;
                var active = this._labMode === modes[m][0];
                roundRect(ctx, tx, tyy, tw, 20, 5);
                ctx.fillStyle = active ? 'rgba(108,92,231,0.4)' : 'rgba(255,255,255,0.06)'; ctx.fill();
                ctx.fillStyle = active ? '#fff' : 'rgba(255,255,255,0.55)';
                ctx.textAlign = 'center';
                ctx.fillText(modes[m][1], tx + tw / 2, tyy + 10);
                this._labRects.push({ act: 'mode:' + modes[m][0], x: tx, y: tyy, w: tw, h: 20 });
                tx += tw + 6;
            }
            var selY = tyy + 30;
            var plotTop = selY + 34;
            var px = pad, pw = w - pad * 2, py = plotTop, ph = h - plotTop - pad;
            var sel = this._labSelects;
            function lbl(s) { return (s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : ''); }

            if (this._labMode === 'op') {
                this._fillSelect(sel.x, vars, 0);
                this._fillSelect(sel.y, vars, vars.length > 1 ? 1 : 0);
                // three controls on the row:  A  [operation]  B
                var triw = Math.min(170, (pw - 40) / 3);
                this._posSelect(sel.x, pad, selY, triw);
                this._posSelect(sel.op, pad + triw + 10, selY, triw);
                this._posSelect(sel.y, pad + (triw + 10) * 2, selY, triw);
                ctx.font = '9px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.45)';
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                ctx.fillText('A', pad, selY - 4);
                ctx.fillText('operation', pad + triw + 10, selY - 4);
                ctx.fillText('B', pad + (triw + 10) * 2, selY - 4);
                var op = labOp(sel.op.value);
                if (op.kind === 'scatter') {
                    this._drawScatter(ctx, rows, sel.x.value, sel.y.value, lbl(sel.x), lbl(sel.y), px, py, pw, ph, pal);
                } else {
                    this._drawSeries(ctx, rows, sel.x.value, sel.y.value, lbl(sel.x), lbl(sel.y), op, px, py, pw, ph, pal);
                }
            } else {
                this._fillSelect(sel.sig, vars, 0);
                this._posSelect(sel.sig, pad, selY, Math.min(260, pw - 20));
                ctx.font = '9px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.45)';
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                ctx.fillText('Signal', pad, selY - 4);
                if (this._labMode === 'fft') this._drawSpectrum(ctx, rows, sel.sig.value, lbl(sel.sig), px, py, pw, ph, pal);
                else this._drawSignalStats(ctx, rows, sel.sig.value, lbl(sel.sig), px, py, pw, ph, pal);
            }
            // Hide only the selects the current mode doesn't use (idempotent → keeps
            // the active dropdowns "sticky" / open across re-renders).
            if (this._labMode === 'op') {
                if (sel.sig.style.display !== 'none') sel.sig.style.display = 'none';
            } else {
                [sel.x, sel.op, sel.y].forEach(function(e) { if (e.style.display !== 'none') e.style.display = 'none'; });
            }
            this._drawLabCursor(ctx);

            // brush-zoom selection rectangle
            if (this._labBrush && this._labPlotRect) {
                var lpb = this._labPlotRect, bb = this._labBrush;
                var rx0 = Math.max(Math.min(bb.x0, bb.x1), lpb.ix), rx1 = Math.min(Math.max(bb.x0, bb.x1), lpb.ix + lpb.iw);
                var ry0 = lpb.iy, ry1 = lpb.iy + lpb.ih;
                if (this._labData && this._labData.mode === 'corr') { ry0 = Math.max(Math.min(bb.y0, bb.y1), lpb.iy); ry1 = Math.min(Math.max(bb.y0, bb.y1), lpb.iy + lpb.ih); }
                ctx.fillStyle = 'rgba(108,92,231,0.18)'; ctx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
                ctx.strokeStyle = 'rgba(108,92,231,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
            }
            // zoom hint / reset affordance
            ctx.font = '8px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            ctx.fillText(this._labZoom ? 'drag to zoom · double-click to reset' : 'drag to zoom · click to pin', 14, h - 4);
        },

        // Convert a brush rectangle (screen coords) into a lab view-zoom (domain coords).
        _applyLabZoom: function(b) {
            var ld = this._labData, lp = this._labPlotRect;
            if (!ld || !lp || !ld.xdom) return;
            var bx0 = Math.max(Math.min(b.x0, b.x1), lp.ix), bx1 = Math.min(Math.max(b.x0, b.x1), lp.ix + lp.iw);
            if (bx1 - bx0 < 6) return;
            var fx0 = (bx0 - lp.ix) / lp.iw, fx1 = (bx1 - lp.ix) / lp.iw;
            var z = { x0: ld.xdom[0] + fx0 * (ld.xdom[1] - ld.xdom[0]), x1: ld.xdom[0] + fx1 * (ld.xdom[1] - ld.xdom[0]) };
            if (ld.mode === 'corr' && ld.ydom) {
                var by0 = Math.max(Math.min(b.y0, b.y1), lp.iy), by1 = Math.min(Math.max(b.y0, b.y1), lp.iy + lp.ih);
                var fyT = (by0 - lp.iy) / lp.ih, fyB = (by1 - lp.iy) / lp.ih;
                var dyA = ld.ydom[1] - fyT * (ld.ydom[1] - ld.ydom[0]), dyB = ld.ydom[1] - fyB * (ld.ydom[1] - ld.ydom[0]);
                z.y0 = Math.min(dyA, dyB); z.y1 = Math.max(dyA, dyB);
            }
            this._labZoom = z;
        },

        // Hover crosshair / nearest-point highlight + tooltip + pinned-delta for Lab plots.
        _drawLabCursor: function(ctx) {
            var ld = this._labData, lp = this._labPlotRect;
            if (!ld || !lp || !ld.pts || !ld.pts.length) return;
            var cur = this._labCursor, pin = this._labPin, i;
            function nearX(px) { var b = 0, bd = Infinity; for (i = 0; i < ld.pts.length; i++) { var d = Math.abs(ld.pts[i].sx - px); if (d < bd) { bd = d; b = i; } } return b; }
            function near2D(px, py) { var b = 0, bd = Infinity; for (i = 0; i < ld.pts.length; i++) { var dx = ld.pts[i].sx - px, dy = ld.pts[i].sy - py, d = dx * dx + dy * dy; if (d < bd) { bd = d; b = i; } } return b; }
            var lines = [], pi = -1;

            if (ld.mode === 'corr') {
                if (pin) { pi = near2D(pin.x, pin.y); var pp = ld.pts[pi];
                    ctx.strokeStyle = 'rgba(0,200,255,0.9)'; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.arc(pp.sx, pp.sy, 5, 0, Math.PI * 2); ctx.stroke(); }
                if (cur) { var hi = near2D(cur.x, cur.y), hp = ld.pts[hi];
                    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.arc(hp.sx, hp.sy, 5, 0, Math.PI * 2); ctx.stroke();
                    lines.push({ k: ld.lx || 'X', v: fmtNum(hp.x) });
                    lines.push({ k: ld.ly || 'Y', v: fmtNum(hp.y) });
                    if (pi >= 0) { lines.push({ k: 'ΔX', v: fmtSign(hp.x - ld.pts[pi].x) }); lines.push({ k: 'ΔY', v: fmtSign(hp.y - ld.pts[pi].y) }); }
                    this._labTooltip(ctx, lp, hp.sx, hp.sy, lines);
                }
                return;
            }
            // line modes: fft / stat — vertical cursor mapped by x
            if (pin) { pi = nearX(pin.x); var pp2 = ld.pts[pi];
                ctx.save(); ctx.setLineDash([3, 2]); ctx.strokeStyle = 'rgba(0,200,255,0.8)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(pp2.sx, lp.iy); ctx.lineTo(pp2.sx, lp.iy + lp.ih); ctx.stroke();
                ctx.setLineDash([]); ctx.restore(); }
            if (cur) { var hj = nearX(cur.x), hp2 = ld.pts[hj];
                ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(hp2.sx, lp.iy); ctx.lineTo(hp2.sx, lp.iy + lp.ih); ctx.stroke();
                ctx.beginPath(); ctx.arc(hp2.sx, hp2.sy, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
                if (ld.mode === 'fft') {
                    lines.push({ k: 'freq', v: fmtNum(hp2.f) + ' ' + ld.funit });
                    lines.push({ k: 'mag', v: fmtNum(hp2.m) });
                    if (pi >= 0) lines.push({ k: 'Δfreq', v: fmtSign(hp2.f - ld.pts[pi].f) });
                } else {
                    lines.push({ k: ld.xunit === 's' ? 't' : 'i', v: fmtNum(hp2.xval) + (ld.xunit === 's' ? ' s' : '') });
                    lines.push({ k: 'val', v: fmtNum(hp2.yval) });
                    if (pi >= 0) lines.push({ k: 'Δval', v: fmtSign(hp2.yval - ld.pts[pi].yval) });
                }
                this._labTooltip(ctx, lp, hp2.sx, hp2.sy, lines);
            }
        },

        _labTooltip: function(ctx, lp, sx, sy, lines) {
            if (!lines.length) return;
            ctx.font = '8px monospace';
            var tw = 0, j;
            for (j = 0; j < lines.length; j++) { var lw = ctx.measureText(lines[j].k + '  ' + lines[j].v).width; if (lw > tw) tw = lw; }
            tw += 14; var th = lines.length * 12 + 6;
            var tx = sx + 8; if (tx + tw > lp.ix + lp.iw) tx = sx - 8 - tw; if (tx < lp.ix) tx = lp.ix;
            var ty = sy + 8; if (ty + th > lp.iy + lp.ih) ty = sy - 8 - th; if (ty < lp.iy) ty = lp.iy;
            roundRect(ctx, tx, ty, tw, th, 4); ctx.fillStyle = 'rgba(15,15,22,0.95)'; ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 0.5; ctx.stroke();
            ctx.textBaseline = 'middle';
            for (j = 0; j < lines.length; j++) {
                var ly = ty + 6 + j * 12 + 3;
                ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.textAlign = 'left'; ctx.fillText(lines[j].k, tx + 6, ly);
                ctx.fillStyle = '#fff'; ctx.textAlign = 'right'; ctx.fillText(lines[j].v, tx + tw - 6, ly);
            }
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        },

        _posSelect: function(sel, x, y, wpx) {
            styleSet(sel, { display: 'block', left: x + 'px', top: y + 'px', width: wpx + 'px', height: '24px' });
        },

        _drawScatter: function(ctx, rows, fx, fy, lx, ly, x, y, w, h, pal) {
            var pts = [], i, a, b, minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
            for (i = 0; i < rows.length; i++) {
                a = rows[i][fx]; b = rows[i][fy];
                if (isNaN(a) || isNaN(b)) continue;
                pts.push([a, b]);
                if (a < minx) minx = a; if (a > maxx) maxx = a;
                if (b < miny) miny = b; if (b > maxy) maxy = b;
            }
            if (pts.length < 2) {
                ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.fillText('Not enough data', x + 10, y + 20); return;
            }
            var padx = (maxx - minx) * 0.05 || 1, pady = (maxy - miny) * 0.05 || 1;
            var x0 = minx - padx, x1 = maxx + padx, y0 = miny - pady, y1 = maxy + pady;
            if (this._labZoom) {   // brush-to-zoom view
                x0 = this._labZoom.x0; x1 = this._labZoom.x1;
                if (this._labZoom.y0 != null) { y0 = this._labZoom.y0; y1 = this._labZoom.y1; }
            }
            var inr = drawPlotAxes(ctx, x, y, w, h, x0, x1, y0, y1, lx + '  (X)', ly + '  (Y)');
            function PX(v) { return inr.ix + (v - x0) / (x1 - x0) * inr.iw; }
            function PY(v) { return inr.iy + inr.ih - (v - y0) / (y1 - y0) * inr.ih; }
            ctx.save(); ctx.beginPath(); ctx.rect(inr.ix, inr.iy, inr.iw, inr.ih); ctx.clip();
            ctx.fillStyle = rgbaStr(pal.model, 0.7);
            for (i = 0; i < pts.length; i++) { ctx.beginPath(); ctx.arc(PX(pts[i][0]), PY(pts[i][1]), 2.2, 0, Math.PI * 2); ctx.fill(); }
            // least-squares regression line
            var n = pts.length, sa = 0, sb = 0, saa = 0, sab = 0;
            for (i = 0; i < n; i++) { sa += pts[i][0]; sb += pts[i][1]; saa += pts[i][0] * pts[i][0]; sab += pts[i][0] * pts[i][1]; }
            var den = n * saa - sa * sa;
            if (Math.abs(den) > 1e-9) {
                var slope = (n * sab - sa * sb) / den, icpt = (sb - slope * sa) / n;
                ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(PX(x0), PY(slope * x0 + icpt)); ctx.lineTo(PX(x1), PY(slope * x1 + icpt)); ctx.stroke();
            }
            ctx.restore();
            var r = pearson(rows, fx, fy);
            ctx.font = 'bold 11px monospace'; ctx.fillStyle = '#fff';
            ctx.textAlign = 'right'; ctx.textBaseline = 'top';
            ctx.fillText('r = ' + (r === null ? '--' : r.toFixed(3)), inr.ix + inr.iw, inr.iy + 2);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            // cursor context
            var spts = [];
            for (i = 0; i < pts.length; i++) spts.push({ sx: PX(pts[i][0]), sy: PY(pts[i][1]), x: pts[i][0], y: pts[i][1] });
            this._labPlotRect = inr;
            this._labData = { mode: 'corr', pts: spts, lx: lx, ly: ly, xdom: [x0, x1], ydom: [y0, y1] };
        },

        _drawSpectrum: function(ctx, rows, field, label, x, y, w, h, pal) {
            var samples = [], i, dts = [];
            for (i = 0; i < rows.length; i++) { var v = rows[i][field]; if (!isNaN(v)) samples.push(v); }
            for (i = 1; i < rows.length; i++) { var d = rows[i]._time - rows[i - 1]._time; if (d > 0) dts.push(d); }
            dts.sort(function(a, b) { return a - b; });
            var dt = dts.length ? dts[Math.floor(dts.length / 2)] : 0;
            var sp = spectrum(samples, dt);
            if (!sp) { ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.fillText('Not enough samples for a spectrum', x + 10, y + 20); return; }
            var maxM = 0, k, peak = 0;
            for (k = 0; k < sp.mag.length; k++) if (sp.mag[k] > maxM) { maxM = sp.mag[k]; peak = k; }
            maxM = maxM || 1;
            var n = sp.mag.length, fmax = sp.freq[n - 1];
            var xd0 = 0, xd1 = fmax;
            if (this._labZoom) { xd0 = Math.max(0, this._labZoom.x0); xd1 = Math.min(fmax, this._labZoom.x1); if (xd1 <= xd0) { xd0 = 0; xd1 = fmax; } }
            // rescale magnitude axis to the visible frequency band
            var vmax = 0;
            for (k = 0; k < n; k++) if (sp.freq[k] >= xd0 && sp.freq[k] <= xd1 && sp.mag[k] > vmax) vmax = sp.mag[k];
            vmax = (vmax || maxM) * 1.08;
            var xtitle = 'Frequency (' + (dt > 0 ? 'Hz' : 'cyc/sample') + ')';
            var inr = drawPlotAxes(ctx, x, y, w, h, xd0, xd1, 0, vmax, xtitle, 'Magnitude · ' + label);
            function FX(f) { return inr.ix + (f - xd0) / (xd1 - xd0) * inr.iw; }
            function FY(m) { return inr.iy + inr.ih - (m / vmax) * inr.ih; }
            ctx.save(); ctx.beginPath(); ctx.rect(inr.ix, inr.iy, inr.iw, inr.ih); ctx.clip();
            ctx.strokeStyle = pal.model; ctx.lineWidth = 1.4; ctx.beginPath();
            for (k = 0; k < n; k++) { if (k === 0) ctx.moveTo(FX(sp.freq[k]), FY(sp.mag[k])); else ctx.lineTo(FX(sp.freq[k]), FY(sp.mag[k])); }
            ctx.stroke();
            ctx.beginPath(); ctx.arc(FX(sp.freq[peak]), FY(sp.mag[peak]), 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
            ctx.restore();
            ctx.font = '9px monospace'; ctx.fillStyle = '#fff'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
            ctx.fillText('peak ' + sp.freq[peak].toFixed(3) + (dt > 0 ? ' Hz' : ' c/smp'), inr.ix + inr.iw, inr.iy + 2);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            // cursor context
            var fpts = [];
            for (k = 0; k < n; k++) fpts.push({ sx: FX(sp.freq[k]), f: sp.freq[k], m: sp.mag[k], sy: FY(sp.mag[k]) });
            this._labPlotRect = inr;
            this._labData = { mode: 'fft', pts: fpts, funit: dt > 0 ? 'Hz' : 'c/smp', xdom: [xd0, xd1] };
        },

        _drawSignalStats: function(ctx, rows, field, label, x, y, w, h, pal) {
            var vals = [], i, n = rows.length;
            for (i = 0; i < n; i++) vals.push(rows[i][field]);
            var st = fieldStats(rows, field);
            if (!st) { ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.fillText('No data', x + 10, y + 20); return; }
            var sd = 0, cnt = 0;
            for (i = 0; i < n; i++) if (!isNaN(vals[i])) { sd += (vals[i] - st.avg) * (vals[i] - st.avg); cnt++; }
            sd = cnt ? Math.sqrt(sd / cnt) : 0;
            var t0 = rows[0]._time, tspan = (n > 1 ? rows[n - 1]._time - t0 : 0);
            var useTime = tspan > 0;
            var xtitle = useTime ? 'time (s)' : 'sample';
            var xfull = useTime ? tspan : (n - 1);
            var xd0 = 0, xd1 = xfull;
            if (this._labZoom) { xd0 = Math.max(0, this._labZoom.x0); xd1 = Math.min(xfull, this._labZoom.x1); if (xd1 <= xd0) { xd0 = 0; xd1 = xfull; } }
            function xv(idx) { return useTime ? (rows[idx]._time - t0) : idx; }
            // y autoscale to the visible x-window
            var vmin = Infinity, vmax = -Infinity;
            for (i = 0; i < n; i++) { if (isNaN(vals[i])) continue; var xx = xv(i); if (xx < xd0 - 1e-9 || xx > xd1 + 1e-9) continue; if (vals[i] < vmin) vmin = vals[i]; if (vals[i] > vmax) vmax = vals[i]; }
            if (vmin === Infinity) { vmin = st.min; vmax = st.max; }
            var span2 = (vmax - vmin) || 1, y0 = vmin - span2 * 0.1, y1 = vmax + span2 * 0.1;
            var inr = drawPlotAxes(ctx, x, y, w, h, xd0, xd1, y0, y1, xtitle, label);
            function PX(idx) { return inr.ix + (xv(idx) - xd0) / (xd1 - xd0) * inr.iw; }
            function PY(v) { return inr.iy + inr.ih - (v - y0) / (y1 - y0) * inr.ih; }
            ctx.save(); ctx.beginPath(); ctx.rect(inr.ix, inr.iy, inr.iw, inr.ih); ctx.clip();
            // ±σ band
            ctx.fillStyle = rgbaStr(pal.model, 0.12);
            var yb = PY(st.avg + sd), yb2 = PY(st.avg - sd);
            ctx.fillRect(inr.ix, Math.min(yb, yb2), inr.iw, Math.max(1, Math.abs(yb2 - yb)));
            // mean line
            ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 0.5; ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(inr.ix, PY(st.avg)); ctx.lineTo(inr.ix + inr.iw, PY(st.avg)); ctx.stroke();
            ctx.setLineDash([]);
            // raw line
            ctx.strokeStyle = pal.model; ctx.lineWidth = 1.2; ctx.beginPath();
            var started = false;
            for (i = 0; i < n; i++) { if (isNaN(vals[i])) continue;
                if (!started) { ctx.moveTo(PX(i), PY(vals[i])); started = true; } else ctx.lineTo(PX(i), PY(vals[i])); }
            ctx.stroke();
            // moving average
            var win = Math.max(2, Math.round(n / 15));
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.beginPath(); started = false;
            for (i = 0; i < n; i++) {
                var s0 = Math.max(0, i - win), acc = 0, c2 = 0;
                for (var jj = s0; jj <= i; jj++) if (!isNaN(vals[jj])) { acc += vals[jj]; c2++; }
                if (!c2) continue;
                var mv = acc / c2;
                if (!started) { ctx.moveTo(PX(i), PY(mv)); started = true; } else ctx.lineTo(PX(i), PY(mv));
            }
            ctx.stroke();
            ctx.restore();
            ctx.font = '9px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.textAlign = 'right'; ctx.textBaseline = 'top';
            ctx.fillText('μ ' + fmtNum(st.avg) + '  σ ' + fmtNum(sd) + '  ▼' + fmtNum(st.min) + '  ▲' + fmtNum(st.max), inr.ix + inr.iw, inr.iy + 2);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            // cursor context
            var lpts = [];
            for (i = 0; i < n; i++) { if (isNaN(vals[i])) continue;
                lpts.push({ sx: PX(i), sy: PY(vals[i]), xval: useTime ? (rows[i]._time - t0) : i, yval: vals[i] }); }
            this._labPlotRect = inr;
            this._labData = { mode: 'stat', pts: lpts, xunit: useTime ? 's' : 'smp', xdom: [xd0, xd1] };
        },

        // Derived elementwise series A op B (e.g. A−B), drawn as a time-series.
        _drawSeries: function(ctx, rows, fa, fb, la, lb, op, x, y, w, h, pal) {
            var i, n = rows.length, vals = [], mn = Infinity, mx = -Infinity, sum = 0, c = 0, last = NaN;
            for (i = 0; i < n; i++) {
                var a = rows[i][fa], b = rows[i][fb];
                var v = (isNaN(a) || isNaN(b)) ? NaN : op.fn(a, b);
                vals.push(v);
                if (!isNaN(v)) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; c++; last = v; }
            }
            if (!c) { ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.fillText('No data', x + 10, y + 20); return; }
            var avg = sum / c;
            var t0 = rows[0]._time, tspan = (n > 1 ? rows[n - 1]._time - t0 : 0), useTime = tspan > 0;
            var xtitle = useTime ? 'time (s)' : 'sample', xfull = useTime ? tspan : (n - 1);
            var xd0 = 0, xd1 = xfull;
            if (this._labZoom) { xd0 = Math.max(0, this._labZoom.x0); xd1 = Math.min(xfull, this._labZoom.x1); if (xd1 <= xd0) { xd0 = 0; xd1 = xfull; } }
            function xv(idx) { return useTime ? (rows[idx]._time - t0) : idx; }
            var vmin = Infinity, vmax = -Infinity;
            for (i = 0; i < n; i++) { if (isNaN(vals[i])) continue; var xx = xv(i); if (xx < xd0 - 1e-9 || xx > xd1 + 1e-9) continue; if (vals[i] < vmin) vmin = vals[i]; if (vals[i] > vmax) vmax = vals[i]; }
            if (vmin === Infinity) { vmin = mn; vmax = mx; }
            var sp2 = (vmax - vmin) || 1, y0 = vmin - sp2 * 0.1, y1 = vmax + sp2 * 0.1;
            var ytitle = op.label.replace('A', la.split(' ')[0]).replace('B', lb.split(' ')[0]);
            var inr = drawPlotAxes(ctx, x, y, w, h, xd0, xd1, y0, y1, xtitle, ytitle);
            function PX(idx) { return inr.ix + (xv(idx) - xd0) / (xd1 - xd0) * inr.iw; }
            function PY(v) { return inr.iy + inr.ih - (v - y0) / (y1 - y0) * inr.ih; }
            ctx.save(); ctx.beginPath(); ctx.rect(inr.ix, inr.iy, inr.iw, inr.ih); ctx.clip();
            if (0 >= y0 && 0 <= y1) { ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 0.5; ctx.setLineDash([3, 3]);
                ctx.beginPath(); ctx.moveTo(inr.ix, PY(0)); ctx.lineTo(inr.ix + inr.iw, PY(0)); ctx.stroke(); ctx.setLineDash([]); }
            ctx.strokeStyle = pal.model; ctx.lineWidth = 1.3; ctx.beginPath();
            var started = false;
            for (i = 0; i < n; i++) { if (isNaN(vals[i])) continue;
                if (!started) { ctx.moveTo(PX(i), PY(vals[i])); started = true; } else ctx.lineTo(PX(i), PY(vals[i])); }
            ctx.stroke(); ctx.restore();
            ctx.font = '9px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
            ctx.fillText('last ' + fmtNum(last) + '  ~' + fmtNum(avg) + '  ▼' + fmtNum(mn) + '  ▲' + fmtNum(mx), inr.ix + inr.iw, inr.iy + 2);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            var lpts = [];
            for (i = 0; i < n; i++) { if (isNaN(vals[i])) continue; lpts.push({ sx: PX(i), sy: PY(vals[i]), xval: useTime ? (rows[i]._time - t0) : i, yval: vals[i] }); }
            this._labPlotRect = inr;
            this._labData = { mode: 'series', pts: lpts, xunit: useTime ? 's' : 'smp', xdom: [xd0, xd1] };
        },

        _drawAccordion: function(ctx, rows, schema, statusBySub, x, y, w, h, warnPct, critPct, scheme, pal) {
            this._headerRects = [];
            this._focusBackRect = null;
            var self = this;
            if (schema.length === 0) {
                ctx.font = '12px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.textAlign = 'left'; ctx.textBaseline = 'top';
                ctx.fillText('No tune_* columns found.', x, y);
                return;
            }

            // Single-chart focus: one maximized chart fills the column.
            if (this._focusChart) {
                var f = this._focusChart;
                ctx.font = 'bold 11px sans-serif';
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'left'; ctx.textBaseline = 'top';
                ctx.fillText(subLabel(f.sub) + ' · ' + f.name, x, y);
                ctx.font = '8px sans-serif';
                var blbl = '✕ back', bw0 = ctx.measureText(blbl).width + 14;
                roundRect(ctx, x + w - bw0, y - 2, bw0, 16, 8);
                ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
                ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(blbl, x + w - bw0 / 2, y + 6);
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                this._focusBackRect = { x: x + w - bw0, y: y - 2, w: bw0, h: 16 };

                var fy = y + 20, fh = h - 22;
                if (f.kind === 'pair') pairChart(ctx, rows, f.sp, f.act, f.name, x, fy, w, fh, f.accent, pal, warnPct, critPct);
                else outChart(ctx, rows, f.field, f.name, x, fy, w, fh, f.accent);
                var fpad = Math.min(3, fh * 0.05), faxis = (fh >= 40 && w >= 90) ? 28 : 0;
                this._chartRects = [{ name: f.name, kind: f.kind, sub: f.sub, sp: f.sp, act: f.act,
                    field: f.field, accent: f.accent, y: fy, h: fh, cx: x, cw: w }];
                this._chartArea = { x: x + fpad + faxis, y: fy + Math.min(15, Math.max(10, fh * 0.22)),
                    w: w - fpad * 2 - faxis, h: fh - Math.min(15, Math.max(10, fh * 0.22)) - fpad, n: rows.length };
                return;
            }

            // Build the visible set: each section filtered to its selected params.
            var vis = [], si, j;
            for (si = 0; si < schema.length; si++) {
                var sc = schema[si];
                var fp = [], fg = [], fo = [];
                for (j = 0; j < sc.pairs.length; j++)
                    if (self._selected[paramId(sc.sub, 'pair', sc.pairs[j].name)]) fp.push(sc.pairs[j]);
                for (j = 0; j < sc.gains.length; j++)
                    if (self._selected[paramId(sc.sub, 'gain', sc.gains[j].name)]) fg.push(sc.gains[j]);
                for (j = 0; j < sc.outs.length; j++)
                    if (self._selected[paramId(sc.sub, 'out', sc.outs[j].name)]) fo.push(sc.outs[j]);
                if (fp.length + fg.length + fo.length > 0)
                    vis.push({ sec: { sub: sc.sub, pairs: fp, gains: fg, outs: fo }, idx: si });
            }
            if (vis.length === 0) {
                ctx.font = '11px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.textAlign = 'left'; ctx.textBaseline = 'top';
                ctx.fillText('No parameters selected —', x, y);
                ctx.fillText('pick some from the list (bottom right).', x, y + 16);
                return;
            }

            var nSub = vis.length;
            var headerH = 22, gap = 6;

            function weight(sec) {
                var charts = sec.pairs.length + sec.outs.length;
                var gainRows = sec.gains.length ? 1 : 0;
                return Math.max(1, charts + gainRows);
            }
            var expandedCount = 0, sumW = 0;
            for (si = 0; si < nSub; si++) {
                if (!self._collapsed[vis[si].sec.sub]) { expandedCount++; sumW += weight(vis[si].sec); }
            }
            var totalHeaderH = nSub * headerH + (nSub - 1) * gap;
            var bodyAvail = h - totalHeaderH - expandedCount * gap;
            if (bodyAvail < 0) bodyAvail = 0;

            var cy = y;
            for (si = 0; si < nSub; si++) {
                var sec = vis[si].sec, sub = sec.sub;
                var collapsed = !!self._collapsed[sub];
                var secAccent = subAccent(sub, vis[si].idx, scheme);

                // header strip
                roundRect(ctx, x, cy, w, headerH, 4);
                ctx.fillStyle = 'rgba(255,255,255,0.05)';
                ctx.fill();
                ctx.fillStyle = secAccent;
                ctx.fillRect(x, cy + 2, 3, headerH - 4);

                ctx.font = '13px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.8)';
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText(collapsed ? '▸' : '▾', x + 10, cy + headerH / 2 + 1);
                ctx.font = 'bold 10px sans-serif';
                ctx.fillStyle = '#ffffff';
                ctx.fillText(subLabel(sub), x + 24, cy + headerH / 2);

                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

                this._headerRects.push({ sub: sub, x: x, y: cy, w: w, h: headerH });
                cy += headerH + gap;

                if (!collapsed) {
                    var bodyH = sumW > 0 ? bodyAvail * (weight(sec) / sumW) : 0;
                    this._drawSectionBody(ctx, rows, sec, x, cy, w, bodyH, vis[si].idx, warnPct, critPct, scheme, pal);
                    cy += bodyH + gap;
                }
            }

            // Compute the shared chart area (for crosshair + event overlay).
            if (this._chartRects.length) {
                var minY = Infinity, maxY = -Infinity, cr;
                for (var ci = 0; ci < this._chartRects.length; ci++) {
                    cr = this._chartRects[ci];
                    if (cr.y < minY) minY = cr.y;
                    if (cr.y + cr.h > maxY) maxY = cr.y + cr.h;
                }
                var caX = (this._chartPlotX != null) ? this._chartPlotX : x + 3;
                var caW = (this._chartPlotW != null) ? this._chartPlotW : w - 6;
                this._chartArea = { x: caX, y: minY, w: caW, h: maxY - minY, n: rows.length };
            }
        },

        _drawSectionBody: function(ctx, rows, sec, x, y, w, h, subIdx, warnPct, critPct, scheme, pal) {
            if (h < 8) return;
            var accent = subAccent(sec.sub, subIdx, scheme);
            var cy = y;
            var gap = 5;

            // gains strip
            if (sec.gains.length) {
                var gh = Math.min(46, h * 0.34);
                var gn = sec.gains.length;
                var gw = (w - gap * (gn - 1)) / gn;
                for (var gi = 0; gi < gn; gi++) {
                    gainChip(ctx, rows, sec.gains[gi].field, sec.gains[gi].name,
                        x + gi * (gw + gap), cy, gw, gh, accent);
                }
                cy += gh + gap;
            }

            // charts (pairs + outs) split remaining height
            var charts = [];
            var i;
            for (i = 0; i < sec.pairs.length; i++) charts.push({ kind: 'pair', d: sec.pairs[i] });
            for (i = 0; i < sec.outs.length; i++) charts.push({ kind: 'out', d: sec.outs[i] });
            var remH = y + h - cy;
            if (charts.length && remH > 8) {
                var ch = (remH - gap * (charts.length - 1)) / charts.length;
                // record the plot x-range (matches pairChart/outChart gutter) for the crosshair
                var cpad = Math.min(3, ch * 0.05);
                var caxis = (ch >= 40 && w >= 90) ? 28 : 0;
                this._chartPlotX = x + cpad + caxis;
                this._chartPlotW = w - cpad * 2 - caxis;
                for (i = 0; i < charts.length; i++) {
                    var cyy = cy + i * (ch + gap);
                    if (charts[i].kind === 'pair') {
                        pairChart(ctx, rows, charts[i].d.sp, charts[i].d.act, charts[i].d.name,
                            x, cyy, w, ch, accent, pal, warnPct, critPct);
                        this._chartRects.push({ name: charts[i].d.name, kind: 'pair', sub: sec.sub,
                            sp: charts[i].d.sp, act: charts[i].d.act, accent: accent, y: cyy, h: ch, cx: x, cw: w });
                    } else {
                        outChart(ctx, rows, charts[i].d.field, charts[i].d.name, x, cyy, w, ch, accent);
                        this._chartRects.push({ name: charts[i].d.name, kind: 'out', sub: sec.sub,
                            field: charts[i].d.field, accent: accent, y: cyy, h: ch, cx: x, cw: w });
                    }
                }
            }
        },

        _drawModelPanel: function(ctx, rows, schema, statusBySub, x, y, w, h, warnPct, critPct, scheme, pal, partMap, showRowPreview) {
            var focused = !!this._modelFocus;
            ctx.font = 'bold 10px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.fillText('Pod model', x, y);

            // focus toggle button (top-right of the model header)
            var btnLabel = focused ? '✕ exit' : '⛶ focus';
            ctx.font = '8px sans-serif';
            var bw = ctx.measureText(btnLabel).width + 12, bh = 13;
            var bx = x + w - bw, by = y - 1;
            roundRect(ctx, bx, by, bw, bh, bh / 2);
            ctx.fillStyle = focused ? 'rgba(108,92,231,0.35)' : 'rgba(255,255,255,0.07)';
            ctx.fill();
            ctx.fillStyle = focused ? '#ffffff' : 'rgba(255,255,255,0.55)';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(btnLabel, bx + bw / 2, by + bh / 2);
            this._modelBtnRect = { x: bx, y: by, w: bw, h: bh };

            ctx.font = '8px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.textAlign = 'right';
            ctx.fillText('drag to orbit · click a part to toggle its graphs', bx - 8, y + 1);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

            var modelTop = y + 16;
            // Focus mode: model fills the whole right column and the list is hidden.
            var modelH = focused ? (y + h - modelTop) : h * 0.6;
            this._modelRect = { x: x, y: modelTop, w: w, h: modelH };

            var wrapped = {};
            for (var k in statusBySub) {
                if (statusBySub.hasOwnProperty(k)) wrapped[k] = { _col: statusBySub[k]._col };
            }
            drawModel(ctx, x, modelTop, w, modelH, schema, wrapped, this._yaw, this._pitch, pal, partMap, this._hotspots, scheme);

            if (focused) {
                this._listRect = null; this._listRects = []; this._listGroupRects = []; this._chipRects = [];
                if (this._filterInput) this._filterInput.style.display = 'none';
                return;
            }

            // parameter selection list (bottom right)
            var listY = modelTop + modelH + 10;
            var listH = y + h - listY;
            if (listH < 40) { this._listRect = null; this._listRects = []; this._listGroupRects = []; this._chipRects = [];
                if (this._filterInput) this._filterInput.style.display = 'none'; return; }
            this._drawParamList(ctx, rows, schema, statusBySub, x, listY, w, listH, scheme, pal, warnPct, critPct, showRowPreview);
        },

        // Scrollable, filterable, sortable checklist of every parameter.
        _drawParamList: function(ctx, rows, schema, statusBySub, x, y, w, h, scheme, pal, warnPct, critPct, showRowPreview) {
            this._listRects = [];
            this._listGroupRects = [];
            this._chipRects = [];
            var self = this;
            var filt = (this._filter || '').toLowerCase();

            // Build a flat, filtered item list with per-item metadata.
            var flat = [], si, k, items;
            for (si = 0; si < schema.length; si++) {
                var sub = schema[si].sub, accent = subAccent(sub, si, scheme);
                items = secItems(schema[si]);
                for (k = 0; k < items.length; k++) {
                    var it = items[k];
                    if (this._roleFilter !== 'all' && it.kind !== this._roleFilter) continue;
                    var hay = (sub + ' ' + subLabel(sub) + ' ' + it.name + ' ' + it.kind).toLowerCase();
                    if (filt && hay.indexOf(filt) < 0) continue;
                    var err = (it.kind === 'pair') ? relErrorPct(rows, it.d.sp, it.d.act) : null;
                    if (this._onlyUnstable && !(err !== null && err >= warnPct)) continue;
                    flat.push({ it: it, sub: sub, subLabel: subLabel(sub), accent: accent,
                        err: err, field: it.kind === 'pair' ? it.d.act : it.d.field });
                }
            }
            var total = 0, selCount = 0, ti;
            for (si = 0; si < schema.length; si++) { items = secItems(schema[si]);
                for (k = 0; k < items.length; k++) { total++; if (self._selected[items[k].id]) selCount++; } }

            // header line
            ctx.font = 'bold 10px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.fillText('Parameters', x, y);
            ctx.font = '8px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.textAlign = 'right';
            ctx.fillText(selCount + ' / ' + total + ' shown', x + w, y + 1);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

            // filter input overlay (positioned over the canvas)
            var fiY = y + 15, fiH = 20;
            if (this._filterInput) {
                styleSet(this._filterInput, { display: 'block', left: x + 'px', top: fiY + 'px', width: w + 'px', height: fiH + 'px' });
            }

            // control chips row
            var chipY = fiY + fiH + 5, chipH = 15;
            var cxp = x;
            var self2 = this;
            function chip(label, act, active) {
                ctx.font = '8px sans-serif';
                var cw = ctx.measureText(label).width + 12;
                roundRect(ctx, cxp, chipY, cw, chipH, chipH / 2);
                ctx.fillStyle = active ? 'rgba(108,92,231,0.35)' : 'rgba(255,255,255,0.07)';
                ctx.fill();
                ctx.fillStyle = active ? '#ffffff' : 'rgba(255,255,255,0.5)';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(label, cxp + cw / 2, chipY + chipH / 2);
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                self2._chipRects.push({ act: act, x: cxp, y: chipY, w: cw, h: chipH });
                cxp += cw + 4;
            }
            chip(this._sortMode === 'error' ? 'sort: error' : 'sort: group', 'sort', this._sortMode === 'error');
            chip('role: ' + this._roleFilter, 'role', this._roleFilter !== 'all');
            chip('unstable', 'unstable', this._onlyUnstable);

            var innerY = chipY + chipH + 6;
            var innerH = y + h - innerY;
            if (innerH < 16) { this._listRect = null; return; }
            this._listRect = { x: x, y: innerY, w: w, h: innerH };

            roundRect(ctx, x, innerY, w, innerH, 6);
            ctx.fillStyle = 'rgba(255,255,255,0.03)';
            ctx.fill();

            var groupH = 15, rowH = showRowPreview ? 18 : 15, pad = 6;

            // Decide layout: grouped (sort=group) vs flat-by-error (sort=error)
            var grouped = (this._sortMode === 'group');
            var display = [];   // sequence of {type:'group'|'row', ...}
            if (grouped) {
                for (si = 0; si < schema.length; si++) {
                    var rowsForSub = [];
                    for (ti = 0; ti < flat.length; ti++) if (flat[ti].sub === schema[si].sub) rowsForSub.push(flat[ti]);
                    if (!rowsForSub.length) continue;
                    // per-department selected count (over ALL of the sub's items, not just filtered rows)
                    var gItems = secItems(schema[si]), gSel = 0;
                    for (ti = 0; ti < gItems.length; ti++) if (self._selected[gItems[ti].id]) gSel++;
                    display.push({ type: 'group', sub: schema[si].sub, accent: subAccent(schema[si].sub, si, scheme),
                        sel: gSel, total: gItems.length });
                    for (ti = 0; ti < rowsForSub.length; ti++) display.push({ type: 'row', f: rowsForSub[ti] });
                }
            } else {
                flat.sort(function(a, b) {
                    var ea = a.err === null ? -1 : a.err, eb = b.err === null ? -1 : b.err;
                    return eb - ea;
                });
                for (ti = 0; ti < flat.length; ti++) display.push({ type: 'row', f: flat[ti] });
            }

            var contentH = pad, di;
            for (di = 0; di < display.length; di++) contentH += display[di].type === 'group' ? groupH : rowH;
            this._listMaxScroll = Math.max(0, contentH - innerH + pad);
            if (this._listScroll > this._listMaxScroll) this._listScroll = this._listMaxScroll;

            ctx.save();
            roundRect(ctx, x, innerY, w, innerH, 6);
            ctx.clip();
            var cyc = innerY + pad - this._listScroll;
            for (di = 0; di < display.length; di++) {
                var ent = display[di];
                if (ent.type === 'group') {
                    if (cyc + groupH > innerY && cyc < innerY + innerH) {
                        ctx.font = 'bold 9px sans-serif';
                        ctx.fillStyle = ent.accent || 'rgba(255,255,255,0.5)';
                        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                        ctx.fillText(subLabel(ent.sub).toUpperCase(), x + pad, cyc + groupH / 2);
                        // per-department on/off toggle (right-aligned): all on ◉ · some ◐ · none ○
                        var gAllOn = ent.total > 0 && ent.sel === ent.total;
                        var gSome = ent.sel > 0 && ent.sel < ent.total;
                        var gGlyph = gAllOn ? '◉' : (gSome ? '◐' : '○');
                        ctx.font = '9px sans-serif';
                        ctx.fillStyle = gAllOn ? ent.accent : (gSome ? rgbaStr(ent.accent, 0.7) : 'rgba(255,255,255,0.3)');
                        ctx.textAlign = 'right';
                        ctx.fillText(gGlyph + ' all', x + w - pad, cyc + groupH / 2);
                        ctx.textAlign = 'left';
                        self._listGroupRects.push({ sub: ent.sub, x: x, y: cyc, w: w, h: groupH });
                    }
                    cyc += groupH;
                } else {
                    var f = ent.f, on = !!self._selected[f.it.id];
                    if (cyc + rowH > innerY && cyc < innerY + innerH) {
                        var midY = cyc + rowH / 2;
                        // subsystem colour dot (matches the chart line colour)
                        ctx.beginPath(); ctx.arc(x + pad + 4, midY, 3, 0, Math.PI * 2);
                        ctx.fillStyle = f.accent; ctx.fill();
                        // toggle glyph
                        ctx.font = '10px sans-serif';
                        ctx.fillStyle = on ? f.accent : 'rgba(255,255,255,0.25)';
                        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                        ctx.fillText(on ? '◉' : '○', x + pad + 12, midY);
                        // name (+ subsystem prefix when flat)
                        ctx.font = '9px sans-serif';
                        ctx.fillStyle = on ? '#ffffff' : 'rgba(255,255,255,0.5)';
                        var nm = grouped ? f.it.name : (f.subLabel.split(' ')[0] + '·' + f.it.name);
                        ctx.fillText(nm, x + pad + 26, midY);
                        // mini sparkline
                        if (showRowPreview) {
                            var spW = 34, spX = x + w - pad - 20 - spW, spH = rowH - 6;
                            this._miniSpark(ctx, rows, f.field, spX, cyc + 3, spW, spH, f.accent);
                        }
                        // role tag
                        ctx.font = '7px monospace';
                        ctx.fillStyle = 'rgba(255,255,255,0.3)';
                        ctx.textAlign = 'right';
                        ctx.fillText(f.it.kind, x + w - pad, midY);
                        ctx.textAlign = 'left';
                        this._listRects.push({ id: f.it.id, x: x, y: cyc, w: w, h: rowH });
                    }
                    cyc += rowH;
                }
            }
            ctx.restore();
            ctx.textBaseline = 'alphabetic';

            if (display.length === 0) {
                ctx.font = '9px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.35)';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText('No parameters match the filter', x + w / 2, innerY + innerH / 2);
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            }

            if (this._listMaxScroll > 0) {
                var trackH = innerH - 4;
                var thumbH = Math.max(16, trackH * (innerH / contentH));
                var thumbY = innerY + 2 + (trackH - thumbH) * (this._listScroll / this._listMaxScroll);
                ctx.fillStyle = 'rgba(255,255,255,0.18)';
                roundRect(ctx, x + w - 4, thumbY, 2.5, thumbH, 1.25);
                ctx.fill();
            }
        },

        // Tiny sparkline used in parameter list rows.
        _miniSpark: function(ctx, rows, field, x, y, w, h, accent) {
            var n = rows.length, i, v, mn = Infinity, mx = -Infinity;
            for (i = 0; i < n; i++) { v = rows[i][field]; if (!isNaN(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } }
            if (mn === Infinity || n < 2) return;
            var span = mx - mn; if (span < 1e-6) span = 1;
            ctx.beginPath();
            for (i = 0; i < n; i++) {
                v = rows[i][field]; if (isNaN(v)) continue;
                var px = x + (i / (n - 1)) * w;
                var py = y + h - ((v - mn) / span) * h;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.strokeStyle = rgbaStr(accent, 0.8); ctx.lineWidth = 1; ctx.stroke();
        },

        _manageRotation: function(autoRot) {
            var self = this;
            if (autoRot && !this._rotTimer) {
                this._rotTimer = setInterval(function() {
                    if (!self._ptrDown) {
                        self._yaw += 0.012;
                        self.invalidateUpdateView();
                    }
                }, 70);
            } else if (!autoRot && this._rotTimer) {
                clearInterval(this._rotTimer);
                this._rotTimer = null;
            }
        },

        _ensureCanvas: function() {
            if (!this.canvas) {
                this.el.innerHTML = '';
                this.canvas = document.createElement('canvas');
                this.canvas.style.width = '100%';
                this.canvas.style.height = '100%';
                this.canvas.style.display = 'block';
                this.el.appendChild(this.canvas);
            }
            var rect = this.el.getBoundingClientRect();
            var dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
        },

        _drawStatusMessage: function(message) {
            var rect = this.el.getBoundingClientRect();
            var dpr = window.devicePixelRatio || 1;
            var ctx = this.canvas.getContext('2d');
            if (!ctx) return;
            if (rect.width <= 0 || rect.height <= 0) return;
            ctx.scale(dpr, dpr);
            var w = rect.width, h = rect.height;
            ctx.clearRect(0, 0, w, h);
            var fontSize = Math.max(10, Math.min(32, Math.min(w, h) * 0.09));
            var emojiSize = Math.round(fontSize * 1.6);
            var gap = fontSize * 0.5;
            ctx.font = '500 ' + fontSize + 'px sans-serif';
            while (ctx.measureText(message).width > w * 0.85 && fontSize > 8) {
                fontSize -= 1; emojiSize = Math.round(fontSize * 1.6);
                ctx.font = '500 ' + fontSize + 'px sans-serif';
            }
            ctx.font = emojiSize + 'px sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(255,255,255,1)';
            ctx.fillText('⏱', w / 2, h / 2 - fontSize * 0.5 - gap);
            ctx.font = '500 ' + fontSize + 'px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.30)';
            ctx.fillText(message, w / 2, h / 2 + emojiSize * 0.3);
            ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        },

        reflow: function() { this.invalidateUpdateView(); },

        destroy: function() {
            if (this._rotTimer) { clearInterval(this._rotTimer); this._rotTimer = null; }
            if (this._playTimer) { clearInterval(this._playTimer); this._playTimer = null; }
            this.el.removeEventListener('mousedown', this._onDown);
            this.el.removeEventListener('mousemove', this._onMove);
            this.el.removeEventListener('mouseup', this._onUp);
            this.el.removeEventListener('mouseleave', this._onLeave);
            this.el.removeEventListener('dblclick', this._onDblClick);
            this.el.removeEventListener('wheel', this._onWheel);
            if (this._filterInput && this._filterInput.parentNode) this._filterInput.parentNode.removeChild(this._filterInput);
            if (this._rangeSelect && this._rangeSelect.parentNode) this._rangeSelect.parentNode.removeChild(this._rangeSelect);
            if (this._labSelects) {
                var s = this._labSelects;
                [s.x, s.y, s.sig, s.op].forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
            }
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
