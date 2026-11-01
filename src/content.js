import {
  SPARKLE,
  createGenerateControls,
  editorTextEquals,
  initToneMenu,
  isVisible,
  nextFrame,
  observeFeed,
  pasteIntoEditor,
  pasteText,
  selectEditorContents,
  setBusy,
  sleep,
  toast,
  waitFor,
  wrapWithRegenerateButton,
} from "./content-common.js";

const SELECTORS = {
  article: 'article[data-testid="tweet"]',
  text: '[data-testid="tweetText"]',
  user: '[data-testid="User-Name"]',
  reply: '[data-testid="reply"]',
  photo: '[data-testid="tweetPhoto"] img',
  editor: '[data-testid="tweetTextarea_0"]',
  dialog: '[role="dialog"]',
};

initToneMenu();

/* ---------- post extraction ---------- */

// Timeline photos are served at a small size; ask for the "medium" variant
// so text inside screenshots stays legible for the vision model.
function photoUrl(src) {
  try {
    const url = new URL(src);
    if (url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/")) return "";
    url.searchParams.set("name", "medium");
    return url.href;
  } catch {
    return "";
  }
}

function extractTweet(article) {
  const textElements = [...article.querySelectorAll(SELECTORS.text)];
  const text = textElements[0]?.innerText?.trim() || "";
  const quoted = textElements
    .slice(1)
    .map((element) => element.innerText.trim())
    .filter(Boolean)
    .join("\n---\n");

  let name = "";
  let handle = "";
  const userElement = article.querySelector(SELECTORS.user);
  if (userElement) {
    const spans = [...userElement.querySelectorAll("span")]
      .map((span) => span.textContent.trim())
      .filter(Boolean);
    handle = spans.find((value) => /^@[\w_]+$/.test(value)) || "";
    name = spans.find((value) => value !== "·" && !value.startsWith("@")) || "";
  }

  const photos = [...article.querySelectorAll(SELECTORS.photo)];
  const imageAlts = photos
    .map((image) => image.alt?.trim())
    .filter((alt) => alt && alt.toLowerCase() !== "image");
  const imageUrls = [...new Set(photos.map((image) => photoUrl(image.src)).filter(Boolean))].slice(0, 4);

  return { text, quoted, name, handle, imageAlts, imageUrls };
}

function hasContent(tweet) {
  return Boolean(tweet.text || tweet.quoted || tweet.imageAlts.length || tweet.imageUrls.length);
}

// Status ID from the tweet's permalink (the link wrapping its timestamp).
function tweetId(article) {
  const link = article.querySelector('a[href*="/status/"] time')?.closest("a");
  return link?.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1] || "";
}

/* ---------- composer handling ---------- */

function resolveEditable(element) {
  if (!(element instanceof HTMLElement)) return null;
  if (element.getAttribute("contenteditable") === "true") return element;
  return element.querySelector('[contenteditable="true"]');
}

function getVisibleEditors() {
  const editors = [];
  for (const container of document.querySelectorAll(SELECTORS.editor)) {
    const editor = resolveEditable(container);
    if (editor && isVisible(editor) && !editors.includes(editor)) editors.push(editor);
  }
  return editors;
}

function findDialogEditor() {
  const dialogs = [...document.querySelectorAll(SELECTORS.dialog)].reverse();
  for (const dialog of dialogs) {
    if (!isVisible(dialog)) continue;
    const editor = resolveEditable(dialog.querySelector(SELECTORS.editor));
    if (editor && isVisible(editor)) return editor;
  }
  return null;
}

function findFocusedEditor() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const editor = active.matches('[contenteditable="true"]')
    ? active
    : active.closest('[contenteditable="true"]');
  return editor && editor.closest(SELECTORS.editor) && isVisible(editor) ? editor : null;
}

function findCurrentEditor(fallback = null) {
  return (
    findDialogEditor() ||
    findFocusedEditor() ||
    (fallback && isVisible(fallback) ? fallback : null)
  );
}

async function openReplyComposer(article) {
  const replyButton = article.querySelector(SELECTORS.reply);
  if (!replyButton) throw new Error("Couldn't find the reply button on this post.");

  const existingEditors = new Set(getVisibleEditors());
  replyButton.click();

  const editor = await waitForReplyEditor(existingEditors);
  if (!editor) throw new Error("The reply box didn't open. Try again.");
  return editor;
}

