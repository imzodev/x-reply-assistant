import { TONES } from "./shared.js";

// Site-agnostic UI shared by the X and LinkedIn content scripts: icons,
// small DOM helpers, the generate/caret controls, and the tone menu.

export const SPARKLE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
  <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9L19 13zM5 14l.7 2 2 .7-2 .7L5 19.5l-.7-2.1-2-.7 2-.7L5 14z" />
</svg>`;

export const SPINNER = `<svg viewBox="0 0 24 24" width="18" height="18" class="xra-spin" aria-hidden="true">
  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" fill="none" stroke-dasharray="40 20" />
</svg>`;

export const REFRESH = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
  <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
</svg>`;

export function toast(message, isError = true) {
  document.querySelectorAll(".xra-toast").forEach((element) => element.remove());
  const element = document.createElement("div");
  element.className = `xra-toast${isError ? " xra-toast-error" : ""}`;
  element.textContent = message;
  element.setAttribute("role", isError ? "alert" : "status");
  document.body.appendChild(element);
  window.setTimeout(() => element.remove(), 4_500);
}

export function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function waitFor(callback, timeout = 6_000, interval = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = callback();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

export function isVisible(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

export function stopArticleNavigation(event) {
  event.preventDefault();
  event.stopPropagation();
}

export function selectEditorContents(editor) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function editorTextEquals(editor, expected) {
  const actual = (editor.innerText || editor.textContent || "").trim();
  return actual === expected.trim();
}

// Replace the editor contents with a single synthetic paste. Used as a
// fallback when the editor ignored the primary insertion path.
export async function pasteIntoEditor(editor, text) {
  selectEditorContents(editor);
  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  editor.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }),
  );

  await nextFrame();
  await nextFrame();
  await sleep(200);
}

// Swap a button between its idle icon and the spinner.
export function setBusy(button, busy, idleHtml) {
  if (!button.isConnected) return;
  button.dataset.busy = busy ? "1" : "0";
  button.disabled = busy;
  button.innerHTML = busy ? SPINNER : idleHtml;
  button.classList.toggle("xra-busy", busy);
}

/* ---------- regenerate button ---------- */

// Move a submit button back to its original parent if it was previously
// wrapped. Idempotent — safe to call when no wrap exists.
export function unwrapSubmitButton(submitButton) {
  if (!submitButton) return;
  const wrapper = submitButton.parentElement;
  if (!wrapper || !wrapper.classList.contains("xra-regen-wrap")) return;
  const host = wrapper.parentElement;
  if (!host) return;
  host.insertBefore(submitButton, wrapper);
  wrapper.remove();
}

// Place a regenerate button directly to the left of the site's submit
// button, inside a row-flex wrapper we control. The wrapper guarantees
// horizontal placement regardless of how the site lays out its cluster.
// Re-injecting is idempotent: any prior wrapper is unwrapped first.
export function wrapWithRegenerateButton(submitButton, onClick) {
  unwrapSubmitButton(submitButton);

  const host = submitButton.parentElement;
  if (!host) return null;

  const button = document.createElement("button");
  button.className = "xra-regen";
  button.type = "button";
  button.setAttribute("aria-label", "Regenerate reply");
  button.title = "Regenerate reply";
  button.innerHTML = REFRESH;

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(button);
  });

  const wrapper = document.createElement("div");
  wrapper.className = "xra-regen-wrap";

  host.insertBefore(wrapper, submitButton);
  wrapper.appendChild(button);
  wrapper.appendChild(submitButton);
  return button;
}

/* ---------- generate controls ---------- */

// Build the sparkle button + tone caret pair. `onGenerate(button, toneId)`
// is called with `toneId === null` for the default tone.
export function createGenerateControls({ onGenerate, title = "Generate AI reply" }) {
  const wrapper = document.createElement("div");
  wrapper.className = "xra-wrap";

  const button = document.createElement("button");
  button.className = "xra-btn";
  button.type = "button";
  button.title = title;
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
    onGenerate(button, null);
  });
  caret.addEventListener("click", (event) => {
    stopArticleNavigation(event);
    if (caretClickGuardActive()) return;
    noteCaretClick();
    showToneMenu(caret, (toneId) => onGenerate(button, toneId));
  });

  wrapper.append(button, caret);
  return { wrapper, button, caret };
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
export function initToneMenu() {
  document.addEventListener("click", (event) => {
    if (isOutsideMenu(event)) closeMenu();
  }, false);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  window.addEventListener("resize", closeMenu);
}

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

// Caret click debounce. Sites occasionally re-dispatch click events on the
// caret (or the browser fires synthetic clicks when the menu appears under the
// cursor). Without a guard these re-clicks create the open/close loop that
// looks like infinite flashing to the user.
function caretClickGuardActive() {
  return Date.now() < caretClickGuard;
}

function noteCaretClick() {
  caretClickGuard = Date.now() + 300;
}

/* ---------- feed scanning ---------- */

// Run `inject` on every not-yet-injected element matching `selector`,
// debounced to one scan per animation frame, for the life of the page.
export function observeFeed(selector, inject) {
  let scanScheduled = false;

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    window.requestAnimationFrame(() => {
      scanScheduled = false;
      document
        .querySelectorAll(`${selector}:not([data-xra-injected="1"])`)
        .forEach(inject);
    });
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  scheduleScan();
}
