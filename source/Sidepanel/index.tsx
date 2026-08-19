import { createRoot } from 'react-dom/client';
import browser from 'webextension-polyfill';
import Sidepanel from './Sidepanel';
import '../styles/_theme.scss';

// Keep the background alive promptly; there is no longer a popup fallback —
// the toolbar icon always opens the sidepanel.
browser.runtime.sendMessage({ type: 'SIDEPANEL_OPENED' }).catch(() => {});

const port = browser.runtime.connect({ name: 'sidepanel' });

// The background pushes the active tab's list to this port right after the
// panel registers (see SIDEPANEL_TAB_ID handling). Bridge it into the app so
// the panel never shows empty when media was captured before it opened. The
// push can arrive before React mounts, so buffer it on window and replay it.
port.onMessage.addListener((msg: any) => {
  if (msg?.type === 'SIDEPANEL_CLOSE_REQUEST') {
    window.close();
  } else if (msg?.type === 'LIST_UPDATED') {
    (window as any).__coolhuskyPanelList = msg;
    window.dispatchEvent(
      new CustomEvent('coolhusky:panel-list', { detail: msg })
    );
  }
});

// Register the currently active tab so the background can map this sidepanel
// port to the tab (toggle open/close, broadcast media lists, etc.). Resolve
// the active tab through the background — `tabs.query` from this embedded
// page can return a stale/other window, which would map the port to the
// wrong tab.
browser.runtime
  .sendMessage({ type: 'GET_ACTIVE_TAB' })
  .then((res: any) => {
    const tabId = res?.tabId;
    if (typeof tabId === 'number') {
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
