import { createRoot } from 'react-dom/client';
import browser from 'webextension-polyfill';
import Sidepanel from './Sidepanel';
import '../styles/_theme.scss';

browser.runtime.sendMessage({ type: 'SIDEPANEL_OPENED' }).catch(() => {});

const port = browser.runtime.connect({ name: 'sidepanel' });

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

browser.runtime
  .sendMessage({ type: 'GET_ACTIVE_TAB' })
  .then((res: any) => {
    const tabId = res?.tabId;
    if (typeof tabId === 'number') {
      port.postMessage({ type: 'SIDEPANEL_TAB_ID', tabId });
    }
  })
  .catch(() => {});

const reassociate = (activeInfo: { tabId: number }): void => {
  browser.runtime
    .sendMessage({ type: 'GET_ACTIVE_TAB' })
    .then((res: any) => {
      const tabId = res?.tabId ?? activeInfo.tabId;
      if (typeof tabId === 'number') {
        port.postMessage({ type: 'SIDEPANEL_TAB_ID', tabId });
      }
    })
    .catch(() => {});
};
browser.tabs.onActivated.addListener(reassociate);

window.addEventListener('pagehide', () => {
  browser.tabs.onActivated.removeListener(reassociate);
  browser.runtime.sendMessage({ type: 'SIDEPANEL_CLOSED' }).catch(() => {});
});

const root = document.getElementById('sidepanel-root');
if (root) {
  createRoot(root).render(<Sidepanel />);
}
