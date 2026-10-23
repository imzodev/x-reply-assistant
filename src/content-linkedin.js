import {
  SPARKLE,
  createGenerateControls,
  editorTextEquals,
  initToneMenu,
  isVisible,
  nextFrame,
  observeFeed,
  pasteIntoEditor,
  selectEditorContents,
  setBusy,
  sleep,
  toast,
  waitFor,
  wrapWithRegenerateButton,
} from "./content-common.js";

// LinkedIn's current feed uses hashed, per-release class names (e.g.
// "gflk9u gflk9t …"), so nothing here relies on classes. Instead we anchor
// on stable attributes (role, data-testid, aria-label, contenteditable) and
// on page structure. The legacy class selectors are kept as fallbacks for
// accounts still on the old feed. The UI is localized, so every label
// match lists several languages.
const SELECTORS = {
  post: [
    '[data-testid="mainFeed"] [role="listitem"]',
    "div.feed-shared-update-v2",
    'div[data-urn^="urn:li:activity"]',
  ].join(", "),
  text: [
    '[data-testid="expandable-text-box"]',
    ".update-components-text",
    ".feed-shared-inline-show-more-text",
  ].join(", "),
  actorName: ".update-components-actor__title, .update-components-actor__name",
  actorHeadline: ".update-components-actor__description",
  profileLink: 'a[href*="/in/"], a[href*="/company/"]',
  editor: '[contenteditable="true"]',
  button: 'button, [role="button"]',
};

// The action-bar "Comment" button, matched on its exact label so that
// counters like "12 comentarios" don't match.
const COMMENT_LABEL =
  /^(comment|comentar|commenter|kommentieren|commenta|comentário|reageren|komentarz|kommentera|kommenter|kommentoi|yorum yap)$/i;

// The submit button inside an open comment box.
const SUBMIT_LABEL =
  /^(comment|comentar|publicar|post|reply|responder|enviar|send|commenter|publier|kommentieren|posten|commenta|pubblica|comentário)$/i;

