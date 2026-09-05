import { PROVIDERS, TONES, loadSettings, saveSettings } from "./shared.js";

const $ = (id) => document.getElementById(id);
let settings;
let activeProvider;

function fillTones() {
  const toneSelect = $("tone");
  toneSelect.replaceChildren();
  for (const [id, tone] of Object.entries(TONES)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = tone.label;
    toneSelect.appendChild(option);
  }
}

function ensureProvider(provider) {
  return Object.hasOwn(PROVIDERS, provider) ? provider : "openai";
}

function stashProviderFields(provider = activeProvider) {
  if (!provider || !settings) return;
  settings.apiKeys[provider] = $("apiKey").value.trim();
  settings.models[provider] = $("model").value.trim();
  settings.baseURLs[provider] = $("baseURL").value.trim();
}

function renderProviderFields() {
  const providerId = ensureProvider($("provider").value);
  const provider = PROVIDERS[providerId];
  activeProvider = providerId;

  $("apiKey").value = settings.apiKeys[providerId] || "";
  $("apiKey").placeholder = provider.keyHint;
  $("model").value = settings.models[providerId] || "";
  $("model").placeholder = provider.defaultModel;
  $("modelHint").textContent = `Default: ${provider.defaultModel}`;
  $("baseURL").value = settings.baseURLs[providerId] || "";
  $("baseURL").placeholder = provider.baseURL;
  $("baseHint").textContent = `Default: ${provider.baseURL}`;
}

function render() {
  settings.provider = ensureProvider(settings.provider);
  $("provider").value = settings.provider;
  $("tone").value = Object.hasOwn(TONES, settings.tone) ? settings.tone : "general";
  $("customTone").value = settings.customTone || "";
  $("customToneWrap").classList.toggle("hidden", $("tone").value !== "custom");
  $("persona").value = settings.persona || "";
  $("language").value = settings.language || "auto";
  $("maxChars").value = settings.maxChars;
  $("temperature").value = settings.temperature;
  renderProviderFields();
}

function collectForm() {
  stashProviderFields();
  settings.provider = ensureProvider($("provider").value);
  settings.tone = Object.hasOwn(TONES, $("tone").value) ? $("tone").value : "general";
  settings.customTone = $("customTone").value.trim();
  settings.persona = $("persona").value.trim();
  settings.language = $("language").value.trim() || "auto";
  settings.maxChars = Math.min(280, Math.max(40, Math.round(Number($("maxChars").value) || 240)));

  const temperature = Number($("temperature").value);
  settings.temperature = Number.isFinite(temperature)
    ? Math.min(2, Math.max(0, temperature))
    : 0.9;
}

async function ensureHostPermission(baseURL) {
  if (!baseURL) return true;

  try {
    const url = new URL(baseURL);
    if (url.protocol !== "https:") return false;
    const originPattern = `${url.origin}/*`;
    if (await chrome.permissions.contains({ origins: [originPattern] })) return true;
    return await chrome.permissions.request({ origins: [originPattern] });
  } catch {
    return false;
  }
}

function setStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  status.style.color = isError ? "#d92d20" : "#16a34a";
}

function setBusy(isBusy) {
  $("save").disabled = isBusy;
  $("test").disabled = isBusy;
}

async function persistSettings() {
  collectForm();
  const baseURL = settings.baseURLs[settings.provider];
  if (baseURL && !(await ensureHostPermission(baseURL))) {
    throw new Error("Permission for the custom HTTPS base URL was denied or the URL is invalid.");
  }
  await saveSettings(settings);
}

async function save() {
  setBusy(true);
  try {
    await persistSettings();
    setStatus("Saved ✓");
  } catch (error) {
    setStatus(error?.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function test() {
  setBusy(true);
  try {
    await persistSettings();
    setStatus("Testing…");
    const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    if (!response?.ok) throw new Error(response?.error || "Connection test failed.");
    setStatus(`OK: ${response.text}`);
  } catch (error) {
    setStatus(error?.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

(async () => {
  try {
    settings = await loadSettings();
    fillTones();
    render();

    $("provider").addEventListener("change", () => {
      stashProviderFields();
      settings.provider = ensureProvider($("provider").value);
      renderProviderFields();
    });

    for (const id of ["apiKey", "model", "baseURL"]) {
      $(id).addEventListener("input", () => stashProviderFields());
    }

    $("tone").addEventListener("change", () => {
      $("customToneWrap").classList.toggle("hidden", $("tone").value !== "custom");
    });
    $("save").addEventListener("click", save);
    $("test").addEventListener("click", test);
  } catch (error) {
    setStatus(`Could not load settings: ${error?.message || String(error)}`, true);
  }
})();
