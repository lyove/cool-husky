import browser from 'webextension-polyfill';
import {
  detectMedia,
  detectMediaFromUrl,
  detectDoc,
  detectFormatFromUrl,
  isKnownMediaCdn,
  type MediaCategory,
} from '../utils/detect';
import {
  loadAllTabData,
  loadTabList,
  saveTabList,
  deleteTabList,
  saveTabPageUrl,
  loadTabPageUrls,
  deleteTabPageUrl,
  type MediaEntry,
} from '../utils/media-storage';
import {
  loadSettings,
  saveSettings,
  isFormatAllowed,
  isMediaAllowed,
  isSizeAllowed,
  isDomainExcluded,
  matchRegexRules,
  type Settings,
  DEFAULT_SETTINGS,
} from '../utils/settings';
import { parseM3U8Manifest, parseDashManifest } from '../utils/stream-parser';
import MediaInfoFactory from 'mediainfo.js';
import type {
  MetadataBatchItem,
  MetadataBatchRequest,
  MetadataBatchResult,
} from '../utils/popup-types';
import type { PlatformMediaTask } from '../utils/platform-media';

const mediaInfoCache = new Map<
  string,
  { width?: number; height?: number; duration?: number }
>();
// Negative cache: skip retrying failed URLs for 60s
const mediaInfoFailCache = new Map<string, number>();
const MEDIA_INFO_FAIL_TTL_MS = 60_000;
// Cap these module-level caches so they don't grow without bound during a
// long-lived service worker. Evict the oldest entries when the cap is hit.
const MEDIA_INFO_CACHE_MAX = 1000;
function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) {
      break;
    }
    map.delete(first);
  }
}
const metadataBatchControllers = new Map<string, AbortController>();

async function fetchMediaInfo(
  url: string,
  signal?: AbortSignal
): Promise<{ width?: number; height?: number; duration?: number } | null> {
  signal?.throwIfAborted();
  if (mediaInfoCache.has(url)) {
    return mediaInfoCache.get(url)!;
  }
  const lastFail = mediaInfoFailCache.get(url);
  if (lastFail && Date.now() - lastFail < MEDIA_INFO_FAIL_TTL_MS) {
    return null;
  }

  try {
    const mediaInfo = await MediaInfoFactory({
      format: 'JSON',
      locateFile: () => browser.runtime.getURL('MediaInfoModule.wasm' as any),
    });

    const getSize = async () => {
      try {
        const headResp = await fetch(url, { method: 'HEAD', signal });
        const cl = headResp.headers.get('Content-Length');
        if (cl) {
          const n = parseInt(cl, 10);
          if (!Number.isNaN(n) && n > 0) {
            return n;
          }
        }
      } catch {
        //
      }

      try {
        const probe = await fetch(url, {
          headers: { Range: 'bytes=0-0' },
          signal,
        });
        const cr = probe.headers.get('Content-Range');
        if (cr) {
          const m = /\/\s*(\d+)\s*$/.exec(cr);
          if (m?.[1]) {
            const n = parseInt(m[1], 10);
            if (!Number.isNaN(n) && n > 0) {
              return n;
            }
          }
        }
      } catch {
        //
      }

      return 0;
    };

    let fullBodyCache: Uint8Array | null = null;
    const readChunk = async (
      chunkSize: number,
      offset: number
    ): Promise<Uint8Array> => {
      if (fullBodyCache) {
        if (offset >= fullBodyCache.length) {
          return new Uint8Array(0);
        }
        return fullBodyCache.subarray(offset, offset + chunkSize);
      }
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + chunkSize - 1}` },
        cache: 'no-store',
        signal,
      });
      if (response.status === 416) {
        return new Uint8Array(0);
      }
      if (response.status === 200) {
        const buf = new Uint8Array(await response.arrayBuffer());
        fullBodyCache = buf;
        if (offset >= buf.length) {
          return new Uint8Array(0);
        }
        return buf.subarray(offset, offset + chunkSize);
      }
      if (!response.ok && response.status !== 206) {
        throw new Error(`readChunk HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    };

    const result = await mediaInfo.analyzeData(getSize, readChunk);
    mediaInfo.close();

    if (result) {
      let parsed: any;
      try {
        parsed = JSON.parse(result);
      } catch {
        mediaInfoFailCache.set(url, Date.now());
        evictOldest(mediaInfoFailCache, MEDIA_INFO_CACHE_MAX);
        return null;
      }
      const info: { width?: number; height?: number; duration?: number } = {};

      const videoTrack = parsed.media?.track?.find(
        (t: any) => t['@type'] === 'Video'
      );
      if (videoTrack) {
        info.width = parseInt(videoTrack.Width, 10);
        info.height = parseInt(videoTrack.Height, 10);
      }

      const audioTrack = parsed.media?.track?.find(
        (t: any) => t['@type'] === 'Audio'
      );
      const generalTrack = parsed.media?.track?.find(
        (t: any) => t['@type'] === 'General'
      );

      const durationStr = audioTrack?.Duration || generalTrack?.Duration;
      if (durationStr) {
        info.duration = parseFloat(durationStr);
      }

      if (info.width || info.height || info.duration) {
        mediaInfoCache.set(url, info);
        evictOldest(mediaInfoCache, MEDIA_INFO_CACHE_MAX);
        return info;
      }
    }
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === 'AbortError') {
      return null;
    }
    console.warn(
      '[fetchMediaInfo] failed for',
      url,
      '-',
      (e as Error)?.message || e
    );
    mediaInfoFailCache.set(url, Date.now());
    evictOldest(mediaInfoFailCache, MEDIA_INFO_CACHE_MAX);
  }
  return null;
}

async function fetchVideoDimensions(
  url: string
): Promise<{ width: number; height: number } | null> {
  const info = await fetchMediaInfo(url);
  if (info?.width && info?.height) {
    return { width: info.width, height: info.height };
  }
  return null;
}

async function fetchContentLength(
  url: string,
  requestHeaders?: Record<string, string>,
  signal?: AbortSignal
): Promise<{ ok: boolean; size: number | null; error?: string }> {
  const headers: Record<string, string> = {};
  if (requestHeaders && typeof requestHeaders === 'object') {
    for (const [key, value] of Object.entries(requestHeaders)) {
      const normalized = key.toLowerCase();
      if (
        normalized === 'referer' ||
        normalized === 'origin' ||
        normalized === 'cookie' ||
        normalized === 'user-agent'
      ) {
        headers[key] = value;
      }
    }
  }
  const parseContentRange = (value: string | null): number | null => {
    if (!value) {
      return null;
    }
    const match = value.match(/\/(\d+)$/);
    return match?.[1] ? parseInt(match[1], 10) : null;
  };
  try {
    const headResponse = await fetch(url, {
      method: 'HEAD',
      headers,
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
    if (headResponse.ok) {
      const contentLength = headResponse.headers.get('content-length');
      if (contentLength) {
        return { ok: true, size: parseInt(contentLength, 10) };
      }
      const contentRange = parseContentRange(
        headResponse.headers.get('content-range')
      );
      if (contentRange) {
        return { ok: true, size: contentRange };
      }
    }
    const rangeResponse = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
    if (rangeResponse.status === 206) {
      const contentRange = parseContentRange(
        rangeResponse.headers.get('content-range')
      );
      if (contentRange) {
        return { ok: true, size: contentRange };
      }
    }
    const contentLength = rangeResponse.headers.get('content-length');
    if (contentLength && rangeResponse.status === 200) {
      return { ok: true, size: parseInt(contentLength, 10) };
    }
    try {
      await rangeResponse.body?.cancel();
    } catch {}
    return { ok: true, size: null };
  } catch (error) {
    return { ok: false, size: null, error: (error as Error).message };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index] as T);
      }
    })
  );
  return results;
}

