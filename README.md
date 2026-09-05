# X Reply Assistant

A Manifest V3 Chrome extension that adds a ✨ button to posts on X. It generates a reply draft with an OpenAI-compatible chat API and places the draft in X's reply composer. It never submits the reply.

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

## Providers

- OpenAI: `https://api.openai.com/v1`, default model `gpt-4o-mini`
- DeepSeek: `https://api.deepseek.com`, default model `deepseek-chat`
- MiniMax: `https://api.minimax.io/v1`, default model `MiniMax-M1`

The Advanced section allows a custom model and HTTPS base URL for another OpenAI-compatible endpoint. Chrome may ask for permission for a custom endpoint. The API key is stored in `chrome.storage.local` and is sent to the configured provider by the extension service worker.

## Limitations

X changes its DOM periodically, so selectors may need maintenance. The extension only drafts text; it does not automatically post, like, follow, or otherwise interact with X on your behalf.