// Wait for the composer that X opens after its reply button is clicked.
function waitForReplyEditor(existingEditors) {
  return waitFor(() => {
    const dialogEditor = findDialogEditor();
    if (dialogEditor) return dialogEditor;

    const focusedEditor = findFocusedEditor();
    if (focusedEditor) return focusedEditor;

    return getVisibleEditors().find((candidate) => !existingEditors.has(candidate)) || null;
  });
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function isPunctuation(char) {
  return char === "." || char === "," || char === "!" ||
    char === "?" || char === ";" || char === ":" || char === "\n";
}

// Editor text with whitespace collapsed, for comparing against what was typed.
function normalizedText(value) {
  return value.replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
}

// Typewriter-style insertion. X's anti-spam system flags replies where the
// text appears all at once as "looks automated", so we simulate human typing
// instead: small chunks (1–3 chars) with variable delays, and longer pauses
// at word/punctuation boundaries.
//
// Each chunk goes in as a small synthetic paste, the one input path Draft.js
// handles cleanly (synthetic `beforeinput` is ignored and `execCommand`
// inserts text twice). After every chunk the editor must match exactly what
// has been typed so far; otherwise this returns false and the caller replaces
// everything with a single paste.
async function typeIntoEditor(editor, text) {
  editor.focus();
  await nextFrame();

  // The first chunk replaces any existing text (e.g. on regenerate).
  selectEditorContents(editor);

  let typed = "";
  let index = 0;
  while (index < text.length) {
    if (!editor.isConnected) return false;

    const roll = Math.random();
    const chunkSize = roll < 0.2 ? 1 : roll < 0.7 ? 2 : 3;
    const chunk = text.slice(index, index + chunkSize);
    index += chunkSize;
    typed += chunk;

    pasteText(editor, chunk);
    await nextFrame();
    const actual = editor.innerText || editor.textContent || "";
    if (normalizedText(actual) !== normalizedText(typed)) return false;

    // Fast typing between chunks, a short pause between words, and a longer
    // one after punctuation.
    const last = chunk[chunk.length - 1];
    const delay = isPunctuation(last)
      ? randomBetween(60, 130)
      : last === " "
        ? randomBetween(25, 60)
        : randomBetween(12, 40);
    await sleep(delay);
  }

  // Let Draft.js flush the final render before we return.
  await nextFrame();
  await nextFrame();
  return true;
}

async function insertIntoEditor(editor, text) {
  if (!editor || !isVisible(editor)) {
    throw new Error("The reply box was closed before the draft was ready.");
  }

  const typed = await typeIntoEditor(editor, text);
  if (typed && editorTextEquals(editor, text)) return;

  // The editor ignored the typed input or ended up with different text:
  // replace everything with a single paste as a last resort.
  await pasteIntoEditor(editor, text);
}

/* ---------- reply generation ---------- */

async function requestDraft(tweet, tone = null) {
  const response = await chrome.runtime.sendMessage({
    type: "GENERATE_REPLY",
    platform: "x",
    tweet,
    tone,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Reply generation failed.");
  }
  return response.text;
}

async function handleGenerate(article, button, toneOverride) {
  if (button.dataset.busy === "1") return;

  const tweet = extractTweet(article);
  if (!hasContent(tweet)) {
    toast("Couldn't read this post's content.");
    return;
  }

  setBusy(button, true, SPARKLE);

  try {
    // Opening the native composer and requesting a draft can happen together.
    // The default tone reuses a background draft when one exists.
    const [originalEditor, text] = await Promise.all([
      openReplyComposer(article),
      toneOverride ? requestDraft(tweet, toneOverride) : getDraft(article, tweet),
    ]);

    await sleep(120);
    const editor = findCurrentEditor(originalEditor);
    await insertIntoEditor(editor, text);
    trackDraft(editor, article, text);
    injectRegenerateButton(editor, article, toneOverride);
    toast("Reply drafted ✨ — review it, then press Reply.", false);
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    setBusy(button, false, SPARKLE);
  }
}

/* ---------- regenerate button (injected into the reply dialog) ---------- */

// X renders the reply dialog itself, so the regenerate control has to live
// inside X's DOM. We anchor it directly to the left of the Reply (submit)
// button (see `wrapWithRegenerateButton`). The button is only ever added on
// a successful `insertIntoEditor` — failures never produce one.

function injectRegenerateButton(editor, article, toneOverride) {
  if (!editor) return;

  // Walk up from the editor (which is always inside the composer) and find
  // the composer submit button by its visible text. Searching the whole
  // dialog by testid can match buttons inside the original tweet or a
  // quoted tweet rendered at the top of the dialog — those would put the
  // regen button in the wrong place.
  const replyButton = findComposerReplyButton(editor);
  if (!replyButton) return;
  watchSubmit(editor, replyButton);

  wrapWithRegenerateButton(replyButton, (button) =>
    regenerateReply({ article, editor, button, toneOverride }),
  );
}

// Find the composer submit button inside the reply dialog. The Reply button
// lives in the composer's *footer*, which is a sibling of the editor's
// subtree — so we can't walk up from the editor to find it. Instead we
// search the whole dialog, but with two layers of filtering to make sure
// we grab the actual submit button and not something else (e.g., a button
// inside the original tweet being replied to, or an "unverified reply"
// button on a quoted tweet).
//
// Layer 1: known testids inside the dialog. These are stable enough across
// X layouts to use as the primary signal.
// Layer 2: text matching ("reply" / "tweet" / "post" / "send") as a sanity
// check on whatever the testid query returns.
// Layer 3: scan all buttons in the dialog for a matching text label.
function findComposerReplyButton(editor) {
  const dialog = editor.closest(SELECTORS.dialog);
  if (!dialog) return null;

  const isSubmitLabel = (btn) => {
    if (!btn) return false;
    if (btn.classList.contains("xra-regen")) return false;
    if (btn.closest(".xra-regen-wrap")) return false;
    const text = (btn.textContent || "").trim().toLowerCase();
    return text === "reply" || text === "tweet" || text === "post" || text === "send";
  };

  // Layer 1+2: testid candidates whose text is a submit label.
  const testidCandidates = [
    dialog.querySelector('[data-testid="tweetButtonInlineCompose"]'),
    dialog.querySelector('[data-testid="tweetButton"]'),
  ];
  for (const btn of testidCandidates) {
    if (isSubmitLabel(btn)) return btn;
  }

  // Layer 3: scan all buttons in the dialog.
  const allButtons = dialog.querySelectorAll('button, [role="button"]');
  for (const btn of allButtons) {
    if (isSubmitLabel(btn)) return btn;
  }

  // Last resort: take the first testid candidate even if its text doesn't
  // match (X sometimes ships icon-only submit buttons with no text).
  for (const btn of testidCandidates) {
    if (btn && !btn.classList.contains("xra-regen")) return btn;
  }

  return null;
}

async function regenerateReply({ article, editor, button, toneOverride }) {
  if (button.dataset.busy === "1") return;

  const tweet = extractTweet(article);
  if (!hasContent(tweet)) {
    toast("Couldn't read this post's content.");
    return;
  }

  const originalHtml = button.innerHTML;
  setBusy(button, true, originalHtml);

  try {
    const text = await requestDraft(tweet, toneOverride || null);
    if (!toneOverride) setDraft(article, text);

    if (!editor.isConnected || !isVisible(editor)) {
      throw new Error("The reply box was closed before regeneration finished.");
    }

    await insertIntoEditor(editor, text);
    trackDraft(editor, article, text);
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    setBusy(button, false, originalHtml);
  }
}

/* ---------- learning from edits ---------- */

// When the user edits a draft and then posts it, the post, the AI draft, and
// the posted text are saved as a training example (see "Train your voice" in
// the settings). Unedited drafts are not saved: they only show the AI's style.

const trackedDrafts = new WeakMap(); // editor -> { post, sample }

function trackDraft(editor, article, text) {
  const tweet = extractTweet(article);
  const post = tweet.text || tweet.quoted;
  if (post) trackedDrafts.set(editor, { post, sample: text });
}

function captureEdit(editor) {
  const draft = trackedDrafts.get(editor);
  if (!draft) return;
  trackedDrafts.delete(editor);

  const reply = (editor.innerText || editor.textContent || "").replace(/\u200b/g, "").trim();
  if (!reply || normalizedText(reply) === normalizedText(draft.sample)) return;

  chrome.runtime
    .sendMessage({ type: "SAVE_EXAMPLE", platform: "x", post: draft.post, sample: draft.sample, reply })
    .then((response) => {
      if (response?.ok) toast("Saved your edit ✍️ Updating your style rules…", false);
    })
    .catch((error) => console.warn("[X Reply Assistant]", error));
}

// Read the editor before X clears it: capture-phase listeners on the submit
// button and on Ctrl/Cmd+Enter in the editor.
function watchSubmit(editor, submitButton) {
  if (submitButton.dataset.xraWatch !== "1") {
    submitButton.dataset.xraWatch = "1";
    submitButton.addEventListener("click", () => captureEdit(editor), true);
  }
  if (editor.dataset.xraWatch !== "1") {
    editor.dataset.xraWatch = "1";
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) captureEdit(editor);
    }, true);
  }
}