{
  const chromeGlobal = (globalThis as any).chrome;
  const nativeBrowser = (globalThis as any).browser;
  const isFirefox = !!nativeBrowser?.sidebarAction;
  const isMobileBrowser = /Android|iPhone|iPad|iPod/i.test(
    (globalThis as any).navigator?.userAgent ?? ''
  );
  // Firefox lacks extraHeaders
  const sendHeadersExtraInfo = isFirefox
    ? ['requestHeaders']
    : ['requestHeaders', 'extraHeaders'];

  const supportsChromeSidepanel =
    !isFirefox &&
    !isMobileBrowser &&
    !!chromeGlobal?.sidePanel &&
    typeof chromeGlobal.sidePanel.setOptions === 'function' &&
    typeof chromeGlobal.sidePanel.open === 'function';
  const supportsFirefoxSidebar = isFirefox && !isMobileBrowser;

  const sidePanelPorts = new Map<number, any>();

  const setSidePanelForAllTabs = async (
    enabled: boolean,
    path?: string
  ): Promise<void> => {
    if (typeof chromeGlobal?.sidePanel?.setOptions !== 'function') {
      return;
    }
    const tabs = await browser.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (tab.id === undefined) {
        continue;
      }
      const options: any = { tabId: tab.id, enabled };
      if (path) {
        options.path = path;
      }
      try {
        await chromeGlobal.sidePanel.setOptions(options);
      } catch {}
    }
  };

  if (supportsChromeSidepanel) {
    const canOpenSidepanel = typeof chromeGlobal.sidePanel.open === 'function';
    const canSetOptions =
      typeof chromeGlobal.sidePanel.setOptions === 'function';

    const applyOpenMode = (openMode: 'sidepanel' | 'popup') => {
      if (openMode === 'popup') {
        if (canSetOptions) {
          try {
            chromeGlobal.sidePanel
              .setOptions({ enabled: false })
              .catch(() => {});
          } catch {}
          void setSidePanelForAllTabs(false);
        }
        chromeGlobal.action.setPopup({ popup: 'Popup/popup.html' });
      } else if (canOpenSidepanel) {
        chromeGlobal.action.setPopup({ popup: '' });
        if (canSetOptions) {
          try {
            chromeGlobal.sidePanel
              .setOptions({
                path: 'Sidepanel/sidepanel.html',
                enabled: true,
              })
              .catch(() => {});
          } catch {}
          void setSidePanelForAllTabs(true, 'Sidepanel/sidepanel.html');
        }
      }
    };

    applyOpenMode('sidepanel');
    loadSettings()
      .then((s) => applyOpenMode(s.openMode))
      .catch((e) => console.warn('[CoolHusky] loadSettings openMode:', e));

    if (canOpenSidepanel) {
      browser.runtime.onConnect.addListener((port) => {
        if (port.name !== 'sidepanel') {
          return;
        }
        let registeredTabId: number | undefined;

        port.onMessage.addListener((msg: any) => {
          if (
            msg?.type === 'SIDEPANEL_TAB_ID' &&
            typeof msg.tabId === 'number'
          ) {
            // Clean up any previous registration for this port so the old
            // tabId doesn't linger in sidePanelPorts after the Sidepanel
            // re-associates with a new tab (Sidepanel re-sends this on tab
            // switch via browser.tabs.onActivated).
            if (
              registeredTabId !== undefined &&
              registeredTabId !== msg.tabId
            ) {
              sidePanelPorts.delete(registeredTabId);
            }
            registeredTabId = msg.tabId;
            sidePanelPorts.set(msg.tabId, port);
            const pushList = (mm?: Map<string, MediaEntry>) => {
              if (mm && mm.size > 0) {
                try {
                  port.postMessage({
                    type: 'LIST_UPDATED',
                    tabId: msg.tabId,
                    list: serializeTabMediaList(mm),
                  });
                } catch {}
              }
            };
            const mediaMap = tabMap.get(msg.tabId);
            if (mediaMap && mediaMap.size > 0) {
              pushList(mediaMap);
            } else {
              loadTabList(msg.tabId)
                .then(pushList)
                .catch(() => {});
            }
          }
        });

        port.onDisconnect.addListener(() => {
          if (registeredTabId !== undefined) {
            sidePanelPorts.delete(registeredTabId);
          }
        });
      });

      browser.action.onClicked.addListener(async (tab) => {
        if (tab.id !== undefined) {
          const existingPort = sidePanelPorts.get(tab.id);
          if (existingPort) {
            try {
              existingPort.postMessage({ type: 'SIDEPANEL_CLOSE_REQUEST' });
            } catch {}
            return;
          }

          sidebarClosedTabs.delete(tab.id);

          try {
            const result = chromeGlobal.sidePanel.open({ tabId: tab.id });
            if (result && typeof result.then === 'function') {
              result.catch((e: any) => {
                console.warn('Failed to open sidepanel:', e);
              });
            }
          } catch (e) {
            console.warn('Failed to open sidepanel:', e);
          }
        }
      });
    } else {
      chromeGlobal.action.setPopup({ popup: 'Popup/popup.html' });
    }
  } else if (supportsFirefoxSidebar) {
    const browserAction = nativeBrowser.browserAction || nativeBrowser.action;
    browserAction.setPopup({ popup: '' });

    let firefoxSidebarOpen = false;

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== 'sidepanel') {
        return;
      }
      firefoxSidebarOpen = true;
      port.onMessage.addListener((msg: any) => {
        if (msg?.type === 'SIDEPANEL_CLOSE_REQUEST') {
          firefoxSidebarOpen = false;
        }
      });
      port.onDisconnect.addListener(() => {
        firefoxSidebarOpen = false;
      });
    });

    browserAction.onClicked.addListener(async () => {
      try {
        if (firefoxSidebarOpen) {
          await nativeBrowser.sidebarAction.close();
        } else {
          await nativeBrowser.sidebarAction.open();
        }
      } catch (e) {
        console.warn('Failed to toggle sidebar:', e);
      }
    });
  } else {
    if (chromeGlobal?.action?.setPopup) {
      chromeGlobal.action.setPopup({ popup: 'Popup/popup.html' });
    }
    if (isFirefox && nativeBrowser?.browserAction?.setPopup) {
      nativeBrowser.browserAction
        .setPopup({ popup: 'Popup/popup.html' })
        .catch?.(() => {});
    }
  }

  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      const welcomeUrl = browser.runtime.getURL('/Welcome/welcome.html' as any);
      browser.tabs.create({ url: welcomeUrl });
    }
  });

  browser.runtime.onStartup.addListener(() => {});

  // Keyboard shortcut commands (declared in manifest.json).
  try {
    browser.commands?.onCommand?.addListener(async (command: string) => {
      if (command === 'toggle_enable') {
        sniffingEnabled = !sniffingEnabled;
        void persistSniffingEnabled();
        try {
          await browser.notifications.create({
            type: 'basic',
            iconUrl: browser.runtime.getURL(
              '/assets/icons/favicon-128.png' as any
            ),
            title: sniffingEnabled ? 'CoolHusky' : 'CoolHusky',
            message: sniffingEnabled ? 'Sniffing enabled' : 'Sniffing paused',
          });
        } catch {}
        return;
      }
      if (command === 'clear_list') {
        try {
          const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true,
          });
          const tabId = tabs[0]?.id;
          if (tabId !== undefined) {
            clearTabMediaData(tabId);
            try {
              updateBadge(tabId);
            } catch {}
            broadcast(tabId, []);
          }
        } catch {}
        return;
      }
      if (command === 'deep_search') {
        try {
          const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true,
          });
          const tabId = tabs[0]?.id;
          if (tabId !== undefined) {
            browser.tabs
              .sendMessage(tabId, {
                type: 'COOLHUSKY_RUN_DEEP_SEARCH',
              })
              .catch(() => {});
          }
        } catch {}
        return;
      }
      if (command === 'preview') {
        try {
          const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true,
          });
          const tabId = tabs[0]?.id;
          if (tabId !== undefined) {
            // Open the sidepanel/popup to preview the current tab's media.
            if (supportsChromeSidepanel && chromeGlobal?.sidePanel?.open) {
              chromeGlobal.sidePanel.open({ tabId }).catch(() => {});
            }
          }
        } catch {}
        return;
      }
    });
  } catch {
    // Firefox may not expose browser.commands in some contexts.
  }

  // Context menu (right-click) actions.
  try {
    const contextMenus = (browser as any).contextMenus;
    if (contextMenus) {
      const MENU_TOGGLE = 'coolhusky-toggle-enable';
      const MENU_DEEP_SEARCH = 'coolhusky-deep-search';
      const MENU_CLEAR = 'coolhusky-clear-list';
      const MENU_PREVIEW = 'coolhusky-preview';

      const setupContextMenu = async (): Promise<void> => {
        try {
          await contextMenus.removeAll();
          contextMenus.create({
            id: MENU_TOGGLE,
            title: 'Toggle Sniffing',
            contexts: ['action'],
          });
          contextMenus.create({
            id: MENU_DEEP_SEARCH,
            title: 'Deep Search This Page',
            contexts: ['action', 'page'],
          });
          contextMenus.create({
            id: MENU_CLEAR,
            title: 'Clear Media List',
            contexts: ['action'],
          });
          contextMenus.create({
            id: MENU_PREVIEW,
            title: 'Preview Media',
            contexts: ['action'],
          });
        } catch {}
      };
      void setupContextMenu();

      contextMenus.onClicked.addListener(
        async (
          info: { menuItemId: string },
          tab?: { id?: number }
        ): Promise<void> => {
          if (info.menuItemId === MENU_TOGGLE) {
            sniffingEnabled = !sniffingEnabled;
            void persistSniffingEnabled();
            try {
              await browser.notifications.create({
                type: 'basic',
                iconUrl: browser.runtime.getURL(
                  '/assets/icons/favicon-128.png' as any
                ),
                title: 'CoolHusky',
                message: sniffingEnabled
                  ? 'Sniffing enabled'
                  : 'Sniffing paused',
              });
            } catch {}
            return;
          }
          if (info.menuItemId === MENU_DEEP_SEARCH && tab?.id !== undefined) {
            browser.tabs
              .sendMessage(tab.id, { type: 'COOLHUSKY_RUN_DEEP_SEARCH' })
              .catch(() => {});
            return;
          }
          if (info.menuItemId === MENU_CLEAR && tab?.id !== undefined) {
            clearTabMediaData(tab.id);
            try {
              updateBadge(tab.id);
            } catch {}
            broadcast(tab.id, []);
            return;
          }
          if (info.menuItemId === MENU_PREVIEW && tab?.id !== undefined) {
            if (supportsChromeSidepanel && chromeGlobal?.sidePanel?.open) {
              chromeGlobal.sidePanel.open({ tabId: tab.id }).catch(() => {});
            }
            return;
          }
        }
      );
    }
  } catch {
    // contextMenus unavailable
  }

  const tabMap = new Map<number, Map<string, MediaEntry>>();
  const bilibiliManagedUrls = new Map<number, Set<string>>();
  const platformManagedUrls = new Map<number, Set<string>>();
  const platformTaskPriorities = new Map<number, Map<string, number>>();
  const douyinMediaMetadata = new Map<
    number,
    Map<string, { title?: string; coverUrl?: string; duration?: number }>
  >();
  const douyinNativeTracks = new Map<
    number,
    Map<string, Array<{ url: string; role: 'video' | 'audio'; at: number }>>
  >();
  const tabPageUrls = new Map<number, string>();
  const tabPageTitles = new Map<number, string>();
  const pendingNavigationCheck = new Map<number, { prevUrl: string }>();

  const masterPrefixIndex = new Map<
    number,
    { version: number; map: Map<string, string[]> }
  >();
  const tabMediaVersion = new Map<number, number>();
  function bumpTabVersion(tabId: number) {
    tabMediaVersion.set(tabId, (tabMediaVersion.get(tabId) ?? 0) + 1);
  }
  function getMasterPrefixIndex(
    tabId: number,
    mediaMap: Map<string, MediaEntry>
  ): Map<string, string[]> {
    const curVersion = tabMediaVersion.get(tabId) ?? 0;
    let entry = masterPrefixIndex.get(tabId);
    if (!entry || entry.version !== curVersion) {
      const map = new Map<string, string[]>();
      for (const [mUrl, mEntry] of mediaMap) {
        if (
          mEntry.format === 'm3u8' &&
          (mEntry.groupRole === 'master' || !mEntry.groupRole)
        ) {
          const prefix = mUrl.substring(0, mUrl.lastIndexOf('/') + 1);
          if (!prefix) {
            continue;
          }
          let arr = map.get(prefix);
          if (!arr) {
            arr = [];
            map.set(prefix, arr);
          }
          arr.push(mUrl);
        }
      }
      entry = { version: curVersion, map };
      masterPrefixIndex.set(tabId, entry);
    }
    return entry.map;
  }

  // Match segment URLs to master playlists by shared URL prefix
  function findMasterBySegmentUrl(
    tabId: number,
    mediaMap: Map<string, MediaEntry>,
    segUrl: string
  ): string | undefined {
    const index = getMasterPrefixIndex(tabId, mediaMap);
    if (index.size === 0) {
      return undefined;
    }
    let probe = segUrl.substring(0, segUrl.lastIndexOf('/') + 1);
    while (probe) {
      const arr = index.get(probe);
      if (arr && arr.length > 0) {
        return arr[0];
      }
      const idx = probe.lastIndexOf('/', probe.length - 2);
      if (idx < 0) {
        break;
      }
      probe = probe.substring(0, idx + 1);
    }
    return undefined;
  }
  const sidebarClosedTabs = new Set<number>();
  let isDataLoaded = false;
  const pendingMessages: Array<{
    msg: any;
    sender: any;
    sendResponse: (response?: any) => void;
  }> = [];

  const uiListeningTabs = new Map<number, number>();
  const UI_LISTENING_TTL = 90_000;
  function isUiListening(tabId: number): boolean {
    if (sidePanelPorts.has(tabId)) {
      return true;
    }
    const ts = uiListeningTabs.get(tabId);
    if (ts === undefined) {
      return false;
    }
    if (Date.now() - ts > UI_LISTENING_TTL) {
      uiListeningTabs.delete(tabId);
      return false;
    }
    return true;
  }

  const pendingProxyFetches = new Map<
    string,
    { controller: AbortController; tabId?: number }
  >();

  let currentSettings: Settings = {
    sniffingRules: { ...DEFAULT_SETTINGS.sniffingRules },
    excludeDomains: [...DEFAULT_SETTINGS.excludeDomains],
    maxItems: DEFAULT_SETTINGS.maxItems,
    enableMseCapture: DEFAULT_SETTINGS.enableMseCapture,
    hideStreamSegments: DEFAULT_SETTINGS.hideStreamSegments,
    captureDataImages: DEFAULT_SETTINGS.captureDataImages,
    dataImageMinSizeKB: DEFAULT_SETTINGS.dataImageMinSizeKB,
    openMode: DEFAULT_SETTINGS.openMode,
    enableDeepSearch: DEFAULT_SETTINGS.enableDeepSearch,
    regexRules: [],
    formatOverrides: {},
  };
  // Global sniffing toggle, bound to the toggle_enable keyboard shortcut.
  let sniffingEnabled = true;
  // Persist sniffingEnabled across SW restarts via storage.session.
  (browser.storage.session as any)
    ?.get?.('coolhusky_sniffing_enabled')
    .then((res: any) => {
      if (res && typeof res.coolhusky_sniffing_enabled === 'boolean') {
        sniffingEnabled = res.coolhusky_sniffing_enabled;
      }
    })
    .catch(() => {});
  async function persistSniffingEnabled(): Promise<void> {
    try {
      await (browser.storage.session as any)?.set?.({
        coolhusky_sniffing_enabled: sniffingEnabled,
      });
    } catch {}
  }
  loadSettings()
    .then((s) => {
      currentSettings = s;
    })
    .catch((e) => {
      console.warn('[CoolHusky] loadSettings failed:', e);
    });

  browser.storage.local.onChanged.addListener((changes) => {
    if (changes['coolhusky_settings']) {
      loadSettings()
        .then((s) => {
          currentSettings = s;
          if (supportsChromeSidepanel && chromeGlobal?.action?.setPopup) {
            if (s.openMode === 'popup') {
              if (typeof chromeGlobal.sidePanel?.setOptions === 'function') {
                try {
                  chromeGlobal.sidePanel
                    .setOptions({ enabled: false })
                    .catch(() => {});
                } catch {}
                void setSidePanelForAllTabs(false);
              }
              chromeGlobal.action.setPopup({ popup: 'Popup/popup.html' });
            } else {
              chromeGlobal.action.setPopup({ popup: '' });
              if (typeof chromeGlobal.sidePanel?.setOptions === 'function') {
                try {
                  chromeGlobal.sidePanel
                    .setOptions({
                      path: 'Sidepanel/sidepanel.html',
                      enabled: true,
                    })
                    .catch(() => {});
                } catch {}
                void setSidePanelForAllTabs(true, 'Sidepanel/sidepanel.html');
              }
            }
          }
          browser.tabs
            .query({})
            .then((tabs) => {
              for (const tab of tabs) {
                if (tab.id) {
                  browser.tabs
                    .sendMessage(tab.id, {
                      type: 'COOLHUSKY_SETTINGS_CHANGED',
                      enableMseCapture: s.enableMseCapture,
                      captureDataImages: s.captureDataImages,
                      dataImageMinSizeKB: s.dataImageMinSizeKB,
                      enableDeepSearch: s.enableDeepSearch,
                    })
                    .catch(() => {});
                }
              }
            })
            .catch(() => {});
          void (async () => {
            try {
              const restored = await loadAllTabData();
              restored.forEach((mediaMap, tabId) => {
                const existing = tabMap.get(tabId);
                if (!existing || existing.size === 0) {
                  tabMap.set(tabId, mediaMap);
                }
              });
            } catch {
              //
            }
            tabMap.forEach((_entries, tabId) => {
              try {
                updateBadge(tabId);
              } catch {
                //
              }
            });
          })();
        })
        .catch((e) => {
          console.warn('[CoolHusky] settings reload failed:', e);
        });
    }
  });

  function clearTabMediaData(tabId: number): void {
    tabMap.delete(tabId);
    bilibiliManagedUrls.delete(tabId);
    platformManagedUrls.delete(tabId);
    platformTaskPriorities.delete(tabId);
    douyinMediaMetadata.delete(tabId);
    douyinNativeTracks.delete(tabId);
    masterPrefixIndex.delete(tabId);
    tabMediaVersion.delete(tabId);
    tabPageUrls.delete(tabId);
    tabPageTitles.delete(tabId);
    pendingNavigationCheck.delete(tabId);
    sidebarClosedTabs.delete(tabId);
    manifestParseTabLastAt.delete(tabId);
    // NOTE: do NOT delete uiListeningTabs / sidePanelPorts here — this runs on
    // CLEAR_LIST (user clicked "clear"), and removing the UI listening
    // registration would stop Background from broadcasting the tab's
    // rediscovered resources after a page reload, so the list stays empty.
    // Those are cleaned only on tab removal (onRemoved).
    // Cancel any pending debounced broadcast for this tab so its timer
    // doesn't fire after the data is gone.
    const pendingTimer = broadcastDebounceTimers.get(tabId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      broadcastDebounceTimers.delete(tabId);
    }
    deleteTabList(tabId).catch(() => {});
    for (const key of processedRequests) {
      if (key.startsWith(`${tabId}:`)) {
        processedRequests.delete(key);
      }
    }
  }

  function isSameSite(a: string, b: string): boolean {
    try {
      const hostA = new URL(a).hostname.toLowerCase().replace(/^www\./, '');
      const hostB = new URL(b).hostname.toLowerCase().replace(/^www\./, '');
      if (hostA === hostB) {
        return true;
      }
      const regA = hostA.split('.').slice(-2).join('.');
      const regB = hostB.split('.').slice(-2).join('.');
      return regA === regB && regA.includes('.');
    } catch {
      return false;
    }
  }

  try {
    if (browser.webNavigation) {
      browser.webNavigation.onBeforeNavigate.addListener(() => {});
      browser.webNavigation.onHistoryStateUpdated.addListener(() => {});
    }
  } catch {
    // Firefox quirk
  }

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
      const nextUrl = changeInfo.url || tab?.url || '';
      const prevUrl = tabPageUrls.get(tabId) || '';
      if (prevUrl && nextUrl && !isSameSite(prevUrl, nextUrl)) {
        clearTabMediaData(tabId);
        try {
          updateBadge(tabId);
        } catch {}
        broadcast(tabId, []);
      } else if (prevUrl && nextUrl) {
        pendingNavigationCheck.set(tabId, { prevUrl });
      }
    }
    if (changeInfo.status === 'complete') {
      const pending = pendingNavigationCheck.get(tabId);
      if (pending) {
        pendingNavigationCheck.delete(tabId);
        const finalUrl = tab?.url || changeInfo.url || '';
        const prevUrl = pending.prevUrl;
        if (prevUrl && finalUrl) {
          if (finalUrl === prevUrl || !isSameSite(prevUrl, finalUrl)) {
            clearTabMediaData(tabId);
            try {
              updateBadge(tabId);
            } catch {}
            broadcast(tabId, []);
          }
        }
      }
    }
    if (changeInfo.url) {
      tabPageUrls.set(tabId, changeInfo.url);
      saveTabPageUrl(tabId, changeInfo.url).catch(() => {});
    } else if (tab.url) {
      tabPageUrls.set(tabId, tab.url);
    }
    if (changeInfo.title) {
      tabPageTitles.set(tabId, changeInfo.title);
    } else if (tab.title) {
      tabPageTitles.set(tabId, tab.title);
    }
  });

  loadAllTabData()
    .then((data) => {
      loadTabPageUrls()
        .then((urls) => {
          urls.forEach((url, tabId) => {
            if (!tabPageUrls.has(tabId)) {
              tabPageUrls.set(tabId, url);
            }
          });
        })
        .catch(() => {});
      data.forEach((mediaMap, tabId) => {
        const existing = tabMap.get(tabId);
        if (existing && existing.size > 0) {
          for (const [url, entry] of mediaMap) {
            if (!existing.has(url)) {
              existing.set(url, entry);
            }
          }
          tabMap.set(tabId, existing);
        } else {
          tabMap.set(tabId, mediaMap);
        }
        try {
          updateBadge(tabId);
        } catch {}
      });
      isDataLoaded = true;
      pendingMessages.forEach(({ msg, sender, sendResponse }) => {
        handleMessage(msg, sender, sendResponse);
      });
      pendingMessages.length = 0;
    })
    .catch((error) => {
      console.warn('[CoolHusky] Failed to restore sniffed media:', error);
      isDataLoaded = true;
      pendingMessages.forEach(({ msg, sender, sendResponse }) => {
        handleMessage(msg, sender, sendResponse);
      });
      pendingMessages.length = 0;
    });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    try {
      updateBadge(tabId);
    } catch {}
    broadcast(tabId, serializeTabMediaList(tabMap.get(tabId)));
  });

  const broadcastDebounceTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();

  // Debounce broadcast to UI: coalesce rapid media additions (150ms)
  function broadcastDebounced(tabId: number) {
    const existing = broadcastDebounceTimers.get(tabId);
    if (existing) {
      clearTimeout(existing);
    }
    broadcastDebounceTimers.set(
      tabId,
      setTimeout(() => {
        broadcastDebounceTimers.delete(tabId);
        const mediaMap = tabMap.get(tabId);
        if (!mediaMap) {
          return;
        }

        if (!isUiListening(tabId)) {
          return;
        }
        const list: Array<{
          url: string;
          format: string;
          size?: number;
          width?: number;
          height?: number;
          detectedAt?: number;
          category?: MediaCategory;
          requestHeaders?: Record<string, string>;
          captureId?: string;
          trackCount?: number;
          mseComplete?: boolean;
          groupId?: string;
          groupRole?: string;
          groupLabel?: string;
          groupMasterId?: string;
          variantBandwidth?: number;
          audioUrl?: string;
          audioOptions?: Array<{ url: string; label: string }>;
          duration?: number;
          coverUrl?: string;
          tabTitle?: string;
          isLiveStream?: boolean;
        }> = [];
        mediaMap.forEach((entry, url) => {
          if (entry.contentType === 'virtual/group') {
            return;
          }
          list.push({
            url,
            format: entry.format,
            size: entry.size,
            width: entry.width,
            height: entry.height,
            detectedAt: entry.detectedAt,
            category: entry.category,
            requestHeaders: entry.requestHeaders,
            captureId: entry.captureId,
            trackCount: entry.trackCount,
            mseComplete: entry.mseComplete,
            groupId: entry.groupId,
            groupRole: entry.groupRole,
            groupLabel: entry.groupLabel,
            groupMasterId: entry.groupMasterId,
            variantBandwidth: entry.variantBandwidth,
            audioUrl: entry.audioUrl,
            audioOptions: entry.audioOptions,
            duration: entry.duration,
            coverUrl: entry.coverUrl,
            tabTitle: entry.tabTitle,
            isLiveStream: entry.isLiveStream,
          });
        });
        broadcast(tabId, list);
      }, 150)
    );
  }

  const processedRequests = new Set<string>();
  const PROCESSED_REQUESTS_MAX = 10000;

  const pendingRequestHeaders = new Map<string, Record<string, string>>();

  const urlSniffPending = new Map<string, string>();

  const AUTH_HEADER_NAMES = new Set([
    'cookie',
    'authorization',
    'x-auth-token',
    'x-access-token',
    'token',
    'api-key',
    'x-api-key',
    'x-csrf-token',
    'wbi-key',
    'referer',
  ]);

  const isPotentialMediaRequest = (url: string): boolean =>
    /\.(m3u8|m3u|mpd|mp4|m4v|webm|ogv|flv|mkv|mov|avi|3gp|3g2|mpeg|mpg|mp3|m4a|oga|weba|wav|flac|aac|gif|jpe?g|png|webp|svg|avif|bmp|ico|heic|heif|apng|tiff?|pdf|docx?|xlsx?|pptx?|epub|csv|rtf|srt|vtt|ass|ssa|ttml)(?:[?#]|$)|(?:subtitle|caption)/i.test(
      url
    );

  const isMediaSegmentRequest = (url: string): boolean =>
    /\.(m4s|m4f|m4i|cmfv|cmfa|cmft|ts)(?:[?#]|$)/i.test(url);

  const sniffMediaFromUrl = (details: {
    requestId: string;
    tabId: number;
    url: string;
    type: string;
  }): void => {
    if (
      details.type === 'main_frame' ||
      details.type === 'sub_frame' ||
      details.type === 'script' ||
      details.type === 'stylesheet' ||
      details.type === 'font' ||
      details.type === 'image' ||
      details.type === 'ping' ||
      details.type === 'csp_report'
    ) {
      return;
    }
    if (!isPotentialMediaRequest(details.url)) {
      return;
    }
    if (isMediaSegmentRequest(details.url)) {
      return;
    }
    const effectiveTabId = details.tabId;
    if (effectiveTabId <= 0) {
      // Requests without a real tab id (tabId <= 0) come from the extension's
      // own service worker (e.g. our manifest sampling fetches), prerender, or
      // browser-internal contexts. Attributing them to the active tab
      // wrongly associates another origin's media with the active tab, so the
      // list shows the active tab's title on media that doesn't belong to it.
      // Skip these instead of guessing.
      return;
    }
    const requestKey = `${effectiveTabId}:${details.url}`;
    if (processedRequests.has(requestKey)) {
      return;
    }
    if (urlSniffPending.has(details.requestId)) {
      return;
    }
    const format = detectMediaFromUrl(details.url);
    if (!format) {
      return;
    }

    urlSniffPending.set(details.requestId, requestKey);
    addMedia(
      details.url,
      effectiveTabId,
      format,
      undefined,
      'media',
      undefined,
      undefined,
      undefined,
      tabPageTitles.get(effectiveTabId)
    );
  };

  const isBilibiliTab = (tabId: number): boolean => {
    try {
      return /(^|\.)bilibili\.com$/i.test(
        new URL(tabPageUrls.get(tabId) || '').hostname
      );
    } catch {
      return false;
    }
  };

  const isBilibiliSubtitleCatalogApi = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      if (!/(^|\.)bilibili\.com$/i.test(parsed.hostname)) {
        return false;
      }
      return /\/x\/player\/(?:wbi\/)?v2(?:\/|$)|\/x\/v2\/dm\/view(?:\/|$)/i.test(
        parsed.pathname
      );
    } catch {
      return false;
    }
  };

  browser.webRequest.onSendHeaders.addListener(
    (details) => {
      if (!details.requestHeaders?.length) {
        return;
      }
      if (details.tabId <= 0) {
        // No real tab: extension SW / prerender / browser-internal. Skip
        // entirely — onHeadersReceived and sniffMediaFromUrl skip these too,
        // so capturing auth headers here would only leak.
        return;
      }
      if (details.type === 'other' && !isPotentialMediaRequest(details.url)) {
        return;
      }
      const authHeaders: Record<string, string> = {};
      for (const h of details.requestHeaders) {
        const name = h.name.toLowerCase();
        if (AUTH_HEADER_NAMES.has(name) && h.value) {
          authHeaders[name] = h.value;
        }
      }
      if (Object.keys(authHeaders).length > 0) {
        pendingRequestHeaders.set(details.requestId, authHeaders);
      }
      sniffMediaFromUrl(details);
    },
    {
      urls: ['<all_urls>'],
    },
    sendHeadersExtraInfo as any[]
  );

  browser.webRequest.onErrorOccurred.addListener(
    (details) => {
      pendingRequestHeaders.delete(details.requestId);
      const sniffKey = urlSniffPending.get(details.requestId);
      if (sniffKey) {
        urlSniffPending.delete(details.requestId);
        const sep = sniffKey.indexOf(':');
        const tabId = Number(sniffKey.slice(0, sep));
        const url = sniffKey.slice(sep + 1);
        const entry = tabMap.get(tabId)?.get(url);
        if (entry && entry.size === undefined && !entry.contentType) {
          tabMap.get(tabId)?.delete(url);
          saveTabList(tabId, tabMap.get(tabId) ?? new Map()).catch(() => {});
          try {
            updateBadge(tabId);
          } catch {
            //
          }
          broadcastDebounced(tabId);
        }
      }
    },
    {
      urls: ['<all_urls>'],
    }
  );

  // Clean up per-request bookkeeping when a request completes normally.
  // onErrorOccurred only fires on failure; without this, requests that finish
  // without triggering onHeadersReceived (e.g. cancelled by another extension)
  // would leak entries in pendingRequestHeaders / urlSniffPending.
  browser.webRequest.onCompleted.addListener(
    (details) => {
      pendingRequestHeaders.delete(details.requestId);
      urlSniffPending.delete(details.requestId);
    },
    {
      urls: ['<all_urls>'],
    }
  );

  function addProcessedRequest(key: string) {
    if (processedRequests.size >= PROCESSED_REQUESTS_MAX) {
      const first = processedRequests.values().next().value;
      if (first !== undefined) {
        processedRequests.delete(first);
      }
    }
    processedRequests.add(key);
  }

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const effectiveTabId = details.tabId;
      if (effectiveTabId <= 0) {
        // See sniffMediaFromUrl: requests without a real tab id come from the
        // extension SW / prerender / browser-internal contexts. Attributing
        // them to the active tab mixes another origin's media with the
        // active tab. Skip instead of guessing. Clean up any auth headers
        // captured in onSendHeaders so they don't leak.
        pendingRequestHeaders.delete(details.requestId);
        return undefined;
      }
      if (isMediaSegmentRequest(details.url)) {
        pendingRequestHeaders.delete(details.requestId);
        return undefined;
      }
      if (
        isBilibiliTab(effectiveTabId) &&
        isBilibiliSubtitleCatalogApi(details.url)
      ) {
        pendingRequestHeaders.delete(details.requestId);
        return undefined;
      }

      const requestKey = `${effectiveTabId}:${details.url}`;
      if (processedRequests.has(requestKey)) {
        return undefined;
      }

      if (details.statusCode === 416) {
        addProcessedRequest(requestKey);
        urlSniffPending.delete(details.requestId);
        return undefined;
      }

      if (details.type === 'other' && !isPotentialMediaRequest(details.url)) {
        pendingRequestHeaders.delete(details.requestId);
        return undefined;
      }

      let contentType: string | null = null;
      let contentLength: number | undefined = undefined;
      let contentDisposition: string | null = null;
      let hasContentRange = false;
      let rangeTotal: number | undefined = undefined;

      for (const header of details.responseHeaders ?? []) {
        const name = header.name.toLowerCase();
        if (name === 'content-type' && header.value) {
          contentType = header.value;
        } else if (name === 'content-length' && header.value) {
          const n = parseInt(header.value, 10);
          if (!isNaN(n)) {
            contentLength = n;
          }
        } else if (name === 'content-disposition' && header.value) {
          contentDisposition = header.value;
        } else if (name === 'content-range' && header.value) {
          hasContentRange = true;
          const m = header.value.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
          if (m && m[3] !== '*') {
            const total = parseInt(m[3]!, 10);
            rangeTotal = total;
          }
        }
      }

      if (hasContentRange && rangeTotal !== undefined) {
        contentLength = rangeTotal;
      }

      let detectedFormat: string;
      let category: MediaCategory = 'media';

      if (details.type === 'media') {
        const isOctetStream =
          contentType?.toLowerCase().startsWith('application/octet-stream') ??
          false;
        const mediaFallback =
          isKnownMediaCdn(details.url) || isOctetStream ? 'mp4' : undefined;
        const detectedMediaFormat = contentType
          ? (detectMedia(
              details.url,
              contentType,
              contentLength,
              contentDisposition
            ) ??
            detectMediaFromUrl(details.url) ??
            mediaFallback)
          : (detectMediaFromUrl(details.url) ?? mediaFallback);
        if (!detectedMediaFormat) {
          return undefined;
        }
        detectedFormat = detectedMediaFormat;
        const settings = currentSettings;
        const pageUrl = tabPageUrls.get(effectiveTabId);
        if (settings && pageUrl && isDomainExcluded(pageUrl, settings)) {
          return undefined;
        }
        if (settings && !isFormatAllowed(detectedFormat, settings)) {
          return undefined;
        }
        addMedia(
          details.url,
          effectiveTabId,
          detectedFormat,
          contentLength,
          category,
          pendingRequestHeaders.get(details.requestId),
          undefined,
          contentType ?? undefined
        );
        addProcessedRequest(requestKey);
        pendingRequestHeaders.delete(details.requestId);
        urlSniffPending.delete(details.requestId);
        return undefined;
      }

      const mediaFmt = detectMedia(
        details.url,
        contentType,
        contentLength,
        contentDisposition
      );
      if (mediaFmt) {
        detectedFormat = mediaFmt;
      } else {
        const doc = detectDoc(details.url, contentType, contentDisposition);
        if (!doc) {
          return undefined;
        }
        detectedFormat = doc.format;
        category = doc.category;
      }

      const settings = currentSettings;
      const pageUrl = tabPageUrls.get(effectiveTabId);
      if (settings && pageUrl && isDomainExcluded(pageUrl, settings)) {
        return undefined;
      }
      if (settings && !isFormatAllowed(detectedFormat, settings)) {
        return undefined;
      }
      const isExplicitMediaType = contentType
        ? /^(audio|video)\//i.test(contentType.trim())
        : false;
      if (
        settings &&
        !isExplicitMediaType &&
        detectedFormat !== 'm3u8' &&
        detectedFormat !== 'mpd' &&
        !isSizeAllowed(detectedFormat, contentLength, settings)
      ) {
        return undefined;
      }

      addMedia(
        details.url,
        effectiveTabId,
        detectedFormat,
        contentLength,
        category,
        pendingRequestHeaders.get(details.requestId),
        undefined,
        contentType ?? undefined,
        tabPageTitles.get(effectiveTabId)
      );
      addProcessedRequest(requestKey);
      pendingRequestHeaders.delete(details.requestId);
      urlSniffPending.delete(details.requestId);
      return undefined;
    },
    {
      urls: ['<all_urls>'],
    },
    ['responseHeaders']
  );

  const CACHE_HEADER_NAMES = new Set([
    'cache-control',
    'pragma',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'if-match',
    'if-unmodified-since',
    'warning',
  ]);

  // Firefox uses webRequest blocking; Chromium uses declarativeNetRequest
  const proxyHeaderExtraInfoSpec = (
    isFirefox ? ['blocking', 'requestHeaders'] : ['requestHeaders']
  ) as any[];
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const proxyHeader = details.requestHeaders?.find(
        (h) => h.name.toLowerCase() === 'x-coolhusky-proxy'
      );
      let playbackRule:
        { referer: string; authHeaders?: Record<string, string> } | undefined;
      if (isFirefox && !proxyHeader) {
        try {
          playbackRule = playbackHeaderHosts.get(new URL(details.url).host);
        } catch {
          playbackRule = undefined;
        }
      }
      if (!proxyHeader && !playbackRule) {
        return {};
      }

      const refererHeader = details.requestHeaders?.find(
        (h) => h.name.toLowerCase() === 'x-coolhusky-referer'
      );
      const newHeaders = (details.requestHeaders || []).filter((h) => {
        const name = h.name.toLowerCase();
        if (name === 'origin') {
          return false;
        }
        if (name === 'x-coolhusky-proxy' || name === 'x-coolhusky-referer') {
          return false;
        }
        if (CACHE_HEADER_NAMES.has(name)) {
          return false;
        }
        return true;
      });

      const referer = refererHeader?.value || playbackRule?.referer;
      if (referer) {
        newHeaders.push({ name: 'Referer', value: referer });
      }
      if (playbackRule?.authHeaders) {
        for (const [name, value] of Object.entries(playbackRule.authHeaders)) {
          newHeaders.push({ name, value });
        }
      }

      return { requestHeaders: newHeaders };
    },
    { urls: ['<all_urls>'] },
    proxyHeaderExtraInfoSpec
  );

  const DNR_RULES_MAX = 5000;
  const DNR_RULES_EVICT = 100;
  const dnlRefererRules = new Map<
    string,
    { id: number; referer: string; headersKey: string; lastUsed: number }
  >();
  const playbackHeaderHosts = new Map<
    string,
    { referer: string; authHeaders?: Record<string, string> }
  >();
  let dnlRefererSeq = 1;

  async function ensureProxyHeaderRule(
    targetUrl: string,
    referer: string,
    authHeaders?: Record<string, string>
  ): Promise<void> {
    const dnr = (browser as any).declarativeNetRequest;
    let host: string;
    try {
      host = new URL(targetUrl).host;
    } catch {
      return;
    }
    if (isFirefox || !dnr) {
      playbackHeaderHosts.set(host, { referer, authHeaders });
      return;
    }

    const headersKey = JSON.stringify({ referer, ...authHeaders });
    const cached = dnlRefererRules.get(host);
    if (
      cached &&
      cached.referer === referer &&
      cached.headersKey === headersKey
    ) {
      cached.lastUsed = Date.now();
      return;
    }

    const ruleId = cached?.id ?? dnlRefererSeq++;
    const removeRuleIds = cached ? [cached.id] : [];

    const requestHeaders: any[] = [
      { operation: 'set', header: 'Referer', value: referer },
      { operation: 'remove', header: 'Origin' },
      { operation: 'remove', header: 'X-CoolHusky-Proxy' },
      { operation: 'remove', header: 'X-CoolHusky-Referer' },
      { operation: 'remove', header: 'Cache-Control' },
      { operation: 'remove', header: 'Pragma' },
      { operation: 'remove', header: 'If-Modified-Since' },
      { operation: 'remove', header: 'If-None-Match' },
      { operation: 'remove', header: 'If-Range' },
      { operation: 'remove', header: 'If-Match' },
      { operation: 'remove', header: 'If-Unmodified-Since' },
    ];

    const responseHeaders: any[] = [
      { operation: 'set', header: 'Access-Control-Allow-Origin', value: '*' },
      { operation: 'set', header: 'Access-Control-Allow-Headers', value: '*' },
      {
        operation: 'set',
        header: 'Access-Control-Allow-Methods',
        value: 'GET,HEAD,OPTIONS',
      },
    ];

    if (authHeaders) {
      for (const [k, v] of Object.entries(authHeaders)) {
        requestHeaders.push({ operation: 'set', header: k, value: v });
      }
    }

    const evictIds: number[] = [];
    if (dnlRefererRules.size >= DNR_RULES_MAX && !cached) {
      const sorted = [...dnlRefererRules.entries()]
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
        .slice(0, DNR_RULES_EVICT);
      for (const [h, v] of sorted) {
        evictIds.push(v.id);
        dnlRefererRules.delete(h);
        playbackHeaderHosts.delete(h);
      }
    }

    await dnr.updateSessionRules({
      removeRuleIds: [...removeRuleIds, ...evictIds],
      addRules: [
        {
          id: ruleId,
          priority: 10,
          action: {
            type: 'modifyHeaders',
            requestHeaders,
            responseHeaders,
          },
          condition: {
            urlFilter: `||${host}^`,
            initiatorDomains: [browser.runtime.id],
          },
        },
      ],
    });
    dnlRefererRules.set(host, {
      id: ruleId,
      referer,
      headersKey,
      lastUsed: Date.now(),
    });
    playbackHeaderHosts.set(host, { referer, authHeaders });
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    for (const key of processedRequests) {
      if (key.startsWith(`${tabId}:`)) {
        processedRequests.delete(key);
      }
    }

    for (const [rid, entry] of pendingProxyFetches) {
      if (entry.tabId === tabId) {
        entry.controller.abort();
        pendingProxyFetches.delete(rid);
      }
    }
    tabMap.delete(tabId);
    bilibiliManagedUrls.delete(tabId);
    platformManagedUrls.delete(tabId);
    platformTaskPriorities.delete(tabId);
    douyinMediaMetadata.delete(tabId);
    douyinNativeTracks.delete(tabId);
    tabPageUrls.delete(tabId);
    tabPageTitles.delete(tabId);
    pendingNavigationCheck.delete(tabId);
    sidebarClosedTabs.delete(tabId);
    masterPrefixIndex.delete(tabId);
    tabMediaVersion.delete(tabId);
    uiListeningTabs.delete(tabId);
    manifestParseTabLastAt.delete(tabId);
    sidePanelPorts.delete(tabId);
    deleteTabList(tabId);
    deleteTabPageUrl(tabId).catch(() => {});
  });

  const notifyPages = new Map<string, string>();

  browser.notifications.onClicked.addListener((notificationId) => {
    handleNotificationClick(String(notificationId));
  });
  // Clean up stored page urls for notifications dismissed without clicking.
  browser.notifications.onClosed.addListener((notificationId) => {
    notifyPages.delete(String(notificationId));
  });

  async function handleNotificationClick(tag: string) {
    if (tag !== 'download-complete' && tag !== 'download-error') {
      return;
    }
    const target = notifyPages.get(tag) || 'https://192.168.1.3:3001/';
    // Clean up the stored page url — the notification is being dismissed.
    notifyPages.delete(tag);
    let tabId: number | undefined;
    try {
      const host = new URL(target).host;
      const [existing] = await browser.tabs.query({ url: `*://${host}/*` });
      if (existing?.id) {
        tabId = existing.id;
        await browser.tabs.update(tabId, { active: true });
        if (existing.windowId !== undefined) {
          await browser.windows
            .update(existing.windowId, { focused: true })
            .catch(() => {});
        }
      } else {
        const created = await browser.tabs.create({ url: target });
        tabId = created.id;
      }
    } catch (e) {
      console.warn('[CoolHusky] notification click failed:', e);
    }
    if (tabId !== undefined) {
      browser.tabs
        .sendMessage(tabId, { type: 'COOLHUSKY_NOTIFY_CLICK', tag })
        .catch(() => {});
    }
  }

  browser.runtime.onMessage.addListener(
    (msg: any, sender: any, sendResponse: any) => {
      const asyncTypes = [
        'GET_VIDEO_DIMENSIONS',
        'GET_AUDIO_DURATION',
        'GET_MEDIA_INFO',
        'GET_SETTINGS',
        'SAVE_SETTINGS',
        'CLOSE_SIDEBAR_FOR_TAB',
        'PROXY_FETCH',
        'PROXY_FETCH_CANCEL',
        'PREPARE_MEDIA_PLAYBACK',
        'COOLHUSKY_NOTIFY',
        'MSE_STREAM_UPDATE',
        'MSE_DOWNLOAD',
        'UPDATE_MEDIA_META',
        'GET_CONTENT_LENGTH',
        'GET_MEDIA_METADATA_BATCH',
        'CANCEL_MEDIA_METADATA_BATCH',
        'REMOVE_MEDIA_IF_TOO_SMALL',
      ];
      if (asyncTypes.includes(msg.type)) {
        handleMessage(msg, sender, sendResponse);
        return true;
      }
      if (!isDataLoaded) {
        pendingMessages.push({ msg, sender, sendResponse });
        return true;
      }
      handleMessage(msg, sender, sendResponse);
      return true;
    }
  );

  async function handleMessage(
    msg: any,
    sender: any,
    sendResponse: (response?: any) => void
  ) {
    if (msg.type === 'MEDIA_FOUND') {
      const tabId = sender.tab?.id;
      const format = msg.format || 'm3u8';
      if (tabId !== undefined) {
        const rh =
          msg.requestHeaders && typeof msg.requestHeaders === 'object'
            ? msg.requestHeaders
            : undefined;
        addMedia(
          msg.url,
          tabId,
          format,
          undefined,
          'media',
          rh,
          undefined,
          undefined,
          sender.tab?.title
        );
      }
      sendResponse({ ok: tabId !== undefined });
      return;
    }

    if (msg.type === 'MEDIA_FOUND_BATCH') {
      const tabId = sender.tab?.id;
      const items: Array<{ url: string; format: string }> = Array.isArray(
        msg.items
      )
        ? msg.items
        : [];
      const tabTitle = sender.tab?.title;
      if (tabId !== undefined) {
        for (const item of items) {
          if (item && typeof item.url === 'string') {
            addMedia(
              item.url,
              tabId,
              item.format || 'm3u8',
              undefined,
              'media',
              undefined,
              undefined,
              undefined,
              tabTitle
            );
          }
        }
      }
      sendResponse({ ok: tabId !== undefined });
      return;
    }

    if (msg.type === 'MSE_STREAM_UPDATE') {
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ ok: false });
        return;
      }
      const captureId: string = msg.captureId;
      const pseudoUrl = `mse://${captureId}`;
      addMedia(
        pseudoUrl,
        tabId,
        'mse',
        msg.totalBytes,
        'media',
        undefined,
        { captureId, trackCount: msg.trackCount, mseComplete: msg.complete },
        undefined,
        sender.tab?.title
      );
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BILIBILI_DASH_FOUND') {
      const tabId = sender.tab?.id;
      if (tabId === undefined || !msg.task) {
        sendResponse({ ok: false });
        return;
      }
      upsertBilibiliDashTask(tabId, msg.task, sender.tab?.title);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'PLATFORM_MEDIA_FOUND') {
      const tabId = sender.tab?.id;
      if (
        tabId === undefined ||
        !isValidPlatformTask(msg.task, sender.tab?.url)
      ) {
        sendResponse({ ok: false });
        return;
      }
      upsertPlatformMediaTask(
        tabId,
        { ...msg.task, referer: sender.tab?.url },
        sender.tab?.title
      );
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'MSE_DOWNLOAD') {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false });
        return;
      }
      browser.tabs
        .sendMessage(tabId, {
          type: 'COOLHUSKY_MSE_DOWNLOAD_TRIGGER',
          captureId: msg.captureId,
          title: msg.title,
        })
        .catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'CLEAR_LIST') {
      const tabId = msg.tabId as number;
      clearTabMediaData(tabId);
      try {
        updateBadge(tabId);
      } catch {}
      sendResponse(true);
      return true;
    }

    if (msg.type === 'GET_LIST') {
      (async () => {
        let tabId: number | undefined =
          typeof msg.tabId === 'number' && msg.tabId >= 0
            ? msg.tabId
            : undefined;
        let title = '';
        if (tabId === undefined) {
          try {
            const tabs = await browser.tabs.query({
              active: true,
              currentWindow: true,
            });
            tabId = tabs[0]?.id;
            title = tabs[0]?.title || '';
          } catch {}
        } else {
          try {
            title = (await browser.tabs.get(tabId))?.title || '';
          } catch {}
        }
        if (tabId === undefined) {
          sendResponse({ tabId: undefined, title: '', list: [] });
          return;
        }
        uiListeningTabs.set(tabId, Date.now());
        const sendList = (mediaMap: Map<string, MediaEntry> | undefined) => {
          sendResponse({
            tabId,
            title,
            list: serializeTabMediaList(mediaMap),
          });
        };
        const mediaMap = tabMap.get(tabId);
        if (mediaMap && mediaMap.size > 0) {
          sendList(mediaMap);
          return;
        }
        loadTabList(tabId)
          .then((saved) => {
            if (saved.size > 0) {
              tabMap.set(tabId, saved);
              try {
                updateBadge(tabId);
              } catch {}
              sendList(saved);
            } else {
              sendList(undefined);
            }
          })
          .catch(() => {
            sendList(undefined);
          });
      })();
      return true;
    }

    if (msg.type === 'GET_ACTIVE_TAB') {
      (async () => {
        // Always query the live active tab — the Sidepanel needs the real
        // currently-active tab so it isn't associated with a stale one
        // (which would cause title/content mismatch).
        let tabId: number | undefined;
        let title = '';
        try {
          const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true,
          });
          tabId = tabs[0]?.id;
          title = tabs[0]?.title || '';
        } catch {}
        sendResponse({ tabId, title });
      })();
      return true;
    }

    if (msg.type === 'GET_CURRENT_TAB') {
      sendResponse(sender.tab);
      return true;
    }

    if (msg.type === 'GET_VIDEO_DIMENSIONS') {
      const url = msg.url as string;
      fetchVideoDimensions(url).then((dimensions) => {
        sendResponse(dimensions);
      });
      return true;
    }

    if (msg.type === 'GET_AUDIO_DURATION') {
      const url = msg.url as string;
      fetchMediaInfo(url).then((info) => {
        sendResponse(info?.duration ? { duration: info.duration } : null);
      });
      return true;
    }

    if (msg.type === 'GET_MEDIA_INFO') {
      const url = msg.url as string;
      fetchMediaInfo(url).then((info) => {
        sendResponse(info);
      });
      return true;
    }

    if (msg.type === 'CANCEL_MEDIA_METADATA_BATCH') {
      const taskId = String(msg.taskId || '');
      metadataBatchControllers.get(taskId)?.abort();
      metadataBatchControllers.delete(taskId);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'GET_MEDIA_METADATA_BATCH') {
      const request = msg as MetadataBatchRequest;
      const tabId = request.tabId;
      const taskId = request.taskId;
      const items = Array.isArray(request.items)
        ? request.items.slice(0, 500)
        : [];
      metadataBatchControllers.get(taskId)?.abort();
      const controller = new AbortController();
      metadataBatchControllers.set(taskId, controller);
      (async () => {
        try {
          const results = await mapWithConcurrency<
            MetadataBatchItem,
            MetadataBatchResult
          >(items, 6, async (item) => {
            controller.signal.throwIfAborted();
            try {
              const [mediaInfo, sizeResult] = await Promise.all([
                item.needMediaInfo
                  ? fetchMediaInfo(item.url, controller.signal)
                  : Promise.resolve(null),
                item.needSize
                  ? fetchContentLength(
                      item.url,
                      item.requestHeaders,
                      controller.signal
                    )
                  : Promise.resolve(null),
              ]);
              controller.signal.throwIfAborted();
              return {
                key: item.key,
                url: item.url,
                width: mediaInfo?.width,
                height: mediaInfo?.height,
                duration: mediaInfo?.duration,
                size: sizeResult?.ok ? sizeResult.size : undefined,
                removed: false,
              };
            } catch (error) {
              if (controller.signal.aborted) {
                throw error;
              }
              return {
                key: item.key,
                url: item.url,
                error: (error as Error).message,
                removed: false,
              };
            }
          });

          controller.signal.throwIfAborted();
          const mediaMap = tabMap.get(tabId);
          let changed = false;
          if (mediaMap) {
            for (const result of results) {
              const entry = mediaMap.get(result.url);
              if (!entry) {
                continue;
              }

              const nextEntry = {
                ...entry,
                width:
                  typeof result.width === 'number' ? result.width : entry.width,
                height:
                  typeof result.height === 'number'
                    ? result.height
                    : entry.height,
                duration:
                  typeof result.duration === 'number'
                    ? result.duration
                    : entry.duration,
                size:
                  typeof result.size === 'number' ? result.size : entry.size,
              };
              if (
                nextEntry.width !== entry.width ||
                nextEntry.height !== entry.height ||
                nextEntry.duration !== entry.duration ||
                nextEntry.size !== entry.size
              ) {
                mediaMap.set(result.url, nextEntry);
                changed = true;
              }
            }
            if (changed) {
              await saveTabList(tabId, mediaMap);
            }
          }
          sendResponse({ ok: true, items: results });
        } catch (error) {
          if (controller.signal.aborted) {
            sendResponse({ ok: false, cancelled: true, items: [] });
          } else {
            sendResponse({
              ok: false,
              error: (error as Error).message,
              items: [],
            });
          }
        } finally {
          if (metadataBatchControllers.get(taskId) === controller) {
            metadataBatchControllers.delete(taskId);
          }
        }
      })();
      return true;
    }
    if (msg.type === 'UPDATE_MEDIA_META') {
      const tabId = msg.tabId as number;
      const url = msg.url as string;
      const mediaMap = tabMap.get(tabId);
      if (!mediaMap) {
        sendResponse({ ok: false });
        return true;
      }
      const entry = mediaMap.get(url);
      if (!entry) {
        sendResponse({ ok: false });
        return true;
      }
      mediaMap.set(url, {
        ...entry,
        duration:
          typeof msg.duration === 'number' ? msg.duration : entry.duration,
        width: typeof msg.width === 'number' ? msg.width : entry.width,
        height: typeof msg.height === 'number' ? msg.height : entry.height,
        size: typeof msg.size === 'number' ? msg.size : entry.size,
      });
      saveTabList(tabId, mediaMap).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'REMOVE_MEDIA_IF_TOO_SMALL') {
      const removed = pruneTooSmallMedia(currentSettings, msg.tabId as number);
      sendResponse({ ok: true, removed });
      return true;
    }

    if (msg.type === 'GET_SETTINGS') {
      loadSettings()
        .then((s) => sendResponse(s))
        .catch((e) => sendResponse({ ...DEFAULT_SETTINGS, error: String(e) }));
      return true;
    }

    if (msg.type === 'SAVE_SETTINGS') {
      saveSettings(msg.settings).then(() => {
        pruneTooSmallMedia(msg.settings);
        sendResponse({ ok: true });
      });
      return true;
    }

    if (msg.type === 'CLOSE_SIDEBAR_FOR_TAB') {
      const tabId = msg.tabId as number;
      if (supportsFirefoxSidebar) {
        nativeBrowser.sidebarAction.close().catch(() => {});
      } else if (tabId !== undefined) {
        sidebarClosedTabs.add(tabId);
        if (supportsChromeSidepanel) {
          chromeGlobal.sidePanel
            .setOptions({ tabId, enabled: false })
            .catch(() => {});
        }
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'PREPARE_MEDIA_PLAYBACK') {
      const url = String(msg.url || '');
      const format = String(msg.format || '').toLowerCase();
      const referrer = String(msg.referrer || '');
      const authHeaders =
        msg.requestHeaders && typeof msg.requestHeaders === 'object'
          ? (msg.requestHeaders as Record<string, string>)
          : undefined;
      (async () => {
        try {
          await ensureProxyHeaderRule(url, referrer, authHeaders);
          if (format !== 'mpd') {
            sendResponse({ ok: true, drm: false });
            return;
          }

          const headers: Record<string, string> = { 'X-CoolHusky-Proxy': '1' };
          if (referrer) {
            headers['X-CoolHusky-Referer'] = referrer;
          }
          if (authHeaders) {
            Object.assign(headers, authHeaders);
          }
          const response = await fetch(url, { headers, cache: 'no-store' });
          if (!response.ok) {
            sendResponse({
              ok: false,
              status: response.status,
              error: `HTTP ${response.status}`,
            });
            return;
          }
          const manifest = await response.text();
          const drm =
            /<ContentProtection\b|widevine|playready|com\.microsoft\.playready|urn:uuid:edef8ba9|cenc:pssh/i.test(
              manifest
            );
          const candidates = new Set<string>([url]);
          for (const match of manifest.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
            candidates.add(match[0]);
          }
          for (const match of manifest.matchAll(
            /<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi
          )) {
            try {
              candidates.add(new URL(match[1]!.trim(), url).toString());
            } catch {}
          }
          await Promise.all(
            [...candidates].map((candidate) =>
              ensureProxyHeaderRule(candidate, referrer, authHeaders).catch(
                () => {}
              )
            )
          );
          sendResponse({ ok: true, drm });
        } catch (error) {
          sendResponse({ ok: false, error: (error as Error).message });
        }
      })();
      return true;
    }
    if (msg.type === 'PROXY_FETCH') {
      const { url, options } = msg;
      const requestId =
        (msg.requestId as string) ||
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const tabId = sender?.tab?.id;
      const controller = new AbortController();
      pendingProxyFetches.set(requestId, { controller, tabId });
      (async () => {
        try {
          const headers: Record<string, string> = {};
          if (options?.headers) {
            for (const [k, v] of Object.entries(options.headers)) {
              if (!CACHE_HEADER_NAMES.has(String(k).toLowerCase())) {
                headers[k] = v as string;
              }
            }
          }
          if (options?.authHeaders) {
            for (const [k, v] of Object.entries(options.authHeaders)) {
              if (!headers[k]) {
                headers[k] = v as string;
              }
            }
          }
          const useProxyHeader = options?.proxyHeader !== false;
          if (useProxyHeader) {
            headers['X-CoolHusky-Proxy'] = '1';
            if (options?.referrer) {
              headers['X-CoolHusky-Referer'] = options.referrer;
            }
          }
          if (options?.referrer || options?.authHeaders) {
            try {
              await ensureProxyHeaderRule(
                url,
                options.referrer || '',
                options.authHeaders
              );
            } catch {}
          }
          const response = await fetch(url, {
            headers,
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!response.ok) {
            const bodyText = await response.text();
            sendResponse({
              ok: false,
              error: `HTTP ${response.status}: ${bodyText.substring(0, 200)}`,
            });
            return;
          }
          const arrayBuffer = await response.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 32768) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
          }
          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
          });
          sendResponse({
            ok: true,
            status: response.status,
            headers: responseHeaders,
            data: btoa(binary),
          });
        } catch (e: any) {
          if (e?.name === 'AbortError') {
            sendResponse({ ok: false, cancelled: true });
            return;
          }
          sendResponse({ ok: false, error: e?.message });
        } finally {
          pendingProxyFetches.delete(requestId);
        }
      })();
      return true;
    }

    if (msg.type === 'PROXY_FETCH_CANCEL') {
      const { requestId } = msg;
      const entry = requestId ? pendingProxyFetches.get(requestId) : undefined;
      if (entry) {
        entry.controller.abort();
        pendingProxyFetches.delete(requestId);
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'COOLHUSKY_NOTIFY') {
      const { title, body, tag, pageUrl } = msg;
      if (pageUrl) {
        notifyPages.set(tag, pageUrl);
      }
      try {
        await browser.notifications.create(String(tag), {
          type: 'basic',
          iconUrl: browser.runtime.getURL('/assets/icons/favicon-128.png'),
          title: title || 'CoolHusky',
          message: body || '',
        });
      } catch (e) {
        console.warn('[CoolHusky] notification failed:', e);
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'GET_CONTENT_LENGTH') {
      fetchContentLength(msg.url, msg.requestHeaders).then(sendResponse);
      return true;
    }
    sendResponse(false);
    return false;
  }

  function addMedia(
    url: string,
    tabId: number,
    detectedFormat: string,
    size?: number,
    category: MediaCategory = 'media',
    requestHeaders?: Record<string, string>,
    extra?: { captureId?: string; trackCount?: number; mseComplete?: boolean },
    contentType?: string,
    tabTitle?: string
  ) {
    const pageUrlForCheck = tabPageUrls.get(tabId);
    if (!sniffingEnabled) {
      return;
    }
    if (pageUrlForCheck && isDomainExcluded(pageUrlForCheck, currentSettings)) {
      return;
    }
    // User-defined regex rules: block or force-match the URL.
    const regexResult = matchRegexRules(url, currentSettings);
    if (regexResult === 'block') {
      return;
    }
    const format =
      regexResult && typeof regexResult === 'object'
        ? regexResult.format
        : detectedFormat;
    if (!isFormatAllowed(format, currentSettings)) {
      return;
    }
    const isExplicitMediaType = contentType
      ? /^(audio|video)\//i.test(contentType.trim())
      : false;
    if (
      size !== undefined &&
      !isExplicitMediaType &&
      format !== 'm3u8' &&
      format !== 'mpd' &&
      format !== 'mse' &&
      format !== 'ts' &&
      format !== 'm4s' &&
      !isSizeAllowed(format, size, currentSettings)
    ) {
      return;
    }
    const managedNow =
      bilibiliManagedUrls.get(tabId)?.has(url) ||
      platformManagedUrls.get(tabId)?.has(url);
    if (managedNow && tabMap.get(tabId)?.has(url)) {
      return;
    }
    if (!tabMap.has(tabId)) {
      tabMap.set(tabId, new Map());
    }
    const mediaMap = tabMap.get(tabId)!;
    const effectiveTabTitle = tabTitle ?? tabPageTitles.get(tabId);

    if ((format === 'ts' || format === 'm4s') && !extra?.captureId) {
      const bestMaster = findMasterBySegmentUrl(tabId, mediaMap, url);
      if (bestMaster) {
        if (!mediaMap.has(url)) {
          if (mediaMap.size >= (currentSettings.maxItems ?? 1000)) {
            const oldestKey = mediaMap.keys().next().value;
            if (oldestKey !== undefined) {
              mediaMap.delete(oldestKey);
              bumpTabVersion(tabId);
            }
          }
          mediaMap.set(url, {
            format,
            size,
            detectedAt: Date.now(),
            category,
            requestHeaders,
            groupId: bestMaster,
            groupRole: 'segment',
            groupMasterId: bestMaster,
            tabTitle: effectiveTabTitle,
          });
          saveTabList(tabId, mediaMap).catch(() => {});
          try {
            updateBadge(tabId);
          } catch {}
          broadcastDebounced(tabId);
        }
        return;
      }
    }

    const existing = mediaMap.get(url);
    if (existing && format !== 'mse') {
      const upgradedContentType = existing.contentType ?? contentType;
      const upgradedHeaders = existing.requestHeaders ?? requestHeaders;
      const upgradedSize = existing.size ?? size;
      const upgradedTitle = existing.tabTitle ?? effectiveTabTitle;
      if (
        upgradedContentType !== existing.contentType ||
        upgradedHeaders !== existing.requestHeaders ||
        upgradedSize !== existing.size ||
        upgradedTitle !== existing.tabTitle
      ) {
        mediaMap.set(url, {
          ...existing,
          contentType: upgradedContentType,
          requestHeaders: upgradedHeaders,
          size: upgradedSize,
          tabTitle: upgradedTitle,
        });
        if (upgradedContentType) {
          tryGroupVideoAudio(url, tabId, upgradedContentType, upgradedSize);
        }
        saveTabList(tabId, mediaMap).catch(() => {});
        broadcastDebounced(tabId);
      }
      return;
    }
    if (mediaMap.size >= (currentSettings.maxItems ?? 1000)) {
      const oldestKey = mediaMap.keys().next().value;
      if (oldestKey !== undefined) {
        mediaMap.delete(oldestKey);
        bumpTabVersion(tabId);
      }
    }
    const effectiveSize =
      format === 'm3u8' || format === 'mpd'
        ? undefined
        : (size ?? existing?.size);
    const isLiveStream =
      format === 'flv' || format === 'ts'
        ? effectiveSize === undefined && !existing?.size
        : existing?.isLiveStream;
    mediaMap.set(url, {
      format,
      size: effectiveSize,
      detectedAt: existing?.detectedAt ?? Date.now(),
      category,
      requestHeaders,
      captureId: extra?.captureId ?? existing?.captureId,
      trackCount: extra?.trackCount ?? existing?.trackCount,
      mseComplete: extra?.mseComplete ?? existing?.mseComplete,
      contentType: contentType ?? existing?.contentType,
      tabTitle: effectiveTabTitle ?? existing?.tabTitle,
      isLiveStream,
    });
    if (format === 'm3u8' || format === 'mpd') {
      bumpTabVersion(tabId);
    }
    saveTabList(tabId, mediaMap).catch(() => {});
    try {
      updateBadge(tabId);
    } catch {}

    if (contentType) {
      tryGroupVideoAudio(url, tabId, contentType, size);
    }

    broadcastDebounced(tabId);

    if (
      (format === 'm3u8' || format === 'mpd') &&
      !manifestParseCache.has(url)
    ) {
      const lastAt = manifestParseTabLastAt.get(tabId) ?? 0;
      if (Date.now() - lastAt >= MANIFEST_PARSE_TAB_THROTTLE) {
        manifestParseTabLastAt.set(tabId, Date.now());
        parseAndGroupManifest(
          url,
          tabId,
          format as 'm3u8' | 'mpd',
          requestHeaders
        ).catch(() => {});
      }
    }
  }

  function updateBadge(tabId: number) {
    const mediaMap = tabMap.get(tabId);
    const countedGroups = new Set<string>();
    let count = 0;
    mediaMap?.forEach((entry, url) => {
      if (
        !isMediaAllowed(
          entry.format,
          currentSettings,
          entry.category,
          entry.groupRole
        )
      ) {
        return;
      }

      if (
        currentSettings?.hideStreamSegments &&
        (entry.groupRole === 'variant' || entry.groupRole === 'segment')
      ) {
        return;
      }
      const groupKey =
        entry.groupId ||
        entry.groupMasterId ||
        (entry.groupRole === 'master' ? url : undefined);
      if (groupKey) {
        if (countedGroups.has(groupKey)) {
          return;
        }
        countedGroups.add(groupKey);
      } else if (
        entry.groupRole === 'variant' ||
        entry.groupRole === 'audio' ||
        entry.groupRole === 'segment'
      ) {
        countedGroups.add(`legacy:${url}`);
      }
      count++;
    });
    const action = (browser as any).action || (browser as any).browserAction;
    if (!action) {
      return;
    }
    action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId });
    if (action.setBadgeTextColor) {
      action.setBadgeTextColor({ color: '#FFFFFF', tabId });
    }
    action.setBadgeBackgroundColor({ color: '#EF4444', tabId });
  }

  function pruneTooSmallMedia(settings: Settings, tabId?: number): number {
    let removedTotal = 0;
    const pruneTab = (id: number): void => {
      const mediaMap = tabMap.get(id);
      if (!mediaMap) {
        return;
      }
      let removed = 0;
      for (const [url, entry] of mediaMap) {
        if (
          entry.size !== undefined &&
          entry.format !== 'm3u8' &&
          entry.format !== 'mpd' &&
          entry.format !== 'mse' &&
          entry.format !== 'ts' &&
          entry.format !== 'm4s' &&
          !isSizeAllowed(entry.format, entry.size, settings)
        ) {
          mediaMap.delete(url);
          removed += 1;
        }
      }
      if (removed > 0) {
        saveTabList(id, mediaMap).catch(() => {});
        try {
          updateBadge(id);
        } catch {}
        broadcastDebounced(id);
        removedTotal += removed;
      }
    };
    if (tabId !== undefined) {
      pruneTab(tabId);
    } else {
      for (const id of tabMap.keys()) {
        pruneTab(id);
      }
    }
    return removedTotal;
  }

  type ListEntry = {
    url: string;
    format: string;
    size?: number;
    width?: number;
    height?: number;
    detectedAt?: number;
    category?: MediaCategory;
    requestHeaders?: Record<string, string>;
    captureId?: string;
    trackCount?: number;
    mseComplete?: boolean;
    groupId?: string;
    groupRole?: string;
    groupLabel?: string;
    groupMasterId?: string;
    variantBandwidth?: number;
    audioUrl?: string;
    audioOptions?: Array<{ url: string; label: string }>;
    duration?: number;
    coverUrl?: string;
    tabTitle?: string;
    isLiveStream?: boolean;
  };

  function serializeTabMediaList(
    mediaMap?: Map<string, MediaEntry>
  ): ListEntry[] {
    const list: ListEntry[] = [];
    mediaMap?.forEach((entry, url) => {
      if (entry.contentType === 'virtual/group') {
        return;
      }
      list.push({
        url,
        format: entry.format,
        size: entry.size,
        width: entry.width,
        height: entry.height,
        detectedAt: entry.detectedAt,
        category: entry.category,
        requestHeaders: entry.requestHeaders,
        captureId: entry.captureId,
        trackCount: entry.trackCount,
        mseComplete: entry.mseComplete,
        groupId: entry.groupId,
        groupRole: entry.groupRole,
        groupLabel: entry.groupLabel,
        groupMasterId: entry.groupMasterId,
        variantBandwidth: entry.variantBandwidth,
        audioUrl: entry.audioUrl,
        audioOptions: entry.audioOptions,
        duration: entry.duration,
        coverUrl: entry.coverUrl,
        tabTitle: entry.tabTitle,
        isLiveStream: entry.isLiveStream,
      });
    });
    return list;
  }

  function broadcast(tabId: number, list: ListEntry[]) {
    browser.runtime
      .sendMessage({ type: 'LIST_UPDATED', tabId, list })
      .catch(() => {});
  }

  function upsertBilibiliDashTask(tabId: number, task: any, tabTitle?: string) {
    const pageUrl = tabPageUrls.get(tabId);
    if (pageUrl && isDomainExcluded(pageUrl, currentSettings)) {
      return;
    }
    if (!isFormatAllowed('mpd', currentSettings)) {
      return;
    }
    if (!tabMap.has(tabId)) {
      tabMap.set(tabId, new Map());
    }
    const mediaMap = tabMap.get(tabId)!;
    if (mediaMap.size >= (currentSettings.maxItems ?? 1000)) {
      return;
    }
    const taskKey = String(task.key || 'current').replace(
      /[^a-zA-Z0-9_-]/g,
      '_'
    );
    const masterUrl = `vid_grp_bili_${taskKey}`;
    const videos = Array.isArray(task.videos)
      ? task.videos.filter((v: any) => typeof v?.url === 'string')
      : [];
    const audios = Array.isArray(task.audios)
      ? task.audios.filter((a: any) => typeof a?.url === 'string')
      : [];
    if (!videos.length) {
      return;
    }
    const requestHeaders =
      typeof task.referer === 'string' && task.referer
        ? { Referer: task.referer }
        : tabPageUrls.get(tabId)
          ? { Referer: tabPageUrls.get(tabId)! }
          : undefined;
    const previousMaster = mediaMap.get(masterUrl);
    const duration = Number(task.duration) || undefined;
    const preferredAudioBandwidth = Number(audios[0]?.bandwidth || 0);
    const estimateCombinedSize = (video: any): number | undefined => {
      const bandwidth = Number(video?.bandwidth || 0) + preferredAudioBandwidth;
      return duration && bandwidth > 0
        ? Math.round((duration * bandwidth) / 8)
        : undefined;
    };
    const previousVariantSizes = new Map<string, number>();
    for (const [url, entry] of mediaMap) {
      if (entry.groupMasterId === masterUrl && entry.size) {
        previousVariantSizes.set(url, entry.size);
      }
    }

    for (const [url, entry] of mediaMap) {
      if (entry.groupMasterId === masterUrl && !entry.contentType) {
        mediaMap.delete(url);
      }
    }
    const managed = bilibiliManagedUrls.get(tabId) || new Set<string>();
    const audioUrls = new Set(audios.map((a: any) => a.url));
    for (const stream of [...videos, ...audios]) {
      managed.add(stream.url);
      const direct = mediaMap.get(stream.url);
      if (direct && audioUrls.has(stream.url)) {
        mediaMap.set(stream.url, {
          ...direct,
          groupId: masterUrl,
          groupRole: 'audio',
          groupMasterId: masterUrl,
        });
      } else {
        mediaMap.delete(stream.url);
      }
    }
    bilibiliManagedUrls.set(tabId, managed);
    mediaMap.set(masterUrl, {
      format: 'mpd',
      detectedAt: Date.now(),
      category: 'stream',
      groupId: masterUrl,
      groupRole: 'master',
      duration,
      size: videos.length ? estimateCombinedSize(videos[0]) : undefined,
      coverUrl:
        typeof task.coverUrl === 'string' && task.coverUrl
          ? task.coverUrl
          : previousMaster?.coverUrl,
      requestHeaders,
      tabTitle: task.title || previousMaster?.tabTitle || tabTitle,
    });
    const audioOptions = audios.map((audio: any) => {
      return { url: audio.url, label: audio.label || '音频' };
    });
    const preferredAudio = audioOptions[0]?.url;
    for (const video of videos) {
      mediaMap.set(video.url, {
        format: 'mp4',
        detectedAt: Date.now(),
        category: 'stream',
        groupId: masterUrl,
        groupRole: 'variant',
        groupLabel: video.label || '视频',
        groupMasterId: masterUrl,
        variantBandwidth: Number(video.bandwidth || 0),
        width: Number(video.width || 0) || undefined,
        height: Number(video.height || 0) || undefined,
        duration,
        size:
          previousVariantSizes.get(video.url) || estimateCombinedSize(video),
        audioUrl: preferredAudio,
        audioOptions,
        requestHeaders,
        tabTitle: task.title || tabTitle,
      });
    }
    saveTabList(tabId, mediaMap).catch(() => {});
    updateBadge(tabId);
    broadcastDebounced(tabId);
  }

  const DOUYIN_PAGE_HOST =
    /(^|\.)(douyin\.com|iesdouyin\.com|tiktok\.com|musical\.ly)$/i;
  const DOUYIN_MEDIA_HOST =
    /(^|\.)(douyinvod|douyincdn|bytecdn|bytego|byteimg|bytedance|amemv|iesdouyin|snssdk|pstatp|toutiaovod|ixigua|tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokcdn-in|tiktokv|muscdn|musical|byteoversea)\.(com|cn|net|us|eu|in|gg|io|ly)$/i;

  function isAllowedDouyinMediaUrl(value: unknown): value is string {
    if (typeof value !== 'string') {
      return false;
    }
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        DOUYIN_MEDIA_HOST.test(url.hostname)
      );
    } catch {
      return false;
    }
  }

  function isValidPlatformTask(
    task: unknown,
    senderUrl?: string
  ): task is PlatformMediaTask {
    if (!task || typeof task !== 'object' || !senderUrl) {
      return false;
    }
    const value = task as PlatformMediaTask;
    try {
      if (!DOUYIN_PAGE_HOST.test(new URL(senderUrl).hostname)) {
        return false;
      }
    } catch {
      return false;
    }
    if (
      value.provider !== 'douyin' ||
      typeof value.key !== 'string' ||
      !Array.isArray(value.candidates)
    ) {
      return false;
    }
    return (
      value.candidates.length > 0 &&
      value.candidates.every(
        (candidate) => !!candidate && isAllowedDouyinMediaUrl(candidate.url)
      )
    );
  }

  function upsertPlatformMediaTask(
    tabId: number,
    task: PlatformMediaTask,
    tabTitle?: string
  ) {
    const pageUrl = tabPageUrls.get(tabId);
    if (pageUrl && isDomainExcluded(pageUrl, currentSettings)) {
      return;
    }
    const masterFormat = (task.candidates?.[0]?.format || 'mp4').toLowerCase();
    if (!isFormatAllowed(masterFormat, currentSettings)) {
      return;
    }
    if (!tabMap.has(tabId)) {
      tabMap.set(tabId, new Map());
    }
    const mediaMap = tabMap.get(tabId)!;
    if (mediaMap.size >= (currentSettings.maxItems ?? 1000)) {
      return;
    }
    const key =
      task.key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'current';
    const masterUrl = `vid_grp_${task.provider}_${key}`;
    const priorities =
      platformTaskPriorities.get(tabId) || new Map<string, number>();
    const priority = Number(task.priority || 0);
    if (priority < (priorities.get(masterUrl) || 0)) {
      return;
    }
    priorities.set(masterUrl, priority);
    platformTaskPriorities.set(tabId, priorities);
    const candidates = task.candidates
      .filter((candidate) => candidate && typeof candidate.url === 'string')
      .filter(
        (candidate, index, list) =>
          list.findIndex((item) => item.url === candidate.url) === index
      )
      .slice(0, 24);
    const audioCandidates = candidates.filter(
      (candidate) => candidate.role === 'audio'
    );
    const videoCandidates = candidates.filter(
      (candidate) => candidate.role !== 'audio'
    );
    if (!videoCandidates.length) {
      return;
    }

    if (task.provider === 'douyin') {
      const metadataByUrl =
        douyinMediaMetadata.get(tabId) ||
        new Map<
          string,
          { title?: string; coverUrl?: string; duration?: number }
        >();
      const cachedMetadata = videoCandidates
        .map(
          (candidate) =>
            metadataByUrl.get(candidate.url) ||
            metadataByUrl.get(getDouyinMediaResourceKey(candidate.url))
        )
        .find(Boolean);
      task.title ||= cachedMetadata?.title;
      task.coverUrl ||= cachedMetadata?.coverUrl;
      task.duration ||= cachedMetadata?.duration;
      const metadata = {
        title: task.title || cachedMetadata?.title,
        coverUrl: task.coverUrl || cachedMetadata?.coverUrl,
        duration: Number(task.duration) || cachedMetadata?.duration,
      };
      for (const candidate of videoCandidates) {
        metadataByUrl.set(candidate.url, metadata);
        metadataByUrl.set(getDouyinMediaResourceKey(candidate.url), metadata);

        const existingVariantUrl = mediaMap.has(candidate.url)
          ? candidate.url
          : Array.from(mediaMap.keys()).find(
              (url) =>
                getDouyinMediaResourceKey(url) ===
                getDouyinMediaResourceKey(candidate.url)
            );
        const existingVariant = existingVariantUrl
          ? mediaMap.get(existingVariantUrl)
          : undefined;
        const existingMasterId = existingVariant?.groupMasterId;
        if (!existingMasterId || existingMasterId === masterUrl) {
          continue;
        }
        const existingMaster = mediaMap.get(existingMasterId);
        if (existingMaster) {
          mediaMap.set(existingMasterId, {
            ...existingMaster,
            duration: metadata.duration || existingMaster.duration,
            coverUrl: metadata.coverUrl || existingMaster.coverUrl,
            tabTitle: metadata.title || existingMaster.tabTitle,
          });
        }
        mediaMap.set(existingVariantUrl!, {
          ...existingVariant,
          duration: metadata.duration || existingVariant.duration,
          coverUrl: metadata.coverUrl || existingVariant.coverUrl,
          tabTitle: metadata.title || existingVariant.tabTitle,
        });
      }
      douyinMediaMetadata.set(tabId, metadataByUrl);
    }

    const previousMaster = mediaMap.get(masterUrl);
    const managed = platformManagedUrls.get(tabId) || new Set<string>();
    for (const [url, entry] of mediaMap) {
      if (entry.groupMasterId === masterUrl && !entry.contentType) {
        mediaMap.delete(url);
      }
    }
    for (const candidate of candidates) {
      managed.add(candidate.url);
      const direct = mediaMap.get(candidate.url);
      if (direct && candidate.role === 'audio') {
        mediaMap.set(candidate.url, {
          ...direct,
          groupId: masterUrl,
          groupRole: 'audio',
          groupMasterId: masterUrl,
        });
      } else {
        mediaMap.delete(candidate.url);
      }
    }
    platformManagedUrls.set(tabId, managed);

    const requestHeaders = task.referer ? { Referer: task.referer } : undefined;
    const duration =
      Number(task.duration) ||
      Number(videoCandidates[0]?.duration || 0) ||
      undefined;
    const audioOptions = audioCandidates.map((candidate) => {
      return {
        url: candidate.url,
        label: candidate.label || '音频',
      };
    });
    const preferredAudio = audioOptions[0]?.url;
    mediaMap.set(masterUrl, {
      format: videoCandidates[0]?.format || 'mp4',
      detectedAt: Date.now(),
      category: 'stream',
      groupId: masterUrl,
      groupRole: 'master',
      duration,
      coverUrl: task.coverUrl || previousMaster?.coverUrl,
      requestHeaders,
      tabTitle: task.title || previousMaster?.tabTitle || tabTitle,
    });
    for (const candidate of videoCandidates) {
      mediaMap.set(candidate.url, {
        format: candidate.format || 'mp4',
        detectedAt: Date.now(),
        category: 'stream',
        groupId: masterUrl,
        groupRole: 'variant',
        groupMasterId: masterUrl,
        groupLabel:
          candidate.label ||
          (candidate.height ? `${candidate.height}p` : '视频'),
        variantBandwidth: Number(candidate.bandwidth || 0) || undefined,
        width: Number(candidate.width || 0) || undefined,
        height: Number(candidate.height || 0) || undefined,
        duration,
        coverUrl: task.coverUrl,
        requestHeaders,
        tabTitle: task.title || tabTitle,
        audioUrl: preferredAudio,
        audioOptions: audioOptions.length ? audioOptions : undefined,
      });
    }
    saveTabList(tabId, mediaMap).catch(() => {});
    updateBadge(tabId);
    broadcastDebounced(tabId);
  }

  function collectNativeDouyinTrack(tabId: number, value: string) {
    try {
      const pageUrl = tabPageUrls.get(tabId);
      if (!pageUrl || !DOUYIN_PAGE_HOST.test(new URL(pageUrl).hostname)) {
        return;
      }
      const url = new URL(value);
      if (!DOUYIN_MEDIA_HOST.test(url.hostname)) {
        return;
      }
      const role = /(?:^|[-_/])media-audio(?:[-_/]|$)|\/audio[-_/]/i.test(
        url.pathname
      )
        ? 'audio'
        : /(?:^|[-_/])media-video(?:[-_/]|$)|\/video[-_/]/i.test(url.pathname)
          ? 'video'
          : undefined;
      const key =
        url.searchParams.get('l') ||
        url.searchParams.get('video_id') ||
        url.searchParams.get('aweme_id');
      if (!role || !key) {
        return;
      }

      const buildTask = (
        videoUrl: string,
        audioUrl: string | undefined,
        priority: number
      ) => {
        const groupKey = getDouyinTrackGroupKey(videoUrl);
        const metadataByUrl = douyinMediaMetadata.get(tabId);
        const metadata =
          metadataByUrl?.get(videoUrl) ||
          metadataByUrl?.get(getDouyinMediaResourceKey(videoUrl));
        const candidates: Array<{
          url: string;
          format: string;
          role: 'video' | 'audio';
          label: string;
        }> = [
          {
            url: videoUrl,
            format: detectFormatFromUrl(videoUrl),
            role: 'video',
            label: '视频',
          },
        ];
        if (audioUrl) {
          candidates.push({
            url: audioUrl,
            format: detectFormatFromUrl(audioUrl),
            role: 'audio',
            label: '音频',
          });
        }
        upsertPlatformMediaTask(
          tabId,
          {
            provider: 'douyin',
            key: groupKey,
            referer: pageUrl,
            priority,
            title: metadata?.title || tabPageTitles.get(tabId),
            coverUrl: metadata?.coverUrl,
            duration: metadata?.duration,
            candidates,
          },
          tabPageTitles.get(tabId)
        );
      };

      const byToken =
        douyinNativeTracks.get(tabId) ||
        new Map<
          string,
          Array<{ url: string; role: 'video' | 'audio'; at: number }>
        >();
      const now = Date.now();
      const pending = (byToken.get(key) || []).filter(
        (track) => now - track.at < 30_000
      );
      const oppositeIndex = pending.findIndex((track) => track.role !== role);
      if (oppositeIndex < 0) {
        if (role === 'video') {
          buildTask(value, undefined, 3);
        }
        pending.push({ url: value, role, at: now });
        byToken.set(key, pending);
        douyinNativeTracks.set(tabId, byToken);
        return;
      }
      const opposite = pending.splice(oppositeIndex, 1)[0]!;
      byToken.set(key, pending);
      douyinNativeTracks.set(tabId, byToken);
      const video = role === 'video' ? value : opposite.url;
      const audio = role === 'audio' ? value : opposite.url;
      buildTask(video, audio, 4);
    } catch {}
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId > 0) {
        collectNativeDouyinTrack(details.tabId, details.url);
      }
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }
  );

  function getDouyinTrackGroupKey(url: string): string {
    let hash = 2166136261;
    for (let i = 0; i < url.length; i++) {
      hash = Math.imul(hash ^ url.charCodeAt(i), 16777619);
    }
    return `track_${(hash >>> 0).toString(36)}`;
  }

  function getDouyinMediaResourceKey(value: string): string {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }

  function isVideoOnlyContentType(ct: string): boolean {
    const c = ct.toLowerCase();
    if (!c.startsWith('video/')) {
      return false;
    }
    const codecsMatch = /codecs="([^"]+)"/.exec(c);
    if (codecsMatch) {
      const codecs = codecsMatch[1]!.toLowerCase();
      if (/mp4a|opus|vorbis|flac|ac-3|ec-3/.test(codecs)) {
        return false;
      }
      if (/avc1|hev1|hvc1|vp[89]|av01/.test(codecs)) {
        return true;
      }
    }
    return false;
  }

  function isAudioOnlyContentType(ct: string): boolean {
    const c = ct.toLowerCase();
    if (c.startsWith('audio/')) {
      return true;
    }
    const codecsMatch = /codecs="([^"]+)"/.exec(c);
    if (codecsMatch) {
      const codecs = codecsMatch[1]!.toLowerCase();
      if (
        /mp4a|opus|vorbis/.test(codecs) &&
        !/avc1|hev1|vp[89]|av01/.test(codecs)
      ) {
        return true;
      }
    }
    return false;
  }

  function extractVideoGroupKey(url: string): string {
    try {
      const u = new URL(url);
      const host = u.host;
      const path = u.pathname;
      if (
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua|tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokcdn-in|tiktokv|muscdn|musical|byteoversea)\.(?:com|cn|net|us|eu|in|gg|io|ly)\b/i.test(
          host
        )
      ) {
        const pathSeg = path.split('/').filter(Boolean)[0] ?? '';
        return `${host}/${pathSeg}`;
      }
      const EXCLUDE_PARAMS = new Set([
        'itag',
        'mime',
        'quality',
        'quality_label',
        'qlt',
        'aitags',
        'range',
        'rn',
        'rbuf',
        'playback_host',
        'playlist',
        'playlist_type',
        'mime_type',
        'backfill',
        'audio_quality',
      ]);
      const kept: string[] = [];
      u.searchParams.forEach((v, k) => {
        if (!EXCLUDE_PARAMS.has(k.toLowerCase())) {
          kept.push(`${k}=${v}`);
        }
      });
      kept.sort();
      return `${host}${path}|${kept.join('&')}`;
    } catch {
      return url.split('?')[0] ?? url;
    }
  }

  function extractQualityLabel(url: string, contentType: string): string {
    const itagMap: Record<string, string> = {
      '137': '1080p',
      '248': '1080p',
      '299': '1080p60',
      '303': '1080p60',
      '136': '720p',
      '247': '720p',
      '298': '720p60',
      '302': '720p60',
      '135': '480p',
      '244': '480p',
      '134': '360p',
      '243': '360p',
      '133': '240p',
      '242': '240p',
      '160': '144p',
      '278': '144p',
      '271': '1440p',
      '308': '1440p60',
      '313': '2160p',
      '315': '2160p60',
      '272': '2160p',
      '138': '4320p',
    };
    try {
      const u = new URL(url);
      const itag = u.searchParams.get('itag') ?? u.searchParams.get('itagid');
      if (itag && itagMap[itag]) {
        return itagMap[itag]!;
      }
      const quality =
        u.searchParams.get('quality_label') ??
        u.searchParams.get('quality') ??
        u.searchParams.get('qlt');
      if (quality) {
        return quality;
      }
    } catch {}
    if (
      /avc1\.640034|avc1\.640032|hev1\.1.*L153|vp9.*profile2/i.test(contentType)
    ) {
      return '1080p+';
    }
    if (/avc1\.640028|hev1\.1.*L120/i.test(contentType)) {
      return '1080p';
    }
    if (/avc1\.64001f/i.test(contentType)) {
      return '720p';
    }
    if (/avc1\.64001e/i.test(contentType)) {
      return '480p';
    }
    return '';
  }

  const VIDEO_AUDIO_GROUP_WINDOW_MS = 8000;

  function detectStreamRoleFromUrl(url: string): 'video' | 'audio' | null {
    try {
      const u = new URL(url);
      const host = u.host.toLowerCase();
      const path = u.pathname.toLowerCase();
      const full = (host + path).toLowerCase();
      const isMediaCdn =
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua|tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokcdn-in|tiktokv|muscdn|musical|byteoversea|ks-yxcdn|kwaixiaodian)\.(?:com|cn|net|us|eu|in|gg|io|ly)\b/i.test(
          host
        );
      if (!isMediaCdn) {
        return null;
      }
      if (/audio|aud|sound|\.m4a\b|\.aac\b/.test(full)) {
        return 'audio';
      }
      if (/video|vid|\.mp4\b|\.flv\b/.test(full)) {
        return 'video';
      }
      if (/[?&](ratio|quality|qlt|resolution|vq)=/.test(url)) {
        return 'video';
      }
      return null;
    } catch {
      return null;
    }
  }

  function tryGroupVideoAudio(
    newUrl: string,
    tabId: number,
    contentType: string,
    newSize?: number
  ) {
    let isVideo = isVideoOnlyContentType(contentType);
    let isAudio = isAudioOnlyContentType(contentType);

    if (!isVideo && !isAudio) {
      const role = detectStreamRoleFromUrl(newUrl);
      if (role === 'video') {
        isVideo = true;
      } else if (role === 'audio') {
        isAudio = true;
      }
    }
    if (!isVideo && !isAudio) {
      return;
    }

    const mediaMap = tabMap.get(tabId);
    if (!mediaMap) {
      return;
    }

    const newEntry = mediaMap.get(newUrl);
    if (!newEntry) {
      return;
    }

    const now = newEntry.detectedAt ?? Date.now();
    const newKey = extractVideoGroupKey(newUrl);
    const newLabel = extractQualityLabel(newUrl, contentType);

    for (const [candidateUrl, candidateEntry] of mediaMap) {
      if (candidateUrl === newUrl) {
        continue;
      }
      if (!candidateEntry.contentType) {
        continue;
      }
      const age = Math.abs((candidateEntry.detectedAt ?? 0) - now);
      if (age > VIDEO_AUDIO_GROUP_WINDOW_MS) {
        continue;
      }

      let candidateIsVideo = isVideoOnlyContentType(candidateEntry.contentType);
      let candidateIsAudio = isAudioOnlyContentType(candidateEntry.contentType);
      if (!candidateIsVideo && !candidateIsAudio) {
        const role = detectStreamRoleFromUrl(candidateUrl);
        if (role === 'video') {
          candidateIsVideo = true;
        } else if (role === 'audio') {
          candidateIsAudio = true;
        }
      }

      if (isVideo && !candidateIsAudio) {
        continue;
      }
      if (isAudio && !candidateIsVideo) {
        continue;
      }

      if (
        contentType === 'application/octet-stream' &&
        candidateEntry.contentType === 'application/octet-stream'
      ) {
        const vSize = isVideo ? newSize : candidateEntry.size;
        const aSize = isVideo ? candidateEntry.size : newSize;
        if (vSize && aSize) {
          if (vSize < aSize * 3) {
            continue;
          } // video >= 3x audio
        }
      }

      const candidateKey = extractVideoGroupKey(candidateUrl);

      const isDouyinCdn =
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua|tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokcdn-in|tiktokv|muscdn|musical|byteoversea)\.(?:com|cn|net|us|eu|in|gg|io|ly)\b/i.test(
          newUrl
        ) &&
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua|tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokcdn-in|tiktokv|muscdn|musical|byteoversea)\.(?:com|cn|net|us|eu|in|gg|io|ly)\b/i.test(
          candidateUrl
        );
      if (!isDouyinCdn) {
        const keySimilarity = computeKeySimilarity(newKey, candidateKey);
        if (keySimilarity < 0.5) {
          continue;
        }
      } else {
        try {
          if (new URL(newUrl).host !== new URL(candidateUrl).host) {
            continue;
          }
        } catch {
          continue;
        }
      }

      const videoUrl = isVideo ? newUrl : candidateUrl;
      const audioUrl_g = isAudio ? newUrl : candidateUrl;
      const videoEntry = mediaMap.get(videoUrl)!;
      const audioEntry = mediaMap.get(audioUrl_g)!;

      if (videoEntry.groupId && videoEntry.groupId === audioEntry.groupId) {
        continue;
      }

      const groupId = `vid_grp_${extractVideoGroupKey(videoUrl).substring(0, 60)}`;
      const label =
        newLabel ||
        extractQualityLabel(videoUrl, videoEntry.contentType ?? '') ||
        '未知清晰度';

      mediaMap.set(videoUrl, {
        ...videoEntry,
        groupId,
        groupRole: 'variant',
        groupLabel: label,
        groupMasterId: groupId,
        audioUrl: audioUrl_g,
      });

      mediaMap.set(audioUrl_g, {
        ...audioEntry,
        groupId,
        groupRole: 'audio',
        groupMasterId: groupId,
      });

      if (!mediaMap.has(groupId)) {
        mediaMap.set(groupId, {
          format: videoEntry.format,
          detectedAt: Math.min(
            videoEntry.detectedAt ?? now,
            audioEntry.detectedAt ?? now
          ),
          category: 'media',
          requestHeaders: videoEntry.requestHeaders,
          groupId,
          groupRole: 'master',
          contentType: 'virtual/group',
        });
      }

      saveTabList(tabId, mediaMap).catch(() => {});
      broadcastDebounced(tabId);
      break;
    }
  }

  function computeKeySimilarity(a: string, b: string): number {
    const aParts = a.split('|');
    const bParts = b.split('|');
    if (aParts[0] !== bParts[0]) {
      return 0;
    }
    const aParams = new Set((aParts[1] ?? '').split('&').filter(Boolean));
    const bParams = new Set((bParts[1] ?? '').split('&').filter(Boolean));
    if (aParams.size === 0 && bParams.size === 0) {
      return 1;
    }
    let common = 0;
    for (const p of aParams) {
      if (bParams.has(p)) {
        common++;
      }
    }
    return common / Math.max(aParams.size, bParams.size);
  }

  const manifestParseCache = new Set<string>();
  const manifestFailCache = new Map<string, number>();
  const MANIFEST_PARSE_FAIL_TTL = 60_000;
  const MANIFEST_CACHE_MAX = 1000;
  function evictOldestSet<T>(set: Set<T>, max: number): void {
    while (set.size > max) {
      const first = set.values().next().value;
      if (first === undefined) {
        break;
      }
      set.delete(first);
    }
  }
  const manifestParseTabLastAt = new Map<number, number>();
  const MANIFEST_PARSE_TAB_THROTTLE = 30_000;

  async function parseAndGroupManifest(
    masterUrl: string,
    tabId: number,
    masterFormat: 'm3u8' | 'mpd',
    requestHeaders?: Record<string, string>
  ) {
    if (manifestParseCache.has(masterUrl)) {
      return;
    }
    const lastFail = manifestFailCache.get(masterUrl);
    if (lastFail && Date.now() - lastFail < MANIFEST_PARSE_FAIL_TTL) {
      return;
    }

    const fetchHeaders: Record<string, string> = {};
    if (requestHeaders) {
      for (const [k, v] of Object.entries(requestHeaders)) {
        const kl = k.toLowerCase();
        if (
          kl === 'referer' ||
          kl === 'origin' ||
          kl === 'cookie' ||
          kl === 'user-agent'
        ) {
          fetchHeaders[k] = v;
        }
      }
    }

    const fetchText = async (u: string): Promise<string> => {
      const resp = await fetch(u, {
        headers: fetchHeaders,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return resp.text();
    };

    try {
      const parsed =
        masterFormat === 'mpd'
          ? await parseDashManifest(masterUrl, fetchText)
          : await parseM3U8Manifest(masterUrl, fetchText, fetchHeaders);

      if (parsed.variants.length === 0) {
        const mm = tabMap.get(tabId);
        if (mm) {
          const entry = mm.get(masterUrl);
          if (entry) {
            const bw = entry.variantBandwidth;
            const estSizeFromBw =
              bw &&
              bw > 0 &&
              parsed.duration &&
              parsed.duration > 0 &&
              !entry.size
                ? Math.round((bw / 8) * parsed.duration)
                : undefined;
            const newSize = entry.size ?? estSizeFromBw ?? parsed.estimatedSize;
            const newDuration = entry.duration ?? parsed.duration;
            if (newDuration !== entry.duration || newSize !== entry.size) {
              mm.set(masterUrl, {
                ...entry,
                duration: newDuration,
                size: newSize,
              });
              saveTabList(tabId, mm).catch(() => {});
              broadcastDebounced(tabId);
            }
          }
        }
        if (parsed.estimatedSize || parsed.duration) {
          manifestParseCache.add(masterUrl);
          evictOldestSet(manifestParseCache, MANIFEST_CACHE_MAX);
        } else {
          manifestFailCache.set(masterUrl, Date.now());
          evictOldest(manifestFailCache, MANIFEST_CACHE_MAX);
        }
        return;
      }

      const mediaMap = tabMap.get(tabId);
      if (!mediaMap) {
        return;
      }
      const masterEntry = mediaMap.get(masterUrl);
      if (!masterEntry) {
        return;
      }

      const groupId = masterUrl;

      const topBandwidth = parsed.variants.reduce(
        (max, v) => Math.max(max, v.bandwidth ?? 0),
        0
      );
      const estimatedSize =
        topBandwidth > 0 && parsed.duration && parsed.duration > 0
          ? Math.round((topBandwidth / 8) * parsed.duration)
          : parsed.estimatedSize;

      mediaMap.set(masterUrl, {
        ...masterEntry,
        groupId,
        groupRole: 'master',
        duration: parsed.duration ?? masterEntry.duration,
        size: estimatedSize ?? masterEntry.size,
      });

      for (const variant of parsed.variants) {
        const existing = mediaMap.get(variant.uri);
        if (
          existing &&
          existing.groupRole &&
          existing.groupRole !== 'segment'
        ) {
          continue;
        }

        mediaMap.set(variant.uri, {
          format: masterFormat === 'mpd' ? 'mpd' : 'm3u8',
          size: existing?.size,
          detectedAt: existing?.detectedAt ?? Date.now(),
          category: 'media',
          requestHeaders: requestHeaders ?? masterEntry.requestHeaders,
          groupId,
          groupRole: 'variant',
          groupLabel: variant.label,
          groupMasterId: masterUrl,
          variantBandwidth: variant.bandwidth,
          audioUrl: variant.audioUri,
        });

        if (variant.audioUri && !mediaMap.has(variant.audioUri)) {
          mediaMap.set(variant.audioUri, {
            format: 'm3u8',
            detectedAt: Date.now(),
            category: 'media',
            requestHeaders: requestHeaders ?? masterEntry.requestHeaders,
            groupId,
            groupRole: 'audio',
            groupMasterId: masterUrl,
          });
        }
      }

      saveTabList(tabId, mediaMap).catch(() => {});
      manifestParseCache.add(masterUrl);
      evictOldestSet(manifestParseCache, MANIFEST_CACHE_MAX);
      broadcastDebounced(tabId);
    } catch (e) {
      manifestFailCache.set(masterUrl, Date.now());
      evictOldest(manifestFailCache, MANIFEST_CACHE_MAX);
      console.warn(
        '[CoolHusky] manifest parse failed:',
        masterUrl,
        (e as Error)?.message
      );
    }
  }
}
