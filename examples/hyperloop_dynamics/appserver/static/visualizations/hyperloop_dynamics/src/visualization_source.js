/*
 * Hyperloop Dynamics — Splunk Custom Visualization
 *
 * Full-panel telemetry monitor for the Delft Hyperloop DH-X prototype.
 * Zones: A) laser sensor sparklines + position/airgap
 *        B) HEMS / EMS / Motor temperature grids
 *        C) HV / LV battery tabs (clickable)
 *
 * Expected SPL columns: _time, vfl, vfr, vml, vmr, vbl, vbr,
 *   lfl, lfr, lml, lmr, lbl, lbr, position, speed, airgap_current,
 *   airgap_target, hems_vf1..hems_lb2, ems_vf1..ems_lb2,
 *   motor_l1..motor_l8, motor_r1..motor_r8,
 *   hv_soc, hv_power, lv_soc, lv_power
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    // ── Colour helpers ──────────────────────────────────────────────

    function hexToRgb(hex) {
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        return [r, g, b];
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

    function tempColour(temp, warn, crit, pal) {
        var cold  = hexToRgb(pal.tempCold);
        var teal  = hexToRgb(pal.tempTeal);
        var orange = hexToRgb(pal.tempOrange);
        var hot   = hexToRgb(pal.tempHot);
        if (temp <= 40) return rgbStr(cold);
        if (temp < warn) return rgbStr(lerpRgb(cold, teal, (temp - 40) / (warn - 40)));
        if (temp < crit) return rgbStr(lerpRgb(teal, orange, (temp - warn) / (crit - warn)));
        return rgbStr(hot);
    }

    // ── Drawing primitives ──────────────────────────────────────────

    function roundRect(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
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

    function drawSparkline(ctx, rows, field, x, y, w, h, accentCol, offsetRange, label, currentVal) {
        // Background
        roundRect(ctx, x, y, w, h, 3);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();

        // Zero line
        var midY = y + h / 2;
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x + 2, midY);
        ctx.lineTo(x + w - 2, midY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Polyline
        var n = rows.length;
        if (n > 1) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();
            ctx.strokeStyle = accentCol;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            for (var i = 0; i < n; i++) {
                var px = x + (i / (n - 1)) * w;
                var raw = rows[i][field] || 0;
                var py = midY - (raw / offsetRange) * (h / 2 - 2);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
            ctx.restore();
        }

        // Sensor label top-left
        ctx.font = 'bold 8px sans-serif';
        ctx.fillStyle = accentCol;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, x + 3, y + 2);

        // Current value bottom-right
        ctx.font = '8px monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText((currentVal >= 0 ? '+' : '') + currentVal.toFixed(1), x + w - 3, y + h - 2);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    function drawTempCell(ctx, x, y, w, h, label, temp, warn, crit, pal) {
        var col = tempColour(temp, warn, crit, pal);
        roundRect(ctx, x, y, w, h, 3);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.font = '7px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + w / 2, y + h * 0.36);
        ctx.font = 'bold 8px monospace';
        ctx.fillText(Math.round(temp) + '°', x + w / 2, y + h * 0.68);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    function drawSectionLabel(ctx, label, x, y, w) {
        ctx.font = 'bold 9px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, x + 4, y + 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    function drawDivider(ctx, x, y, h, col) {
        ctx.strokeStyle = col || 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + h);
        ctx.stroke();
    }

    // ── Zone A helpers ──────────────────────────────────────────────

    function drawZoneA(ctx, rows, latest, x, y, w, h, offsetRange, trackLen, airgapMin, airgapMax, pal) {
        var gridW = w * 0.75;
        var rightW = w - gridW;
        var rightX = x + gridW;

        // Faint separator
        drawDivider(ctx, rightX, y, h, 'rgba(255,255,255,0.1)');

        // ── Sensor grid ──────────────────────────────────────────
        var axisLabelW = 12;
        var headerH = 14;
        var gridInnerX = x + axisLabelW;
        var gridInnerW = gridW - axisLabelW - 4;
        var gridInnerH = h - headerH;
        var rowH = gridInnerH / 2;
        var colW = gridInnerW / 6;

        var vSensors = ['vfl','vfr','vml','vmr','vbl','vbr'];
        var lSensors = ['lfl','lfr','lml','lmr','lbl','lbr'];
        var vLabels  = ['VFL','VFR','VML','VMR','VBL','VBR'];
        var lLabels  = ['LFL','LFR','LML','LMR','LBL','LBR'];
        var groups   = ['FRONT','MIDDLE','BACK'];

        // Group headers
        ctx.font = 'bold 8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (var g = 0; g < 3; g++) {
            var gx = gridInnerX + (g * 2 + 1) * colW;
            ctx.fillText(groups[g], gx, y + headerH / 2);
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Dashed dividers between groups
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 0.5;
        for (var d = 1; d <= 2; d++) {
            var dx = gridInnerX + d * 2 * colW;
            ctx.beginPath();
            ctx.moveTo(dx, y + headerH);
            ctx.lineTo(dx, y + h);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();

        // Row axis labels
        ctx.font = 'bold 8px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillStyle = pal.purple;
        ctx.fillText('V', x + axisLabelW / 2, y + headerH + rowH / 2);
        ctx.fillStyle = pal.cyan;
        ctx.fillText('L', x + axisLabelW / 2, y + headerH + rowH + rowH / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Sparkline cells
        var pad = 2;
        for (var i = 0; i < 6; i++) {
            var cx2 = gridInnerX + i * colW + pad;
            var cw2 = colW - pad * 2;
            // V row
            drawSparkline(ctx, rows, vSensors[i],
                cx2, y + headerH + pad, cw2, rowH - pad * 2,
                pal.purple, offsetRange, vLabels[i],
                latest[vSensors[i]] || 0);
            // L row
            drawSparkline(ctx, rows, lSensors[i],
                cx2, y + headerH + rowH + pad, cw2, rowH - pad * 2,
                pal.cyan, offsetRange, lLabels[i],
                latest[lSensors[i]] || 0);
        }

        // ── Right panel: position + airgap ───────────────────────
        var rPad = 8;
        var rX = rightX + rPad;
        var rW = rightW - rPad * 2;
        var posH = h * 0.5;
        var agH = h - posH;

        // Position
        var pos = latest.position || 0;
        var spd = latest.speed || 0;
        var trackFrac = Math.min(1, Math.max(0, pos / trackLen));

        ctx.font = 'bold 22px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pos.toFixed(1) + ' m', rX + rW / 2, y + posH * 0.32);

        ctx.font = '10px monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(spd.toFixed(1) + ' m/s', rX + rW / 2, y + posH * 0.55);

        // Track bar
        var barY = y + posH * 0.72;
        var barH2 = 6;
        roundRect(ctx, rX, barY, rW, barH2, 3);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fill();
        var dotR = 5;
        var dotX = rX + trackFrac * rW;
        ctx.beginPath();
        ctx.arc(dotX, barY + barH2 / 2, dotR, 0, Math.PI * 2);
        ctx.fillStyle = pal.purple;
        ctx.fill();

        ctx.font = '7px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.textAlign = 'left';
        ctx.fillText('0', rX, barY + barH2 + 9);
        ctx.textAlign = 'right';
        ctx.fillText(trackLen + 'm', rX + rW, barY + barH2 + 9);

        // Airgap
        var agY = y + posH + 10;
        var agCur = latest.airgap_current || 0;
        var agTgt = latest.airgap_target || 0;
        var agRange = Math.max(1, airgapMax - airgapMin);
        var labelW2 = 36;
        var valW = 34;
        var barAreaW = rW - labelW2 - valW;
        var barThick = 9;
        var agBarGap = 14;

        // TARGET bar
        var tgtFrac = Math.min(1, Math.max(0, (agTgt - airgapMin) / agRange));
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('TARGET', rX, agY + barThick / 2);
        roundRect(ctx, rX + labelW2, agY, barAreaW, barThick, 2);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fill();
        roundRect(ctx, rX + labelW2, agY, barAreaW * tgtFrac, barThick, 2);
        ctx.fillStyle = pal.cyan;
        ctx.fill();
        ctx.font = '8px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(agTgt.toFixed(1), rX + rW, agY + barThick / 2);

        // CURRENT bar
        var curFrac = Math.min(1, Math.max(0, (agCur - airgapMin) / agRange));
        var dev = Math.abs(agCur - agTgt);
        var curCol = dev < 0.5 ? pal.tempTeal : dev < 1.5 ? pal.tempOrange : pal.tempHot;
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('CURRENT', rX, agY + agBarGap + barThick / 2);
        roundRect(ctx, rX + labelW2, agY + agBarGap, barAreaW, barThick, 2);
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fill();
        roundRect(ctx, rX + labelW2, agY + agBarGap, barAreaW * curFrac, barThick, 2);
        ctx.fillStyle = curCol;
        ctx.fill();
        ctx.font = '8px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(agCur.toFixed(1), rX + rW, agY + agBarGap + barThick / 2);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // ── Zone B helpers ──────────────────────────────────────────────

    function draw4x2Grid(ctx, x, y, w, h, labels, values, warn, crit, pal) {
        var pad = 2;
        var cw = (w - pad * 5) / 4;
        var ch = (h - pad * 3) / 2;
        for (var row = 0; row < 2; row++) {
            for (var col = 0; col < 4; col++) {
                var idx = row * 4 + col;
                var cx3 = x + pad + col * (cw + pad);
                var cy3 = y + pad + row * (ch + pad);
                drawTempCell(ctx, cx3, cy3, cw, ch, labels[idx], values[idx] || 0, warn, crit, pal);
            }
        }
    }

    function drawZoneB(ctx, latest, x, y, w, h, warnHems, critHems, warnMotor, critMotor, pal) {
        var hemsW  = w * 0.28;
        var emsW   = w * 0.28;
        var motorW = w - hemsW - emsW;
        var labelH = 14;
        var gridH  = h - labelH;

        // HEMS
        drawSectionLabel(ctx, 'HEMS', x, y, hemsW);
        var hemsLabels = ['VF1','VF2','VB1','VB2','LF1','LF2','LB1','LB2'];
        var hemsFields = ['hems_vf1','hems_vf2','hems_vb1','hems_vb2','hems_lf1','hems_lf2','hems_lb1','hems_lb2'];
        var hemsVals = [];
        for (var i = 0; i < 8; i++) hemsVals.push(latest[hemsFields[i]] || 0);
        draw4x2Grid(ctx, x, y + labelH, hemsW, gridH, hemsLabels, hemsVals, warnHems, critHems, pal);
        drawDivider(ctx, x + hemsW, y, h);

        // EMS
        var emsX = x + hemsW;
        drawSectionLabel(ctx, 'EMS', emsX, y, emsW);
        var emsLabels = ['VF1','VF2','VB1','VB2','LF1','LF2','LB1','LB2'];
        var emsFields = ['ems_vf1','ems_vf2','ems_vb1','ems_vb2','ems_lf1','ems_lf2','ems_lb1','ems_lb2'];
        var emsVals = [];
        for (var j = 0; j < 8; j++) emsVals.push(latest[emsFields[j]] || 0);
        draw4x2Grid(ctx, emsX, y + labelH, emsW, gridH, emsLabels, emsVals, warnHems, critHems, pal);
        drawDivider(ctx, emsX + emsW, y, h);

        // MOTOR
        var motorX = x + hemsW + emsW;
        drawSectionLabel(ctx, 'MOTOR', motorX, y, motorW);
        var halfMW = motorW / 2;

        // LEFT sub-panel
        var lLabels2 = ['ML1','ML2','ML3','ML4','ML5','ML6','ML7','ML8'];
        var lFields  = ['motor_l1','motor_l2','motor_l3','motor_l4','motor_l5','motor_l6','motor_l7','motor_l8'];
        var lVals = [];
        for (var k = 0; k < 8; k++) lVals.push(latest[lFields[k]] || 0);

        ctx.font = 'bold 7px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('LEFT', motorX + halfMW / 2, y + labelH);
        draw4x2Grid(ctx, motorX, y + labelH + 9, halfMW, gridH - 9, lLabels2, lVals, warnMotor, critMotor, pal);

        // Solid divider between left/right motor
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(motorX + halfMW, y);
        ctx.lineTo(motorX + halfMW, y + h);
        ctx.stroke();

        // RIGHT sub-panel
        var rLabels2 = ['MR1','MR2','MR3','MR4','MR5','MR6','MR7','MR8'];
        var rFields  = ['motor_r1','motor_r2','motor_r3','motor_r4','motor_r5','motor_r6','motor_r7','motor_r8'];
        var rVals = [];
        for (var m = 0; m < 8; m++) rVals.push(latest[rFields[m]] || 0);

        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('RIGHT', motorX + halfMW + halfMW / 2, y + labelH);
        draw4x2Grid(ctx, motorX + halfMW, y + labelH + 9, halfMW, gridH - 9, rLabels2, rVals, warnMotor, critMotor, pal);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    // ── Zone C helpers ──────────────────────────────────────────────

    function drawDonutGauge(ctx, cx, cy, r, soc, pal) {
        var startAngle = (210 / 180) * Math.PI;
        var endAngle   = (330 / 180) * Math.PI;
        // Track
        ctx.beginPath();
        ctx.arc(cx, cy, r, startAngle, endAngle);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        ctx.stroke();
        // Fill
        var fillEnd = startAngle + (soc / 100) * (endAngle - startAngle + Math.PI * 2);
        // 270 degree sweep: end wraps past 0, need modular math
        var sweep = (270 / 180) * Math.PI;
        var fillAngle = startAngle + (soc / 100) * sweep;
        var socCol = soc > 60 ? pal.tempTeal : soc > 20 ? pal.tempOrange : pal.tempHot;
        ctx.beginPath();
        ctx.arc(cx, cy, r, startAngle, fillAngle);
        ctx.strokeStyle = socCol;
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
        // Center text
        ctx.font = 'bold 16px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(Math.round(soc) + '%', cx, cy - 4);
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText('SoC', cx, cy + 10);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    function drawPowerSparkline(ctx, rows, field, x, y, w, h, accentCol, unit) {
        var vals = [];
        for (var i = 0; i < rows.length; i++) {
            vals.push(rows[i][field] || 0);
        }
        var maxV = 0;
        for (var j = 0; j < vals.length; j++) {
            if (vals[j] > maxV) maxV = vals[j];
        }
        maxV = maxV * 1.1 || 1;

        // Background
        roundRect(ctx, x, y, w, h, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fill();

        var n = vals.length;
        if (n > 1) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();

            // Filled area
            ctx.beginPath();
            ctx.moveTo(x, y + h);
            for (var k = 0; k < n; k++) {
                var px = x + (k / (n - 1)) * w;
                var py = y + h - (vals[k] / maxV) * (h - 4);
                if (k === 0) ctx.lineTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.lineTo(x + w, y + h);
            ctx.closePath();
            ctx.fillStyle = accentCol.replace(')', ',0.15)').replace('rgb', 'rgba');
            ctx.fill();

            // Line
            ctx.beginPath();
            for (var l = 0; l < n; l++) {
                var px2 = x + (l / (n - 1)) * w;
                var py2 = y + h - (vals[l] / maxV) * (h - 4);
                if (l === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
            }
            ctx.strokeStyle = accentCol;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
        }

        // Current value top-right
        var curVal = vals[vals.length - 1] || 0;
        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(curVal.toFixed(1) + ' ' + unit, x + w - 4, y + 4);
        ctx.font = '8px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillText('POWER', x + 4, y + 4);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Y axis max label
        ctx.font = '7px monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(maxV.toFixed(0), x + w - 2, y + 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    function drawZoneC(ctx, rows, latest, x, y, w, h, activeTab, tabRects, pal) {
        var tabH = 22;
        var tabW = w / 2;
        var contentY = y + tabH;
        var contentH = h - tabH;

        // Tabs
        var tabs = [
            { id: 'hv', label: 'HV BATTERY', col: pal.purple },
            { id: 'lv', label: 'LV BATTERY', col: pal.cyan }
        ];

        tabRects.length = 0;
        for (var t = 0; t < tabs.length; t++) {
            var tx = x + t * tabW;
            var isActive = (activeTab === tabs[t].id);
            tabRects.push({ x: tx, y: y, w: tabW, h: tabH, id: tabs[t].id });

            ctx.fillStyle = isActive ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.02)';
            roundRect(ctx, tx + 1, y + 1, tabW - 2, tabH - 1, 3);
            ctx.fill();

            if (isActive) {
                ctx.fillStyle = tabs[t].col;
                ctx.fillRect(tx + 1, y + tabH - 2, tabW - 2, 2);
            }

            ctx.font = 'bold 9px sans-serif';
            ctx.fillStyle = isActive ? '#ffffff' : 'rgba(255,255,255,0.35)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(tabs[t].label, tx + tabW / 2, y + tabH / 2);
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Content area
        var donutW = w * 0.35;
        var sparkX = x + donutW + 8;
        var sparkW = w - donutW - 12;
        var sparkH = contentH - 8;
        var donutCX = x + donutW / 2;
        var donutCY = contentY + contentH / 2;
        var donutR = Math.min(donutW / 2, contentH / 2) - 10;

        if (activeTab === 'hv') {
            drawDonutGauge(ctx, donutCX, donutCY, donutR, latest.hv_soc || 0, pal);
            drawPowerSparkline(ctx, rows, 'hv_power', sparkX, contentY + 4, sparkW, sparkH, pal.purple, 'kW');
        } else {
            drawDonutGauge(ctx, donutCX, donutCY, donutR, latest.lv_soc || 0, pal);
            drawPowerSparkline(ctx, rows, 'lv_power', sparkX, contentY + 4, sparkW, sparkH, pal.cyan, 'W');
        }

        // Divider between tab area and above
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.stroke();
    }

    // ── Palette builder ─────────────────────────────────────────────

    function buildPalette(scheme) {
        if (scheme === 'neon') {
            return {
                purple:     '#B400FF',
                cyan:       '#00FFFF',
                tempCold:   '#3A86FF',
                tempTeal:   '#00FF88',
                tempOrange: '#FF9900',
                tempHot:    '#FF0055'
            };
        }
        return {
            purple:     '#6C5CE7',
            cyan:       '#00B4D8',
            tempCold:   '#3A86FF',
            tempTeal:   '#2EC4B6',
            tempOrange: '#F4A261',
            tempHot:    '#E63946'
        };
    }

    // ── Visualization Class ─────────────────────────────────────────

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('hyperloop-dynamics-viz');

            this.canvas = document.createElement('canvas');
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this.canvas.style.display = 'block';
            this.el.appendChild(this.canvas);

            this._lastGoodData = null;
            this._activeTab = 'hv';
            this._tabRects = [];

            var self = this;
            this._clickHandler = function(e) {
                var rect = self.el.getBoundingClientRect();
                var mx = e.clientX - rect.left;
                var my = e.clientY - rect.top;
                for (var i = 0; i < self._tabRects.length; i++) {
                    var r = self._tabRects[i];
                    if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
                        self._activeTab = r.id;
                        self.invalidateUpdateView();
                        break;
                    }
                }
            };
            this.el.addEventListener('click', this._clickHandler);
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
                return { _status: 'Awaiting pod telemetry' };
            }

            var fields = data.fields;
            var colIdx = {};
            for (var i = 0; i < fields.length; i++) {
                colIdx[fields[i].name] = i;
            }

            // Required column check
            var required = ['vfl', 'position', 'airgap_current', 'hems_vf1', 'motor_l1', 'hv_soc'];
            for (var r = 0; r < required.length; r++) {
                if (colIdx[required[r]] === undefined) {
                    if (this._lastGoodData) return this._lastGoodData;
                    throw new SplunkVisualizationBase.VisualizationError(
                        'Missing required column: ' + required[r]
                    );
                }
            }

            // Parse all rows, sort by _time ascending
            var timeIdx = colIdx['_time'];
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
            var offsetRange  = parseFloat(config[ns + 'offsetRange'])  || 15;
            var trackLen     = parseFloat(config[ns + 'trackLength'])   || 100;
            var tempWarnHems = parseFloat(config[ns + 'tempWarnHems'])  || 70;
            var tempCritHems = parseFloat(config[ns + 'tempCritHems'])  || 90;
            var tempWarnMot  = parseFloat(config[ns + 'tempWarnMotor']) || 100;
            var tempCritMot  = parseFloat(config[ns + 'tempCritMotor']) || 130;
            var airgapMin    = parseFloat(config[ns + 'airgapMin'])     || 5;
            var airgapMax    = parseFloat(config[ns + 'airgapMax'])     || 15;
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

            var rows   = data.rows;
            var latest = rows[rows.length - 1];

            var zoneAH = h * 0.42;
            var zoneBH = h * 0.26;
            var zoneCH = h - zoneAH - zoneBH;

            drawZoneA(ctx, rows, latest, 0, 0, w, zoneAH,
                offsetRange, trackLen, airgapMin, airgapMax, pal);

            // Thin separator line between zones
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, zoneAH);
            ctx.lineTo(w, zoneAH);
            ctx.stroke();

            drawZoneB(ctx, latest, 0, zoneAH, w, zoneBH,
                tempWarnHems, tempCritHems, tempWarnMot, tempCritMot, pal);

            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, zoneAH + zoneBH);
            ctx.lineTo(w, zoneAH + zoneBH);
            ctx.stroke();

            drawZoneC(ctx, rows, latest, 0, zoneAH + zoneBH, w, zoneCH,
                this._activeTab, this._tabRects, pal);
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
            if (this._clickHandler) {
                this.el.removeEventListener('click', this._clickHandler);
                this._clickHandler = null;
            }
            SplunkVisualizationBase.prototype.destroy.apply(this, arguments);
        }
    });
});
