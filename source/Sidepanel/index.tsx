import { createRoot } from 'react-dom/client';
import browser from 'webextension-polyfill';
import Sidepanel from './Sidepanel';
import '../styles/_theme.scss';

// Keep the background alive promptly; there is no longer a popup fallback —
// the toolbar icon always opens the sidepanel.
browser.runtime.sendMessage({ type: 'SIDEPANEL_OPENED' }).catch(() => {});

const port = browser.runtime.connect({ name: 'sidepanel' });

port.onMessage.addListener((msg: any) => {
  if (msg?.type === 'SIDEPANEL_CLOSE_REQUEST') {
    window.close();
  }
});

// Register the currently active tab so the background can map this sidepanel
// port to the tab (toggle open/close, broadcast media lists, etc.)
browser.tabs
  .query({ active: true, currentWindow: true })
  .then((tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) {
      port.postMessage({ type: 'SIDEPANEL_TAB_ID', tabId });
    }
  })
  .catch(() => {});

window.addEventListener('pagehide', () => {
  browser.runtime.sendMessage({ type: 'SIDEPANEL_CLOSED' }).catch(() => {});
});

const root = document.getElementById('sidepanel-root');
if (root) {
  createRoot(root).render(<Sidepanel />);
}
