// The toolbar icon opens the side panel, and its badge counts what is waiting to
// reach RemNote. Queued operations are stored as `op:<id>` (see content.js).

const openOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.runtime.onInstalled.addListener(openOnClick);
chrome.runtime.onStartup.addListener(openOnClick);

async function updateBadge() {
  const stored = await chrome.storage.local.get(null);
  const waiting = Object.keys(stored).filter((key) => key.startsWith('op:')).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : '' });
}

chrome.storage.onChanged.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);

// Chrome allows this only in response to a user action, so it has to be called
// straight away, with no await before it.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.ie === 'openPanel' && sender.tab) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch((err) => {
      console.warn('Could not open the panel', err);
    });
  }
});
