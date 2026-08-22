function downsample(points, maxPoints) {
  if (!Array.isArray(points) || !points.length) return [];
  if (!Number.isFinite(maxPoints) || maxPoints < 2 || points.length <= maxPoints) return points;
  const bucketSize = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const start = Math.floor(i * bucketSize);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize));
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    let t = points[start]?.t ?? 0;
    let lost = 0;
    let jitterMs = points[start]?.jitterMs ?? null;
    for (let j = start; j < end; j += 1) {
      const point = points[j];
      t = point.t;
      jitterMs = point.jitterMs ?? jitterMs;
      if (point.lost || point.rttMs == null) {
        lost += 1;
        continue;
      }
      min = Math.min(min, point.rttMs);
      max = Math.max(max, point.rttMs);
      sum += point.rttMs;
      count += 1;
    }
    out.push({
      t,
      rttMs: count ? sum / count : null,
      rttMin: count ? min : null,
      rttMax: count ? max : null,
      jitterMs,
      lost: lost > 0 && count === 0,
      lossInBucket: lost,
    });
  }
  return out;
}

function niceMax(value) {
  if (!value || value <= 0) return 50;
  const padded = value * 1.15;
  const mag = 10 ** Math.floor(Math.log10(padded));
  return Math.ceil(padded / mag) * mag;
}

function formatAxisTime(ts, spanMs) {
  const date = new Date(ts);
  if (spanMs > 12 * 3600_000) {
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: spanMs < 15 * 60_000 ? "2-digit" : undefined });
}

