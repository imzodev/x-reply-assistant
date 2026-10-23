import {
  SPARKLE,
  createGenerateControls,
  editorTextEquals,
  initToneMenu,
  isVisible,
  observeFeed,
  pasteIntoEditor,
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

  const editor = await waitFor(() => {
    const dialogEditor = findDialogEditor();
    if (dialogEditor) return dialogEditor;

    const focusedEditor = findFocusedEditor();
    if (focusedEditor) return focusedEditor;

    return getVisibleEditors().find((candidate) => !existingEditors.has(candidate)) || null;
  });

  if (!editor) throw new Error("The reply box didn't open. Try again.");
  return editor;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function isPunctuation(char) {
  return char === " " || char === "." || char === "," || char === "!" ||
    char === "?" || char === ";" || char === ":" || char === "\n";
}

async function typeIntoEditor(editor, text) {
  // Typewriter-style insertion. X's anti-spam system flags replies where the
  // text appears all at once (via a paste event) as "looks automated", so we
  // simulate human typing instead: small chunks (1–3 chars) with variable
  // delays, and longer pauses at word/punctuation boundaries.

  editor.focus();
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));

  // Clear any existing draft by selecting all and dispatching a delete event.
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  editor.dispatchEvent(
    new InputEvent("beforeinput", {
      inputType: "deleteContentBackward",
      bubbles: true,
      cancelable: true,
    }),
  );
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));

  // Type the text in small chunks. Random chunk size keeps the timing
  // pattern from looking mechanical.
  let index = 0;
  while (index < text.length) {
    const roll = Math.random();
    const chunkSize = roll < 0.2 ? 1 : roll < 0.7 ? 2 : 3;
    const chunk = text.slice(index, index + chunkSize);
    index += chunkSize;

    editor.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: chunk,
        bubbles: true,
        cancelable: true,
      }),
    );

    // Base delay between chunks: 25–90ms (looks like fast typing).
    // Longer pause after punctuation and spaces (looks like a human pausing
    // to think or to start a new word).
    let delay = randomBetween(25, 90);
    if (isPunctuation(chunk[chunk.length - 1])) {
      delay = randomBetween(120, 280);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // Let Draft.js flush the final render before we return.
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function insertIntoEditor(editor, text) {
  if (!editor || !isVisible(editor)) {
    throw new Error("The reply box was closed before the draft was ready.");
  }

  await typeIntoEditor(editor, text);

  if (editorTextEquals(editor, text)) return;

  // If the typewriter path somehow didn't land the full text (rare — would
  // mean Draft.js ignored one or more beforeinput events), fall back to a
  // single paste as a last resort. The paste path avoids the duplicate
  // render that direct beforeinput caused in earlier versions.
  await pasteIntoEditor(editor, text);
}

/* ---------- reply generation ---------- */

async function handleGenerate(article, button, toneOverride) {
  if (button.dataset.busy === "1") return;

  const tweet = extractTweet(article);
  if (!tweet.text && !tweet.quoted && !tweet.imageAlts.length && !tweet.imageUrls.length) {
    toast("Couldn't read this post's content.");
    return;
  }

  setBusy(button, true, SPARKLE);

  try {
    // Opening the native composer and requesting a draft can happen together.
    const [originalEditor, response] = await Promise.all([
      openReplyComposer(article),
      chrome.runtime.sendMessage({
        type: "GENERATE_REPLY",
        platform: "x",
        tweet,
        tone: toneOverride || null,
      }),
    ]);

    if (!response?.ok) {
      throw new Error(response?.error || "Reply generation failed.");
    }

    await sleep(120);
    const editor = findCurrentEditor(originalEditor);
    await insertIntoEditor(editor, response.text);
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
  if (!tweet.text && !tweet.quoted && !tweet.imageAlts.length && !tweet.imageUrls.length) {
    toast("Couldn't read this post's content.");
    return;
  }

  const originalHtml = button.innerHTML;
  setBusy(button, true, originalHtml);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_REPLY",
      platform: "x",
      tweet,
      tone: toneOverride || null,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Reply regeneration failed.");
    }

    if (!editor.isConnected || !isVisible(editor)) {
      throw new Error("The reply box was closed before regeneration finished.");
    }

    await insertIntoEditor(editor, response.text);
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    setBusy(button, false, originalHtml);
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

  actionGroup.appendChild(wrapper);
  article.dataset.xraInjected = "1";
}

observeFeed(SELECTORS.article, injectButton);
