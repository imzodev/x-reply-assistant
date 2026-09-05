import { TONES } from "./shared.js";

const SELECTORS = {
  article: 'article[data-testid="tweet"]',
  text: '[data-testid="tweetText"]',
  user: '[data-testid="User-Name"]',
  reply: '[data-testid="reply"]',
  photo: '[data-testid="tweetPhoto"] img',
  editor: '[data-testid="tweetTextarea_0"]',
  dialog: '[role="dialog"]',
};

const SPARKLE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
  <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9L19 13zM5 14l.7 2 2 .7-2 .7L5 19.5l-.7-2.1-2-.7 2-.7L5 14z" />
</svg>`;

const SPINNER = `<svg viewBox="0 0 24 24" width="18" height="18" class="xra-spin" aria-hidden="true">
  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" fill="none" stroke-dasharray="40 20" />
</svg>`;

const REFRESH = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
  <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
</svg>`;

function toast(message, isError = true) {
  document.querySelectorAll(".xra-toast").forEach((element) => element.remove());
  const element = document.createElement("div");
  element.className = `xra-toast${isError ? " xra-toast-error" : ""}`;
  element.textContent = message;
  element.setAttribute("role", isError ? "alert" : "status");
  document.body.appendChild(element);
  window.setTimeout(() => element.remove(), 4_500);
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitFor(callback, timeout = 6_000, interval = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = callback();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

function isVisible(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function stopArticleNavigation(event) {
  event.preventDefault();
  event.stopPropagation();
}

/* ---------- post extraction ---------- */

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

  const imageAlts = [...article.querySelectorAll(SELECTORS.photo)]
    .map((image) => image.alt?.trim())
    .filter((alt) => alt && alt.toLowerCase() !== "image");

  return { text, quoted, name, handle, imageAlts };
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

function selectEditorContents(editor) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

function editorTextEquals(editor, expected) {
  const actual = (editor.innerText || editor.textContent || "").trim();
  return actual === expected.trim();
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
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  editor.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }),
  );

  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await sleep(200);
}

/* ---------- reply generation ---------- */