export class DualChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.series = [];
    this.range = null;
    this.highlight = null;
    this.hover = null;
    this.onHover = options.onHover || (() => {});
    this.colors = {
      bg: "#0c1014",
      grid: "rgba(125, 150, 170, 0.14)",
      text: "#7a8a9a",
      rtt: "#3ee0d0",
      jitter: "#f0a030",
      loss: "#e85d5d",
      highlight: "rgba(240, 160, 48, 0.12)",
    };
    this.resize();
    this._onMove = (event) => this._pointer(event);
    this._onLeave = () => {
      this.hover = null;
      this.onHover(null);
      this.draw();
    };
    canvas.addEventListener("mousemove", this._onMove);
    canvas.addEventListener("mouseleave", this._onLeave);
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
  }

  resize() {
    const parent = this.canvas.parentElement || this.canvas;
    const rect = parent.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(320, Math.floor(rect.width) || parent.clientWidth || 320);
    const height = Math.max(280, Math.floor(rect.height) || parent.clientHeight || 360);
    const nextW = Math.floor(width * dpr);
    const nextH = Math.floor(height * dpr);
    if (this.canvas.width !== nextW) this.canvas.width = nextW;
    if (this.canvas.height !== nextH) this.canvas.height = nextH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = width;
    this.height = height;
    this.draw();
  }

  setData({ series, range, highlight }) {
    this.series = series || [];
    this.range = range || null;
    this.highlight = highlight || null;
    this.draw();
  }

  _layout() {
    const pad = { l: 52, r: 18, t: 28, b: 28, gap: 18 };
    const usable = this.height - pad.t - pad.b - pad.gap;
    const rttH = Math.floor(usable * 0.62);
    const jitH = usable - rttH;
    return {
      pad,
      rtt: { x: pad.l, y: pad.t, w: this.width - pad.l - pad.r, h: rttH },
      jit: {
        x: pad.l,
        y: pad.t + rttH + pad.gap,
        w: this.width - pad.l - pad.r,
        h: jitH,
      },
    };
  }

  _xRange() {
    if (this.range) return this.range;
    let min = Infinity;
    let max = -Infinity;
    for (const s of this.series) {
      for (const p of s.points) {
        min = Math.min(min, p.t);
        max = Math.max(max, p.t);
      }
    }
    if (!Number.isFinite(min)) {
      const now = Date.now();
      return { start: now - 60_000, end: now };
    }
    if (min === max) return { start: min - 1000, end: max + 1000 };
    return { start: min, end: max };
  }

  _pointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const layout = this._layout();
    const xr = this._xRange();
    const plot = layout.rtt;
    if (x < plot.x || x > plot.x + plot.w) {
      this.hover = null;
      this.onHover(null);
      this.draw();
      return;
    }
    const t = xr.start + ((x - plot.x) / plot.w) * (xr.end - xr.start);
    const hover = { t, x, items: [] };
    for (const series of this.series) {
      if (!series.points.length) continue;
      let best = series.points[0];
      let bestDist = Math.abs(best.t - t);
      for (const point of series.points) {
        const dist = Math.abs(point.t - t);
        if (dist < bestDist) {
          best = point;
          bestDist = dist;
        }
      }
      hover.items.push({ series, point: best });
    }
    this.hover = hover;
    this.onHover(hover);
    this.draw();
  }

  draw() {
    const { ctx, colors } = this;
    const width = this.width || 0;
    const height = this.height || 0;
    if (!ctx || width < 2 || height < 2) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, height);

    const layout = this._layout();
    const xr = this._xRange();
    const span = Math.max(1, xr.end - xr.start);

    let rttPeak = 0;
    let jitPeak = 0;
    let pointCount = 0;
    for (const series of this.series) {
      const points = Array.isArray(series.points) ? series.points : [];
      pointCount += points.length;
      for (const point of points) {
        if (point.rttMs != null && point.rttMs > rttPeak) rttPeak = point.rttMs;
        if (point.rttMax != null && point.rttMax > rttPeak) rttPeak = point.rttMax;
        if (point.jitterMs != null && point.jitterMs > jitPeak) jitPeak = point.jitterMs;
      }
    }
    const rttMax = niceMax(rttPeak);
    const jitMax = niceMax(jitPeak);

    this._pane(layout.rtt, "RTT (ms)", rttMax, xr, span, (series, xOf, yOf) => {
      const getY = (p) => (p.rttMs == null ? null : yOf(p.rttMs));
      this._area(series.points, xOf, getY, series.color, 0.16, layout.rtt);
      this._line(series.points, xOf, getY, series.color);
      this._dots(series.points, xOf, getY, series.color);
      this._loss(series.points, xOf, layout.rtt);
    }, false);

    this._pane(layout.jit, "Jitter (ms)", jitMax, xr, span, (series, xOf, yOf) => {
      const getY = (p) => (p.jitterMs == null ? null : yOf(p.jitterMs));
      this._line(series.points, xOf, getY, series.jitterColor || colors.jitter, 1.5);
      this._dots(series.points, xOf, getY, series.jitterColor || colors.jitter);
    }, true);

    if (!pointCount) {
      ctx.fillStyle = colors.text;
      ctx.textAlign = "center";
      ctx.font = "13px Segoe UI, system-ui, sans-serif";
      ctx.fillText("Waiting for samples…", width / 2, layout.rtt.y + layout.rtt.h / 2);
    }

    if (this.hover) {
      ctx.strokeStyle = "rgba(215, 224, 234, 0.35)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(this.hover.x, layout.rtt.y);
      ctx.lineTo(this.hover.x, layout.jit.y + layout.jit.h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _pane(box, title, yMax, xr, span, plotSeries, showXLabels = false) {
    const { ctx } = this;
    ctx.fillStyle = this.colors.text;
    ctx.font = "11px ui-monospace, Cascadia Code, Segoe UI Mono, monospace";
    ctx.textAlign = "left";
    ctx.fillText(title, box.x, box.y - 10);

    const xOf = (t) => box.x + ((t - xr.start) / span) * box.w;
    const yOf = (v) => box.y + box.h - (Math.max(0, v ?? 0) / Math.max(1, yMax)) * box.h;

    this._highlight(box, xr);
    this._grid(box, yMax, xr, span, Boolean(showXLabels));
    this._coverage(box, xr, xOf, showXLabels);

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    for (const series of this.series) {
      const source = Array.isArray(series.points) ? series.points : [];
      const points = downsample(source, Math.max(80, Math.floor(box.w) || 80));
      plotSeries({ ...series, points }, xOf, yOf);
    }
    ctx.restore();
  }

  _coverage(box, xr, xOf, labeled) {
    const times = [];
    for (const series of this.series) {
      for (const point of series.points || []) {
        if (point?.t != null) times.push(point.t);
      }
    }
    if (!times.length) return;
    let minT = Infinity;
    let maxT = -Infinity;
    for (const time of times) {
      if (time < minT) minT = time;
      if (time > maxT) maxT = time;
    }
    const bands = [];
    if (minT - xr.start > (xr.end - xr.start) * 0.02) bands.push([xr.start, minT]);
    if (xr.end - maxT > (xr.end - xr.start) * 0.02) bands.push([maxT, xr.end]);
    for (const [from, to] of bands) {
      const left = Math.max(box.x, xOf(from));
      const right = Math.min(box.x + box.w, xOf(to));
      if (right - left < 3) continue;
      this._stripe(box, left, right);
      if (!labeled && right - left > 72) {
        const ctx = this.ctx;
        ctx.fillStyle = "rgba(122, 138, 154, 0.85)";
        ctx.font = "10px Segoe UI, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No data", (left + right) / 2, box.y + box.h / 2);
        ctx.textBaseline = "alphabetic";
      }
    }
  }

  _stripe(box, x0, x1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, box.y, x1 - x0, box.h);
    ctx.clip();
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.fillRect(x0, box.y, x1 - x0, box.h);
    ctx.strokeStyle = "rgba(125, 150, 170, 0.07)";
    ctx.lineWidth = 1;
    for (let x = x0 - box.h; x < x1; x += 9) {
      ctx.beginPath();
      ctx.moveTo(x, box.y + box.h);
      ctx.lineTo(x + box.h * 0.45, box.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _highlight(box, xr) {
    if (!this.highlight) return;
    const span = xr.end - xr.start;
    const x1 = box.x + ((this.highlight.start - xr.start) / span) * box.w;
    const x2 = box.x + (((this.highlight.end ?? xr.end) - xr.start) / span) * box.w;
    const left = Math.max(box.x, Math.min(x1, x2));
    const right = Math.min(box.x + box.w, Math.max(x1, x2));
    if (right <= left) return;
    this.ctx.fillStyle = this.colors.highlight;
    this.ctx.fillRect(left, box.y, right - left, box.h);
  }

  _grid(box, yMax, xr, span, showXLabels) {
    const { ctx, colors } = this;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    const ticks = 4;
    ctx.textAlign = "right";
    ctx.fillStyle = colors.text;
    ctx.font = "10px ui-monospace, Cascadia Code, Segoe UI Mono, monospace";
    for (let i = 0; i <= ticks; i += 1) {
      const y = box.y + (box.h * i) / ticks;
      ctx.beginPath();
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + box.w, y);
      ctx.stroke();
      const label = Math.round(yMax * (1 - i / ticks));
      ctx.fillText(String(label), box.x - 8, y + 3);
    }
    const xTicks = 5;
    ctx.textAlign = "center";
    for (let i = 0; i <= xTicks; i += 1) {
      const x = box.x + (box.w * i) / xTicks;
      ctx.beginPath();
      ctx.moveTo(x, box.y);
      ctx.lineTo(x, box.y + box.h);
      ctx.stroke();
      if (showXLabels) {
        const t = xr.start + (span * i) / xTicks;
        ctx.fillText(formatAxisTime(t, span), x, box.y + box.h + 16);
      }
    }
    ctx.strokeStyle = "rgba(125, 150, 170, 0.28)";
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  }

  _line(points, xOf, getY, color, width = 1.6) {
    const ctx = this.ctx;
    const maxGap = Math.max(typicalGap(points) * 2.5, 12_000);
    ctx.beginPath();
    let started = false;
    let prevT = null;
    for (const point of points) {
      const y = getY(point);
      if (y == null) {
        started = false;
        prevT = null;
        continue;
      }
      const x = xOf(point.t);
      if (!started || (prevT != null && point.t - prevT > maxGap)) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      prevT = point.t;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  _area(points, xOf, getY, color, alpha, box) {
    const ctx = this.ctx;
    if (!points.length) return;
    const maxGap = Math.max(typicalGap(points) * 2.5, 12_000);
    const base = box.y + box.h;
    const flush = (lastX) => {
      ctx.lineTo(lastX, base);
      ctx.closePath();
      ctx.fillStyle = hexAlpha(color, alpha);
      ctx.fill();
      ctx.beginPath();
    };
    let started = false;
    let lastX = 0;
    let prevT = null;
    ctx.beginPath();
    for (const point of points) {
      const y = getY(point);
      const gap = prevT != null && point.t - prevT > maxGap;
      if (y == null || gap) {
        if (started) flush(lastX);
        started = false;
        prevT = y == null ? null : point.t;
        if (y == null) continue;
      }
      const x = xOf(point.t);
      if (!started) {
        ctx.moveTo(x, base);
        ctx.lineTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      lastX = x;
      prevT = point.t;
    }
    if (started) flush(lastX);
  }

  _dots(points, xOf, getY, color) {
    const ctx = this.ctx;
    const radius = points.length > 400 ? 1.4 : points.length > 120 ? 2 : 2.6;
    ctx.fillStyle = color;
    for (const point of points) {
      const y = getY(point);
      if (y == null) continue;
      ctx.beginPath();
      ctx.arc(xOf(point.t), y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _loss(points, xOf, box) {
    const ctx = this.ctx;
    for (const point of points) {
      if (!point.lost && !point.lossInBucket) continue;
      const x = xOf(point.t);
      ctx.strokeStyle = this.colors.loss;
      ctx.beginPath();
      ctx.moveTo(x, box.y + box.h - 8);
      ctx.lineTo(x, box.y + box.h);
      ctx.stroke();
      ctx.fillStyle = this.colors.loss;
      ctx.beginPath();
      ctx.arc(x, box.y + box.h - 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function typicalGap(points) {
  const gaps = [];
  for (let i = 1; i < points.length; i += 1) {
    const delta = points[i].t - points[i - 1].t;
    if (delta > 0) gaps.push(delta);
  }
  if (!gaps.length) return 8000;
  gaps.sort((a, b) => a - b);
  return Math.max(1000, gaps[Math.floor(gaps.length / 2)]);
}

function hexAlpha(hex, alpha) {
  const raw = String(hex || "#3ee0d0");
  const n = raw.replace("#", "");
  if (n.length < 6) return `rgba(62, 224, 208, ${alpha})`;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function drawSparkline(canvas, values, color = "#3ee0d0") {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 120;
  const height = canvas.clientHeight || 28;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!values.length) return;
  const nums = values.map((v) => (v == null ? null : v));
  const present = nums.filter((v) => v != null);
  const max = Math.max(10, ...(present.length ? present : [10]));
  const min = Math.min(0, ...(present.length ? present : [0]));
  const span = Math.max(1, max - min);
  ctx.beginPath();
  let started = false;
  nums.forEach((value, i) => {
    const x = (i / Math.max(1, nums.length - 1)) * (width - 2) + 1;
    if (value == null) {
      started = false;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = "#e85d5d";
      ctx.fillRect(x - 1, height - 4, 2, 3);
      return;
    }
    const y = height - 3 - ((value - min) / span) * (height - 6);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}