/* ---------- background drafts ---------- */

// Good reply targets get a default-tone draft while the user scrolls past
// them, so the reply box can be filled as soon as it opens. Drafts are keyed
// by status ID because X recycles article nodes in its virtualized timeline.

const MAX_DRAFTS = 50;
const DWELL_MS = 1_000;

const drafts = new Map(); // status ID -> { promise, text }
const dwellTimers = new Map(); // article -> timeout ID
let autoDraft = false;

// Return the default-tone draft for a tweet, requesting one unless it is
// already cached or in flight. Failed requests are dropped so they can retry.
function getDraft(article, tweet = extractTweet(article)) {
  const id = tweetId(article);
  if (!id) return requestDraft(tweet);

  const cached = drafts.get(id);
  if (cached) return cached.promise;

  const entry = { promise: requestDraft(tweet), text: "" };
  entry.promise.then(
    (text) => {
      entry.text = text;
      markDraftReady(id);
    },
    () => {
      if (drafts.get(id) === entry) drafts.delete(id);
    },
  );
  drafts.set(id, entry);
  if (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
  return entry.promise;
}

function setDraft(article, text) {
  const id = tweetId(article);
  if (id) drafts.set(id, { promise: Promise.resolve(text), text });
}

function markDraftReady(id) {
  for (const article of document.querySelectorAll(SELECTORS.article)) {
    if (tweetId(article) === id) {
      article.querySelector(".xra-wrap")?.classList.add("xra-wrap--draft-ready");
    }
  }
}

function prefetchDraft(article) {
  if (!autoDraft || !article.isConnected) return;
  if (scoreReplyTarget(article) < GOOD_TARGET_THRESHOLD) return;
  const tweet = extractTweet(article);
  if (!hasContent(tweet)) return;
  getDraft(article, tweet).catch((error) => console.warn("[X Reply Assistant]", error));
}

// A tweet counts as "seen" once half of it, or half the viewport for tall
// tweets, has been on screen for DWELL_MS. Fast scrolling never triggers it.
const dwellObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const article = entry.target;
    const seen =
      entry.isIntersecting &&
      (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= window.innerHeight / 2);

    if (!seen) {
      clearTimeout(dwellTimers.get(article));
      dwellTimers.delete(article);
      continue;
    }
    if (dwellTimers.has(article)) continue;

    dwellTimers.set(article, setTimeout(() => {
      dwellTimers.delete(article);
      prefetchDraft(article);
    }, DWELL_MS));
  }
}, { threshold: [0, 0.25, 0.5] });

