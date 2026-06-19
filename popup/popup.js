const STATE_KEY = "translationProgress";
const SETTINGS_KEY = "translationSettings";
const REFRESH_MS = 500;
const DEFAULT_LANGUAGE = "zh-CN";
const DEFAULT_FONT_SIZE = 22;
const DEFAULT_PROVIDER = "google";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const FONT_SIZES = [
  { value: 16, label: "Small" },
  { value: 22, label: "Medium" },
  { value: 28, label: "Large" },
  { value: 34, label: "Extra large" }
];
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
const providerSelect = document.getElementById("providerSelect");
const deepseekSettings = document.getElementById("deepseekSettings");
const deepseekApiKey = document.getElementById("deepseekApiKey");
const toggleApiKey = document.getElementById("toggleApiKey");
const deepseekModel = document.getElementById("deepseekModel");
const settingsError = document.getElementById("settingsError");
const apiError = document.getElementById("apiError");
const apiErrorText = document.getElementById("apiErrorText");
const fontSizeSelect = document.getElementById("fontSizeSelect");
const translateButton = document.getElementById("translateButton");
let hasLoadedSettings = false;

function renderProviderSettings() {
  deepseekSettings.hidden = providerSelect.value !== "deepseek";
  settingsError.hidden = true;
}

function applySettingsToForm(settings) {
  languageSelect.value = settings.targetLanguage || DEFAULT_LANGUAGE;
  fontSizeSelect.value = String(normalizeFontSize(settings.subtitleFontSize));
  providerSelect.value = settings.translationProvider === "deepseek" ? "deepseek" : DEFAULT_PROVIDER;
  deepseekApiKey.value = settings.deepseekApiKey || "";
  deepseekModel.value = settings.deepseekModel || DEFAULT_DEEPSEEK_MODEL;
  renderProviderSettings();
}

function renderLanguageOptions() {
  const options = LANGUAGES.map(language => {
    const option = document.createElement("option");
    option.value = language.value;
    option.textContent = language.label;
    return option;
  });
  languageSelect.replaceChildren(...options);
}

function renderFontSizeOptions() {
  const options = FONT_SIZES.map(size => {
    const option = document.createElement("option");
    option.value = String(size.value);
    option.textContent = size.label;
    return option;
  });
  fontSizeSelect.replaceChildren(...options);
}

function normalizeFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE;
  return Math.max(14, Math.min(40, size));
}

async function updateSettings(patch) {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const current = result?.[SETTINGS_KEY] || {};
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...current,
      ...patch
    }
  });
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
  const errorMessage = String(progress?.errorMessage || "").trim();
  apiError.hidden = !errorMessage;
  apiErrorText.textContent = errorMessage;
}

async function refreshProgress() {
  const result = await chrome.storage.local.get(STATE_KEY);
  renderState(result[STATE_KEY]);
}

async function loadSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = result?.[SETTINGS_KEY] || {};
  applySettingsToForm(settings);
  hasLoadedSettings = true;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STATE_KEY]) {
    renderState(changes[STATE_KEY].newValue);
  }
  if (changes[SETTINGS_KEY]) {
    const settings = changes[SETTINGS_KEY].newValue || {};
    applySettingsToForm(settings);
    hasLoadedSettings = true;
  }
});

translateButton.addEventListener("click", async () => {
  const provider = providerSelect.value === "deepseek" ? "deepseek" : "google";
  const apiKey = deepseekApiKey.value.trim();
  const model = deepseekModel.value.trim();
  if (provider === "deepseek" && (!apiKey || !model)) {
    settingsError.textContent = "DeepSeek requires both an API key and a model name.";
    settingsError.hidden = false;
    return;
  }

  translateButton.disabled = true;
  try {
    await updateSettings({
      targetLanguage: languageSelect.value || DEFAULT_LANGUAGE,
      subtitleFontSize: normalizeFontSize(fontSizeSelect.value),
      translationProvider: provider,
      deepseekApiKey: apiKey,
      deepseekModel: model || DEFAULT_DEEPSEEK_MODEL,
      translationRequestId: Date.now()
    });
    settingsError.hidden = true;
  } finally {
    translateButton.disabled = false;
  }
});

providerSelect.addEventListener("change", renderProviderSettings);

toggleApiKey.addEventListener("click", () => {
  const shouldShow = deepseekApiKey.type === "password";
  deepseekApiKey.type = shouldShow ? "text" : "password";
  toggleApiKey.setAttribute("aria-pressed", String(shouldShow));
  toggleApiKey.setAttribute("aria-label", shouldShow ? "Hide API key" : "Show API key");
  toggleApiKey.title = shouldShow ? "Hide API key" : "Show API key";
});

fontSizeSelect.addEventListener("change", async () => {
  await updateSettings({
    subtitleFontSize: normalizeFontSize(fontSizeSelect.value)
  });
});

renderLanguageOptions();
renderFontSizeOptions();
if (!hasLoadedSettings) loadSettings();
refreshProgress();
setInterval(refreshProgress, REFRESH_MS);
