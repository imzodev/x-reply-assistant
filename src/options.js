import {
  EXAMPLES_IN_PROMPT,
  MAX_EXAMPLES,
  PROVIDERS,
  TONES,
  loadExamples,
  loadSettings,
  saveExamples,
  saveSettings,
} from "./shared.js";

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
  $("linkedinMaxChars").value = settings.linkedinMaxChars;
  $("temperature").value = settings.temperature;
  $("analyzeImages").checked = settings.analyzeImages !== false;
  $("autoDraft").checked = settings.autoDraft !== false;
  $("styleNotes").value = settings.styleNotes || "";
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
  settings.linkedinMaxChars = Math.min(1250, Math.max(40, Math.round(Number($("linkedinMaxChars").value) || 400)));

  settings.analyzeImages = $("analyzeImages").checked;
  settings.autoDraft = $("autoDraft").checked;
  settings.styleNotes = $("styleNotes").value.trim();

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

/* ---------- train your voice ---------- */

let examples = [];
let editingId = null;
// The AI draft currently in the reply box, saved alongside the edit.
let currentSample = "";

function setTrainStatus(message, isError = false) {
  const status = $("trainStatus");
  status.textContent = message;
  status.style.color = isError ? "#d92d20" : "#16a34a";
}

function setTrainBusy(isBusy) {
  $("trainGenerate").disabled = isBusy;
  $("trainSave").disabled = isBusy;
}

function resetTrainForm() {
  editingId = null;
  currentSample = "";
  $("trainPost").value = "";
  $("trainReply").value = "";
  $("trainSave").textContent = "Save example";
  $("trainCancel").classList.add("hidden");
}

function renderExamples() {
  const list = $("exampleList");
  list.replaceChildren();

  for (const example of examples) {
    const item = document.createElement("li");
    item.className = `example${example.id === editingId ? " editing" : ""}`;

    const post = document.createElement("div");
    post.className = "example-post";
    post.textContent = example.post;
    post.title = example.post;

    const reply = document.createElement("div");
    reply.className = "example-reply";
    reply.textContent = example.reply;

    const meta = document.createElement("div");
    meta.className = "example-meta";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = example.platform === "linkedin" ? "LinkedIn" : "X";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editExample(example.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteExample(example.id));
    meta.append(badge, edit, remove);

    item.append(post, reply, meta);
    list.appendChild(item);
  }

  const count = examples.length;
  $("exampleCount").textContent = count
    ? `${count} example${count === 1 ? "" : "s"} saved. The ${EXAMPLES_IN_PROMPT} most recent per platform are used.`
    : "";
}

async function generateSample() {
  const post = $("trainPost").value.trim();
  if (!post) {
    setTrainStatus("Paste a post first.", true);
    return;
  }

  setTrainBusy(true);
  setTrainStatus("Generating…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_REPLY",
      platform: $("trainPlatform").value,
      tweet: { text: post, quoted: "", name: "", handle: "", imageAlts: [], imageUrls: [] },
      tone: null,
    });
    if (!response?.ok) throw new Error(response?.error || "Reply generation failed.");
    currentSample = response.text;
    $("trainReply").value = response.text;
    $("trainReply").focus();
    setTrainStatus("Edit the reply until it sounds like you, then save.");
  } catch (error) {
    setTrainStatus(error?.message || String(error), true);
  } finally {
    setTrainBusy(false);
  }
}

async function saveExample() {
  const post = $("trainPost").value.trim();
  const reply = $("trainReply").value.trim();
  if (!post || !reply) {
    setTrainStatus("Both the post and your reply are needed.", true);
    return;
  }

  const fields = { platform: $("trainPlatform").value, post, reply, sample: currentSample };
  const existing = examples.find((example) => example.id === editingId);
  if (existing) {
    Object.assign(existing, fields);
  } else {
    examples.unshift({ id: crypto.randomUUID(), createdAt: Date.now(), ...fields });
  }

  setTrainBusy(true);
  try {
    examples = examples.slice(0, MAX_EXAMPLES);
    await saveExamples(examples);
    resetTrainForm();
    renderExamples();
    refreshStyle(existing ? "Example updated ✓ Style rules updated." : "Example saved ✓ Style rules updated.");
  } catch (error) {
    setTrainStatus(error?.message || String(error), true);
  } finally {
    setTrainBusy(false);
  }
}

// Ask the worker to update the style notes from the current examples. The
// new notes arrive through `chrome.storage.onChanged` (see below).
async function refreshStyle(doneMessage) {
  $("summarizeStyle").disabled = true;
  setTrainStatus("Updating your style rules…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "REFRESH_STYLE" });
    if (!response?.ok) throw new Error(response?.error || "Could not update your style rules.");
    setTrainStatus(doneMessage);
  } catch (error) {
    setTrainStatus(error?.message || String(error), true);
  } finally {
    $("summarizeStyle").disabled = false;
  }
}

function editExample(id) {
  const example = examples.find((candidate) => candidate.id === id);
  if (!example) return;
  editingId = id;
  currentSample = example.sample || "";
  $("trainPlatform").value = example.platform === "linkedin" ? "linkedin" : "x";
  $("trainPost").value = example.post;
  $("trainReply").value = example.reply;
  $("trainSave").textContent = "Update example";
  $("trainCancel").classList.remove("hidden");
  setTrainStatus("");
  renderExamples();
  $("trainReply").focus();
}

async function deleteExample(id) {
  examples = examples.filter((example) => example.id !== id);
  if (editingId === id) resetTrainForm();
  try {
    await saveExamples(examples);
    renderExamples();
    refreshStyle("Example deleted. Style rules updated.");
  } catch (error) {
    setTrainStatus(error?.message || String(error), true);
    renderExamples();
  }
}

(async () => {
  try {
    settings = await loadSettings();
    examples = await loadExamples();
    renderExamples();
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

    $("trainGenerate").addEventListener("click", generateSample);
    $("trainSave").addEventListener("click", saveExample);
    $("summarizeStyle").addEventListener("click", () => refreshStyle("Style rules updated ✓"));

    // Style notes and examples also change from X (edits captured there) and
    // from the worker; keep this page in sync so Save never writes stale notes.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.settings) {
        const notes = changes.settings.newValue?.styleNotes || "";
        settings.styleNotes = notes;
        $("styleNotes").value = notes;
      }
      if (changes.examples && editingId === null) {
        examples = Array.isArray(changes.examples.newValue) ? changes.examples.newValue : [];
        renderExamples();
      }
    });
    $("trainCancel").addEventListener("click", () => {
      resetTrainForm();
      setTrainStatus("");
      renderExamples();
    });
  } catch (error) {
    setStatus(`Could not load settings: ${error?.message || String(error)}`, true);
  }
})();
