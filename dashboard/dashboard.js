import { DualChart } from "../lib/chart.js";
import {
  formatDateTime,
  formatDuration,
  formatInterval,
  formatMs,
  formatTime,
} from "../lib/format.js";
import { originPattern, requestOrigins, requestTargets } from "../lib/permissions.js";
import { summarize } from "../lib/stats.js";
import {
  INTERVAL_OPTIONS,
  RETENTION_OPTIONS,
  getIncidents,
  getSamplesMap,
  getSettings,
  hostLabel,
  mergeIncidents,
  mergeSampleMaps,
  newTarget,
  saveSamplesMap,
  saveIncidents,
  saveMonitorState,
  saveSettings,
  targetColors,
  unpackSamples,
} from "../lib/storage.js";

const RANGES = [
  { id: "5m", label: "5m", ms: 5 * 60_000 },
  { id: "15m", label: "15m", ms: 15 * 60_000 },
  { id: "1h", label: "1h", ms: 60 * 60_000 },
  { id: "6h", label: "6h", ms: 6 * 60 * 60_000 },
  { id: "24h", label: "24h", ms: 24 * 60 * 60_000 },
  { id: "all", label: "All", ms: 30 * 24 * 60 * 60_000 },
];

const els = {
  toggle: document.getElementById("toggle"),
  runState: document.getElementById("runState"),
  error: document.getElementById("error"),
  stats: document.getElementById("stats"),
  ranges: document.getElementById("ranges"),
  targetFilters: document.getElementById("targetFilters"),
  hover: document.getElementById("hover"),
  incidents: document.getElementById("incidents"),
  interval: document.getElementById("interval"),
  retention: document.getElementById("retention"),
  threshold: document.getElementById("threshold"),
  spike: document.getElementById("spike"),
  bad: document.getElementById("bad"),
  good: document.getElementById("good"),
  targetList: document.getElementById("targetList"),
  addForm: document.getElementById("addForm"),
  newLabel: document.getElementById("newLabel"),
  newUrl: document.getElementById("newUrl"),
  clearHistory: document.getElementById("clearHistory"),
  clearHighlight: document.getElementById("clearHighlight"),
};

let settings = null;
let samplesMap = {};
let incidents = [];
let rangeId = "5m";
let selectedTargetId = "all";
let highlight = null;
let selectedIncidentId = null;
let applyingSettings = false;

const chart = new DualChart(document.getElementById("chart"), {
  onHover: (hover) => {
    if (!hover?.items?.length) {
      els.hover.textContent = "Move across the chart for sample detail";
      return;
    }
    const bits = hover.items.map(({ series, point }) => {
      const rtt = point.lost ? "loss" : formatMs(point.rttMs);
      return `${series.label} ${rtt} · j ${formatMs(point.jitterMs)} · ${formatTime(point.t)}`;
    });
    els.hover.textContent = bits.join("   |   ");
  },
});

function showError(message) {
  els.error.hidden = !message;
  els.error.textContent = message || "";
}

function fillSelect(select, options, current, labelFn) {
  select.innerHTML = options
    .map((value) => `<option value="${value}">${labelFn(value)}</option>`)
    .join("");
  select.value = String(current);
}

function visibleTargets() {
  if (selectedTargetId === "all") return settings.targets.filter((t) => t.enabled);
  return settings.targets.filter((t) => t.id === selectedTargetId);
}

function rangeWindow() {
  const now = Date.now();
  if (highlight?.start) {
    const pad = Math.max(15_000, ((highlight.end || now) - highlight.start) * 0.35);
    return { start: highlight.start - pad, end: (highlight.end || now) + pad };
  }
  const spec = RANGES.find((range) => range.id === rangeId) || RANGES[1];
  return { start: now - spec.ms, end: now };
}

function asSampleList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function samplesInRange(targetId, window) {
  return asSampleList(samplesMap[targetId]).filter(
    (sample) => sample && sample.t >= window.start && sample.t <= window.end
  );
}

function ingestSample(targetId, sample) {
  if (!targetId || !sample || sample.t == null) return;
  const list = asSampleList(samplesMap[targetId]);
  samplesMap[targetId] = list;
  const last = list[list.length - 1];
  if (last && last.t === sample.t) {
    list[list.length - 1] = sample;
    return;
  }
  list.push(sample);
}

