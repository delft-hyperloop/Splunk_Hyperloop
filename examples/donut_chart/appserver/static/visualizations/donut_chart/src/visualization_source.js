/*
 * Donut Chart — Splunk Custom Visualization
 *
 * Renders search results as a proportional donut chart with a
 * configurable center label. Supports legend, glow, and colour palettes.
 *
 * Expected SPL columns: label (string), value (numeric)
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function(SplunkVisualizationBase, SplunkVisualizationUtils) {

    // ── Palettes ────────────────────────────────────────────────────
    var PALETTES = {
        splunk:  ['#6C5CE7','#00B4D8','#F4A261','#2EC4B6','#E63946','#A8DADC','#457B9D','#52B788'],
        vibrant: ['#FF006E','#FB5607','#FFBE0B','#8338EC','#3A86FF','#06D6A0','#EF476F','#FFD166'],
        pastel:  ['#B5C0EA','#9DD9EC','#F7C59F','#A8D5BA','#F4ACB7','#C9B1FF','#BFD3C1','#FFD6A5']
    };

    var TWO_PI  = Math.PI * 2;
    var HALF_PI = Math.PI / 2;
    var GAP_RAD = (2 * Math.PI) / 180; // 2-degree inter-segment gap

    // ── Pure helper functions (no `this`) ───────────────────────────

    function formatNumber(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n % 1 === 0 ? String(n) : n.toFixed(2);
    }

    function drawSegment(ctx, cx, cy, outerR, innerR, startAngle, endAngle, color, glow) {
        ctx.beginPath();
        ctx.arc(cx, cy, outerR, startAngle, endAngle);
        ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
        ctx.closePath();
        if (glow) {
            ctx.shadowColor = color;
            ctx.shadowBlur  = 14;
        }
        ctx.fillStyle = color;
        ctx.fill();
        if (glow) {
            ctx.shadowBlur  = 0;
            ctx.shadowColor = 'transparent';
        }
    }

    function fitText(ctx, text, maxW, maxSize, minSize) {
        var size = maxSize;
        ctx.font = 'bold ' + size + 'px monospace';
        while (ctx.measureText(text).width > maxW && size > minSize) {
            size -= 1;
            ctx.font = 'bold ' + size + 'px monospace';
        }
        return size;
    }

    function truncateLabel(ctx, text, maxW) {
        if (ctx.measureText(text).width <= maxW) return text;
        var t = text;
        while (t.length > 1 && ctx.measureText(t + '…').width > maxW) {
            t = t.slice(0, -1);
        }
        return t + '…';
    }

    // ── Visualization class ─────────────────────────────────────────

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('donut-chart-viz');
            this.canvas = document.createElement('canvas');
            this.canvas.style.width   = '100%';
            this.canvas.style.height  = '100%';
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
                throw new SplunkVisualizationBase.VisualizationError(
                    'Awaiting data — Donut Chart'
                );
            }

            var fields = data.fields;
            var colIdx = {};
            for (var i = 0; i < fields.length; i++) {
                colIdx[fields[i].name] = i;
            }

            // _status sentinel from appendpipe no-data pattern
            if (colIdx._status !== undefined) {
                var statusRow = data.rows[data.rows.length - 1];
                var statusVal = statusRow[colIdx._status];
                if (statusVal) return { _status: statusVal };
            }

            if (colIdx.label === undefined) {
                if (this._lastGoodData) return this._lastGoodData;
                throw new SplunkVisualizationBase.VisualizationError(
                    'Missing required column: label'
                );
            }
            if (colIdx.value === undefined) {
                if (this._lastGoodData) return this._lastGoodData;
                throw new SplunkVisualizationBase.VisualizationError(
                    'Missing required column: value'
                );
            }

            var segments = [];
            var total    = 0;
            for (var r = 0; r < data.rows.length; r++) {
                var row = data.rows[r];
                var lbl = row[colIdx.label] || '';
                var val = parseFloat(row[colIdx.value]);
                if (isNaN(val) || val <= 0) continue;
                segments.push({ label: lbl, value: val });
                total += val;
            }

            if (segments.length === 0) {
                if (this._lastGoodData) return this._lastGoodData;
                throw new SplunkVisualizationBase.VisualizationError(
                    'No positive values to display'
                );
            }

            segments.sort(function(a, b) { return b.value - a.value; });

            var result = { segments: segments, total: total };
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

            // ── Read settings (JS defaults MUST match formatter.html defaults) ──
            var ns             = this.getPropertyNamespaceInfo().propertyNamespace;
            var innerRadiusMode = config[ns + 'innerRadius'] || 'medium';
            var showLegend      = (config[ns + 'showLegend']  || 'true')  === 'true';
            var showGlow        = (config[ns + 'showGlow']    || 'true')  === 'true';
            var centerLabel     = config[ns + 'centerLabel']  || '';
            var colorScheme     = config[ns + 'colorScheme']  || 'splunk';

            var innerRatios = { thin: 0.40, medium: 0.60, thick: 0.75 };
            var innerRatio  = innerRatios[innerRadiusMode] !== undefined
                              ? innerRatios[innerRadiusMode] : 0.60;
            var palette     = PALETTES[colorScheme] || PALETTES.splunk;

            // ── Size canvas for HiDPI ──
            var el   = this.el;
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

            var segments = data.segments;
            var total    = data.total;
            var numSegs  = segments.length;

            // ── Legend height reservation ──
            var lineH   = 0;
            var legendH = 0;
            if (showLegend) {
                lineH   = Math.max(13, Math.min(20, h * 0.048));
                legendH = Math.min(numSegs * lineH + lineH * 0.6, h * 0.35);
            }

            // ── Donut geometry ──
            var donutH  = h - legendH;
            var pad     = Math.min(w, donutH) * 0.07;
            var cx      = w / 2;
            var cy      = donutH / 2;
            var outerR  = Math.min(w / 2, donutH / 2) - pad;
            if (outerR < 6) return;
            var innerR  = outerR * innerRatio;

            // ── Draw segments ──
            var totalGap = numSegs > 1 ? GAP_RAD * numSegs : 0;
            var availArc = TWO_PI - totalGap;
            var angle    = -HALF_PI;

            for (var i = 0; i < numSegs; i++) {
                var seg     = segments[i];
                var arcSize = (seg.value / total) * availArc;
                var color   = palette[i % palette.length];
                drawSegment(ctx, cx, cy, outerR, innerR, angle, angle + arcSize, color, showGlow);
                angle += arcSize + (numSegs > 1 ? GAP_RAD : 0);
            }

            // ── Inner circle (subtle dark backdrop for center text) ──
            ctx.beginPath();
            ctx.arc(cx, cy, innerR - 1, 0, TWO_PI);
            ctx.fillStyle = 'rgba(0,0,0,0.20)';
            ctx.fill();

            // ── Center text ──
            var centerText    = centerLabel || formatNumber(total);
            var centerSub     = centerLabel ? '' : 'Total';
            var maxCenterW    = innerR * 1.55;
            var valSize       = fitText(ctx, centerText, maxCenterW,
                                        Math.min(48, Math.round(innerR * 0.48)), 8);

            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle    = '#ffffff';

            if (centerSub) {
                ctx.fillText(centerText, cx, cy - valSize * 0.28);
                var subSize = Math.max(8, Math.round(valSize * 0.44));
                ctx.font      = subSize + 'px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.55)';
                ctx.fillText(centerSub, cx, cy + valSize * 0.60);
            } else {
                ctx.fillText(centerText, cx, cy);
            }

            // Reset shadow state
            ctx.shadowBlur  = 0;
            ctx.shadowColor = 'transparent';

            // ── Legend ──
            if (showLegend && legendH > 0 && lineH > 0) {
                var visRows   = Math.floor(legendH / lineH);
                var shown     = Math.min(visRows, numSegs);
                var cols      = (shown > 6 && w > 300) ? 2 : 1;
                var colW      = w / cols;
                var legendTop = donutH + lineH * 0.4;
                var dotR      = lineH * 0.32;
                var lblSize   = Math.round(lineH * 0.66);

                ctx.font = lblSize + 'px sans-serif';

                for (var j = 0; j < shown; j++) {
                    var col  = j % cols;
                    var row2 = Math.floor(j / cols);
                    var lx   = col * colW + colW * 0.04;
                    var ly   = legendTop + row2 * lineH + lineH * 0.5;
                    var c2   = palette[j % palette.length];

                    ctx.beginPath();
                    ctx.arc(lx + dotR, ly, dotR, 0, TWO_PI);
                    ctx.fillStyle = c2;
                    ctx.fill();

                    var availW = colW * 0.88 - dotR * 2 - 6;
                    var lbl2   = truncateLabel(ctx, segments[j].label, availW);
                    ctx.fillStyle    = 'rgba(255,255,255,0.82)';
                    ctx.textAlign    = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(lbl2, lx + dotR * 2 + 6, ly);
                }
            }

            ctx.textAlign    = 'start';
            ctx.textBaseline = 'alphabetic';
        },

        _ensureCanvas: function() {
            if (!this.canvas) {
                this.el.innerHTML = '';
                this.canvas = document.createElement('canvas');
                this.canvas.style.width   = '100%';
                this.canvas.style.height  = '100%';
                this.canvas.style.display = 'block';
                this.el.appendChild(this.canvas);
            }
            var rect = this.el.getBoundingClientRect();
            var dpr  = window.devicePixelRatio || 1;
            this.canvas.width  = rect.width  * dpr;
            this.canvas.height = rect.height * dpr;
        },

        _drawStatusMessage: function(message) {
            var rect = this.el.getBoundingClientRect();
            var dpr  = window.devicePixelRatio || 1;
            var ctx  = this.canvas.getContext('2d');
            if (!ctx) return;
            if (rect.width <= 0 || rect.height <= 0) return;
            ctx.scale(dpr, dpr);
            var w = rect.width;
            var h = rect.height;
            ctx.clearRect(0, 0, w, h);

            var maxTextW  = w * 0.85;
            var fontSize  = Math.max(10, Math.min(32, Math.min(w, h) * 0.09));
            var emojiSize = Math.round(fontSize * 1.6);
            var gap       = fontSize * 0.5;

            ctx.font = '500 ' + fontSize + 'px sans-serif';
            while (ctx.measureText(message).width > maxTextW && fontSize > 8) {
                fontSize  -= 1;
                emojiSize  = Math.round(fontSize * 1.6);
                ctx.font   = '500 ' + fontSize + 'px sans-serif';
            }

            ctx.font         = emojiSize + 'px sans-serif';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle    = 'rgba(255,255,255,1)';
            ctx.fillText('⏳', w / 2, h / 2 - fontSize * 0.5 - gap);

            ctx.font      = '500 ' + fontSize + 'px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.30)';
            ctx.fillText(message, w / 2, h / 2 + emojiSize * 0.3);

            ctx.textAlign    = 'start';
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
