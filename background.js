// DeepPilot background service worker.
// - Runs the agent engine (lib/engine.js): tasks keep going when you switch tabs or close the panel.
// - Makes the side panel per-tab: clicking the DeepPilot icon opens a panel dedicated to THAT tab.
//   Other tabs don't show it (unless you open DeepPilot there too, which starts a separate session).
import './lib/engine.js';

async function setup() {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (_) { /* old Chrome */ }
  try { await chrome.sidePanel.setOptions({ enabled: false }); } catch (_) { /* old Chrome */ }
}
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  await setup();
  // v2.1 makes the light "Daylight" theme the default — switch people updating from 2.0.x once.
  if (reason === 'update' && previousVersion && /^(1\.|2\.0\.)/.test(previousVersion)) {
    try { await chrome.storage.local.set({ theme: 'light' }); } catch (_) { /* ignore */ }
  }
});
chrome.runtime.onStartup.addListener(setup);

chrome.action.onClicked.addListener(tab => {
  // Both calls are made synchronously so the user gesture is still valid for open().
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tab=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch(err => console.warn('sidePanel.open failed', err));
});