function renderChart() {
  const window = rangeWindow();
  const series = visibleTargets().map((target, index) => {
    const colorIndex = settings.targets.findIndex((item) => item.id === target.id);
    return {
      id: target.id,
      label: target.label,
      color: targetColors(colorIndex >= 0 ? colorIndex : index),
      jitterColor: "#f0a030",
      points: samplesInRange(target.id, window),
    };
  });
  chart.setData({
    series,
    range: window,
    highlight: highlight ? { start: highlight.start, end: highlight.end } : null,
  });
}

function renderChips() {
  els.ranges.innerHTML = "";
  for (const range of RANGES) {
    const button = document.createElement("button");
    button.className = `chip ${range.id === rangeId && !highlight ? "active" : ""}`;
    button.type = "button";
    button.textContent = range.label;
    button.addEventListener("click", () => {
      rangeId = range.id;
      highlight = null;
      selectedIncidentId = null;
      renderChart();
      renderIncidents();
      renderChips();
    });
    els.ranges.appendChild(button);
  }

  els.targetFilters.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.className = `chip ${selectedTargetId === "all" ? "active" : ""}`;
  allBtn.type = "button";
  allBtn.textContent = "All targets";
  allBtn.addEventListener("click", () => {
    selectedTargetId = "all";
    render();
  });
  els.targetFilters.appendChild(allBtn);
  settings.targets.forEach((target, index) => {
    const button = document.createElement("button");
    button.className = `chip ${selectedTargetId === target.id ? "active" : ""}`;
    button.type = "button";
    button.textContent = target.label;
    button.style.borderColor = selectedTargetId === target.id ? targetColors(index) : "";
    button.addEventListener("click", () => {
      selectedTargetId = target.id;
      render();
    });
    els.targetFilters.appendChild(button);
  });
}