async function loadAutoDraft() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_PUBLIC_SETTINGS" });
    autoDraft = Boolean(response?.ok && response.autoDraft);
  } catch {
    autoDraft = false;
  }
}

loadAutoDraft();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) loadAutoDraft();
});

/* ---------- filling X's own reply box ---------- */

// When the user clicks X's native reply button on a tweet with a background
// draft (or a good target while auto-drafting is on), type the draft into the
// composer X opens. Capture phase, so the open editors can be recorded before
// X reacts; the event itself is left alone. Synthetic clicks (from ✨) are
// ignored because `handleGenerate` fills the box itself.
document.addEventListener("click", (event) => {
  if (!event.isTrusted || !(event.target instanceof Element)) return;
  const article = event.target.closest(SELECTORS.reply)?.closest(SELECTORS.article);
  if (!article) return;

  const id = tweetId(article);
  if (!id) return;
  if (!drafts.has(id)) {
    if (!autoDraft || scoreReplyTarget(article) < GOOD_TARGET_THRESHOLD) return;
    if (!hasContent(extractTweet(article))) return;
  }
  fillNativeReply(article, id);
}, true);

async function fillNativeReply(article, id) {
  const existingEditors = new Set(getVisibleEditors());
  const draftReady = Boolean(drafts.get(id)?.text);
  const draft = getDraft(article);

  try {
    const openedEditor = await waitForReplyEditor(existingEditors);
    if (!openedEditor) return;
    await sleep(120);
    const editor = findCurrentEditor(openedEditor);
    if (!editor) return;

    if (!draftReady) toast("Drafting a reply…", false);
    const text = await draft;

    // Leave the box alone if it was closed or the user started typing.
    if (!editor.isConnected || !isVisible(editor) || !editorTextEquals(editor, "")) return;
    await insertIntoEditor(editor, text);
    trackDraft(editor, article, text);
    injectRegenerateButton(editor, article, null);
  } catch (error) {
    toast(error?.message || String(error));
  }
}

