import { drawSparkline } from "../lib/chart.js";
import { formatInterval, formatMs } from "../lib/format.js";
import { requestTargets } from "../lib/permissions.js";
import { getLive, getSettings, targetColors } from "../lib/storage.js";

const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const targetsEl = document.getElementById("targets");
const dashBtn = document.getElementById("dashboard");

let settings = null;
let live = {};

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

function render() {
  if (!settings) return;
  toggle.checked = Boolean(settings.monitoring);
  const enabled = settings.targets.filter((target) => target.enabled);
  statusEl.textContent = settings.monitoring
    ? `Sampling every ${formatInterval(settings.intervalMs)} · ${enabled.length} target${enabled.length === 1 ? "" : "s"}`
    : "Idle — start sampling to collect jitter";

  targetsEl.innerHTML = "";
  if (!enabled.length) {
    targetsEl.innerHTML = `<div class="empty">No enabled targets. Open the dashboard to add URLs.</div>`;
    return;
  }

  enabled.forEach((target, index) => {
    const snapshot = live[target.id] || {};
    const color = targetColors(index);
    const lost = snapshot.lost;
    const rtt = lost ? "loss" : formatMs(snapshot.rttMs);
    const jitter = formatMs(snapshot.jitterMs);
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card-top">
        <div class="name"><span class="dot" style="color:${color};background:${color}"></span>${escapeHtml(target.label)}</div>
        <div class="rtt" style="color:${lost ? "var(--red)" : color}">${rtt}</div>
      </div>
      <div class="meta">
        <span class="${(snapshot.deltaMs || 0) > settings.jitterThresholdMs ? "warn" : ""}">jitter ${jitter}</span>
        <span class="${lost ? "bad" : ""}">${lost ? "timeout / fail" : "ok"}</span>
      </div>
      <canvas class="spark" height="28"></canvas>
    `;
    targetsEl.appendChild(card);
    drawSparkline(card.querySelector("canvas"), snapshot.sparkline || [], color);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function refresh() {
  settings = await getSettings();
  live = await getLive();
  render();
}

toggle.addEventListener("change", async () => {
  showError("");
  try {
    if (toggle.checked) {
      const enabled = settings.targets.filter((target) => target.enabled);
      if (!enabled.length) {
        toggle.checked = false;
        showError("Enable at least one target in the dashboard first.");
        return;
      }
      const granted = await requestTargets(enabled);
      if (!granted) {
        toggle.checked = false;
        showError("Host permission is required for the enabled targets.");
        return;
      }
      const result = await chrome.runtime.sendMessage({ type: "START_MONITORING" });
      if (!result?.ok) throw new Error(result?.error || "Could not start");
    } else {
      await chrome.runtime.sendMessage({ type: "STOP_MONITORING" });
    }
    await refresh();
  } catch (error) {
    toggle.checked = false;
    showError(error.message || String(error));
  }
});

dashBtn.addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  } catch (error) {
    showError(error.message || "Could not open dashboard");
    return;
  }
  window.close();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "LIVE_SAMPLE") return;
  if (message.live && message.targetId) {
    live[message.targetId] = message.live;
    render();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) settings = changes.settings.newValue;
  if (changes.live) live = changes.live.newValue || live;
  if (changes.settings || changes.live) render();
});

await refresh();
