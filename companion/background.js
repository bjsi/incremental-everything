// The toolbar icon opens the side panel, and its badge counts what is waiting to
// reach RemNote. Queued operations are stored as `op:<id>` (see content.js).

// Chrome hides a panel that belongs to one tab when another tab is shown, and shows
// it again on the way back. Only one is kept open: each runs all of RemNote, and
// nothing tells their frames apart.
const useClickHandler = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
chrome.runtime.onInstalled.addListener(useClickHandler);
chrome.runtime.onStartup.addListener(useClickHandler);

async function closePanelOfOtherTab(tabId) {
  const { panelTab } = await chrome.storage.session.get('panelTab');
  if (panelTab !== undefined && panelTab !== tabId) {
    await chrome.sidePanel.setOptions({ tabId: panelTab, enabled: false }).catch(() => {});
  }
  await chrome.storage.session.set({ panelTab: tabId });
}

// Chrome allows opening only in response to a user action, so nothing is awaited
// before it. The tab's own panel has to exist first, or Chrome opens one for all tabs.
function openPanelOn(tab) {
  chrome.sidePanel.setOptions({ tabId: tab.id, path: 'panel.html', enabled: true }).catch(() => {});
  chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }).catch((err) => {
    console.warn('Could not open the panel', err);
  });
  closePanelOfOtherTab(tab.id).catch(() => {});
}

chrome.action.onClicked.addListener(openPanelOn);

async function updateBadge() {
  const stored = await chrome.storage.local.get(null);
  const waiting = Object.keys(stored).filter((key) => key.startsWith('op:')).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : '' });
}

chrome.storage.onChanged.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.ie === 'openPanel' && sender.tab) openPanelOn(sender.tab);
});
