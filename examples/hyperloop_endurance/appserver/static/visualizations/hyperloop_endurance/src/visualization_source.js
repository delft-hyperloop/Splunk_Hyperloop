/*
 * Hyperloop Endurance — Splunk Custom Visualization
 *
 * Endurance / performance telemetry monitor for the Delft Hyperloop DH-X.
 * All signals shown as historical time-series in three columns:
 *   Col 1) Run dynamics — speed + distance line charts
 *   Col 2) Battery — HV / LV voltage, current, power line charts
 *   Col 3) Thermal — HEMS / EMS / MOTOR temperature ribbons over time
 *
 * Expected SPL columns: _time, speed, position,
 *   hv_soc, hv_voltage, hv_current, hv_power,
 *   lv_soc, lv_voltage, lv_current, lv_power,
 *   hems_vf1..hems_lb2, ems_vf1..ems_lb2,
 *   motor_l1..motor_l8, motor_r1..motor_r8
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    // ── Colour helpers ──────────────────────────────────────────────

    function hexToRgb(hex) {
        return [
            parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16)
        ];
    }

    function lerpRgb(a, b, t) {
        return [
            Math.round(a[0] + (b[0] - a[0]) * t),
            Math.round(a[1] + (b[1] - a[1]) * t),
            Math.round(a[2] + (b[2] - a[2]) * t)
        ];
    }

    function rgbStr(c) {
        return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    }

    function rgbaStr(hex, alpha) {
        var c = hexToRgb(hex);
        return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
    }

    function tempColour(temp, warn, crit, pal) {
        var cold   = hexToRgb(pal.tempCold);
        var teal   = hexToRgb(pal.tempTeal);
        var orange = hexToRgb(pal.tempOrange);
        var hot    = hexToRgb(pal.tempHot);
        if (isNaN(temp)) return 'rgba(255,255,255,0.05)';
        if (temp <= 40) return rgbStr(cold);
        if (temp < warn) return rgbStr(lerpRgb(cold, teal, (temp - 40) / (warn - 40)));
        if (temp < crit) return rgbStr(lerpRgb(teal, orange, (temp - warn) / (crit - warn)));
        return rgbStr(hot);
    }

    // ── Drawing primitives ──────────────────────────────────────────

    function roundRect(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        if (r < 0) r = 0;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    function drawSectionLabel(ctx, label, x, y) {
        ctx.font = 'bold 10px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, x, y);
        ctx.textBaseline = 'alphabetic';
    }

    // Generic time-series line/area chart with auto-scaled Y axis.
    function lineChart(ctx, rows, field, x, y, w, h, accent, label, unit, fill, decimals) {
        // Background
        roundRect(ctx, x, y, w, h, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fill();

        var n = rows.length;
        var minV = Infinity, maxV = -Infinity;
        var i, v;
        for (i = 0; i < n; i++) {
            v = rows[i][field];
            if (isNaN(v)) continue;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        }
        if (minV === Infinity) { minV = 0; maxV = 1; }
        // Pad the range so the line doesn't touch top/bottom edges
        var span = maxV - minV;
        if (span < 1e-6) span = Math.abs(maxV) > 1e-6 ? Math.abs(maxV) * 0.1 : 1;
        var pTop = maxV + span * 0.15;
        var pBot = minV - span * 0.15;
        var range = pTop - pBot;

        // Layout scales with the cell's own height so charts never clip
        // out of small cells (e.g. when a column gains rows).
        var headerH = Math.min(16, Math.max(10, h * 0.22));
        var plotPad = Math.min(3, h * 0.05);
        var plotX = x + plotPad;
        var plotW = w - plotPad * 2;
        var plotY = y + headerH;
        var plotH = h - headerH - plotPad;
        if (plotH < 4) plotH = 4;
        var labelFont = Math.min(9, Math.max(7, headerH * 0.6));
        var valFont = Math.min(11, Math.max(8, headerH * 0.7));

        function px(idx) { return plotX + (n > 1 ? (idx / (n - 1)) * plotW : plotW / 2); }
        function py(val) { return plotY + plotH - ((val - pBot) / range) * plotH; }

        if (n > 1) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, plotY, w, plotH);
            ctx.clip();

            if (fill) {
                ctx.beginPath();
                ctx.moveTo(px(0), plotY + plotH);
                for (i = 0; i < n; i++) {
                    v = rows[i][field];
                    if (isNaN(v)) v = pBot;
                    ctx.lineTo(px(i), py(v));
                }
                ctx.lineTo(px(n - 1), plotY + plotH);
                ctx.closePath();
                ctx.fillStyle = rgbaStr(accent, 0.12);
                ctx.fill();
            }

            ctx.beginPath();
            var started = false;
            for (i = 0; i < n; i++) {
                v = rows[i][field];
                if (isNaN(v)) continue;
                if (!started) { ctx.moveTo(px(i), py(v)); started = true; }
                else ctx.lineTo(px(i), py(v));
            }
            ctx.strokeStyle = accent;
            ctx.lineWidth = 1.4;
            ctx.stroke();
            ctx.restore();
        }

        // Label top-left
        ctx.font = labelFont + 'px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, x + 4, y + 3);

        // Current value top-right
        var cur = rows[n - 1][field];
        if (!isNaN(cur)) {
            ctx.font = 'bold ' + valFont + 'px monospace';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'right';
            ctx.fillText(cur.toFixed(decimals) + ' ' + unit, x + w - 4, y + 2);
        }

        // Y-axis min/max hints — only when there is room to avoid clutter
        if (plotH > 24) {
            ctx.font = '7px monospace';
            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(maxV.toFixed(decimals), plotX, plotY);
            ctx.textBaseline = 'bottom';
            ctx.fillText(minV.toFixed(decimals), plotX, plotY + plotH);
        }

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // Horizontal thermal ribbon: X = time, fill = temperature colour.
    function thermalRibbon(ctx, rows, field, labelTxt, x, y, w, h, labelW, badgeW, warn, crit, pal) {
        var n = rows.length;
        var ribX = x + labelW;
        var ribW = w - labelW - badgeW;

        // Strip background
        roundRect(ctx, ribX, y, ribW, h, 2);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();

        // Coloured segments over time
        if (n > 0) {
            ctx.save();
            roundRect(ctx, ribX, y, ribW, h, 2);
            ctx.clip();
            var segW = ribW / n;
            for (var i = 0; i < n; i++) {
                var t = rows[i][field];
                ctx.fillStyle = tempColour(t, warn, crit, pal);
                ctx.fillRect(ribX + i * segW, y, segW + 0.6, h);
            }
            ctx.restore();
        }

        // Channel label (left rail)
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelTxt, x, y + h / 2);

        // Current temperature badge (right)
        var cur = rows[n - 1][field];
        ctx.font = 'bold 8px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        if (!isNaN(cur)) {
            ctx.fillText(Math.round(cur) + '°', x + w, y + h / 2);
        }

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // Draws a labelled thermal section (a list of ribbons).
    function thermalSection(ctx, rows, labelTxt, fields, labels, x, y, w, h, warn, crit, pal, dividerAfter) {
        drawSectionLabel(ctx, labelTxt, x, y);
        var topPad = 14;
        var gridY = y + topPad;
        var gridH = h - topPad;
        var nStrips = fields.length;
        var gap = 1;
        var stripH = (gridH - gap * (nStrips - 1)) / nStrips;
        var labelW = 34;
        var badgeW = 26;
        for (var i = 0; i < nStrips; i++) {
            var sy = gridY + i * (stripH + gap);
            thermalRibbon(ctx, rows, fields[i], labels[i], x, sy, w, stripH, labelW, badgeW, warn, crit, pal);
            // Optional divider line (e.g. between motor LEFT and RIGHT)
            if (dividerAfter !== undefined && dividerAfter === i) {
                ctx.save();
                ctx.setLineDash([2, 2]);
                ctx.strokeStyle = 'rgba(255,255,255,0.3)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, sy + stripH + gap / 2);
                ctx.lineTo(x + w, sy + stripH + gap / 2);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();
            }
        }
    }

    // ── Palette builder ─────────────────────────────────────────────

    function buildPalette(scheme) {
        if (scheme === 'neon') {
            return {
                green:      '#00FF88',
                purple:     '#B400FF',
                cyan:       '#00FFFF',
                tempCold:   '#3A86FF',
                tempTeal:   '#00FF88',
                tempOrange: '#FF9900',
                tempHot:    '#FF0055'
            };
        }
        return {
            green:      '#2DC653',
            purple:     '#6C5CE7',
            cyan:       '#00B4D8',
            tempCold:   '#3A86FF',
            tempTeal:   '#2EC4B6',
            tempOrange: '#F4A261',
            tempHot:    '#E63946'
        };
    }

    // ── Zone drawing ────────────────────────────────────────────────

    function drawColumnDynamics(ctx, rows, latest, x, y, w, h, trackLen, pal) {
        // Header badges
        var badgeH = 30;
        var bGap = 8;
        var bW = (w - bGap) / 2;

        var spd = latest.speed;
        var pos = latest.position;

        // Speed badge
        roundRect(ctx, x, y, bW, badgeH, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('SPEED', x + bW / 2, y + 4);
        ctx.font = 'bold 13px monospace';
        ctx.fillStyle = pal.green;
        ctx.fillText((isNaN(spd) ? '--' : spd.toFixed(1)) + ' m/s', x + bW / 2, y + 14);

        // Distance badge
        roundRect(ctx, x + bW + bGap, y, bW, badgeH, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText('DISTANCE', x + bW + bGap + bW / 2, y + 4);
        ctx.font = 'bold 13px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText((isNaN(pos) ? '--' : pos.toFixed(1)) + ' m', x + bW + bGap + bW / 2, y + 14);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Charts: speed gets ~55% of remaining, distance ~45%
        var chartsY = y + badgeH + 10;
        var chartsH = h - badgeH - 10;
        var gap = 10;
        var speedH = (chartsH - gap) * 0.55;
        var distH = (chartsH - gap) - speedH;

        lineChart(ctx, rows, 'speed', x, chartsY, w, speedH, pal.green, 'Speed (m/s)', 'm/s', true, 1);
        lineChart(ctx, rows, 'position', x, chartsY + speedH + gap, w, distH, pal.green, 'Distance (m)', 'm', false, 1);
    }

    function drawColumnBattery(ctx, rows, x, y, w, h, pal) {
        drawSectionLabel(ctx, 'Battery', x, y);
        var topPad = 14;
        var gy = y + topPad;
        var gh = h - topPad;

        var subGap = 10;
        var subW = (w - subGap) / 2;
        var hvX = x;
        var lvX = x + subW + subGap;

        // Sub-column headers
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = pal.purple;
        ctx.fillText('HV', hvX, gy);
        ctx.fillStyle = pal.cyan;
        ctx.fillText('LV', lvX, gy);
        ctx.textBaseline = 'alphabetic';

        var rowsY = gy + 12;
        var rowsH = gh - 12;
        var rGap = 8;
        var cellH = (rowsH - rGap * 3) / 4;

        // HV: SoC, voltage, current, power
        lineChart(ctx, rows, 'hv_soc', hvX, rowsY, subW, cellH, pal.purple, 'SoC (%)', '%', true, 1);
        lineChart(ctx, rows, 'hv_voltage', hvX, rowsY + (cellH + rGap), subW, cellH, pal.purple, 'Voltage (V)', 'V', false, 1);
        lineChart(ctx, rows, 'hv_current', hvX, rowsY + (cellH + rGap) * 2, subW, cellH, pal.purple, 'Current (A)', 'A', false, 1);
        lineChart(ctx, rows, 'hv_power', hvX, rowsY + (cellH + rGap) * 3, subW, cellH, pal.purple, 'Power (kW)', 'kW', true, 1);

        // LV: SoC, voltage, current, power
        lineChart(ctx, rows, 'lv_soc', lvX, rowsY, subW, cellH, pal.cyan, 'SoC (%)', '%', true, 1);
        lineChart(ctx, rows, 'lv_voltage', lvX, rowsY + (cellH + rGap), subW, cellH, pal.cyan, 'Voltage (V)', 'V', false, 2);
        lineChart(ctx, rows, 'lv_current', lvX, rowsY + (cellH + rGap) * 2, subW, cellH, pal.cyan, 'Current (A)', 'A', false, 1);
        lineChart(ctx, rows, 'lv_power', lvX, rowsY + (cellH + rGap) * 3, subW, cellH, pal.cyan, 'Power (W)', 'W', true, 0);
    }

    function drawColumnThermal(ctx, rows, x, y, w, h, warnHems, critHems, warnMotor, critMotor, pal) {
        var hemsFields = ['hems_vf1','hems_vf2','hems_vb1','hems_vb2','hems_lf1','hems_lf2','hems_lb1','hems_lb2'];
        var hemsLabels = ['VF1','VF2','VB1','VB2','LF1','LF2','LB1','LB2'];
        var emsFields  = ['ems_vf1','ems_vf2','ems_vb1','ems_vb2','ems_lf1','ems_lf2','ems_lb1','ems_lb2'];
        var emsLabels  = ['VF1','VF2','VB1','VB2','LF1','LF2','LB1','LB2'];
        var motorFields = ['motor_l1','motor_l2','motor_l3','motor_l4','motor_l5','motor_l6','motor_l7','motor_l8',
                           'motor_r1','motor_r2','motor_r3','motor_r4','motor_r5','motor_r6','motor_r7','motor_r8'];
        var motorLabels = ['ML1','ML2','ML3','ML4','ML5','ML6','ML7','ML8',
                           'MR1','MR2','MR3','MR4','MR5','MR6','MR7','MR8'];

        // Heights proportional to strip counts (8 + 8 + 16 = 32) plus per-section label padding.
        var secGap = 8;
        var labelOverhead = 14;
        var usable = h - secGap * 2 - labelOverhead * 3;
        var unit = usable / 32;
        var hemsH = unit * 8 + labelOverhead;
        var emsH = unit * 8 + labelOverhead;
        var motorH = unit * 16 + labelOverhead;

        var cy = y;
        thermalSection(ctx, rows, 'HEMS', hemsFields, hemsLabels, x, cy, w, hemsH, warnHems, critHems, pal);
        cy += hemsH + secGap;
        thermalSection(ctx, rows, 'EMS', emsFields, emsLabels, x, cy, w, emsH, warnHems, critHems, pal);
        cy += emsH + secGap;
        thermalSection(ctx, rows, 'MOTOR', motorFields, motorLabels, x, cy, w, motorH, warnMotor, critMotor, pal, 7);
    }

    // ── Visualization Class ─────────────────────────────────────────

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('hyperloop-endurance-viz');

            this.canvas = document.createElement('canvas');
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.canvas.style.display = 'block';
            this.el.appendChild(this.canvas);

            this._lastGoodData = null;
        },

        getInitialDataParams: function() {
            return {
                outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE,
                count: 10000
            };
        },

        formatData: function(data, config) {
            if (!data || !data.rows || data.rows.length === 0) {
                if (this._lastGoodData) return this._lastGoodData;
                return { _status: 'Awaiting endurance telemetry' };
            }

            var fields = data.fields;
            var colIdx = {};
            for (var i = 0; i < fields.length; i++) {
                colIdx[fields[i].name] = i;
            }

            var required = ['speed', 'position', 'hv_voltage', 'lv_voltage', 'hems_vf1', 'motor_l1'];
            for (var r = 0; r < required.length; r++) {
                if (colIdx[required[r]] === undefined) {
                    if (this._lastGoodData) return this._lastGoodData;
                    throw new SplunkVisualizationBase.VisualizationError(
                        'Missing required column: ' + required[r]
                    );
                }
            }

            var parsed = [];
            for (var row = 0; row < data.rows.length; row++) {
                var r2 = data.rows[row];
                var obj = {};
                for (var f = 0; f < fields.length; f++) {
                    var fname = fields[f].name;
                    if (fname === '_time') {
                        obj._time = parseFloat(r2[f]) || 0;
                    } else {
                        obj[fname] = parseFloat(r2[f]);
                    }
                }
                parsed.push(obj);
            }
            parsed.sort(function(a, b) { return a._time - b._time; });

            var result = { rows: parsed, numRows: parsed.length };
            this._lastGoodData = result;
            return result;
        },

        updateView: function(data, config) {
            if (data && data._status) {
                this._ensureCanvas();
                this._drawStatusMessage(data._status);
                return;
            }

            if (!data) {
                if (this._lastGoodData) { data = this._lastGoodData; }
                else { return; }
            }

            var ns = this.getPropertyNamespaceInfo().propertyNamespace;
            var trackLen     = parseFloat(config[ns + 'trackLength'])   || 100;
            var tempWarnHems = parseFloat(config[ns + 'tempWarnHems'])  || 70;
            var tempCritHems = parseFloat(config[ns + 'tempCritHems'])  || 90;
            var tempWarnMot  = parseFloat(config[ns + 'tempWarnMotor']) || 100;
            var tempCritMot  = parseFloat(config[ns + 'tempCritMotor']) || 130;
            var scheme       = config[ns + 'colorScheme'] || 'dark';

            var pal = buildPalette(scheme);

            var el = this.el;
            var rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;

            var dpr = window.devicePixelRatio || 1;
            this.canvas.width  = rect.width  * dpr;
            this.canvas.height = rect.height * dpr;
            var ctx = this.canvas.getContext('2d');
            if (!ctx) return;
            ctx.scale(dpr, dpr);

            var w = rect.width;
            var h = rect.height;
            ctx.clearRect(0, 0, w, h);

            var rows = data.rows;
            var latest = rows[rows.length - 1];

            var pad = 10;
            var innerX = pad;
            var innerY = pad;
            var innerW = w - pad * 2;
            var innerH = h - pad * 2;

            var colGap = 12;
            var col1W = innerW * 0.30;
            var col2W = innerW * 0.28;
            var col3W = innerW - col1W - col2W - colGap * 2;

            var col1X = innerX;
            var col2X = innerX + col1W + colGap;
            var col3X = col2X + col2W + colGap;

            drawColumnDynamics(ctx, rows, latest, col1X, innerY, col1W, innerH, trackLen, pal);

            // Column dividers
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(col2X - colGap / 2, innerY);
            ctx.lineTo(col2X - colGap / 2, innerY + innerH);
            ctx.moveTo(col3X - colGap / 2, innerY);
            ctx.lineTo(col3X - colGap / 2, innerY + innerH);
            ctx.stroke();

            drawColumnBattery(ctx, rows, col2X, innerY, col2W, innerH, pal);
            drawColumnThermal(ctx, rows, col3X, innerY, col3W, innerH,
                tempWarnHems, tempCritHems, tempWarnMot, tempCritMot, pal);
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
            this.canvas.width  = rect.width  * dpr;
            this.canvas.height = rect.height * dpr;
        },

        _drawStatusMessage: function(message) {
            var rect = this.el.getBoundingClientRect();
            var dpr = window.devicePixelRatio || 1;
            var ctx = this.canvas.getContext('2d');
            if (!ctx) return;
            if (rect.width <= 0 || rect.height <= 0) return;
            ctx.scale(dpr, dpr);
            var w = rect.width;
            var h = rect.height;
            ctx.clearRect(0, 0, w, h);

            var maxTextW = w * 0.85;
            var fontSize = Math.max(10, Math.min(32, Math.min(w, h) * 0.09));
            var emojiSize = Math.round(fontSize * 1.6);
            var gap = fontSize * 0.5;

            ctx.font = '500 ' + fontSize + 'px sans-serif';
            while (ctx.measureText(message).width > maxTextW && fontSize > 8) {
                fontSize -= 1;
                emojiSize = Math.round(fontSize * 1.6);
                ctx.font = '500 ' + fontSize + 'px sans-serif';
            }

            ctx.font = emojiSize + 'px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(255,255,255,1)';
            ctx.fillText('⏱', w / 2, h / 2 - fontSize * 0.5 - gap);

            ctx.font = '500 ' + fontSize + 'px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.30)';
            ctx.fillText(message, w / 2, h / 2 + emojiSize * 0.3);

            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';
        },

        reflow: function() {
            this.invalidateUpdateView();
        },

        destroy: function() {
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
