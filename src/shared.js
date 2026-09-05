export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyHint: "sk-…",
  },
  deepseek: {
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    keyHint: "sk-…",
  },
  minimax: {
    label: "MiniMax",
    baseURL: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M1",
    keyHint: "eyJhbGciOi…",
  },
};

export const TONES = {
  general: {
    label: "General",
    prompt: "a natural, thoughtful reply that adds something to the conversation.",
  },
  funny: {
    label: "Funny",
    prompt:
      "a genuinely funny, light-hearted reply. Use humor, wordplay, or an unexpected observation. Be playful, never mean.",
  },
  sarcastic: {
    label: "Sarcastic",
    prompt:
      "a dry, sarcastic reply with sharp wit and deadpan delivery. Be clever, not cruel. Do not use emojis.",
  },
  supportive: {
    label: "Supportive",
    prompt:
      "a warm, encouraging, empathetic reply that makes the author feel heard and appreciated. Be sincere, not saccharine.",
  },
  hot_take: {
    label: "Hot take",
    prompt:
      "a bold, provocative hot take that challenges the conventional view of the post. Be confident, punchy, and designed to spark discussion.",
  },
  insightful: {
    label: "Insightful",
    prompt:
      "an insightful reply that adds a non-obvious perspective, useful fact, or nuance. Be smart but accessible.",
  },
  question: {
    label: "Curious question",
    prompt:
      "a genuinely curious follow-up question that invites the author to elaborate. Ask one question only.",
  },
  contrarian: {
    label: "Contrarian",
    prompt:
      "a respectful but firm disagreement with the post that gives one strong counter-argument.",
  },
  hype: {
    label: "Hype",
    prompt:
      "an enthusiastic, high-energy reply that hypes up the post. Keep it short and punchy; at most one emoji.",
  },
  professional: {
    label: "Professional",
    prompt:
      "a polished, professional reply suitable for a business or industry context. Do not use slang or emojis.",
  },
  custom: {
    label: "Custom…",
    prompt: "",
  },
};

export const DEFAULT_SETTINGS = {
  provider: "openai",
  apiKeys: { openai: "", deepseek: "", minimax: "" },
  models: { openai: "", deepseek: "", minimax: "" },
  baseURLs: { openai: "", deepseek: "", minimax: "" },
  tone: "general",
  customTone: "",
  persona: "",
  language: "auto",
  maxChars: 240,
  temperature: 0.9,
};

function mergeRecord(defaultValue, storedValue) {
  const value =
    storedValue && typeof storedValue === "object" && !Array.isArray(storedValue)
      ? storedValue
      : {};
  return { ...defaultValue, ...value };
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  const value =
    stored.settings && typeof stored.settings === "object" ? stored.settings : {};

  return {
    ...DEFAULT_SETTINGS,
    ...value,
    apiKeys: mergeRecord(DEFAULT_SETTINGS.apiKeys, value.apiKeys),
    models: mergeRecord(DEFAULT_SETTINGS.models, value.models),
    baseURLs: mergeRecord(DEFAULT_SETTINGS.baseURLs, value.baseURLs),
  };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
