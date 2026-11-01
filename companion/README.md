# Companion extension test

A throwaway test of a separate Chrome extension working with the plugin in production, not dev mode. It hosts RemNote in a side panel and turns a page selection into an Incremental Rem.

Use only a **throwaway knowledge base**, with the main Incremental RemNote plugin disabled there. The test plugin refuses to write in your primary KB. Opening the panel on a page creates or reuses that page's document in `Links`, as the Clipper does.

The plugin's half is on the `companion-test` branch, in `src/lib/companion_test.ts`, and must never reach a main release. It is built under the test plugin's ID, `incremental-everything-plus`.

## Run

1. Upload `PluginZip-companion-test.zip` to the test plugin, and update it in the throwaway KB.
2. In Chrome, open `https://www.remnote.com` in a normal tab and switch to the throwaway KB. The panel opens whichever KB this browser last used.
3. Reload this extension in `chrome://extensions`, keeping Chrome's Developer mode on, and reload any open web pages. Close the Clipper's panel.
4. Follow the page steps below. A bar with test buttons appears at the bottom right of every page.
5. Click **Show report** in the panel. It is also copied to the clipboard.

### Page 1: `https://supermemo.guru/wiki/Pleasure_of_learning`

1. Open the page, then the panel, and click **Start test on this tab**. The `ready` line should name the throwaway KB.
2. Right after that, select a sentence and click **Add Extract**, to test clicking before the plugin is ready.
3. Click **Import headings**. Check in the panel that the sections match the page's contents, in the same order and nesting.
4. Add extracts: the paragraph under "The main problem in education" with the link *endured*, one with bold text from the yellow box, one under "Orbitofrontal cortex", and one that crosses two paragraphs. Do one further down the page before one higher up in the same section, to test reading order. Each should turn blue and land in its section.
5. Scroll down the page, click **Set read point**, scroll elsewhere, then **Go to read point**.
6. Reload the page. The highlights and the orange read point should come back, and **Go to read point** should still work.
7. Close the panel and reload the page. The highlights should still appear, from the browser's copy.
8. Reopen the panel and start the test. Delete one extract Rem in the panel, then reload the page. Its highlight should be gone.

### Page 2: a Wikipedia article

Open any long article, without restarting the panel. Import headings, add two extracts, and reload.

### Page 3: a modern site that builds its text with JavaScript

For example a GitHub README or a news article. Add two extracts and reload, and say whether the highlights came back.

## Automated checks

`REAL_PAGE=<saved html> node --test spikes/companion-extension/anchors.test.js` runs the text-finding and outline logic under jsdom.

Earlier results are in `findings/PLUGIN_BRIDGE_AND_SDK.md`.
