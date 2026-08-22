import { ping } from "../lib/ping.js";
import {
  createDetector,
  processSample,
  pushRing,
  snapshotIncident,
} from "../lib/stats.js";
import {
  SPARKLINE_POINTS,
  getDetectorState,
  getIncidents,
  getSamplesMap,
  getSettings,
  saveMonitorState,
  saveSamplesMap,
  saveIncidents,
  trimIncidents,
} from "../lib/storage.js";

let worker = null;
let settings = null;
let samplesMap = {};
let incidents = [];
let live = {};
let detectors = {};
let inFlight = new Set();
let dirty = false;
let flushTimer = 0;
let loopTimer = 0;
let lastAlertAt = 0;
let sampling = false;

URL.createObjectURL(new Blob(["jitter-keepalive"], { type: "text/plain" }));

function asSampleList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

async function hydrate() {
  settings = await getSettings();
  samplesMap = await getSamplesMap();
  incidents = await getIncidents();
  const storedDetectors = await getDetectorState();
  detectors = {};
  for (const target of settings.targets) {
    const restored = storedDetectors[target.id];
    detectors[target.id] = restored
      ? {
          ...createDetector(),
          ...restored,
          recentRtts: Array.isArray(restored.recentRtts) ? restored.recentRtts : [],
        }
      : createDetector();
    samplesMap[target.id] = asSampleList(samplesMap[target.id]);
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL("offscreen/ping-worker.js"));
  return worker;
}

function startLoop() {
  ensureWorker();
  if (sampling) return;
  sampling = true;
  const beat = () => {
    if (!settings?.monitoring) {
      sampling = false;
      return;
    }
    void sampleAll().finally(() => {
      if (!settings?.monitoring) {
        sampling = false;
        return;
      }
      loopTimer = setTimeout(beat, settings.intervalMs || 5000);
    });
  };
  beat();
}

function stopLoop() {
  sampling = false;
  clearTimeout(loopTimer);
  loopTimer = 0;
}

function serializeDetectors() {
  const out = {};
  for (const [id, detector] of Object.entries(detectors)) {
    out[id] = {
      recentRtts: detector.recentRtts.slice(-30),
      prevRtt: detector.prevRtt,
      jitter: detector.jitter,
      badStreak: detector.badStreak,
      goodStreak: detector.goodStreak,
      open: detector.open,
    };
  }
  return out;
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    await saveSamplesMap(samplesMap, { maxPerTarget: settings?.maxSamplesPerTarget || 10000 });
    await saveMonitorState({
      incidents,
      live,
      detector: serializeDetectors(),
    });
  } catch (error) {
    dirty = true;
    console.warn("Failed to persist samples", error);
    try {
      await saveSamplesMap(samplesMap, { maxPerTarget: settings?.maxSamplesPerTarget || 10000 });
    } catch (retryError) {
      console.warn("Retry persist samples failed", retryError);
    }
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = 0;
    void flush();
  }, 250);
}

async function sampleAll() {
  if (!settings?.monitoring) return;
  const enabled = settings.targets.filter((target) => target.enabled);
  await Promise.all(enabled.map((target) => sampleTarget(target)));
  dirty = true;
  await flush();
}

async function sampleTarget(target) {
  if (inFlight.has(target.id)) return;
  inFlight.add(target.id);
  try {
    if (!detectors[target.id]) detectors[target.id] = createDetector();
    const result = await ping(target.url, settings.timeoutMs);
    const detector = detectors[target.id];
    const { sample, opened, closed, liveJitter } = processSample(
      detector,
      { t: Date.now(), rttMs: result.rttMs, lost: result.lost },
      settings,
      target.id
    );

    if (!Array.isArray(samplesMap[target.id])) samplesMap[target.id] = [];
    pushRing(samplesMap[target.id], sample, settings.maxSamplesPerTarget);

    const sparkSrc = samplesMap[target.id].slice(-SPARKLINE_POINTS);
    live[target.id] = {
      t: sample.t,
      rttMs: sample.rttMs,
      lost: sample.lost,
      jitterMs: liveJitter,
      deltaMs: sample.deltaMs,
      sparkline: sparkSrc.map((point) => (point.lost ? null : point.rttMs)),
    };

    if (opened) {
      incidents = trimIncidents([...incidents, snapshotIncident(opened)]);
    }
    if (closed) {
      incidents = incidents.map((incident) => (incident.id === closed.id ? closed : incident));
    } else if (detector.open) {
      incidents = incidents.map((incident) =>
        incident.id === detector.open.id ? snapshotIncident(detector.open) : incident
      );
    }

    const incidentUpdate = closed || (opened ? snapshotIncident(opened) : null);
    const alert = Boolean(
      opened || sample.lost || (sample.deltaMs != null && sample.deltaMs > settings.jitterThresholdMs)
    );
    const now = Date.now();
    chrome.runtime
      .sendMessage({
        type: "LIVE_SAMPLE",
        targetId: target.id,
        sample,
        live: live[target.id],
        incident: incidentUpdate,
        alert: alert && now - lastAlertAt > 4000,
      })
      .catch(() => {});
    if (alert) lastAlertAt = now;

    if (incidentUpdate) {
      void saveIncidents([incidentUpdate]).catch((error) => console.warn("Failed to persist incident", error));
    }

    scheduleFlush();
  } finally {
    inFlight.delete(target.id);
  }
}

function resetHistory() {
  samplesMap = {};
  incidents = [];
  live = {};
  detectors = {};
  for (const target of settings?.targets || []) {
    detectors[target.id] = createDetector();
    samplesMap[target.id] = [];
  }
}

async function applyConfig(nextSettings) {
  settings = nextSettings;
  for (const target of settings.targets) {
    if (!detectors[target.id]) detectors[target.id] = createDetector();
    samplesMap[target.id] = asSampleList(samplesMap[target.id]);
    if (samplesMap[target.id].length > settings.maxSamplesPerTarget) {
      samplesMap[target.id] = samplesMap[target.id].slice(-settings.maxSamplesPerTarget);
    }
  }
  if (settings.monitoring) startLoop();
  else stopLoop();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (!type || !["OFFSCREEN_PING", "OFFSCREEN_CONFIG", "OFFSCREEN_STOP", "OFFSCREEN_CLEAR", "OFFSCREEN_GET_STATE"].includes(type)) {
    return;
  }
  const task = (async () => {
    switch (type) {
      case "OFFSCREEN_PING":
        return { ok: true };
      case "OFFSCREEN_CONFIG":
        await applyConfig(message.settings || (await getSettings()));
        return { ok: true };
      case "OFFSCREEN_STOP":
        stopLoop();
        dirty = true;
        await flush();
        return { ok: true };
      case "OFFSCREEN_CLEAR":
        resetHistory();
        dirty = true;
        await saveSamplesMap({}, { replace: true });
        await saveIncidents([], { replace: true });
        await saveMonitorState({ live: {}, detector: {} });
        return { ok: true };
      case "OFFSCREEN_GET_STATE":
        return {
          ok: true,
          samples: samplesMap,
          incidents,
          live,
        };
      default:
        return null;
    }
  })();
  task.then((result) => sendResponse(result));
  return true;
});

addEventListener("pagehide", () => {
  void flush();
});

await hydrate();
if (settings.monitoring) startLoop();