/* ---------- reply target scoring ---------- */

// Score a tweet 0-100 based on how good a reply target it is. The number
// is displayed on every tweet as a small chip so the user can see the
// actual score; tweets that clear GOOD_TARGET_THRESHOLD are highlighted
// (filled purple chip, glowing generate button).

const OPINION_REGEX = /\b(hot take|unpopular|change my mind|convince me|am i the only|controversial take)\b/i;
const GOOD_TARGET_THRESHOLD = 60;

function scoreReplyTarget(article) {
  if (isOwnOrPromoted(article) || !hasTweetText(article)) return 0;
  const text = (extractTweet(article).text || "").toLowerCase();
  const metrics = readEngagement(article);
  const ageHours = tweetAgeHours(article);
  let score = 0;
  if (ageHours !== null) {
    if (ageHours >= 0 && ageHours < 4) score += 30;
    else if (ageHours < 12) score += 15;
    else if (ageHours < 24) score += 5;
  }
  if (text.includes("?")) score += 12;
  if (OPINION_REGEX.test(text)) score += 15;
  if (metrics.likes >= 1000) score += 15;
  else if (metrics.likes >= 200) score += 10;
  else if (metrics.likes >= 50) score += 5;
  if (metrics.likes > 0) {
    const ratio = metrics.replies / metrics.likes;
    if (ratio > 0.15) score += 20;
    else if (ratio > 0.08) score += 12;
    else if (ratio > 0.03) score += 6;
  }
  if (metrics.views >= 50000) score += 10;
  else if (metrics.views >= 10000) score += 5;
  return Math.min(100, score);
}

function readEngagement(article) {
  const m = { likes: 0, replies: 0, retweets: 0, views: 0 };
  const replyBtn = article.querySelector('[data-testid="reply"]');
  const retweetBtn = article.querySelector('[data-testid="retweet"]');
  const likeBtn = article.querySelector('[data-testid="like"]');
  if (replyBtn) m.replies = parseCount(replyBtn.textContent || replyBtn.getAttribute("aria-label") || "");
  if (retweetBtn) m.retweets = parseCount(retweetBtn.textContent || retweetBtn.getAttribute("aria-label") || "");
  if (likeBtn) m.likes = parseCount(likeBtn.textContent || likeBtn.getAttribute("aria-label") || "");
  const viewEl = article.querySelector('a[href*="/analytics"]') || article.querySelector('[data-testid="viewCount"]');
  if (viewEl) m.views = parseCount(viewEl.textContent || viewEl.getAttribute("aria-label") || "");
  return m;
}

function parseCount(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/,/g, "");
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*([KkMmBb])?/);
  if (!match) return 0;
  let num = parseFloat(match[1]);
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "K") num *= 1_000;
  else if (suffix === "M") num *= 1_000_000;
  else if (suffix === "B") num *= 1_000_000_000;
  return Math.round(num);
}

function tweetAgeHours(article) {
  const timeEl = article.querySelector("time");
  if (!timeEl) return null;
  const t = timeEl.getAttribute("datetime");
  if (!t) return null;
  const ms = Date.now() - new Date(t).getTime();
  if (isNaN(ms)) return null;
  return ms / 3_600_000;
}

function hasTweetText(article) {
  return !!article.querySelector(SELECTORS.text);
}

