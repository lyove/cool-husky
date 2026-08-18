import browser from 'webextension-polyfill';
import { detectMedia, detectDoc, type MediaCategory } from '../utils/detect';
import {
  loadAllTabData,
  saveTabList,
  deleteTabList,
  type MediaEntry,
} from '../utils/media-storage';
import {
  loadSettings,
  saveSettings,
  isFormatAllowed,
  isSizeAllowed,
  isDomainExcluded,
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
const mediaInfoFailCache = new Map<string, number>();
const MEDIA_INFO_FAIL_TTL_MS = 60_000;
const metadataBatchControllers = new Map<string, AbortController>();

// ── Resource health tracking ──────────────────────────────────────────────────

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
          if (!Number.isNaN(n) && n > 0) return n;
        }
      } catch {
        /* fall through to the Range probe below */
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
            if (!Number.isNaN(n) && n > 0) return n;
          }
        }
      } catch {
        /* ignore, return 0 */
      }

      return 0;
    };

    let fullBodyCache: Uint8Array | null = null;
    const readChunk = async (
      chunkSize: number,
      offset: number
    ): Promise<Uint8Array> => {
      if (fullBodyCache) {
        if (offset >= fullBodyCache.length) return new Uint8Array(0);
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
        if (offset >= buf.length) return new Uint8Array(0);
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
        // mediainfo sometimes produces non-strict JSON; on parse failure, drop that URL's metadata but keep the download unaffected
        mediaInfoFailCache.set(url, Date.now());
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
        return info;
      }
    }
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === 'AbortError') return null;
    console.warn(
      '[fetchMediaInfo] failed for',
      url,
      '-',
      (e as Error)?.message || e
    );
    // Negative cache: don't retry the same URL within 60s, solving "task keeps downloading + repeated errors"
    mediaInfoFailCache.set(url, Date.now());
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
    if (!value) return null;
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
      if (contentLength) return { ok: true, size: parseInt(contentLength, 10) };
      const contentRange = parseContentRange(
        headResponse.headers.get('content-range')
      );
      if (contentRange) return { ok: true, size: contentRange };
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
      if (contentRange) return { ok: true, size: contentRange };
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
  // Firefox only accepts requestHeaders for onSendHeaders; Chromium also
  // supports extraHeaders.
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

  // Track open sidepanel ports per tab: tabId → Port (declared here, shared by isUiListening etc.)
  const sidePanelPorts = new Map<number, any>();

  const setSidePanelForAllTabs = async (
    enabled: boolean,
    path?: string
  ): Promise<void> => {
    if (typeof chromeGlobal?.sidePanel?.setOptions !== 'function') return;
    const tabs = await browser.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const options: any = { tabId: tab.id, enabled };
      if (path) options.path = path;
      try {
        await chromeGlobal.sidePanel.setOptions(options);
      } catch {
        /* ignore per-tab failures */
      }
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
    loadSettings().then((s) => applyOpenMode(s.openMode));

    if (canOpenSidepanel) {
      browser.runtime.onConnect.addListener((port) => {
        if (port.name !== 'sidepanel') return;
        let registeredTabId: number | undefined;

        port.onMessage.addListener((msg: any) => {
          if (
            msg?.type === 'SIDEPANEL_TAB_ID' &&
            typeof msg.tabId === 'number'
          ) {
            registeredTabId = msg.tabId;
            sidePanelPorts.set(msg.tabId, port);
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
      if (port.name !== 'sidepanel') return;
      firefoxSidebarOpen = true;
      port.onMessage.addListener((msg: any) => {
        if (msg?.type === 'SIDEPANEL_CLOSE_REQUEST') firefoxSidebarOpen = false;
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

  // browser.runtime.setUninstallURL('https://github.com/1337-ops/m3u8-downloader-ext')

  const tabMap = new Map<number, Map<string, MediaEntry>>();
  const bilibiliManagedUrls = new Map<number, Set<string>>();
  const platformManagedUrls = new Map<number, Set<string>>();
  const platformTaskPriorities = new Map<number, Map<string, number>>();
  const douyinMediaMetadata = new Map<
    number,
    Map<string, { title?: string; coverUrl?: string; duration?: number }>
  >();
  // Native <video> preloads do not pass through the page's fetch/XHR hook.
  const douyinNativeTracks = new Map<
    number,
    Map<string, Array<{ url: string; role: 'video' | 'audio'; at: number }>>
  >();
  const tabPageUrls = new Map<number, string>();
  // Track each tab's current page title (to record the "at-the-time" title during sniffing)
  const tabPageTitles = new Map<number, string>();

  const masterPrefixIndex = new Map<
    number,
    { version: number; map: Map<string, string[]> }
  >();
  const tabMediaVersion = new Map<number, number>();
  function bumpTabVersion(tabId: number) {
    tabMediaVersion.set(tabId, (tabMediaVersion.get(tabId) ?? 0) + 1);
  }
  // Build the master prefix index for a tab (lazy; rebuilt when the version changes)
  function getMasterPrefixIndex(
    tabId: number,
    mediaMap: Map<string, MediaEntry>
  ): Map<string, string[]> {
    const curVersion = tabMediaVersion.get(tabId) ?? 0;
    let entry = masterPrefixIndex.get(tabId);
    if (!entry || entry.version !== curVersion) {
      // Rebuild: scan mediaMap once and bucket by prefix
      const map = new Map<string, string[]>();
      for (const [mUrl, mEntry] of mediaMap) {
        if (
          mEntry.format === 'm3u8' &&
          (mEntry.groupRole === 'master' || !mEntry.groupRole)
        ) {
          const prefix = mUrl.substring(0, mUrl.lastIndexOf('/') + 1);
          if (!prefix) continue;
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

  function findMasterBySegmentUrl(
    tabId: number,
    mediaMap: Map<string, MediaEntry>,
    segUrl: string
  ): string | undefined {
    const index = getMasterPrefixIndex(tabId, mediaMap);
    if (index.size === 0) return undefined;
    let probe = segUrl.substring(0, segUrl.lastIndexOf('/') + 1);
    while (probe) {
      const arr = index.get(probe);
      if (arr && arr.length > 0) return arr[0];
      // move up one directory level
      const idx = probe.lastIndexOf('/', probe.length - 2);
      if (idx < 0) break;
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
    if (sidePanelPorts.has(tabId)) return true;
    const ts = uiListeningTabs.get(tabId);
    if (ts === undefined) return false;
    if (Date.now() - ts > UI_LISTENING_TTL) {
      uiListeningTabs.delete(tabId);
      return false;
    }
    return true;
  }

  // ── External downloader (OPEN_DOWNLOAD_PAGE) not deployed yet; fully commented out ──
  // interface DownloadSession {
  //   url: string;
  //   format: string;
  //   filename: string;
  //   sourceUrl: string;
  //   requestHeaders?: Record<string, string>;
  //   audioUrl?: string;
  // }
  // const pendingDownloads = new Map<number, DownloadSession>();
  // Track in-flight PROXY_FETCH proxy fetches so they can be aborted when the tab closes or the
  // page cancels them, avoiding resource leaks where segments keep being fetched after the page is gone
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
  };
  loadSettings().then((s) => {
    currentSettings = s;
  });

  browser.storage.local.onChanged.addListener((changes) => {
    if (changes['ext_settings']) {
      loadSettings().then((s) => {
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
                  })
                  .catch(() => {});
              }
            }
          })
          .catch(() => {});
      });
    }
  });

  try {
    if (browser.webNavigation) {
      browser.webNavigation.onBeforeNavigate.addListener(() => {});
      browser.webNavigation.onHistoryStateUpdated.addListener(() => {});
    }
  } catch {
    /* Firefox without the webNavigation permission */
  }

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      tabPageUrls.set(tabId, changeInfo.url);
    } else if (tab.url) {
      tabPageUrls.set(tabId, tab.url);
    }
    if (changeInfo.title) {
      tabPageTitles.set(tabId, changeInfo.title);
    } else if (tab.title) {
      tabPageTitles.set(tabId, tab.title);
    }
  });

  loadAllTabData().then((data) => {
    data.forEach((mediaMap, tabId) => {
      tabMap.set(tabId, mediaMap);
    });
    isDataLoaded = true;
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]?.id) {
        updateBadge(tabs[0].id);
      }
    });

    pendingMessages.forEach(({ msg, sender, sendResponse }) => {
      handleMessage(msg, sender, sendResponse);
    });
    pendingMessages.length = 0;
  });

  // Currently active tab ID, used as a fallback for tabId=-1
  let currentActiveTabId = -1;
  browser.tabs.onActivated.addListener(({ tabId }) => {
    currentActiveTabId = tabId;
    // Refresh the toolbar badge for the newly activated tab so it never shows
    // a stale count from a previous tab.
    try {
      updateBadge(tabId);
    } catch {}
  });
  browser.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (tab?.id) currentActiveTabId = tab.id;
    })
    .catch(() => {});
  void currentActiveTabId;

  // Broadcast debounce (coalesces multiple updates of the same tab within 100ms, avoiding frequent popup re-renders under high concurrency)
  const broadcastDebounceTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();

  function broadcastDebounced(tabId: number) {
    const existing = broadcastDebounceTimers.get(tabId);
    if (existing) clearTimeout(existing);
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

  // Header names to cache and replay (auth-related)
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
  ]);

  const isPotentialMediaRequest = (url: string): boolean =>
    /\.(m3u8|m3u|mpd|mp4|m4v|webm|ogv|flv|mkv|mov|avi|3gp|3g2|mpeg|mpg|mp3|m4a|oga|weba|wav|flac|aac|gif|jpe?g|png|webp|svg|pdf|docx?|xlsx?|pptx?|epub|csv|rtf|srt|vtt|ass|ssa|ttml)(?:[?#]|$)|(?:subtitle|caption)/i.test(
      url
    );

  // Transport fragments are implementation details of HLS/DASH downloads,
  // not user-downloadable media entries. Never place them in the sniff list.
  const isMediaSegmentRequest = (url: string): boolean =>
    /\.(m4s|m4f|m4i|cmfv|cmfa|cmft|ts)(?:[?#]|$)/i.test(url);

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
      if (!/(^|\.)bilibili\.com$/i.test(parsed.hostname)) return false;
      return /\/x\/player\/(?:wbi\/)?v2(?:\/|$)|\/x\/v2\/dm\/view(?:\/|$)/i.test(
        parsed.pathname
      );
    } catch {
      return false;
    }
  };

  browser.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId <= 0 || !details.requestHeaders?.length) return;
      if (details.type === 'other' && !isPotentialMediaRequest(details.url))
        return;
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
    },
    {
      urls: ['<all_urls>'],
      types: [
        'main_frame',
        'media',
        'xmlhttprequest',
        'sub_frame',
        'image',
        'other',
      ],
    },
    // Chromium needs extraHeaders to expose Cookie headers; Firefox does not support this option here.
    sendHeadersExtraInfo as any[]
  );

  browser.webRequest.onErrorOccurred.addListener(
    (details) => {
      pendingRequestHeaders.delete(details.requestId);
    },
    {
      urls: ['<all_urls>'],
      types: [
        'main_frame',
        'media',
        'xmlhttprequest',
        'sub_frame',
        'image',
        'other',
      ],
    }
  );

  function addProcessedRequest(key: string) {
    if (processedRequests.size >= PROCESSED_REQUESTS_MAX) {
      const first = processedRequests.values().next().value;
      if (first !== undefined) processedRequests.delete(first);
    }
    processedRequests.add(key);
  }

  // Detect the media format when response headers arrive (prefer Content-Type)
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const effectiveTabId = details.tabId;
      if (effectiveTabId <= 0) return undefined;
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
      if (processedRequests.has(requestKey)) return undefined;

      if (details.statusCode === 416) {
        addProcessedRequest(requestKey);
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
          if (!isNaN(n)) contentLength = n;
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

      // For Range responses, use the total instead of Content-Length
      if (hasContentRange && rangeTotal !== undefined) {
        contentLength = rangeTotal;
      }

      // A 206 Partial Content response still carries the full resource total in
      // Content-Range (rangeTotal above). We keep the request so that the total
      // size can be recorded; the actual segment size is ignored.

      let detectedFormat: string;
      let category: MediaCategory = 'media';

      if (details.type === 'media') {
        // Refine the format via Content-Type, falling back to mp4 when unrecognized
        detectedFormat = contentType
          ? (detectMedia(details.url, contentType, contentLength) ?? 'mp4')
          : 'mp4';
        const settings = currentSettings;
        const pageUrl = tabPageUrls.get(effectiveTabId);
        if (settings && pageUrl && isDomainExcluded(pageUrl, settings))
          return undefined;
        if (settings && !isFormatAllowed(detectedFormat, settings))
          return undefined;
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
        return undefined;
      }

      const mediaFmt = detectMedia(details.url, contentType, contentLength);
      if (mediaFmt) {
        detectedFormat = mediaFmt;
      } else {
        const doc = detectDoc(details.url, contentType, contentDisposition);
        if (!doc) return undefined;
        detectedFormat = doc.format;
        category = doc.category;
      }

      const settings = currentSettings;
      const pageUrl = tabPageUrls.get(effectiveTabId);
      if (settings && pageUrl && isDomainExcluded(pageUrl, settings))
        return undefined;
      if (settings && !isFormatAllowed(detectedFormat, settings))
        return undefined;
      if (settings && !isSizeAllowed(detectedFormat, contentLength, settings))
        return undefined;

      // Player resources fetched via XHR/fetch must also keep their response Content-Type.
      // Douyin often fetches separated audio/video as XHR; missing it breaks the later pairing logic.
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
      return undefined;
    },
    {
      urls: ['<all_urls>'],
      types: [
        'main_frame',
        'media',
        'xmlhttprequest',
        'sub_frame',
        'image',
        'other',
      ],
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

  const proxyHeaderExtraInfoSpec = (
    isFirefox ? ['blocking', 'requestHeaders'] : ['requestHeaders']
  ) as any[];
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const proxyHeader = details.requestHeaders?.find(
        (h) => h.name.toLowerCase() === 'x-coolhusky-proxy'
      );
      let playbackRule:
        | { referer: string; authHeaders?: Record<string, string> }
        | undefined;
      if (isFirefox && !proxyHeader) {
        try {
          playbackRule = playbackHeaderHosts.get(new URL(details.url).host);
        } catch {
          playbackRule = undefined;
        }
      }
      if (!proxyHeader && !playbackRule) return {};

      const refererHeader = details.requestHeaders?.find(
        (h) => h.name.toLowerCase() === 'x-coolhusky-referer'
      );
      const newHeaders = (details.requestHeaders || []).filter((h) => {
        const name = h.name.toLowerCase();
        // Remove Origin (CDNs reject chrome-extension:// origins)
        if (name === 'origin') return false;
        // Remove custom marker headers
        if (name === 'x-coolhusky-proxy' || name === 'x-coolhusky-referer')
          return false;
        // Remove browser-attached cache/conditional headers so the proxy doesn't hit the cache and get partial 206 content
        if (CACHE_HEADER_NAMES.has(name)) return false;
        return true;
      });

      // Inject Referer
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

  // DNR session rule cache for proxy requests (deduped by host)
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

    // Firefox cannot use Chromium's session DNR header rules here. Keep the
    // same per-host state for the blocking webRequest listener instead, so
    // direct <video>/<audio>/<img> requests also receive the captured headers.
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

    // Inject CORS response headers so <video>/<audio> in the popup can load media CDN resources cross-origin
    // Domestic CDNs (Douyin/Kuaishou/Bilibili etc.) often omit Access-Control-Allow-Origin, breaking playback
    const responseHeaders: any[] = [
      { operation: 'set', header: 'Access-Control-Allow-Origin', value: '*' },
      { operation: 'set', header: 'Access-Control-Allow-Headers', value: '*' },
      {
        operation: 'set',
        header: 'Access-Control-Allow-Methods',
        value: 'GET,HEAD,OPTIONS',
      },
    ];

    // Inject auth headers (Cookie is a forbidden header for fetch and can only
    // be injected via DNR)
    if (authHeaders) {
      for (const [k, v] of Object.entries(authHeaders)) {
        requestHeaders.push({ operation: 'set', header: k, value: v });
      }
    }

    // LRU eviction: when the cap is exceeded, batch-remove the oldest session rules first,
    // then add new ones, avoiding jitter from a single updateSessionRules that both removes and adds many rules.
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

  // Clean up handled request records (when the tab closes)
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const key of processedRequests) {
      if (key.startsWith(`${tabId}:`)) {
        processedRequests.delete(key);
      }
    }
    // Abort proxy fetches (segment downloads / preview playback) started by this tab that are still running,
    // otherwise the Service Worker keeps requesting segments after the tab is closed, leaking resources
    for (const [rid, entry] of pendingProxyFetches) {
      if (entry.tabId === tabId) {
        entry.controller.abort();
        pendingProxyFetches.delete(rid);
      }
    }
    // pendingDownloads.delete(tabId); // external-link download session is commented out
    tabMap.delete(tabId);
    bilibiliManagedUrls.delete(tabId);
    platformManagedUrls.delete(tabId);
    platformTaskPriorities.delete(tabId);
    douyinMediaMetadata.delete(tabId);
    douyinNativeTracks.delete(tabId);
    tabPageUrls.delete(tabId);
    tabPageTitles.delete(tabId);
    sidebarClosedTabs.delete(tabId);
    masterPrefixIndex.delete(tabId);
    tabMediaVersion.delete(tabId);
    uiListeningTabs.delete(tabId);
    deleteTabList(tabId);
  });

  const notifyPages = new Map<string, string>();

  // Notification click: jump back to the matching download page (focus an existing tab or create one), then tell the page to trigger a save
  browser.notifications.onClicked.addListener((notificationId) => {
    handleNotificationClick(String(notificationId));
  });

  async function handleNotificationClick(tag: string) {
    if (tag !== 'download-complete' && tag !== 'download-error') return;
    const target = notifyPages.get(tag) || 'https://192.168.1.3:3001/';
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
        // 'OPEN_DOWNLOAD_PAGE', // external-link downloader not yet deployed
        // 'COOLHUSKY_DOWNLOAD_READY',
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
      // The page adapter may suggest a referer, but the sender tab is the only
      // authoritative origin for a cross-page download session.
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
          type: 'MSE_DOWNLOAD_TRIGGER',
          captureId: msg.captureId,
          title: msg.title,
        })
        .catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    // ── The external downloader page feature is not deployed yet (coolhusky.net / localhost:3001); fully commented out ──
    // if (msg.type === 'OPEN_DOWNLOAD_PAGE') {
    //   const { url, format, filename, requestHeaders } = msg;
    //   let sourceUrl = sender.tab?.url || '';
    //   if (!sourceUrl) {
    //     const [activeTab] = await browser.tabs.query({
    //       active: true,
    //       currentWindow: true,
    //     });
    //     sourceUrl = activeTab?.url || '';
    //   }
    //
    //   // If the caller didn't pass requestHeaders directly, try to find them in the current tab's media entries
    //   let resolvedHeaders = requestHeaders as
    //     | Record<string, string>
    //     | undefined;
    //   if (!resolvedHeaders && sender.tab?.id) {
    //     const tabMedia = tabMap.get(sender.tab.id);
    //     if (tabMedia) {
    //       const entry = tabMedia.get(url);
    //       if (entry?.requestHeaders) resolvedHeaders = entry.requestHeaders;
    //     }
    //   }
    //   const suppliedReferer =
    //     resolvedHeaders?.referer || resolvedHeaders?.Referer;
    //   if (typeof suppliedReferer === 'string' && suppliedReferer)
    //     sourceUrl = suppliedReferer;
    //
    //   let downloaderPage: string;
    //   if (format === 'mpd') {
    //     downloaderPage = 'dash-downloader';
    //   } else if (format === 'm3u8') {
    //     downloaderPage = 'm3u8-downloader';
    //   } else {
    //     downloaderPage = 'video-downloader';
    //   }
    //
    //   const languageMapping: Record<string, string> = {
    //     'zh-CN': 'zh-Hans',
    //     'zh-SG': 'zh-Hans',
    //     'zh-TW': 'zh-Hant',
    //     'zh-HK': 'zh-Hant',
    //     ja: 'ja',
    //     ko: 'ko',
    //     de: 'de',
    //     es: 'es',
    //     ru: 'ru',
    //   };
    //
    //   const browserLang = browser.i18n.getUILanguage();
    //   const langSuffix = languageMapping[browserLang];
    //   const targetUrl = langSuffix
    //     ? `http://localhost:3001/${langSuffix}/${downloaderPage}`
    //     : `http://localhost:3001/${downloaderPage}`;
    //   const tab = await browser.tabs.create({ url: targetUrl });
    //   if (tab.id) {
    //     pendingDownloads.set(tab.id, {
    //       url,
    //       format,
    //       filename,
    //       sourceUrl,
    //       requestHeaders: resolvedHeaders,
    //       audioUrl: msg.audioUrl as string | undefined,
    //     });
    //   }
    //   sendResponse({ ok: true });
    //   return true;
    // }
    //
    // if (msg.type === 'COOLHUSKY_DOWNLOAD_READY') {
    //   const tabId = sender.tab?.id;
    //   if (tabId && pendingDownloads.has(tabId)) {
    //     const session = pendingDownloads.get(tabId)!;
    //     pendingDownloads.delete(tabId);
    //     sendResponse({
    //       ok: true,
    //       url: session.url,
    //       format: session.format,
    //       filename: session.filename,
    //       sourceUrl: session.sourceUrl,
    //       requestHeaders: session.requestHeaders,
    //       audioUrl: session.audioUrl,
    //     });
    //   } else {
    //     sendResponse({ ok: false });
    //   }
    //   return true;
    // }

    if (msg.type === 'CLEAR_LIST') {
      const tabId = msg.tabId as number;
      tabMap.delete(tabId);
      bilibiliManagedUrls.delete(tabId);
      platformManagedUrls.delete(tabId);
      platformTaskPriorities.delete(tabId);
      douyinMediaMetadata.delete(tabId);
      douyinNativeTracks.delete(tabId);
      masterPrefixIndex.delete(tabId);
      tabMediaVersion.delete(tabId);
      deleteTabList(tabId);
      for (const key of processedRequests) {
        if (key.startsWith(`${tabId}:`)) {
          processedRequests.delete(key);
        }
      }
      try {
        updateBadge(tabId);
      } catch {}
      sendResponse(true);
      return true;
    }

    if (msg.type === 'GET_LIST') {
      const tabId = msg.tabId as number;
      uiListeningTabs.set(tabId, Date.now());
      const mediaMap = tabMap.get(tabId);
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
      if (mediaMap) {
        mediaMap.forEach((entry, url) => {
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
      }
      sendResponse(list);
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
              // Metadata is best-effort enrichment: a URL may be playable in-page
              // while extension-side probes fail (CORS / hotlink protection), so a
              // fetch failure NEVER removes the sniffed item (reference Media-Extractor).
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
              if (controller.signal.aborted) throw error;
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
            if (changed) await saveTabList(tabId, mediaMap);
          }
          sendResponse({ ok: true, items: results });
        } catch (error) {
          if (controller.signal.aborted)
            sendResponse({ ok: false, cancelled: true, items: [] });
          else
            sendResponse({
              ok: false,
              error: (error as Error).message,
              items: [],
            });
        } finally {
          if (metadataBatchControllers.get(taskId) === controller)
            metadataBatchControllers.delete(taskId);
        }
      })();
      return true;
    }
    // After the popup obtains duration / width / height / size, write them back into MediaEntry for persistence (kept across popup sessions)
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
      sendResponse({ ok: true, removed: false });
      return true;
    }

    if (msg.type === 'GET_SETTINGS') {
      loadSettings().then((s) => sendResponse(s));
      return true;
    }

    if (msg.type === 'SAVE_SETTINGS') {
      saveSettings(msg.settings).then(() => sendResponse({ ok: true }));
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
          if (referrer) headers['X-CoolHusky-Referer'] = referrer;
          if (authHeaders) Object.assign(headers, authHeaders);
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

          // Install the same temporary rules for cross-host BaseURL/resource URLs explicitly present in the MPD.
          const candidates = new Set<string>([url]);
          for (const match of manifest.matchAll(/https?:\/\/[^\s"'<>]+/gi))
            candidates.add(match[0]);
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
              if (!headers[k]) headers[k] = v as string;
            }
          }
          const useProxyHeader = options?.proxyHeader !== false;
          if (useProxyHeader) {
            headers['X-CoolHusky-Proxy'] = '1';
            if (options?.referrer) {
              headers['X-CoolHusky-Referer'] = options.referrer;
            }
          }
          // On Chrome, register DNR rules in advance to carry Referer and auth headers (forbidden headers like cookie can only be injected via DNR)
          if (options?.referrer || options?.authHeaders) {
            try {
              await ensureProxyHeaderRule(
                url,
                options.referrer || '',
                options.authHeaders
              );
            } catch (_) {}
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
            return;
          }
          sendResponse({ ok: false, error: e.message });
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

    // Dispatch system notifications from the extension process
    if (msg.type === 'COOLHUSKY_NOTIFY') {
      const { title, body, tag, pageUrl } = msg;
      if (pageUrl) notifyPages.set(tag, pageUrl);
      try {
        await browser.notifications.create(String(tag), {
          type: 'basic',
          iconUrl: browser.runtime.getURL('/icon/128.png'),
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
    return false;
  }

  function addMedia(
    url: string,
    tabId: number,
    format: string,
    size?: number,
    category: MediaCategory = 'media',
    requestHeaders?: Record<string, string>,
    extra?: { captureId?: string; trackCount?: number; mseComplete?: boolean },
    contentType?: string,
    tabTitle?: string
  ) {
    // Respect per-type sniffing switches: disabled types should not be stored or counted at all.
    if (!isFormatAllowed(format, currentSettings)) {
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

    // Auto-associate ts/.m4s segments with the same tab's m3u8 master (longest URL path-prefix match)
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
        if (upgradedContentType)
          tryGroupVideoAudio(url, tabId, upgradedContentType, upgradedSize);
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
    // m3u8/mpd Content-Length is the manifest text size (a few KB), not the video size — don't store it
    const effectiveSize =
      format === 'm3u8' || format === 'mpd'
        ? undefined
        : (size ?? existing?.size);
    // FLV/MPEG-TS without Content-Length is treated as a live stream (typical of HTTP-FLV live)
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
    // m3u8/mpd is a potential master; bump the version so the prefix index rebuilds on the next segment lookup
    if (format === 'm3u8' || format === 'mpd') bumpTabVersion(tabId);
    saveTabList(tabId, mediaMap).catch(() => {});
    try {
      updateBadge(tabId);
    } catch {}

    // Audio/video separated-stream grouping (Bilibili/YouTube/Douyin etc.)
    if (contentType) {
      tryGroupVideoAudio(url, tabId, contentType, size);
    }

    broadcastDebounced(tabId);

    // Asynchronously parse the m3u8/mpd master manifest and build variant groups
    if (
      (format === 'm3u8' || format === 'mpd') &&
      !manifestParseCache.has(url)
    ) {
      parseAndGroupManifest(
        url,
        tabId,
        format as 'm3u8' | 'mpd',
        requestHeaders
      ).catch(() => {});
    }
  }

  function updateBadge(tabId: number) {
    const mediaMap = tabMap.get(tabId);
    const countedGroups = new Set<string>();
    let count = 0;
    mediaMap?.forEach((entry, url) => {
      // Skip disabled sniffing types so the toolbar badge matches the popup.
      if (!isFormatAllowed(entry.format, currentSettings)) {
        return;
      }
      const groupKey = entry.groupId || entry.groupMasterId;
      if (groupKey) {
        if (countedGroups.has(groupKey)) return;
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
    if (!action) return;
    action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId });
    if (action.setBadgeTextColor) {
      action.setBadgeTextColor({ color: '#FFFFFF', tabId });
    }
    action.setBadgeBackgroundColor({ color: '#EF4444', tabId });
  }

  function broadcast(
    tabId: number,
    list: Array<{
      url: string;
      format: string;
      size?: number;
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
    }>
  ) {
    browser.runtime
      .sendMessage({ type: 'LIST_UPDATED', tabId, list })
      .catch(() => {});
  }

  /** Convert Bilibili's playurl response into one virtual stream group. */
  function upsertBilibiliDashTask(tabId: number, task: any, tabTitle?: string) {
    if (!tabMap.has(tabId)) tabMap.set(tabId, new Map());
    const mediaMap = tabMap.get(tabId)!;
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
    if (!videos.length) return;
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
      if (entry.groupMasterId === masterUrl && entry.size)
        previousVariantSizes.set(url, entry.size);
    }

    for (const [url, entry] of mediaMap) {
      if (entry.groupMasterId === masterUrl && !entry.contentType)
        mediaMap.delete(url);
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

  // ── Audio/video separated-stream grouping (Bilibili/YouTube etc.)
  const DOUYIN_PAGE_HOST = /(^|\.)(douyin\.com|iesdouyin\.com)$/i;
  const DOUYIN_MEDIA_HOST =
    /(^|\.)(douyinvod|douyincdn|bytecdn|bytego|byteimg|bytedance|amemv|iesdouyin|snssdk|pstatp|toutiaovod|ixigua)\.(com|cn|net)$/i;

  function isAllowedDouyinMediaUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
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
    if (!task || typeof task !== 'object' || !senderUrl) return false;
    const value = task as PlatformMediaTask;
    try {
      if (!DOUYIN_PAGE_HOST.test(new URL(senderUrl).hostname)) return false;
    } catch {
      return false;
    }
    if (
      value.provider !== 'douyin' ||
      typeof value.key !== 'string' ||
      !Array.isArray(value.candidates)
    )
      return false;
    return (
      value.candidates.length > 0 &&
      value.candidates.every(
        (candidate) => !!candidate && isAllowedDouyinMediaUrl(candidate.url)
      )
    );
  }

  /** Provider-neutral grouping for candidates emitted by a platform adapter. */
  function upsertPlatformMediaTask(
    tabId: number,
    task: PlatformMediaTask,
    tabTitle?: string
  ) {
    if (!tabMap.has(tabId)) tabMap.set(tabId, new Map());
    const mediaMap = tabMap.get(tabId)!;
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
    // A provider may not be able to classify a legacy payload. In that case
    // retain the previous direct-video behavior instead of creating an empty group.
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
        if (!existingMasterId || existingMasterId === masterUrl) continue;
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

      // A feed/detail response frequently exposes only a video URL. It is
      // metadata, not a completed downloadable unit; wait for the player's
      // matching audio/video preload pair to create the visible card.
      if (!audioCandidates.length) {
        saveTabList(tabId, mediaMap).catch(() => {});
        broadcastDebounced(tabId);
        return;
      }
    }

    const previousMaster = mediaMap.get(masterUrl);
    const managed = platformManagedUrls.get(tabId) || new Set<string>();
    for (const [url, entry] of mediaMap) {
      if (entry.groupMasterId === masterUrl && !entry.contentType)
        mediaMap.delete(url);
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

  /**
   * Catch native player preloads (including Douyin's next-card prefetch).
   */
  function collectNativeDouyinTrack(tabId: number, value: string) {
    try {
      const pageUrl = tabPageUrls.get(tabId);
      if (!pageUrl || !DOUYIN_PAGE_HOST.test(new URL(pageUrl).hostname)) return;
      const url = new URL(value);
      if (!DOUYIN_MEDIA_HOST.test(url.hostname)) return;
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
      if (!role || !key) return;

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
      const groupKey = getDouyinTrackGroupKey(video);
      const metadataByUrl = douyinMediaMetadata.get(tabId);
      const metadata =
        metadataByUrl?.get(video) ||
        metadataByUrl?.get(getDouyinMediaResourceKey(video));

      upsertPlatformMediaTask(
        tabId,
        {
          provider: 'douyin',
          key: groupKey,
          referer: pageUrl,
          priority: 4,
          title: metadata?.title || tabPageTitles.get(tabId),
          coverUrl: metadata?.coverUrl,
          duration: metadata?.duration,
          candidates: [
            { url: video, format: 'mp4', role: 'video', label: '视频' },
            { url: audio, format: 'mp4', role: 'audio', label: '音频' },
          ],
        },
        tabPageTitles.get(tabId)
      );
    } catch {}
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId > 0)
        collectNativeDouyinTrack(details.tabId, details.url);
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }
  );

  /** A card key is based on the video resource, never on the reusable `l` token. */
  function getDouyinTrackGroupKey(url: string): string {
    let hash = 2166136261;
    for (let i = 0; i < url.length; i++)
      hash = Math.imul(hash ^ url.charCodeAt(i), 16777619);
    return `track_${(hash >>> 0).toString(36)}`;
  }

  /** Playback URLs rotate hosts and query signatures; their CDN path is stable. */
  function getDouyinMediaResourceKey(value: string): string {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }

  function isVideoOnlyContentType(ct: string): boolean {
    const c = ct.toLowerCase();
    if (!c.startsWith('video/')) return false;
    // If codecs explicitly include an audio codec, this is a muxed stream
    const codecsMatch = /codecs="([^"]+)"/.exec(c);
    if (codecsMatch) {
      const codecs = codecsMatch[1]!.toLowerCase();
      // mp4a / opus / vorbis / flac / ac-3 are all audio codecs
      if (/mp4a|opus|vorbis|flac|ac-3|ec-3/.test(codecs)) return false;
      // Video-only codecs (avc1, hev1, hvc1, vp8, vp9, av01)
      if (/avc1|hev1|hvc1|vp[89]|av01/.test(codecs)) return true;
    }
    return false;
  }

  function isAudioOnlyContentType(ct: string): boolean {
    const c = ct.toLowerCase();
    if (c.startsWith('audio/')) return true;
    // video/mp4 with audio-only codecs (rarely seen on Bilibili)
    const codecsMatch = /codecs="([^"]+)"/.exec(c);
    if (codecsMatch) {
      const codecs = codecsMatch[1]!.toLowerCase();
      if (
        /mp4a|opus|vorbis/.test(codecs) &&
        !/avc1|hev1|vp[89]|av01/.test(codecs)
      )
        return true;
    }
    return false;
  }

  // Extract a grouping key from the URL: drop mime/itag/quality/range params
  // and keep the core id params.
  function extractVideoGroupKey(url: string): string {
    try {
      const u = new URL(url);
      const host = u.host;
      const path = u.pathname;
      if (
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua)\.(?:com|cn|net)\b/i.test(
          host
        )
      ) {
        const pathSeg = path.split('/').filter(Boolean)[0] ?? '';
        return `${host}/${pathSeg}`;
      }
      // YouTube/Bilibili: keep all param names, drop known resolution/format
      // params, then sort the remaining ones to form the key
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
        if (!EXCLUDE_PARAMS.has(k.toLowerCase())) kept.push(`${k}=${v}`);
      });
      kept.sort();
      return `${host}${path}|${kept.join('&')}`;
    } catch {
      // When parsing fails, use the URL without its query string
      return url.split('?')[0] ?? url;
    }
  }

  // Extract a resolution label from the URL or Content-Type
  function extractQualityLabel(url: string, contentType: string): string {
    // YouTube itag → resolution mapping
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
      if (itag && itagMap[itag]) return itagMap[itag]!;
      const quality =
        u.searchParams.get('quality_label') ??
        u.searchParams.get('quality') ??
        u.searchParams.get('qlt');
      if (quality) return quality;
    } catch {}
    // Infer rough quality from Content-Type codecs (not exact)
    if (
      /avc1\.640034|avc1\.640032|hev1\.1.*L153|vp9.*profile2/i.test(contentType)
    )
      return '1080p+';
    if (/avc1\.640028|hev1\.1.*L120/i.test(contentType)) return '1080p';
    if (/avc1\.64001f/i.test(contentType)) return '720p';
    if (/avc1\.64001e/i.test(contentType)) return '480p';
    return '';
  }

  // Try to pair a newly added URL with an existing video/audio entry in the same tab
  const VIDEO_AUDIO_GROUP_WINDOW_MS = 8000;

  // For known media CDN URLs served as application/octet-stream, infer
  // video-only / audio-only from URL features. Douyin/ByteDance CDNs return
  // octet-stream without codecs, so the normal content-type check does not work.
  function detectStreamRoleFromUrl(url: string): 'video' | 'audio' | null {
    try {
      const u = new URL(url);
      const host = u.host.toLowerCase();
      const path = u.pathname.toLowerCase();
      const full = (host + path).toLowerCase();
      // Known media CDN domains
      const isMediaCdn =
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua|ks-yxcdn|kwaixiaodian)\.(?:com|cn|net)\b/i.test(
          host
        );
      if (!isMediaCdn) return null;
      // URL path/params contain an audio keyword → audio-only
      if (/audio|aud|sound|\.m4a\b|\.aac\b/.test(full)) return 'audio';
      // URL path/params contain a video keyword → video-only
      if (/video|vid|\.mp4\b|\.flv\b/.test(full)) return 'video';
      // No explicit keyword: fall back to the ratio/quality params in the URL
      // (video carries resolution params, audio does not)
      if (/[?&](ratio|quality|qlt|resolution|vq)=/.test(url)) return 'video';
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
    // Standard content-type detection (Bilibili/YouTube: explicit codecs)
    let isVideo = isVideoOnlyContentType(contentType);
    let isAudio = isAudioOnlyContentType(contentType);

    // application/octet-stream fallback: identify Douyin/ByteDance CDN URLs
    // via URL features
    if (!isVideo && !isAudio) {
      const role = detectStreamRoleFromUrl(newUrl);
      if (role === 'video') isVideo = true;
      else if (role === 'audio') isAudio = true;
    }
    if (!isVideo && !isAudio) return;

    const mediaMap = tabMap.get(tabId);
    if (!mediaMap) return;

    const newEntry = mediaMap.get(newUrl);
    if (!newEntry) return;

    const now = newEntry.detectedAt ?? Date.now();
    const newKey = extractVideoGroupKey(newUrl);
    const newLabel = extractQualityLabel(newUrl, contentType);

    // Search for pairing candidates within the time window in the same tab
    for (const [candidateUrl, candidateEntry] of mediaMap) {
      if (candidateUrl === newUrl) continue;
      if (!candidateEntry.contentType) continue;
      const age = Math.abs((candidateEntry.detectedAt ?? 0) - now);
      if (age > VIDEO_AUDIO_GROUP_WINDOW_MS) continue;

      // Try standard content-type for the candidate first, then the octet-stream fallback
      let candidateIsVideo = isVideoOnlyContentType(candidateEntry.contentType);
      let candidateIsAudio = isAudioOnlyContentType(candidateEntry.contentType);
      // Douyin can label both isolated tracks as `video/mp4` without codecs.
      // For a known Byte CDN URL, its media-audio/media-video path is then the
      // only reliable track signal; do not reserve this fallback for octet-stream.
      if (!candidateIsVideo && !candidateIsAudio) {
        const role = detectStreamRoleFromUrl(candidateUrl);
        if (role === 'video') candidateIsVideo = true;
        else if (role === 'audio') candidateIsAudio = true;
      }

      // Need one video-only and one audio-only entry to pair
      if (isVideo && !candidateIsAudio) continue;
      if (isAudio && !candidateIsVideo) continue;

      // octet-stream fallback scenario: double-check with the Content-Length
      // ratio. Video streams are usually much larger than audio streams
      // (>3:1); skip pairing if the sizes are close.
      if (
        contentType === 'application/octet-stream' &&
        candidateEntry.contentType === 'application/octet-stream'
      ) {
        const vSize = isVideo ? newSize : candidateEntry.size;
        const aSize = isVideo ? candidateEntry.size : newSize;
        if (vSize && aSize) {
          if (vSize < aSize * 3) continue; // video should be at least 3x larger than audio
        }
      }

      const candidateKey = extractVideoGroupKey(candidateUrl);

      // URL similarity check: share ratio of common params between the two keys.
      // Douyin/ByteDance CDN: keys are simplified host/pathSeg where video and
      // audio pathSegs differ. Skip the similarity check and pair by time
      // window + URL features + size ratio instead.
      const isDouyinCdn =
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua)\.(?:com|cn|net)\b/i.test(
          newUrl
        ) &&
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua)\.(?:com|cn|net)\b/i.test(
          candidateUrl
        );
      if (!isDouyinCdn) {
        const keySimilarity = computeKeySimilarity(newKey, candidateKey);
        if (keySimilarity < 0.5) continue;
      } else {
        // Douyin domain: require the same host
        try {
          if (new URL(newUrl).host !== new URL(candidateUrl).host) continue;
        } catch {
          continue;
        }
      }

      // Pair confirmed: create the group
      const videoUrl = isVideo ? newUrl : candidateUrl;
      const audioUrl_g = isAudio ? newUrl : candidateUrl;
      const videoEntry = mediaMap.get(videoUrl)!;
      const audioEntry = mediaMap.get(audioUrl_g)!;

      // Skip if both are already grouped into the same group
      if (videoEntry.groupId && videoEntry.groupId === audioEntry.groupId)
        continue;

      // Generate groupId from the core key of the video URL
      const groupId = `vid_grp_${extractVideoGroupKey(videoUrl).substring(0, 60)}`;
      const label =
        newLabel ||
        extractQualityLabel(videoUrl, videoEntry.contentType ?? '') ||
        '未知清晰度';

      // Update the video entry: act as a variant holding audioUrl
      mediaMap.set(videoUrl, {
        ...videoEntry,
        groupId,
        groupRole: 'variant',
        groupLabel: label,
        groupMasterId: groupId,
        audioUrl: audioUrl_g,
      });

      // Update the audio entry: mark it as audio and link it to the group
      mediaMap.set(audioUrl_g, {
        ...audioEntry,
        groupId,
        groupRole: 'audio',
        groupMasterId: groupId,
      });

      // Check whether the groupId already has a master entry (virtual master)
      if (!mediaMap.has(groupId)) {
        // Create a virtual master entry
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
    // Compare the similarity of two keys (host+path|params)
    const aParts = a.split('|');
    const bParts = b.split('|');
    // host+path must be identical
    if (aParts[0] !== bParts[0]) return 0;
    // Compare params
    const aParams = new Set((aParts[1] ?? '').split('&').filter(Boolean));
    const bParams = new Set((bParts[1] ?? '').split('&').filter(Boolean));
    if (aParams.size === 0 && bParams.size === 0) return 1;
    let common = 0;
    for (const p of aParams) {
      if (bParams.has(p)) common++;
    }
    return common / Math.max(aParams.size, bParams.size);
  }

  // ── Manifest parse cache and grouping ─────────────────────────────
  const manifestParseCache = new Set<string>();
  const manifestFailCache = new Map<string, number>();
  const MANIFEST_PARSE_FAIL_TTL = 60_000;

  async function parseAndGroupManifest(
    masterUrl: string,
    tabId: number,
    masterFormat: 'm3u8' | 'mpd',
    requestHeaders?: Record<string, string>
  ) {
    if (manifestParseCache.has(masterUrl)) return;
    const lastFail = manifestFailCache.get(masterUrl);
    if (lastFail && Date.now() - lastFail < MANIFEST_PARSE_FAIL_TTL) return;

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
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
        // Single-bitrate media playlist: duration and size have been attempted;
        // cache to avoid duplicate requests. If size is still missing, allow a
        // retry after 60s (the segment server may be temporarily unavailable).
        if (parsed.estimatedSize || parsed.duration) {
          manifestParseCache.add(masterUrl);
        } else {
          manifestFailCache.set(masterUrl, Date.now());
        }
        return;
      }

      const mediaMap = tabMap.get(tabId);
      if (!mediaMap) return;
      const masterEntry = mediaMap.get(masterUrl);
      if (!masterEntry) return;

      const groupId = masterUrl;

      // Estimate the total size from the highest-bandwidth variant + duration
      // (bandwidth bps / 8 * duration = bytes). Without bandwidth, fall back to
      // the segment-sampled size estimated by stream-parser.
      const topBandwidth = parsed.variants.reduce(
        (max, v) => Math.max(max, v.bandwidth ?? 0),
        0
      );
      const estimatedSize =
        topBandwidth > 0 && parsed.duration && parsed.duration > 0
          ? Math.round((topBandwidth / 8) * parsed.duration)
          : parsed.estimatedSize;

      // Mark the master entry and write the parsed duration and estimated size
      mediaMap.set(masterUrl, {
        ...masterEntry,
        groupId,
        groupRole: 'master',
        duration: parsed.duration ?? masterEntry.duration,
        size: estimatedSize ?? masterEntry.size,
      });

      for (const variant of parsed.variants) {
        const existing = mediaMap.get(variant.uri);
        if (existing && existing.groupRole && existing.groupRole !== 'segment')
          continue;

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
      broadcastDebounced(tabId);
    } catch (e) {
      manifestFailCache.set(masterUrl, Date.now());
      console.warn(
        '[CoolHusky] manifest parse failed:',
        masterUrl,
        (e as Error)?.message
      );
    }
  }
}
