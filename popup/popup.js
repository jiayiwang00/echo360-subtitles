const STATE_KEY = "translationProgress";
const REFRESH_MS = 500;

const statusText = document.getElementById("statusText");
const meterFill = document.getElementById("meterFill");
const translatedValue = document.getElementById("translatedValue");
const uniqueValue = document.getElementById("uniqueValue");
const queueValue = document.getElementById("queueValue");
const activeText = document.getElementById("activeText");

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function trimText(text, maxLength = 120) {
  const normalized = String(text || "").trim();
  if (!normalized) return "No active subtitle";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function renderState(progress) {
  const isActive = Boolean(progress?.running);
  const translated = progress?.translated ?? 0;
  const total = progress?.total ?? 0;
  const uniqueDone = progress?.uniqueDone ?? 0;
  const uniqueTotal = progress?.uniqueTotal ?? 0;
  const queue = progress?.queueLength ?? 0;
  const percent = clampPercent(progress?.percent ?? 0);

  statusText.textContent = isActive
    ? progress?.statusText || "Translating"
    : "Waiting for translation...";
  meterFill.style.width = `${percent}%`;
  translatedValue.textContent = `${translated}/${total}`;
  uniqueValue.textContent = `${uniqueDone}/${uniqueTotal}`;
  queueValue.textContent = String(queue);
  activeText.textContent = trimText(progress?.activeText);
}

async function refresh() {
  const result = await chrome.storage.local.get(STATE_KEY);
  renderState(result[STATE_KEY]);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STATE_KEY]) return;
  renderState(changes[STATE_KEY].newValue);
});

refresh();
setInterval(refresh, REFRESH_MS);
