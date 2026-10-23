# X Reply Assistant

A Manifest V3 Chrome extension that adds a ✨ button to posts on X and LinkedIn. It generates a reply (or LinkedIn comment) draft with an OpenAI-compatible chat API and places it in the site's reply or comment box. It never submits the reply.

LinkedIn drafts use their own prompt (specific, no empty praise, answers the post's closing question, includes the keyword on "comment KEYWORD" posts) and their own max length setting.

## Requirements

- Google Chrome 110 or newer
- Node.js 18 or newer
- An API key for OpenAI, DeepSeek, or MiniMax

## Build

From this directory:

```text
npm install
npm run build
```

The ready-to-load extension is created in `dist/`.

For development, use:

```text
npm run dev
```

The JavaScript bundle is watched. Reload the unpacked extension in `chrome://extensions` after changes to the manifest or standalone HTML/CSS files.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `dist/` directory.
5. Open the extension popup, choose a provider, enter its API key, and click **Save**.
6. Use **Test connection** before visiting X.

On X, open a post's action bar and click ✨ to draft a reply. Use the small arrow to choose a one-off tone. Review and edit the draft, then click X's own **Reply** button.

Posts with a purple score chip (60+) that stay on screen for about a second are drafted in the background. Clicking X's own Reply button (or ✨) on one of them types the ready draft straight into the reply box, with ↻ next to Reply to regenerate. Turn this off with **Pre-draft replies for good targets while scrolling** in the settings.

## Providers

- OpenAI: `https://api.openai.com/v1`, default model `gpt-4o-mini`
- DeepSeek: `https://api.deepseek.com`, default model `deepseek-chat`
- MiniMax: `https://api.minimax.io/v1`, default model `MiniMax-M1`

The Advanced section allows a custom model and HTTPS base URL for another OpenAI-compatible endpoint. Chrome may ask for permission for a custom endpoint. The API key is stored in `chrome.storage.local` and is sent to the configured provider by the extension service worker.

## Images

Most posts only make sense with their images, so the extension reads up to four images per post (toggle **Analyze post images** in the settings):

- **OpenAI**: the images are attached to the request directly (the default `gpt-4o-mini` supports vision). If a custom model rejects images, the reply is retried as text only.
- **DeepSeek / MiniMax**: the chat models are text-only, so each image is first described by MiniMax's image understanding endpoint (`/v1/coding_plan/vlm`, included in the MiniMax Coding/Token Plan) and the descriptions are added to the prompt. This needs a MiniMax API key saved in the settings, even when DeepSeek is the selected provider.

If image analysis fails, the draft is still generated from the post text and image alt text.

## Limitations

X and LinkedIn change their DOM periodically, so selectors may need maintenance (LinkedIn's live in the `SELECTORS` object in `src/content-linkedin.js`). The extension only drafts text; it does not automatically post, like, follow, or otherwise interact with either site on your behalf.
