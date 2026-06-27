/*
 * Hyperloop Tuning — Splunk Custom Visualization
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
    var KNOWN_LABELS = { lev: 'Levitation', lat: 'Lateral guidance', prop: 'Propulsion', therm: 'Thermal' };
    var ACCENTS = { lev: '#6C5CE7', lat: '#00B4D8', prop: '#2DC653', therm: '#F4A261' };
    var CYCLE = ['#6C5CE7', '#00B4D8', '#2DC653', '#F4A261', '#E76F51', '#B5179E'];

    // ── Colour helpers ──────────────────────────────────────────────

    function hexToRgb(hex) {
        return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }
    function rgbaStr(hex, a) {
        var c = hexToRgb(hex);
        return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
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
            var neon = { lev: '#B400FF', lat: '#00FFFF', prop: '#00FF88', therm: '#FF9900' };
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

    // Setpoint-vs-actual chart with shaded error band + relErr badge.
    function pairChart(ctx, rows, spField, actField, name, x, y, w, h, accent, pal, warnPct, critPct) {
        roundRect(ctx, x, y, w, h, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fill();

        var n = rows.length, i, v;
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
        var plotX = x + pad, plotW = w - pad * 2;
        var plotY = y + headerH, plotH = h - headerH - pad;
        if (plotH < 4) plotH = 4;

        function px(idx) { return plotX + (n > 1 ? (idx / (n - 1)) * plotW : plotW / 2); }
        function py(val) { return plotY + plotH - ((val - pBot) / range) * plotH; }

        ctx.save();
        roundRect(ctx, x, plotY, w, plotH, 0);
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
        ctx.restore();

        // header: name + current actual + relErr badge
        var labelFont = Math.min(9, Math.max(7, headerH * 0.62));
        ctx.font = labelFont + 'px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(name, x + 4, y + 3);

        var pct = relErrorPct(rows, spField, actField);
        var curAct = rows[n - 1][actField];
        ctx.font = 'bold ' + Math.min(10, Math.max(8, headerH * 0.66)) + 'px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(fmtNum(curAct), x + w - 4, y + 2);

        if (pct !== null) {
            var bw = 44, bh = Math.min(11, headerH - 1);
            var bx = x + w - 4 - ctx.measureText(fmtNum(curAct)).width - 6 - bw;
            var sc = statusColour(pct, warnPct, critPct, pal);
            roundRect(ctx, bx, y + 2, bw, bh, bh / 2);
            ctx.fillStyle = rgbaStr(sc, 0.18);
            ctx.fill();
            ctx.font = '7px monospace';
            ctx.fillStyle = sc;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(pct.toFixed(1) + '% err', bx + bw / 2, y + 2 + bh / 2);
        }
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // Plain output trace (no setpoint).
    function outChart(ctx, rows, field, name, x, y, w, h, accent) {
        roundRect(ctx, x, y, w, h, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fill();
        var n = rows.length, i, v, minV = Infinity, maxV = -Infinity;
        for (i = 0; i < n; i++) { v = rows[i][field]; if (!isNaN(v)) { if (v < minV) minV = v; if (v > maxV) maxV = v; } }
        if (minV === Infinity) { minV = 0; maxV = 1; }
        var span = maxV - minV; if (span < 1e-6) span = Math.abs(maxV) > 1e-6 ? Math.abs(maxV) * 0.1 : 1;
        var pTop = maxV + span * 0.2, pBot = minV - span * 0.2, range = pTop - pBot;
        var headerH = Math.min(15, Math.max(10, h * 0.22));
        var pad = Math.min(3, h * 0.05);
        var plotX = x + pad, plotW = w - pad * 2, plotY = y + headerH, plotH = h - headerH - pad;
        if (plotH < 4) plotH = 4;
        function px(idx) { return plotX + (n > 1 ? (idx / (n - 1)) * plotW : plotW / 2); }
        function py(val) { return plotY + plotH - ((val - pBot) / range) * plotH; }
        ctx.save();
        roundRect(ctx, x, plotY, w, plotH, 0); ctx.clip();
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
        var v = [[-0.955,-0.677,-0.135],[-0.955,-0.528,-0.353],[-0.955,-0.242,-0.362],[-0.955,-0.048,-0.243],[-0.955,0.053,-0.268],[-0.955,0.267,-0.399],[-0.955,0.533,-0.356],[-0.955,0.643,-0.128],[-0.955,0.593,0.118],[-0.955,0.434,0.29],[-0.955,0.231,0.346],[-0.955,0.062,0.311],[-0.955,-0.062,0.313],[-0.955,-0.236,0.353],[-0.955,-0.453,0.303],[-0.955,-0.625,0.124],[-0.864,-0.657,-0.131],[-0.864,-0.481,-0.321],[-0.864,-0.201,-0.3],[-0.864,-0.039,-0.197],[-0.864,0.045,-0.228],[-0.864,0.245,-0.366],[-0.864,0.501,-0.335],[-0.864,0.632,-0.126],[-0.864,0.582,0.116],[-0.864,0.435,0.291],[-0.864,0.227,0.34],[-0.864,0.061,0.307],[-0.864,-0.062,0.311],[-0.864,-0.239,0.357],[-0.864,-0.461,0.308],[-0.864,-0.622,0.124],[-0.773,-0.607,-0.121],[-0.773,-0.414,-0.276],[-0.773,-0.155,-0.232],[-0.773,-0.03,-0.153],[-0.773,0.038,-0.19],[-0.773,0.199,-0.298],[-0.773,0.44,-0.294],[-0.773,0.583,-0.116],[-0.773,0.576,0.115],[-0.773,0.428,0.286],[-0.773,0.22,0.329],[-0.773,0.055,0.278],[-0.773,-0.057,0.287],[-0.773,-0.23,0.344],[-0.773,-0.46,0.307],[-0.773,-0.617,0.123],[-0.682,-0.551,-0.11],[-0.682,-0.329,-0.22],[-0.682,-0.119,-0.178],[-0.682,-0.023,-0.117],[-0.682,0.029,-0.146],[-0.682,0.153,-0.229],[-0.682,0.349,-0.233],[-0.682,0.535,-0.106],[-0.682,0.553,0.11],[-0.682,0.419,0.28],[-0.682,0.204,0.305],[-0.682,0.046,0.23],[-0.682,-0.045,0.226],[-0.682,-0.207,0.31],[-0.682,-0.439,0.293],[-0.682,-0.591,0.117],[-0.591,-0.514,-0.102],[-0.591,-0.297,-0.198],[-0.591,-0.095,-0.143],[-0.591,-0.021,-0.105],[-0.591,0.026,-0.132],[-0.591,0.131,-0.195],[-0.591,0.324,-0.216],[-0.591,0.507,-0.101],[-0.591,0.551,0.11],[-0.591,0.417,0.279],[-0.591,0.195,0.292],[-0.591,0.041,0.207],[-0.591,-0.039,0.195],[-0.591,-0.184,0.275],[-0.591,-0.426,0.285],[-0.591,-0.564,0.112],[-0.5,-0.519,-0.103],[-0.5,-0.318,-0.212],[-0.5,-0.106,-0.158],[-0.5,-0.022,-0.111],[-0.5,0.03,-0.149],[-0.5,0.157,-0.235],[-0.5,0.348,-0.233],[-0.5,0.525,-0.104],[-0.5,0.557,0.111],[-0.5,0.421,0.282],[-0.5,0.206,0.308],[-0.5,0.045,0.228],[-0.5,-0.043,0.218],[-0.5,-0.192,0.288],[-0.5,-0.421,0.282],[-0.5,-0.574,0.114],[-0.409,-0.585,-0.116],[-0.409,-0.38,-0.254],[-0.409,-0.152,-0.227],[-0.409,-0.033,-0.168],[-0.409,0.046,-0.229],[-0.409,0.207,-0.31],[-0.409,0.415,-0.277],[-0.409,0.565,-0.112],[-0.409,0.568,0.113],[-0.409,0.436,0.291],[-0.409,0.213,0.319],[-0.409,0.054,0.27],[-0.409,-0.051,0.254],[-0.409,-0.213,0.319],[-0.409,-0.449,0.3],[-0.409,-0.596,0.119],[-0.318,-0.616,-0.123],[-0.318,-0.462,-0.309],[-0.318,-0.217,-0.325],[-0.318,-0.063,-0.317],[-0.318,0.07,-0.353],[-0.318,0.272,-0.408],[-0.318,0.475,-0.317],[-0.318,0.591,-0.118],[-0.318,0.581,0.116],[-0.318,0.424,0.284],[-0.318,0.216,0.323],[-0.318,0.052,0.262],[-0.318,-0.054,0.273],[-0.318,-0.217,0.325],[-0.318,-0.454,0.304],[-0.318,-0.619,0.123],[-0.227,-0.647,-0.129],[-0.227,-0.524,-0.35],[-0.227,-0.316,-0.472],[-0.227,-0.1,-0.5],[-0.227,0.105,-0.529],[-0.227,0.325,-0.486],[-0.227,0.513,-0.343],[-0.227,0.6,-0.119],[-0.227,0.562,0.112],[-0.227,0.413,0.276],[-0.227,0.191,0.286],[-0.227,0.052,0.259],[-0.227,-0.051,0.254],[-0.227,-0.211,0.316],[-0.227,-0.445,0.297],[-0.227,-0.606,0.12],[-0.136,-0.651,-0.13],[-0.136,-0.579,-0.387],[-0.136,-0.372,-0.557],[-0.136,-0.128,-0.643],[-0.136,0.125,-0.628],[-0.136,0.362,-0.542],[-0.136,0.531,-0.355],[-0.136,0.601,-0.12],[-0.136,0.561,0.112],[-0.136,0.399,0.266],[-0.136,0.193,0.289],[-0.136,0.051,0.255],[-0.136,-0.054,0.271],[-0.136,-0.21,0.315],[-0.136,-0.438,0.293],[-0.136,-0.609,0.121],[-0.045,-0.662,-0.132],[-0.045,-0.59,-0.395],[-0.045,-0.398,-0.595],[-0.045,-0.137,-0.688],[-0.045,0.135,-0.679],[-0.045,0.38,-0.569],[-0.045,0.553,-0.369],[-0.045,0.613,-0.122],[-0.045,0.565,0.112],[-0.045,0.405,0.271],[-0.045,0.195,0.292],[-0.045,0.055,0.274],[-0.045,-0.056,0.283],[-0.045,-0.214,0.321],[-0.045,-0.441,0.294],[-0.045,-0.606,0.121],[0.045,-0.65,-0.129],[0.045,-0.586,-0.392],[0.045,-0.394,-0.589],[0.045,-0.137,-0.687],[0.045,0.135,-0.681],[0.045,0.382,-0.572],[0.045,0.554,-0.37],[0.045,0.609,-0.121],[0.045,0.559,0.111],[0.045,0.403,0.27],[0.045,0.195,0.292],[0.045,0.055,0.275],[0.045,-0.057,0.287],[0.045,-0.215,0.322],[0.045,-0.437,0.292],[0.045,-0.601,0.12],[0.136,-0.634,-0.126],[0.136,-0.565,-0.378],[0.136,-0.38,-0.569],[0.136,-0.131,-0.657],[0.136,0.13,-0.651],[0.136,0.369,-0.552],[0.136,0.534,-0.357],[0.136,0.593,-0.118],[0.136,0.548,0.109],[0.136,0.4,0.267],[0.136,0.197,0.295],[0.136,0.054,0.274],[0.136,-0.057,0.285],[0.136,-0.215,0.322],[0.136,-0.432,0.289],[0.136,-0.586,0.117],[0.227,-0.632,-0.126],[0.227,-0.558,-0.373],[0.227,-0.357,-0.534],[0.227,-0.122,-0.615],[0.227,0.121,-0.609],[0.227,0.343,-0.513],[0.227,0.525,-0.351],[0.227,0.589,-0.117],[0.227,0.555,0.11],[0.227,0.416,0.278],[0.227,0.209,0.312],[0.227,0.057,0.288],[0.227,-0.058,0.292],[0.227,-0.22,0.329],[0.227,-0.437,0.292],[0.227,-0.591,0.118],[0.318,-0.639,-0.127],[0.318,-0.524,-0.35],[0.318,-0.318,-0.477],[0.318,-0.103,-0.519],[0.318,0.102,-0.514],[0.318,0.31,-0.463],[0.318,0.496,-0.332],[0.318,0.604,-0.12],[0.318,0.576,0.114],[0.318,0.434,0.29],[0.318,0.228,0.342],[0.318,0.061,0.305],[0.318,-0.061,0.308],[0.318,-0.233,0.348],[0.318,-0.455,0.304],[0.318,-0.61,0.121],[0.409,-0.617,-0.123],[0.409,-0.467,-0.312],[0.409,-0.252,-0.378],[0.409,-0.079,-0.397],[0.409,0.079,-0.396],[0.409,0.244,-0.365],[0.409,0.464,-0.31],[0.409,0.594,-0.118],[0.409,0.577,0.115],[0.409,0.443,0.296],[0.409,0.231,0.346],[0.409,0.063,0.314],[0.409,-0.062,0.314],[0.409,-0.24,0.359],[0.409,-0.466,0.311],[0.409,-0.607,0.121],[0.5,-0.589,-0.117],[0.5,-0.444,-0.297],[0.5,-0.224,-0.336],[0.5,-0.068,-0.344],[0.5,0.064,-0.321],[0.5,0.218,-0.326],[0.5,0.426,-0.284],[0.5,0.583,-0.116],[0.5,0.573,0.114],[0.5,0.435,0.291],[0.5,0.23,0.344],[0.5,0.062,0.31],[0.5,-0.063,0.317],[0.5,-0.243,0.364],[0.5,-0.463,0.309],[0.5,-0.604,0.12],[0.591,-0.615,-0.122],[0.591,-0.463,-0.309],[0.591,-0.264,-0.396],[0.591,-0.078,-0.392],[0.591,0.077,-0.388],[0.591,0.234,-0.35],[0.591,0.451,-0.301],[0.591,0.579,-0.115],[0.591,0.564,0.112],[0.591,0.431,0.288],[0.591,0.227,0.34],[0.591,0.061,0.308],[0.591,-0.063,0.319],[0.591,-0.244,0.365],[0.591,-0.466,0.311],[0.591,-0.598,0.119],[0.682,-0.617,-0.123],[0.682,-0.515,-0.344],[0.682,-0.288,-0.431],[0.682,-0.094,-0.472],[0.682,0.089,-0.447],[0.682,0.287,-0.43],[0.682,0.483,-0.323],[0.682,0.591,-0.118],[0.682,0.56,0.111],[0.682,0.427,0.285],[0.682,0.224,0.336],[0.682,0.061,0.308],[0.682,-0.063,0.319],[0.682,-0.245,0.366],[0.682,-0.463,0.309],[0.682,-0.606,0.121],[0.773,-0.655,-0.13],[0.773,-0.519,-0.347],[0.773,-0.317,-0.474],[0.773,-0.096,-0.484],[0.773,0.1,-0.501],[0.773,0.305,-0.456],[0.773,0.514,-0.343],[0.773,0.609,-0.121],[0.773,0.57,0.113],[0.773,0.426,0.285],[0.773,0.227,0.34],[0.773,0.061,0.308],[0.773,-0.064,0.32],[0.773,-0.245,0.366],[0.773,-0.463,0.309],[0.773,-0.616,0.123],[0.864,-0.635,-0.126],[0.864,-0.509,-0.34],[0.864,-0.293,-0.439],[0.864,-0.097,-0.49],[0.864,0.093,-0.466],[0.864,0.283,-0.423],[0.864,0.473,-0.316],[0.864,0.6,-0.119],[0.864,0.578,0.115],[0.864,0.434,0.29],[0.864,0.227,0.339],[0.864,0.062,0.312],[0.864,-0.063,0.317],[0.864,-0.239,0.358],[0.864,-0.462,0.308],[0.864,-0.622,0.124],[0.955,-0.603,-0.12],[0.955,-0.445,-0.298],[0.955,-0.271,-0.405],[0.955,-0.088,-0.445],[0.955,0.083,-0.416],[0.955,0.226,-0.339],[0.955,0.397,-0.265],[0.955,0.558,-0.111],[0.955,0.574,0.114],[0.955,0.434,0.29],[0.955,0.231,0.346],[0.955,0.062,0.311],[0.955,-0.062,0.312],[0.955,-0.235,0.352],[0.955,-0.451,0.302],[0.955,-0.607,0.121],[1.0,0.0,0.0],[-1.0,0.0,0.0]];
        var e = [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,13],[13,14],[14,15],[15,0],[0,16],[1,17],[2,18],[3,19],[4,20],[5,21],[6,22],[7,23],[8,24],[9,25],[10,26],[11,27],[12,28],[13,29],[14,30],[15,31],[16,17],[17,18],[18,19],[19,20],[20,21],[21,22],[22,23],[23,24],[24,25],[25,26],[26,27],[27,28],[28,29],[29,30],[30,31],[31,16],[16,32],[17,33],[18,34],[19,35],[20,36],[21,37],[22,38],[23,39],[24,40],[25,41],[26,42],[27,43],[28,44],[29,45],[30,46],[31,47],[32,33],[33,34],[34,35],[35,36],[36,37],[37,38],[38,39],[39,40],[40,41],[41,42],[42,43],[43,44],[44,45],[45,46],[46,47],[47,32],[32,48],[33,49],[34,50],[35,51],[36,52],[37,53],[38,54],[39,55],[40,56],[41,57],[42,58],[43,59],[44,60],[45,61],[46,62],[47,63],[48,49],[49,50],[50,51],[51,52],[52,53],[53,54],[54,55],[55,56],[56,57],[57,58],[58,59],[59,60],[60,61],[61,62],[62,63],[63,48],[48,64],[49,65],[50,66],[51,67],[52,68],[53,69],[54,70],[55,71],[56,72],[57,73],[58,74],[59,75],[60,76],[61,77],[62,78],[63,79],[64,65],[65,66],[66,67],[67,68],[68,69],[69,70],[70,71],[71,72],[72,73],[73,74],[74,75],[75,76],[76,77],[77,78],[78,79],[79,64],[64,80],[65,81],[66,82],[67,83],[68,84],[69,85],[70,86],[71,87],[72,88],[73,89],[74,90],[75,91],[76,92],[77,93],[78,94],[79,95],[80,81],[81,82],[82,83],[83,84],[84,85],[85,86],[86,87],[87,88],[88,89],[89,90],[90,91],[91,92],[92,93],[93,94],[94,95],[95,80],[80,96],[81,97],[82,98],[83,99],[84,100],[85,101],[86,102],[87,103],[88,104],[89,105],[90,106],[91,107],[92,108],[93,109],[94,110],[95,111],[96,97],[97,98],[98,99],[99,100],[100,101],[101,102],[102,103],[103,104],[104,105],[105,106],[106,107],[107,108],[108,109],[109,110],[110,111],[111,96],[96,112],[97,113],[98,114],[99,115],[100,116],[101,117],[102,118],[103,119],[104,120],[105,121],[106,122],[107,123],[108,124],[109,125],[110,126],[111,127],[112,113],[113,114],[114,115],[115,116],[116,117],[117,118],[118,119],[119,120],[120,121],[121,122],[122,123],[123,124],[124,125],[125,126],[126,127],[127,112],[112,128],[113,129],[114,130],[115,131],[116,132],[117,133],[118,134],[119,135],[120,136],[121,137],[122,138],[123,139],[124,140],[125,141],[126,142],[127,143],[128,129],[129,130],[130,131],[131,132],[132,133],[133,134],[134,135],[135,136],[136,137],[137,138],[138,139],[139,140],[140,141],[141,142],[142,143],[143,128],[128,144],[129,145],[130,146],[131,147],[132,148],[133,149],[134,150],[135,151],[136,152],[137,153],[138,154],[139,155],[140,156],[141,157],[142,158],[143,159],[144,145],[145,146],[146,147],[147,148],[148,149],[149,150],[150,151],[151,152],[152,153],[153,154],[154,155],[155,156],[156,157],[157,158],[158,159],[159,144],[144,160],[145,161],[146,162],[147,163],[148,164],[149,165],[150,166],[151,167],[152,168],[153,169],[154,170],[155,171],[156,172],[157,173],[158,174],[159,175],[160,161],[161,162],[162,163],[163,164],[164,165],[165,166],[166,167],[167,168],[168,169],[169,170],[170,171],[171,172],[172,173],[173,174],[174,175],[175,160],[160,176],[161,177],[162,178],[163,179],[164,180],[165,181],[166,182],[167,183],[168,184],[169,185],[170,186],[171,187],[172,188],[173,189],[174,190],[175,191],[176,177],[177,178],[178,179],[179,180],[180,181],[181,182],[182,183],[183,184],[184,185],[185,186],[186,187],[187,188],[188,189],[189,190],[190,191],[191,176],[176,192],[177,193],[178,194],[179,195],[180,196],[181,197],[182,198],[183,199],[184,200],[185,201],[186,202],[187,203],[188,204],[189,205],[190,206],[191,207],[192,193],[193,194],[194,195],[195,196],[196,197],[197,198],[198,199],[199,200],[200,201],[201,202],[202,203],[203,204],[204,205],[205,206],[206,207],[207,192],[192,208],[193,209],[194,210],[195,211],[196,212],[197,213],[198,214],[199,215],[200,216],[201,217],[202,218],[203,219],[204,220],[205,221],[206,222],[207,223],[208,209],[209,210],[210,211],[211,212],[212,213],[213,214],[214,215],[215,216],[216,217],[217,218],[218,219],[219,220],[220,221],[221,222],[222,223],[223,208],[208,224],[209,225],[210,226],[211,227],[212,228],[213,229],[214,230],[215,231],[216,232],[217,233],[218,234],[219,235],[220,236],[221,237],[222,238],[223,239],[224,225],[225,226],[226,227],[227,228],[228,229],[229,230],[230,231],[231,232],[232,233],[233,234],[234,235],[235,236],[236,237],[237,238],[238,239],[239,224],[224,240],[225,241],[226,242],[227,243],[228,244],[229,245],[230,246],[231,247],[232,248],[233,249],[234,250],[235,251],[236,252],[237,253],[238,254],[239,255],[240,241],[241,242],[242,243],[243,244],[244,245],[245,246],[246,247],[247,248],[248,249],[249,250],[250,251],[251,252],[252,253],[253,254],[254,255],[255,240],[240,256],[241,257],[242,258],[243,259],[244,260],[245,261],[246,262],[247,263],[248,264],[249,265],[250,266],[251,267],[252,268],[253,269],[254,270],[255,271],[256,257],[257,258],[258,259],[259,260],[260,261],[261,262],[262,263],[263,264],[264,265],[265,266],[266,267],[267,268],[268,269],[269,270],[270,271],[271,256],[256,272],[257,273],[258,274],[259,275],[260,276],[261,277],[262,278],[263,279],[264,280],[265,281],[266,282],[267,283],[268,284],[269,285],[270,286],[271,287],[272,273],[273,274],[274,275],[275,276],[276,277],[277,278],[278,279],[279,280],[280,281],[281,282],[282,283],[283,284],[284,285],[285,286],[286,287],[287,272],[272,288],[273,289],[274,290],[275,291],[276,292],[277,293],[278,294],[279,295],[280,296],[281,297],[282,298],[283,299],[284,300],[285,301],[286,302],[287,303],[288,289],[289,290],[290,291],[291,292],[292,293],[293,294],[294,295],[295,296],[296,297],[297,298],[298,299],[299,300],[300,301],[301,302],[302,303],[303,288],[288,304],[289,305],[290,306],[291,307],[292,308],[293,309],[294,310],[295,311],[296,312],[297,313],[298,314],[299,315],[300,316],[301,317],[302,318],[303,319],[304,305],[305,306],[306,307],[307,308],[308,309],[309,310],[310,311],[311,312],[312,313],[313,314],[314,315],[315,316],[316,317],[317,318],[318,319],[319,304],[304,320],[305,321],[306,322],[307,323],[308,324],[309,325],[310,326],[311,327],[312,328],[313,329],[314,330],[315,331],[316,332],[317,333],[318,334],[319,335],[320,321],[321,322],[322,323],[323,324],[324,325],[325,326],[326,327],[327,328],[328,329],[329,330],[330,331],[331,332],[332,333],[333,334],[334,335],[335,320],[320,336],[321,337],[322,338],[323,339],[324,340],[325,341],[326,342],[327,343],[328,344],[329,345],[330,346],[331,347],[332,348],[333,349],[334,350],[335,351],[336,337],[337,338],[338,339],[339,340],[340,341],[341,342],[342,343],[343,344],[344,345],[345,346],[346,347],[347,348],[348,349],[349,350],[350,351],[351,336],[336,352],[0,353],[337,352],[1,353],[338,352],[2,353],[339,352],[3,353],[340,352],[4,353],[341,352],[5,353],[342,352],[6,353],[343,352],[7,353],[344,352],[8,353],[345,352],[9,353],[346,352],[10,353],[347,352],[11,353],[348,352],[12,353],[349,352],[13,353],[350,352],[14,353],[351,352],[15,353]];
        return { v: v, e: e };
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
        var cx = x + w / 2, cyc = y + h * 0.46;
        var scale = Math.min(w, h) * 0.30;

        // edges
        var i, a, b, pa, pb, depth;
        for (i = 0; i < geo.e.length; i++) {
            a = rot3(geo.v[geo.e[i][0]], yaw, pitch);
            b = rot3(geo.v[geo.e[i][1]], yaw, pitch);
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

        // hotspots, depth-sorted (far first)
        hotOut.length = 0;
        var spots = [];
        for (i = 0; i < subs.length; i++) {
            var sub = subs[i].sub;
            var anchor = (partMap && partMap[sub]) ? partMap[sub] : autoAnchor(i, subs.length);
            var r = rot3(anchor, yaw, pitch);
            spots.push({ sub: sub, sx: cx + r[0] * scale, sy: cyc - r[2] * scale, depth: r[1], status: statusBySub[sub] });
        }
        spots.sort(function(p, q) { return q.depth - p.depth; });
        for (i = 0; i < spots.length; i++) {
            var s = spots[i];
            var near = s.depth < 0;
            var col = (s.status && s.status._col) ? s.status._col : pal.neutral;
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
            this.el.classList.add('hyperloop-tuning-viz');
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
            this._listRect = null;
            this._listScroll = 0;
            this._listMaxScroll = 0;

            var self = this;
            function pos(e) {
                var r = self.el.getBoundingClientRect();
                return { x: e.clientX - r.left, y: e.clientY - r.top };
            }
            this._onDown = function(e) {
                var p = pos(e);
                self._ptrDown = true; self._moved = false;
                self._downX = p.x; self._downY = p.y;
                self._startYaw = self._yaw; self._startPitch = self._pitch;
                self._dragInModel = self._modelRect &&
                    p.x >= self._modelRect.x && p.x <= self._modelRect.x + self._modelRect.w &&
                    p.y >= self._modelRect.y && p.y <= self._modelRect.y + self._modelRect.h;
            };
            this._onMove = function(e) {
                if (!self._ptrDown) return;
                var p = pos(e);
                var dx = p.x - self._downX, dy = p.y - self._downY;
                if (Math.abs(dx) + Math.abs(dy) > 4) self._moved = true;
                if (self._dragInModel && self._moved) {
                    self._yaw = self._startYaw + dx * 0.01;
                    self._pitch = Math.max(-1.2, Math.min(1.2, self._startPitch - dy * 0.01));
                    self.invalidateUpdateView();
                }
            };
            this._onUp = function(e) {
                if (self._ptrDown && !self._moved) {
                    var p = pos(e), i;
                    // accordion header → collapse/expand
                    for (i = 0; i < self._headerRects.length; i++) {
                        var hr = self._headerRects[i];
                        if (p.x >= hr.x && p.x <= hr.x + hr.w && p.y >= hr.y && p.y <= hr.y + hr.h) {
                            self._collapsed[hr.sub] = !self._collapsed[hr.sub];
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
            this.el.addEventListener('mousedown', this._onDown);
            this.el.addEventListener('mousemove', this._onMove);
            this.el.addEventListener('mouseup', this._onUp);
            this.el.addEventListener('mouseleave', this._onUp);
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
                    obj[nm] = (nm === '_time') ? (parseFloat(r2[f]) || 0) : parseFloat(r2[f]);
                }
                parsed.push(obj);
            }
            parsed.sort(function(a, b) { return a._time - b._time; });

            var result = { rows: parsed, schema: schema };
            this._lastGoodData = result;
            return result;
        },

        updateView: function(data, config) {
            if (data && data._status) { this._ensureCanvas(); this._drawStatusMessage(data._status); return; }
            if (!data) { if (this._lastGoodData) data = this._lastGoodData; else return; }

            var ns = this.getPropertyNamespaceInfo().propertyNamespace;
            var warnPct = parseFloat(config[ns + 'errWarnPct']) || 5;
            var critPct = parseFloat(config[ns + 'errCritPct']) || 15;
            var scheme = config[ns + 'colorScheme'] || 'dark';
            var autoRot = (config[ns + 'modelAutoRotate'] || 'true') === 'true';
            var partMap = null;
            var pmRaw = config[ns + 'partMap'];
            if (pmRaw) { try { partMap = JSON.parse(pmRaw); } catch (err) { partMap = null; } }

            var pal = buildPalette(scheme);
            var rows = data.rows, schema = data.schema;
            this._schema = schema;

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

            // ── Accordion (left) ──
            this._drawAccordion(ctx, rows, schema, statusBySub, pad, pad, accW, h - pad * 2,
                warnPct, critPct, scheme, pal);

            // divider
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(modelX - pad / 2, pad);
            ctx.lineTo(modelX - pad / 2, h - pad);
            ctx.stroke();

            // ── Model (right) ──
            this._drawModelPanel(ctx, rows, schema, statusBySub, modelX, pad, modelW, h - pad * 2,
                warnPct, critPct, scheme, pal, partMap);

            // Auto-rotate timer management
            this._manageRotation(autoRot);
        },

        _drawAccordion: function(ctx, rows, schema, statusBySub, x, y, w, h, warnPct, critPct, scheme, pal) {
            this._headerRects = [];
            var self = this;
            if (schema.length === 0) {
                ctx.font = '12px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.textAlign = 'left'; ctx.textBaseline = 'top';
                ctx.fillText('No tune_* columns found.', x, y);
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
                var st = statusBySub[sub];

                // header strip
                roundRect(ctx, x, cy, w, headerH, 4);
                ctx.fillStyle = 'rgba(255,255,255,0.05)';
                ctx.fill();
                ctx.fillStyle = st._col;
                ctx.fillRect(x, cy + 2, 3, headerH - 4);

                ctx.font = '13px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.8)';
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText(collapsed ? '▸' : '▾', x + 10, cy + headerH / 2 + 1);
                ctx.font = 'bold 10px sans-serif';
                ctx.fillStyle = '#ffffff';
                ctx.fillText(subLabel(sub), x + 24, cy + headerH / 2);

                // status badge (right)
                var word = statusWord(st.pct, warnPct, critPct);
                var badgeTxt = (st.pct !== null ? word + ' · ' + st.pct.toFixed(1) + '%' : word);
                ctx.font = '8px sans-serif';
                var btw = ctx.measureText(badgeTxt).width + 14;
                roundRect(ctx, x + w - btw - 6, cy + 4, btw, headerH - 8, (headerH - 8) / 2);
                ctx.fillStyle = rgbaStr(st._col, 0.18); ctx.fill();
                ctx.fillStyle = st._col;
                ctx.textAlign = 'center';
                ctx.fillText(badgeTxt, x + w - btw - 6 + btw / 2, cy + headerH / 2);
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

                this._headerRects.push({ sub: sub, x: x, y: cy, w: w, h: headerH });
                cy += headerH + gap;

                if (!collapsed) {
                    var bodyH = sumW > 0 ? bodyAvail * (weight(sec) / sumW) : 0;
                    this._drawSectionBody(ctx, rows, sec, x, cy, w, bodyH, vis[si].idx, warnPct, critPct, scheme, pal);
                    cy += bodyH + gap;
                }
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
                for (i = 0; i < charts.length; i++) {
                    var cyy = cy + i * (ch + gap);
                    if (charts[i].kind === 'pair') {
                        pairChart(ctx, rows, charts[i].d.sp, charts[i].d.act, charts[i].d.name,
                            x, cyy, w, ch, accent, pal, warnPct, critPct);
                    } else {
                        outChart(ctx, rows, charts[i].d.field, charts[i].d.name, x, cyy, w, ch, accent);
                    }
                }
            }
        },

        _drawModelPanel: function(ctx, rows, schema, statusBySub, x, y, w, h, warnPct, critPct, scheme, pal, partMap) {
            ctx.font = 'bold 10px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.fillText('Pod model', x, y);
            ctx.font = '8px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.textAlign = 'right';
            ctx.fillText('drag to orbit · click a part to toggle its graphs', x + w, y + 1);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

            var modelTop = y + 16;
            var modelH = h * 0.6;
            this._modelRect = { x: x, y: modelTop, w: w, h: modelH };

            // status colour passed to model via statusBySub[sub]._col, wrapped so the
            // drawModel depth-sort can read it.
            var wrapped = {};
            for (var k in statusBySub) {
                if (statusBySub.hasOwnProperty(k)) wrapped[k] = { _col: statusBySub[k]._col };
            }
            drawModel(ctx, x, modelTop, w, modelH, schema, wrapped, this._yaw, this._pitch, pal, partMap, this._hotspots, scheme);

            // parameter selection list (bottom right)
            var listY = modelTop + modelH + 10;
            var listH = y + h - listY;
            if (listH < 30) { this._listRect = null; this._listRects = []; return; }
            this._drawParamList(ctx, schema, statusBySub, x, listY, w, listH, scheme, pal);
        },

        // Scrollable checklist of every parameter; click toggles graphing.
        _drawParamList: function(ctx, schema, statusBySub, x, y, w, h, scheme, pal) {
            this._listRects = [];
            var self = this;

            // count selected / total
            var total = 0, selCount = 0, si, items, k;
            for (si = 0; si < schema.length; si++) {
                items = secItems(schema[si]);
                for (k = 0; k < items.length; k++) { total++; if (self._selected[items[k].id]) selCount++; }
            }

            // header
            ctx.font = 'bold 10px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.fillText('Parameters', x, y);
            ctx.font = '8px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.textAlign = 'right';
            ctx.fillText(selCount + ' / ' + total + ' shown', x + w, y + 1);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

            var innerY = y + 16;
            var innerH = h - 16;
            this._listRect = { x: x, y: innerY, w: w, h: innerH };

            // panel bg
            roundRect(ctx, x, innerY, w, innerH, 6);
            ctx.fillStyle = 'rgba(255,255,255,0.03)';
            ctx.fill();

            var groupH = 16, rowH = 15, pad = 6;
            // total content height
            var contentH = 0, gi;
            for (gi = 0; gi < schema.length; gi++) contentH += groupH + secItems(schema[gi]).length * rowH;
            contentH += pad;
            this._listMaxScroll = Math.max(0, contentH - innerH + pad);
            if (this._listScroll > this._listMaxScroll) this._listScroll = this._listMaxScroll;

            ctx.save();
            roundRect(ctx, x, innerY, w, innerH, 6);
            ctx.clip();

            var cyc = innerY + pad - this._listScroll;
            for (si = 0; si < schema.length; si++) {
                var sec = schema[si], sub = sec.sub;
                var accent = subAccent(sub, si, scheme);
                // group label
                if (cyc + groupH > innerY && cyc < innerY + innerH) {
                    ctx.font = 'bold 9px sans-serif';
                    ctx.fillStyle = statusBySub[sub] ? statusBySub[sub]._col : accent;
                    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                    ctx.fillText(subLabel(sub).toUpperCase(), x + pad, cyc + groupH / 2);
                }
                cyc += groupH;

                items = secItems(sec);
                for (k = 0; k < items.length; k++) {
                    var it = items[k], on = !!self._selected[it.id];
                    if (cyc + rowH > innerY && cyc < innerY + innerH) {
                        // toggle glyph
                        ctx.font = '11px sans-serif';
                        ctx.fillStyle = on ? accent : 'rgba(255,255,255,0.25)';
                        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                        ctx.fillText(on ? '◉' : '○', x + pad + 6, cyc + rowH / 2);
                        // name
                        ctx.font = '9px sans-serif';
                        ctx.fillStyle = on ? '#ffffff' : 'rgba(255,255,255,0.45)';
                        ctx.fillText(it.name, x + pad + 22, cyc + rowH / 2);
                        // role tag
                        ctx.font = '7px monospace';
                        ctx.fillStyle = 'rgba(255,255,255,0.3)';
                        ctx.textAlign = 'right';
                        ctx.fillText(it.kind, x + w - pad, cyc + rowH / 2);
                        ctx.textAlign = 'left';
                        this._listRects.push({ id: it.id, x: x, y: cyc, w: w, h: rowH });
                    }
                    cyc += rowH;
                }
            }
            ctx.restore();
            ctx.textBaseline = 'alphabetic';

            // scrollbar
            if (this._listMaxScroll > 0) {
                var trackH = innerH - 4;
                var thumbH = Math.max(16, trackH * (innerH / contentH));
                var thumbY = innerY + 2 + (trackH - thumbH) * (this._listScroll / this._listMaxScroll);
                ctx.fillStyle = 'rgba(255,255,255,0.18)';
                roundRect(ctx, x + w - 4, thumbY, 2.5, thumbH, 1.25);
                ctx.fill();
            }
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
            this.el.removeEventListener('mousedown', this._onDown);
            this.el.removeEventListener('mousemove', this._onMove);
            this.el.removeEventListener('mouseup', this._onUp);
            this.el.removeEventListener('mouseleave', this._onUp);
            this.el.removeEventListener('wheel', this._onWheel);
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