function renderStats() {
  const window = rangeWindow();
  const targets = visibleTargets();
  const combined = targets.flatMap((target) => samplesInRange(target.id, window));
  const summary = summarize(combined);
  const openCount = incidents.filter((incident) => !incident.end).length;
  const elsStats = [
    ["Samples", String(summary.count)],
    ["Avg RTT", formatMs(summary.avg)],
    ["Median RTT", formatMs(summary.median)],
    ["Jitter", formatMs(summary.jitter)],
    ["Loss", `${summary.lossPct.toFixed(1)}%${openCount ? ` · ${openCount} open` : ""}`],
  ];
  els.stats.innerHTML = elsStats
    .map(([label, value]) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`)
    .join("");
}

function targetLabel(id) {
  return settings.targets.find((target) => target.id === id)?.label || id;
}

function renderIncidents() {
  const window = rangeWindow();
  const matchingTarget = incidents.filter((incident) =>
    selectedTargetId === "all" || incident.targetId === selectedTargetId
  );
  const rows = matchingTarget
    .filter((incident) => {
      const end = incident.end || Date.now();
      return end >= window.start && incident.start <= window.end;
    })
    .slice()
    .sort((a, b) => {
      if (!a.end !== !b.end) return a.end ? 1 : -1;
      return (b.start || 0) - (a.start || 0);
    });
  const hidden = matchingTarget.length - rows.length;

  if (!rows.length) {
    const message = hidden
      ? `${hidden} incident${hidden === 1 ? "" : "s"} are outside this ${rangeId} range. Choose a longer range or All to see them.`
      : "No incidents yet. Spikes, jitter jumps, and losses will show up here.";
    els.incidents.innerHTML = `<tr><td class="empty" colspan="6">${message}</td></tr>`;
    return;
  }

  const notice = hidden
    ? `<tr><td class="empty" colspan="6">${hidden} older incident${hidden === 1 ? "" : "s"} hidden by the ${rangeId} range. Choose All to show everything.</td></tr>`
    : "";

  els.incidents.innerHTML =
    notice +
    rows
      .map((incident) => {
        const duration = (incident.end || Date.now()) - incident.start;
        const active = incident.id === selectedIncidentId ? "active" : "";
        const when = incident.end
          ? formatDateTime(incident.start)
          : `${formatDateTime(incident.start)} · ongoing`;
        return `<tr data-id="${incident.id}" class="${active}">
        <td class="${incident.end ? "" : "ongoing"}">${when}</td>
        <td>${escapeHtml(targetLabel(incident.targetId))}</td>
        <td>${formatDuration(duration)}</td>
        <td>${formatMs(incident.peakRtt)}</td>
        <td>${formatMs(incident.avgJitter)}</td>
        <td>${incident.lossCount}/${incident.sampleCount}</td>
      </tr>`;
      })
      .join("");

  for (const row of els.incidents.querySelectorAll("tr[data-id]")) {
    row.addEventListener("click", () => {
      const incident = incidents.find((item) => item.id === row.dataset.id);
      if (!incident) return;
      selectedIncidentId = incident.id;
      highlight = { start: incident.start, end: incident.end };
      selectedTargetId = incident.targetId;
      render();
    });
  }
}

function renderTargets() {
  els.targetList.innerHTML = "";
  settings.targets.forEach((target) => {
    const row = document.createElement("div");
    row.className = "target-row";
    row.innerHTML = `
      <input type="checkbox" ${target.enabled ? "checked" : ""} data-act="enable" />
      <input type="text" value="${escapeAttr(target.label)}" data-act="label" />
      <input type="url" value="${escapeAttr(target.url)}" data-act="url" />
      <button class="btn danger" type="button" data-act="remove">Remove</button>
    `;
    const enable = row.querySelector('[data-act="enable"]');
    const label = row.querySelector('[data-act="label"]');
    const url = row.querySelector('[data-act="url"]');
    enable.addEventListener("change", async () => {
      if (enable.checked) {
        try {
          const granted = await requestOrigins([originPattern(target.url)]);
          if (!granted) {
            enable.checked = false;
            showError("Permission denied for that host.");
            return;
          }
        } catch (error) {
          enable.checked = false;
          showError(error.message || String(error));
          return;
        }
      }
      await patchTarget(target.id, { enabled: enable.checked });
    });
    label.addEventListener("change", () => patchTarget(target.id, { label: label.value.trim() || target.label }));
    url.addEventListener("change", async () => {
      try {
        const granted = await requestOrigins([originPattern(url.value)]);
        if (!granted) {
          url.value = target.url;
          showError("Permission denied for that host.");
          return;
        }
        await patchTarget(target.id, { url: url.value.trim() });
      } catch (error) {
        url.value = target.url;
        showError(error.message || String(error));
      }
    });
    row.querySelector('[data-act="remove"]').addEventListener("click", async () => {
      settings.targets = settings.targets.filter((item) => item.id !== target.id);
      await persistSettings({ targets: settings.targets });
    });
    els.targetList.appendChild(row);
  });
}

function renderSettings() {
  applyingSettings = true;
  fillSelect(els.interval, INTERVAL_OPTIONS, settings.intervalMs, formatInterval);
  fillSelect(els.retention, RETENTION_OPTIONS, settings.maxSamplesPerTarget, (value) => `${value.toLocaleString()} samples`);
  els.threshold.value = settings.jitterThresholdMs;
  els.spike.value = settings.rttSpikeFactor;
  els.bad.value = settings.consecutiveBad;
  els.good.value = settings.consecutiveGood;
  els.toggle.checked = Boolean(settings.monitoring);
  els.runState.textContent = settings.monitoring
    ? `Sampling · ${formatInterval(settings.intervalMs)}`
    : "Idle";
  els.runState.className = `run-state ${settings.monitoring ? "on" : "idle"}`;
  renderTargets();
  queueMicrotask(() => {
    applyingSettings = false;
  });
}

function render() {
  if (!settings) return;
  renderSettings();
  renderChips();
  renderStats();
  renderChart();
  renderIncidents();
}

async function persistSettings(patch) {
  if (applyingSettings) return;
  settings = await saveSettings(patch);
  await chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED" });
  render();
}

async function patchTarget(id, patch) {
  settings.targets = settings.targets.map((target) =>
    target.id === id ? { ...target, ...patch } : target
  );
  await persistSettings({ targets: settings.targets });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

els.toggle.addEventListener("change", async () => {
  showError("");
  try {
    if (els.toggle.checked) {
      const enabled = settings.targets.filter((target) => target.enabled);
      if (!enabled.length) {
        els.toggle.checked = false;
        showError("Enable at least one target first.");
        return;
      }
      const granted = await requestTargets(enabled);
      if (!granted) {
        els.toggle.checked = false;
        showError("Host permission is required for the enabled targets.");
        return;
      }
      const result = await chrome.runtime.sendMessage({ type: "START_MONITORING" });
      if (!result?.ok) throw new Error(result?.error || "Could not start");
    } else {
      await chrome.runtime.sendMessage({ type: "STOP_MONITORING" });
    }
    settings = await getSettings();
    render();
  } catch (error) {
    els.toggle.checked = false;
    showError(error.message || String(error));
  }
});

els.interval.addEventListener("change", () => persistSettings({ intervalMs: Number(els.interval.value) }));
els.retention.addEventListener("change", () => persistSettings({ maxSamplesPerTarget: Number(els.retention.value) }));
els.threshold.addEventListener("change", () => persistSettings({ jitterThresholdMs: Number(els.threshold.value) }));
els.spike.addEventListener("change", () => persistSettings({ rttSpikeFactor: Number(els.spike.value) }));
els.bad.addEventListener("change", () => persistSettings({ consecutiveBad: Number(els.bad.value) }));
els.good.addEventListener("change", () => persistSettings({ consecutiveGood: Number(els.good.value) }));

els.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const url = els.newUrl.value.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      showError("Use an http:// or https:// URL.");
      return;
    }
    const granted = await requestOrigins([originPattern(url)]);
    if (!granted) {
      showError("Permission denied for that host.");
      return;
    }
    const target = newTarget(els.newLabel.value, url);
    if (!target.label) target.label = hostLabel(url);
    settings.targets = [...settings.targets, target];
    els.newLabel.value = "";
    els.newUrl.value = "";
    await persistSettings({ targets: settings.targets });
  } catch (error) {
    showError(error.message || "Enter a valid http(s) URL.");
  }
});

els.clearHistory.addEventListener("click", async () => {
  if (!confirm("Clear all samples and incidents?")) return;
  samplesMap = {};
  incidents = [];
  highlight = null;
  selectedIncidentId = null;
  await saveSamplesMap({}, { replace: true });
  await saveIncidents([], { replace: true });
  await saveMonitorState({ live: {}, detector: {} });
  await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
  render();
});

els.clearHighlight.addEventListener("click", () => {
  highlight = null;
  selectedIncidentId = null;
  render();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "LIVE_SAMPLE") return;
  if (message.sample && message.targetId) ingestSample(message.targetId, message.sample);
  renderStats();
  renderChart();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const settingsChanged = Boolean(changes.settings);
  if (changes.settings) settings = changes.settings.newValue;
  if (changes.samplePack) {
    samplesMap = mergeSampleMaps(samplesMap, unpackSamples(changes.samplePack.newValue));
  }
  if (changes.samples) {
    samplesMap = mergeSampleMaps(samplesMap, unpackSamples(changes.samples.newValue));
  }
  if (changes.incidents && Array.isArray(changes.incidents.newValue)) {
    incidents = mergeIncidents(incidents, changes.incidents.newValue);
  }
  if (!settings) return;
  if (settingsChanged) render();
  else {
    renderStats();
    renderChart();
    renderIncidents();
  }
});

async function loadHistory() {
  const stored = await getSamplesMap();
  const storedIncidents = await getIncidents();
  try {
    const liveState = await chrome.runtime.sendMessage({ type: "OFFSCREEN_GET_STATE" });
    if (liveState?.ok) {
      return {
        samples: mergeSampleMaps(stored, liveState.samples || {}),
        incidents: mergeIncidents(storedIncidents, liveState.incidents || []),
      };
    }
  } catch {
    // offscreen may be closed
  }
  return { samples: stored, incidents: storedIncidents };
}

async function boot() {
  try {
    settings = await getSettings();
    samplesMap = await getSamplesMap();
    incidents = await getIncidents();
    render();
    requestAnimationFrame(() => chart.resize());
    const history = await loadHistory();
    samplesMap = mergeSampleMaps(samplesMap, history.samples);
    incidents = mergeIncidents(incidents, history.incidents);
    render();
  } catch (error) {
    showError(error.message || String(error));
    console.error(error);
    if (settings) render();
  }
}

setInterval(async () => {
  if (!settings) return;
  try {
    const history = await loadHistory();
    samplesMap = mergeSampleMaps(samplesMap, history.samples);
    incidents = mergeIncidents(incidents, history.incidents);
    renderStats();
    renderChart();
    renderIncidents();
  } catch {
    // keep last in-memory samples
  }
}, 5000);

await boot();