async function handleGenerate(article, button, toneOverride) {
  if (button.dataset.busy === "1") return;

  const tweet = extractTweet(article);
  if (!tweet.text && !tweet.quoted && !tweet.imageAlts.length) {
    toast("Couldn't read this post's content.");
    return;
  }

  button.dataset.busy = "1";
  button.disabled = true;
  button.innerHTML = SPINNER;
  button.classList.add("xra-busy");

  try {
    // Opening the native composer and requesting a draft can happen together.
    const [originalEditor, response] = await Promise.all([
      openReplyComposer(article),
      chrome.runtime.sendMessage({
        type: "GENERATE_REPLY",
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
    if (button.isConnected) {
      button.dataset.busy = "0";
      button.disabled = false;
      button.innerHTML = SPARKLE;
      button.classList.remove("xra-busy");
    }
  }
}

/* ---------- regenerate button (injected into the reply dialog) ---------- */

// X renders the reply dialog itself, so the regenerate control has to live
// inside X's DOM. We anchor it directly to the left of the Reply (submit)
// button, inside a row-flex wrapper that we control. That wrapper is what
// guarantees horizontal placement regardless of whether X's action cluster
// is row- or column-flexed — on column-flex layouts the regen button would
// otherwise land above the Reply button.
//
// Re-injecting is idempotent: any prior wrapper is unwrapped (the Reply
// button is moved back to its original parent) before a fresh one is
// created. The button is only ever added on a successful `insertIntoEditor`
// — failures never produce one.

function injectRegenerateButton(editor, article, toneOverride) {
  if (!editor) return;

  // Walk up from the editor (which is always inside the composer) and find
  // the composer submit button by its visible text. Searching the whole
  // dialog by testid can match buttons inside the original tweet or a
  // quoted tweet rendered at the top of the dialog — those would put the
  // regen button in the wrong place.
  const replyButton = findComposerReplyButton(editor);
  if (!replyButton) return;

  // If a previous injection wrapped the Reply button, put it back where it
  // was before we re-wrap. Idempotent.
  unwrapReplyButton(replyButton);

  const host = replyButton.parentElement;
  if (!host) return;

  const button = document.createElement("button");
  button.className = "xra-regen";
  button.type = "button";
  button.setAttribute("aria-label", "Regenerate reply");
  button.title = "Regenerate reply";
  button.innerHTML = REFRESH;

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    regenerateReply({ article, editor, button, toneOverride });
  });

  // Wrap the Reply button in a row-flex container along with the regen
  // button. This guarantees the regen button sits horizontally to the left
  // of the Reply button no matter how X has laid out the cluster above us.
  const wrapper = document.createElement("div");
  wrapper.className = "xra-regen-wrap";

  host.insertBefore(wrapper, replyButton);
  wrapper.appendChild(button);
  wrapper.appendChild(replyButton);
}

// Move the Reply button back to its original parent if it was previously
// wrapped. Idempotent — safe to call when no wrap exists.
function unwrapReplyButton(replyButton) {
  if (!replyButton) return;
  const wrapper = replyButton.parentElement;
  if (!wrapper || !wrapper.classList.contains("xra-regen-wrap")) return;
  const host = wrapper.parentElement;
  if (!host) return;
  host.insertBefore(replyButton, wrapper);
  wrapper.remove();
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
  if (!tweet.text && !tweet.quoted && !tweet.imageAlts.length) {
    toast("Couldn't read this post's content.");
    return;
  }

  button.dataset.busy = "1";
  button.disabled = true;
  const originalHtml = button.innerHTML;
  button.innerHTML = SPINNER;
  button.classList.add("xra-busy");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_REPLY",
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
    if (button.isConnected) {
      button.dataset.busy = "0";
      button.disabled = false;
      button.innerHTML = originalHtml;
      button.classList.remove("xra-busy");
    }
  }
}

/* ---------- tone menu ---------- */

// The menu element is created exactly once and reused for the lifetime of the
// page. Rebuilding it on every open (an earlier design) interacted badly with
// X's event handling: rapid re-clicks on the caret made the menu tear down and
// rebuild in a loop, which the user saw as “flashing” or “resizing”.

let menuElement = null;
let menuAnchor = null;
let menuOnPick = null;
let showToneMenuPromise = null;

let caretClickGuard = 0;

function isMenuOpen() {
  return Boolean(menuElement && menuElement.isConnected);
}

function closeMenu() {
  if (menuElement && menuElement.isConnected) {
    menuElement.remove();
  }
  menuAnchor = null;
  menuOnPick = null;
}

function isOutsideMenu(event) {
  if (!isMenuOpen()) return false;
  if (menuElement.contains(event.target)) return false;
  if (menuAnchor && menuAnchor.contains(event.target)) return false;
  return true;
}

// Listen for `click` in the bubble phase. The caret already calls
// `stopPropagation` on its click, so the opening click never reaches this
// listener. Using `mousedown`/`pointerdown` would race with the caret handler
// (which is async) and tear down the menu before it's fully created.
document.addEventListener("click", (event) => {
  if (isOutsideMenu(event)) closeMenu();
}, false);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

window.addEventListener("resize", closeMenu);

function ensureMenuElement() {
  if (menuElement && menuElement.isConnected) return menuElement;

  const menu = document.createElement("div");
  menu.className = "xra-menu";
  menu.setAttribute("role", "menu");
  menu.addEventListener("click", (event) => {
    const target = event.target.closest(".xra-menu-item");
    if (!target || !menu.contains(target)) return;
    stopArticleNavigation(event);
    const toneId = target.dataset.toneId;
    const callback = menuOnPick;
    closeMenu();
    if (callback) callback(toneId);
  });
  document.body.appendChild(menu);
  menuElement = menu;
  return menu;
}

function populateMenu(publicSettings) {
  const menu = ensureMenuElement();
  const fragment = document.createDocumentFragment();

  for (const [id, tone] of Object.entries(TONES)) {
    if (id === "custom" && !publicSettings.hasCustomTone) continue;

    const item = document.createElement("button");
    item.type = "button";
    item.className = `xra-menu-item${
      id === publicSettings.tone ? " xra-menu-default" : ""
    }`;
    item.textContent = id === "custom" ? "Custom" : tone.label;
    item.dataset.toneId = id;
    item.setAttribute("role", "menuitem");
    fragment.appendChild(item);
  }

  menu.replaceChildren(fragment);
}

function positionMenu(anchor) {
  const menu = menuElement;
  if (!menu || !anchor) return;
  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const top =
    anchorRect.bottom + menuRect.height + 8 > window.innerHeight
      ? Math.max(8, anchorRect.top - menuRect.height - 4)
      : anchorRect.bottom + 4;
  const left = Math.max(
    8,
    Math.min(anchorRect.left, window.innerWidth - menuRect.width - 8),
  );
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

async function showToneMenu(anchor, onPick) {
  // Coalesce concurrent calls: if another show/close is in flight, wait for
  // it before deciding what to do. This prevents two near-simultaneous clicks
  // (e.g. caret click + a re-dispatched click) from creating a torn state.
  if (showToneMenuPromise) {
    try { await showToneMenuPromise; } catch { /* ignore */ }
  }

  // Toggle: clicking the same caret again closes the menu.
  if (isMenuOpen() && menuAnchor === anchor) {
    closeMenu();
    return;
  }

  // If a menu is open under a different anchor, close it first so only one
  // menu is ever visible.
  if (isMenuOpen()) closeMenu();

  const operation = (async () => {
    let publicSettings;
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_PUBLIC_SETTINGS" });
      if (!response?.ok) throw new Error(response?.error || "Could not load settings.");
      publicSettings = response;
    } catch (error) {
      toast(error?.message || String(error));
      return;
    }

    if (!anchor.isConnected) return;

    populateMenu(publicSettings);
    positionMenu(anchor);

    menuAnchor = anchor;
    menuOnPick = onPick;
  })();

  showToneMenuPromise = operation;
  try {
    await operation;
  } finally {
    if (showToneMenuPromise === operation) showToneMenuPromise = null;
  }
}

// Caret click debounce. X occasionally re-dispatches click events on the caret
// (or the browser fires synthetic clicks when the menu appears under the
// cursor). Without a guard these re-clicks create the open/close loop that
// looks like infinite flashing to the user.
function caretClickGuardActive() {
  return Date.now() < caretClickGuard;
}

function noteCaretClick() {
  caretClickGuard = Date.now() + 300;
}

/* ---------- action-bar injection ---------- */

function injectButton(article) {
  if (article.dataset.xraInjected === "1" || article.querySelector(".xra-wrap")) {
    return;
  }

  const replyButton = article.querySelector(SELECTORS.reply);
  const actionGroup = replyButton?.closest('[role="group"]');
  if (!actionGroup || !article.contains(actionGroup)) return;

  const wrapper = document.createElement("div");
  wrapper.className = "xra-wrap";

  const button = document.createElement("button");
  button.className = "xra-btn";
  button.type = "button";
  button.title = "Generate AI reply";
  button.setAttribute("aria-label", "Generate AI reply");
  button.innerHTML = SPARKLE;

  const caret = document.createElement("button");
  caret.className = "xra-caret";
  caret.type = "button";
  caret.title = "Choose reply tone";
  caret.setAttribute("aria-label", "Choose AI reply tone");
  caret.textContent = "▾";

  button.addEventListener("click", (event) => {
    stopArticleNavigation(event);
    handleGenerate(article, button, null);
  });
  caret.addEventListener("click", (event) => {
    stopArticleNavigation(event);
    if (caretClickGuardActive()) return;
    noteCaretClick();
    showToneMenu(caret, (toneId) => handleGenerate(article, button, toneId));
  });

  wrapper.append(button, caret);
  actionGroup.appendChild(wrapper);
  article.dataset.xraInjected = "1";
}

let scanScheduled = false;

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  window.requestAnimationFrame(() => {
    scanScheduled = false;
    document
      .querySelectorAll(`${SELECTORS.article}:not([data-xra-injected="1"])`)
      .forEach(injectButton);
  });
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
scheduleScan();
