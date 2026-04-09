const STATE_KEY = "translationProgress";
const SETTINGS_KEY = "translationSettings";
const REFRESH_MS = 500;
const DEFAULT_LANGUAGE = "zh-CN";
const LANGUAGES = [
  { value: "zh-CN", label: "Chinese (Simplified) 简体中文" },
  { value: "zh-TW", label: "Chinese (Traditional) 繁體中文" },
  { value: "es", label: "Spanish Español" },
  { value: "fr", label: "French Français" },
  { value: "de", label: "German Deutsch" },
  { value: "ja", label: "Japanese 日本語" },
  { value: "ko", label: "Korean 한국어" },
  { value: "ru", label: "Russian Русский" },
  { value: "ar", label: "Arabic العربية" },
  { value: "pt", label: "Portuguese Português" }
];

const statusText = document.getElementById("statusText");
const meterFill = document.getElementById("meterFill");
const translatedValue = document.getElementById("translatedValue");
const uniqueValue = document.getElementById("uniqueValue");
const queueValue = document.getElementById("queueValue");
const activeText = document.getElementById("activeText");
const languageSelect = document.getElementById("languageSelect");
const translateButton = document.getElementById("translateButton");
let hasLoadedSettings = false;

function renderLanguageOptions() {
  const options = LANGUAGES.map(language => {
    const option = document.createElement("option");
    option.value = language.value;
    option.textContent = language.label;
    return option;
  });
  languageSelect.replaceChildren(...options);
}

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

async function refreshProgress() {
  const result = await chrome.storage.local.get(STATE_KEY);
  renderState(result[STATE_KEY]);
}

async function loadSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  languageSelect.value = result?.[SETTINGS_KEY]?.targetLanguage || DEFAULT_LANGUAGE;
  hasLoadedSettings = true;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STATE_KEY]) {
    renderState(changes[STATE_KEY].newValue);
  }
  if (changes[SETTINGS_KEY]) {
    languageSelect.value = changes[SETTINGS_KEY].newValue?.targetLanguage || DEFAULT_LANGUAGE;
    hasLoadedSettings = true;
  }
});

translateButton.addEventListener("click", async () => {
  translateButton.disabled = true;
  try {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        targetLanguage: languageSelect.value || DEFAULT_LANGUAGE
      }
    });
  } finally {
    translateButton.disabled = false;
  }
});

renderLanguageOptions();
if (!hasLoadedSettings) loadSettings();
refreshProgress();
setInterval(refreshProgress, REFRESH_MS);