// Matches "comment GUIDE", "Comment 'PLAYBOOK' below", "Comenta GUIA",
// "comenta la palabra IA". Only all-caps words count, which is how
// creators flag the trigger keyword.
const KEYWORD_REGEX =
  /\b(?:[Cc]omment|[Cc]omenta|[Cc]omentá|[Cc]ommente|[Kk]ommentiere)\s+(?:the\s+word\s+|la\s+palabra\s+|with\s+|con\s+)?["“'‘«]?([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9]{1,19})["”'’»]?(?=[\s.,!:;)¡!]|$)/;

initToneMenu();

function labelOf(element) {
  return (element.getAttribute("aria-label") || element.innerText || "").trim();
}

/* ---------- post structure ---------- */

// The action-bar Comment button: the first button labelled "Comment" (in
// any supported language) that isn't part of an open comment box.
function findCommentButton(post) {
  for (const button of post.querySelectorAll(SELECTORS.button)) {
    if (button.closest(".xra-wrap, .xra-regen-wrap, form")) continue;
    if (!COMMENT_LABEL.test(labelOf(button))) continue;
    // An open comment box has its own "Comment" submit button; skip any
    // button sitting next to an editor.
    let ancestor = button.parentElement;
    let nearEditor = false;
    for (let i = 0; i < 4 && ancestor && ancestor !== post; i += 1) {
      if (ancestor.querySelector(SELECTORS.editor)) {
        nearEditor = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (!nearEditor) return button;
  }
  return null;
}

// The smallest ancestor of the Comment button that also holds the other
// actions (react, repost, send) — i.e. the social action bar.
function findActionBar(post, commentButton) {
  let element = commentButton.parentElement;
  while (element && element !== post) {
    if (element.querySelectorAll(SELECTORS.button).length >= 3) return element;
    element = element.parentElement;
  }
  return null;
}

/* ---------- post extraction ---------- */

function cleanText(value) {
  return String(value || "")
    // Hashtag links carry a visually-hidden "hashtag" prefix.
    .replace(/\bhashtag#/g, "#")
    .replace(/…\s*(see more|show more|más|ver más|mehr|plus|altro|mais)\s*$/i, "")
    .trim();
}

// Fallback when no known text container exists: the leaf-ish element with
// the longest text that isn't a button, a profile link, or the comments.
function findLongestTextBlock(post) {
  let best = null;
  let bestLength = 0;
  for (const element of post.querySelectorAll("p, span[dir], div[dir], span")) {
    if (element.closest(`${SELECTORS.button}, ${SELECTORS.profileLink}, form`)) continue;
    if (element.querySelector("p, div")) continue;
    const length = (element.innerText || "").trim().length;
    if (length > bestLength) {
      best = element;
      bestLength = length;
    }
  }
  return best;
}

function extractAuthor(post) {
  const legacyName = post.querySelector(SELECTORS.actorName);
  if (legacyName) {
    const visible = (element) =>
      element
        ? ((element.querySelector('span[aria-hidden="true"]') || element).innerText || "")
            .split("\n")[0]
            .trim()
        : "";
    return {
      name: visible(legacyName),
      handle: visible(post.querySelector(SELECTORS.actorHeadline)),
    };
  }

  // New feed: the first profile/company link with text holds the name and,
  // usually, the headline on the following lines.
  for (const link of post.querySelectorAll(SELECTORS.profileLink)) {
    const lines = [...new Set(
      (link.innerText || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )];
    if (!lines.length) continue;
    const headline = lines
      .slice(1)
      .find((line) => line.length > 3 && !/^[•·]|^\d+\s*[º°o]|^(seguir|follow|siguiendo|following)$/i.test(line));
    return { name: lines[0], handle: headline || "" };
  }
  return { name: "", handle: "" };
}

function extractPost(post) {
  const textElements = [...post.querySelectorAll(SELECTORS.text)];
  const ownText = textElements[0] || findLongestTextBlock(post);
  const text = cleanText(ownText?.innerText);

  // Reshared posts render a second text block.
  const quoted = textElements
    .slice(1)
    .map((element) => cleanText(element.innerText))
    .filter(Boolean)
    .join("\n---\n");

  const { name, handle } = extractAuthor(post);

  const imageAlts = [...post.querySelectorAll("img")]
    .filter((image) => !image.closest(SELECTORS.profileLink))
    .map((image) => image.alt?.trim())
    .filter((alt) => alt && alt.length > 15 && !/^(image|imagen|no alternative text)/i.test(alt));

  // Post media only: skip avatars, logos, and small thumbnails (comments,
  // reactions), which all come from the same CDN.
  const imageUrls = [...new Set(
    [...post.querySelectorAll('img[src^="https://media.licdn.com/"]')]
      .filter((image) => !image.closest(SELECTORS.profileLink))
      .filter((image) => !/profile-displayphoto|profile-framedphoto|company-logo/.test(image.src))
      .filter((image) => image.getBoundingClientRect().width >= 200)
      .map((image) => image.src),
  )].slice(0, 4);

  const keyword = text.match(KEYWORD_REGEX)?.[1] || "";

  return { text, quoted, name, handle, imageAlts, imageUrls, keyword };
}

/* ---------- comment box handling ---------- */

function visibleEditors(root) {
  return [...root.querySelectorAll(SELECTORS.editor)].filter(isVisible);
}

async function openCommentBox(post) {
  // The comment box may already be open (e.g. after a previous draft).
  const existing = visibleEditors(post)[0];
  if (existing) return existing;

  const commentButton = findCommentButton(post);
  if (!commentButton) throw new Error("Couldn't find the comment button on this post.");

  const before = new Set(visibleEditors(document));
  commentButton.click();

  // Prefer an editor inside the post; otherwise take any editor that
  // appeared because of the click.
  const editor = await waitFor(
    () =>
      visibleEditors(post)[0] ||
      visibleEditors(document).find((candidate) => !before.has(candidate)) ||
      null,
  );
  if (!editor) throw new Error("The comment box didn't open. Try again.");
  return editor;
}

async function insertIntoEditor(editor, text) {
  if (!editor || !isVisible(editor)) {
    throw new Error("The comment box was closed before the draft was ready.");
  }

  // LinkedIn's rich-text editor picks up native editing commands, so the
  // whole draft goes in as one insertText (LinkedIn doesn't flag instant
  // text the way X does).
  editor.focus();
  await nextFrame();
  selectEditorContents(editor);
  document.execCommand("insertText", false, text);
  await nextFrame();
  await sleep(50);

  if (editorTextEquals(editor, text)) return;

  await pasteIntoEditor(editor, text);
}

// Walk up from the editor looking for the comment box's submit button.
// Stop before reaching the action bar, whose own "Comment" button would
// otherwise match.
function findSubmitButton(editor, post) {
  const actionButton = findCommentButton(post);
  let element = editor.parentElement;
  for (let depth = 0; element && depth < 8; depth += 1) {
    if (actionButton && element.contains(actionButton)) return null;
    for (const button of element.querySelectorAll(SELECTORS.button)) {
      if (editor.contains(button) || button.classList.contains("xra-regen")) continue;
      if (button.getAttribute("type") === "submit" || SUBMIT_LABEL.test(labelOf(button))) {
        return button;
      }
    }
    if (element === post) return null;
    element = element.parentElement;
  }
  return null;
}

/* ---------- reply generation ---------- */

function requestDraft(data, toneOverride) {
  return chrome.runtime.sendMessage({
    type: "GENERATE_REPLY",
    platform: "linkedin",
    tweet: data,
    tone: toneOverride || null,
  });
}

function hasContent(data) {
  return Boolean(data.text || data.quoted || data.imageAlts.length || data.imageUrls.length);
}

async function handleGenerate(post, button, toneOverride) {
  if (button.dataset.busy === "1") return;

  const data = extractPost(post);
  if (!hasContent(data)) {
    toast("Couldn't read this post's content.");
    return;
  }

  setBusy(button, true, SPARKLE);

  try {
    const [editor, response] = await Promise.all([
      openCommentBox(post),
      requestDraft(data, toneOverride),
    ]);

    if (!response?.ok) {
      throw new Error(response?.error || "Comment generation failed.");
    }

    await insertIntoEditor(editor, response.text);
    injectRegenerateButton(editor, post, toneOverride);
    toast("Comment drafted ✨ — review it, then press Comment.", false);
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    setBusy(button, false, SPARKLE);
  }
}

function injectRegenerateButton(editor, post, toneOverride) {
  const submitButton = findSubmitButton(editor, post);
  if (!submitButton) return;

  wrapWithRegenerateButton(submitButton, (button) =>
    regenerateComment({ post, editor, button, toneOverride }),
  );
}

async function regenerateComment({ post, editor, button, toneOverride }) {
  if (button.dataset.busy === "1") return;

  const data = extractPost(post);
  if (!hasContent(data)) {
    toast("Couldn't read this post's content.");
    return;
  }

  const originalHtml = button.innerHTML;
  setBusy(button, true, originalHtml);

  try {
    const response = await requestDraft(data, toneOverride);
    if (!response?.ok) {
      throw new Error(response?.error || "Comment regeneration failed.");
    }

    if (!editor.isConnected || !isVisible(editor)) {
      throw new Error("The comment box was closed before regeneration finished.");
    }

    await insertIntoEditor(editor, response.text);
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    setBusy(button, false, originalHtml);
  }
}

/* ---------- action-bar injection ---------- */

function injectButton(post) {
  if (post.dataset.xraInjected === "1") return;

  // Nested matches (reshares, comment lists) — only the outermost post
  // gets a button.
  if (post.parentElement?.closest(SELECTORS.post)) {
    post.dataset.xraInjected = "1";
    return;
  }

  // Posts without a Comment button yet (still lazy-loading, or the share
  // box at the top of the feed) are retried on the next scan.
  const commentButton = findCommentButton(post);
  if (!commentButton) return;
  const actionBar = findActionBar(post, commentButton);
  if (!actionBar || actionBar.querySelector(".xra-wrap")) return;

  const { wrapper } = createGenerateControls({
    title: "Generate AI comment",
    onGenerate: (button, toneId) => handleGenerate(post, button, toneId),
  });
  wrapper.classList.add("xra-wrap--linkedin");

  actionBar.appendChild(wrapper);
  post.dataset.xraInjected = "1";
}

observeFeed(SELECTORS.post, injectButton);
