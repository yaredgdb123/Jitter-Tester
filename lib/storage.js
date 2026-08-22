export const INTERVAL_OPTIONS = [1000, 2000, 5000, 10000, 15000, 30000, 60000];
export const RETENTION_OPTIONS = [2500, 5000, 10000, 20000];
export const MAX_INCIDENTS = 200;
export const SPARKLINE_POINTS = 48;
export const DEFAULT_TIMEOUT_MS = 5000;

export const DEFAULT_TARGETS = [
  {
    id: "google-204",
    label: "Google",
    url: "https://www.google.com/generate_204",
    enabled: true,
  },
  {
    id: "gstatic-204",
    label: "gstatic",
    url: "https://www.gstatic.com/generate_204",
    enabled: true,
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    url: "https://1.1.1.1/cdn-cgi/trace",
    enabled: true,
  },
];

export function defaultSettings() {
  return {
    monitoring: false,
    intervalMs: 5000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxSamplesPerTarget: 10000,
    rttSpikeFactor: 2,
    jitterThresholdMs: 50,
    consecutiveBad: 3,
    consecutiveGood: 3,
    targets: DEFAULT_TARGETS.map((target) => ({ ...target })),
  };
}

function mergeSettings(stored) {
  const defaults = defaultSettings();
  if (!stored) return defaults;
  return {
    ...defaults,
    ...stored,
    targets: Array.isArray(stored.targets) && stored.targets.length
      ? stored.targets
      : defaults.targets,
  };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = mergeSettings(settings);
  if (!settings) await chrome.storage.local.set({ settings: merged });
  return merged;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const settings = mergeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ settings });
  return settings;
}

export async function getSamplesMap() {
  const data = await chrome.storage.local.get(["samplePack", "samples"]);
  const fromPack = unpackSamples(data.samplePack);
  const fromLegacy = unpackSamples(data.samples);
  return mergeSampleMaps(fromLegacy, fromPack);
}

export async function getIncidents() {
  const { incidents } = await chrome.storage.local.get("incidents");
  return Array.isArray(incidents) ? incidents : [];
}

export async function getLive() {
  const { live } = await chrome.storage.local.get("live");
  return live && typeof live === "object" ? live : {};
}

export async function getDetectorState() {
  const { detector } = await chrome.storage.local.get("detector");
  return detector && typeof detector === "object" ? detector : {};
}

export function asSampleList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === "object") return Object.values(value).filter(Boolean);
  return [];
}

export function mergeSampleMaps(left = {}, right = {}) {
  const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
  const out = {};
  for (const id of ids) {
    const byTime = new Map();
    for (const sample of [...asSampleList(left[id]), ...asSampleList(right[id])]) {
      if (sample && sample.t != null) byTime.set(sample.t, sample);
    }
    out[id] = [...byTime.values()].sort((a, b) => a.t - b.t);
  }
  return out;
}

export function packSamples(map) {
  const packed = {};
  for (const [id, list] of Object.entries(map || {})) {
    const samples = asSampleList(list);
    packed[id] = {
      t: samples.map((sample) => sample.t),
      r: samples.map((sample) =>
        sample.lost || sample.rttMs == null ? -1 : round2(sample.rttMs)
      ),
      j: samples.map((sample) => (sample.jitterMs == null ? -1 : round2(sample.jitterMs))),
      d: samples.map((sample) => (sample.deltaMs == null ? -1 : round2(sample.deltaMs))),
    };
  }
  return packed;
}

export function unpackSamples(packed) {
  if (!packed || typeof packed !== "object" || Array.isArray(packed)) return {};
  const map = {};
  for (const [id, value] of Object.entries(packed)) {
    if (Array.isArray(value)) {
      map[id] = value.filter((sample) => sample && sample.t != null);
      continue;
    }
    if (!value || !Array.isArray(value.t)) continue;
    map[id] = value.t.map((time, index) => {
      const rtt = value.r?.[index];
      const jitter = value.j?.[index];
      const delta = value.d?.[index];
      const lost = rtt == null || rtt < 0;
      return {
        t: time,
        rttMs: lost ? null : rtt,
        lost,
        jitterMs: jitter == null || jitter < 0 ? 0 : jitter,
        deltaMs: delta == null || delta < 0 ? null : delta,
      };
    });
  }
  return map;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function saveSamplesMap(samples, { replace = false, maxPerTarget = 10000 } = {}) {
  const next = replace ? unpackSamples(packSamples(samples || {})) : mergeSampleMaps(await getSamplesMap(), samples);
  for (const id of Object.keys(next)) {
    if (next[id].length > maxPerTarget) next[id] = next[id].slice(-maxPerTarget);
  }
  await chrome.storage.local.set({ samplePack: packSamples(next) });
  return next;
}

export function mergeIncidents(left = [], right = []) {
  const byId = new Map();
  for (const incident of [...left, ...right]) {
    if (!incident?.id) continue;
    const prev = byId.get(incident.id);
    if (!prev) {
      byId.set(incident.id, incident);
      continue;
    }
    const preferNew =
      (!prev.end && incident.end) ||
      (incident.sampleCount || 0) >= (prev.sampleCount || 0);
    byId.set(incident.id, preferNew ? incident : prev);
  }
  return [...byId.values()].sort((a, b) => (b.start || 0) - (a.start || 0));
}

export async function saveIncidents(list, { replace = false } = {}) {
  const next = replace
    ? (Array.isArray(list) ? list : [])
    : mergeIncidents(await getIncidents(), list);
  const trimmed = trimIncidents(next);
  await chrome.storage.local.set({ incidents: cloneJson(trimmed) });
  return trimmed;
}

export async function saveMonitorState({
  samples,
  incidents,
  live,
  detector,
  replaceSamples = false,
  replaceIncidents = false,
}) {
  if (samples) {
    await saveSamplesMap(samples, { replace: replaceSamples });
  }
  if (incidents && (replaceIncidents || incidents.length)) {
    await saveIncidents(incidents, { replace: replaceIncidents });
  }
  const payload = {};
  if (live) payload.live = cloneJson(live);
  if (detector) payload.detector = cloneJson(detector);
  if (Object.keys(payload).length) await chrome.storage.local.set(payload);
}

export function trimIncidents(incidents) {
  if (incidents.length <= MAX_INCIDENTS) return incidents;
  const open = incidents.filter((incident) => !incident.end);
  const closed = incidents.filter((incident) => incident.end);
  const keepClosed = Math.max(0, MAX_INCIDENTS - open.length);
  return [...closed.slice(-keepClosed), ...open];
}

export function newTarget(label, url) {
  return {
    id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    label: label.trim() || hostLabel(url),
    url: url.trim(),
    enabled: true,
  };
}

export function hostLabel(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "Target";
  }
}

export function targetColors(index) {
  const palette = ["#3ee0d0", "#6ea8ff", "#d4a0ff", "#f0a030", "#5dca8a", "#ff7a90"];
  return palette[index % palette.length];
}
