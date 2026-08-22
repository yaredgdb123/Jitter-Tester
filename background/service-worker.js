import { getLive, getSamplesMap, getSettings, saveIncidents, saveSamplesMap, saveSettings } from "../lib/storage.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";
const WATCHDOG_ALARM = "watchdog";
const DASHBOARD_URL = "dashboard/dashboard.html";

let persistChain = Promise.resolve();

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function waitForOffscreen(timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" });
      if (response?.ok) return;
    } catch {
      // document still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Offscreen document did not become ready");
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS", "BLOBS"],
      justification: "Keep a worker and blob URL alive so HTTP latency samples continue in the background.",
    });
  } catch {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Run a dedicated worker that schedules periodic HTTP latency samples.",
    });
  }
  await waitForOffscreen();
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

async function sendConfig() {
  const settings = await getSettings();
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_CONFIG",
    settings,
  });
}

async function startMonitoring() {
  const settings = await saveSettings({ monitoring: true });
  await ensureOffscreen();
  await sendConfig();
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  await updateBadge(settings);
  return { ok: true, monitoring: true };
}

async function stopMonitoring() {
  const settings = await saveSettings({ monitoring: false });
  try {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" });
  } catch {
    // offscreen may already be gone
  }
  await closeOffscreen();
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await updateBadge(settings);
  return { ok: true, monitoring: false };
}

async function updateBadge(settings) {
  if (!settings?.monitoring) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#1b3a38" });
  await chrome.action.setBadgeTextColor({ color: "#3ee0d0" });
  await chrome.action.setBadgeText({ text: "ON" });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  if (settings.monitoring) await startMonitoring();
  else await updateBadge(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (settings.monitoring) await startMonitoring();
  else await updateBadge(settings);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const settings = await getSettings();
  if (!settings.monitoring) return;
  if (!(await hasOffscreen())) {
    try {
      await ensureOffscreen();
      await sendConfig();
    } catch (error) {
      console.warn("Watchdog failed to restore sampling", error);
    }
  }
});

const HANDLED_MESSAGES = new Set([
  "START_MONITORING",
  "STOP_MONITORING",
  "SETTINGS_CHANGED",
  "GET_STATUS",
  "OPEN_DASHBOARD",
  "CLEAR_HISTORY",
  "GET_HISTORY",
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "LIVE_SAMPLE") {
    if (message.sample && message.targetId) {
      persistChain = persistChain
        .then(() => saveSamplesMap({ [message.targetId]: [message.sample] }))
        .catch((error) => console.warn("Failed to persist live sample", error));
    }
    if (message.incident) {
      persistChain = persistChain
        .then(() => saveIncidents([message.incident]))
        .catch((error) => console.warn("Failed to persist incident", error));
    }
    if (message.alert) {
      chrome.action.setBadgeBackgroundColor({ color: "#5a2a12" });
      chrome.action.setBadgeTextColor({ color: "#f0a030" });
      chrome.action.setBadgeText({ text: "!" });
    }
    return;
  }

  if (!HANDLED_MESSAGES.has(message?.type)) return;

  const task = (async () => {
    switch (message?.type) {
      case "START_MONITORING":
        return startMonitoring();
      case "STOP_MONITORING":
        return stopMonitoring();
      case "SETTINGS_CHANGED": {
        const settings = await getSettings();
        if (settings.monitoring) {
          await ensureOffscreen();
          await sendConfig();
        }
        return { ok: true };
      }
      case "GET_STATUS": {
        const [settings, live] = await Promise.all([getSettings(), getLive()]);
        return {
          ok: true,
          monitoring: settings.monitoring,
          intervalMs: settings.intervalMs,
          live,
        };
      }
      case "OPEN_DASHBOARD": {
        await chrome.tabs.create({ url: chrome.runtime.getURL(DASHBOARD_URL) });
        return { ok: true };
      }
      case "CLEAR_HISTORY": {
        try {
          await chrome.runtime.sendMessage({ type: "OFFSCREEN_CLEAR" });
        } catch {
          // offscreen may be closed
        }
        return { ok: true };
      }
      case "GET_HISTORY": {
        const stored = await getSamplesMap();
        return { ok: true, samples: stored };
      }
      default:
        return null;
    }
  })();

  task
    .then((result) => {
      if (result) sendResponse(result);
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});