function isOwnOrPromoted(article) {
  // Own tweets and "Promoted" / "Ad" slots are never reply targets.
  if (article.querySelector('[data-testid="socialContext"]')) return true;
  if (article.querySelector('[data-testid="placementTracking"]')) return true;
  return false;
}

function explainTargetScore(article) {
  // Human-readable reasons for a high score, used in tooltips. Only the
  // signals that actually contributed points are listed.
  const reasons = [];
  const ageHours = tweetAgeHours(article);
  if (ageHours !== null && ageHours < 4) reasons.push("recent");
  else if (ageHours !== null && ageHours < 12) reasons.push("fresh");
  const text = (extractTweet(article).text || "").toLowerCase();
  if (text.includes("?")) reasons.push("asks a question");
  if (OPINION_REGEX.test(text)) reasons.push("invites takes");
  const metrics = readEngagement(article);
  if (metrics.likes >= 200) reasons.push("high reach");
  if (metrics.likes > 0 && metrics.replies / metrics.likes > 0.08) reasons.push("active discussion");
  if (metrics.views >= 10000) reasons.push("trending");
  return reasons;
}

/* ---------- action-bar injection ---------- */

// Inject the visible score chip for one tweet. Idempotent — the dataset
// flag and the class-name lookup both prevent duplicate work. Sits in the
// same row as the existing reply/retweet/like buttons (the action group)
// so it doesn't overlap the tweet text or the avatar.
function injectScoreChip(article) {
  if (article.dataset.xraScoreChip === "1" || article.querySelector(".xra-target-score")) {
    return;
  }

  const score = scoreReplyTarget(article);
  article.dataset.xraTargetScore = String(score);

  const chip = document.createElement("span");
  chip.className = "xra-target-score";
  if (score >= GOOD_TARGET_THRESHOLD) chip.classList.add("xra-target-score--good");
  chip.textContent = String(score);
  chip.setAttribute("data-xra-score", String(score));
  chip.setAttribute("aria-label", `Reply target score: ${score} out of 100`);
  chip.setAttribute(
    "title",
    score >= GOOD_TARGET_THRESHOLD
      ? `Good reply target — ${explainTargetScore(article).join(", ") || "worth a reply"} (${score}/100)`
      : `Reply target score: ${score}/100`,
  );

  // Prefer the action group (the natural row of reply/retweet/like buttons);
  // sit to the LEFT of our generate wrapper when both exist, so the chip +
  // wrapper are visually paired at the end of the action row. Fall back to
  // appending to the article if the action group is missing — the chip's
  // CSS handles absolute positioning in that case.
  const actionGroup = article.querySelector('[role="group"]');
  const wrapper = article.querySelector(".xra-wrap");
  if (actionGroup) {
    if (wrapper) {
      actionGroup.insertBefore(chip, wrapper);
    } else {
      actionGroup.appendChild(chip);
    }
  } else {
    article.appendChild(chip);
  }

  article.dataset.xraScoreChip = "1";
}

function injectButton(article) {
  // Always inject the score chip first — every tweet gets a score, even if
  // the action group is missing (so the button can't be added).
  injectScoreChip(article);
  dwellObserver.observe(article);

  if (article.dataset.xraInjected === "1" || article.querySelector(".xra-wrap")) {
    return;
  }

  const replyButton = article.querySelector(SELECTORS.reply);
  const actionGroup = replyButton?.closest('[role="group"]');
  if (!actionGroup || !article.contains(actionGroup)) return;

  // Highlight the wrapper for high-scoring targets. The chip already
  // reflects the score visually; this gives the generate button itself
  // a "this one's worth a reply" cue.
  const score = Number(article.dataset.xraTargetScore || "0");
  const isGood = score >= GOOD_TARGET_THRESHOLD;

  const { wrapper } = createGenerateControls({
    title: isGood
      ? `Good reply target (${score}/100) — click to draft a reply`
      : "Generate AI reply",
    onGenerate: (button, toneId) => handleGenerate(article, button, toneId),
  });
  if (isGood) wrapper.classList.add("xra-wrap--good-target");
  if (drafts.get(tweetId(article))?.text) wrapper.classList.add("xra-wrap--draft-ready");

  actionGroup.appendChild(wrapper);
  article.dataset.xraInjected = "1";
}

observeFeed(SELECTORS.article, injectButton);
