# Companion extension test

A throwaway test of a separate Chrome extension working with the plugin in production, not dev mode. It hosts RemNote in a side panel and turns a page selection into an Incremental Rem.

Use only a **throwaway knowledge base**, with the main Incremental RemNote plugin disabled there. The test plugin refuses to write in your primary KB. Opening the panel on a page creates or reuses that page's document in `Links`, as the Clipper does.

The plugin's half is on the `companion-test` branch, in `src/lib/companion_test.ts`, and must never reach a main release. It is built under the test plugin's ID, `incremental-everything-plus`.

## Run

1. Upload `PluginZip-companion-test.zip` to the test plugin, and install or update it in the throwaway KB.
2. In Chrome, open `https://www.remnote.com` in a normal tab and switch to the throwaway KB. The panel opens whichever KB this browser last used.
3. Reload this extension in `chrome://extensions` (**Load unpacked** if it isn't there), and reload any open web pages. Close the Clipper's panel.
4. Open `https://example.com`, click the toolbar icon, then **Start test on this tab**. Check that the `ready` line names the throwaway KB.
5. Select text on the page and click **Test: Add Extract**. A banner should report the result, and the extract should appear under the page's document in the panel.
6. In the panel's RemNote, run **Companion Test: Send to Page** from the Omnibar. A banner should appear on the page.
7. Click **Show report**. It is also copied to the clipboard.

Earlier results are in `findings/PLUGIN_BRIDGE_AND_SDK.md`.
