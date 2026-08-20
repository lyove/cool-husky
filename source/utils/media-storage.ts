import browser from 'webextension-polyfill';
import type { MediaCategory } from './detect';

const PREFIX = 'coolhusky_tab_';
const PAGE_URL_PREFIX = 'coolhusky_tabpage_';

export interface MediaEntry {
  format: string;
  size?: number;
  detectedAt?: number;
  category?: MediaCategory;
  requestHeaders?: Record<string, string>;
  captureId?: string;
  trackCount?: number;
  mseComplete?: boolean;
  contentType?: string;
  groupId?: string;
  groupRole?: 'master' | 'variant' | 'audio' | 'segment';
  groupLabel?: string;
  groupMasterId?: string;
  variantBandwidth?: number;
  audioUrl?: string;
  audioOptions?: Array<{ url: string; label: string }>;
  width?: number;
  height?: number;
  duration?: number;
  coverUrl?: string;
  tabTitle?: string;
  isLiveStream?: boolean;
}

function tabKey(tabId: number) {
  return `${PREFIX}${tabId}`;
}

const useSessionStorage =
  typeof browser !== 'undefined' && !!browser.storage?.session;

// Serialize writes to avoid race conditions in session storage
let writeChain: Promise<void> = Promise.resolve();
function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(fn).catch(() => {});
  return writeChain;
}

// Fallback to local storage snapshot when session storage unavailable
const SESSION_SNAPSHOT_KEY = 'coolhusky__session__';

async function getSessionData(): Promise<Record<string, any>> {
  let data: Record<string, any> = {};
  if (useSessionStorage) {
    try {
      const session = await browser.storage.session.get(null);
      if (session && typeof session === 'object') {
        data = { ...session };
      }
    } catch {}
  }
  try {
    const local = await browser.storage.local.get(SESSION_SNAPSHOT_KEY);
    const localData = local[SESSION_SNAPSHOT_KEY] as
      Record<string, any> | undefined;
    if (localData && typeof localData === 'object') {
      return { ...data, ...localData };
    }
  } catch {}
  return data;
}

async function setSessionData(data: Record<string, any>): Promise<void> {
  if (useSessionStorage) {
    try {
      await browser.storage.session.set(data);
      return;
    } catch {}
  }
  const existing = await browser.storage.local.get(SESSION_SNAPSHOT_KEY);
  const merged = {
    ...((existing[SESSION_SNAPSHOT_KEY] as Record<string, any>) || {}),
    ...data,
  };
  await browser.storage.local.set({ [SESSION_SNAPSHOT_KEY]: merged });
}

async function removeSessionData(keys: string | string[]): Promise<void> {
  const keyArr = Array.isArray(keys) ? keys : [keys];
  if (useSessionStorage) {
    try {
      await browser.storage.session.remove(keyArr);
    } catch {
      /* ignore */
    }
  }
  try {
    const existing = await browser.storage.local.get(SESSION_SNAPSHOT_KEY);
    const data = (existing[SESSION_SNAPSHOT_KEY] as Record<string, any>) || {};
    let changed = false;
    for (const k of keyArr) {
      if (k in data) {
        delete data[k];
        changed = true;
      }
    }
    if (changed) {
      await browser.storage.local.set({ [SESSION_SNAPSHOT_KEY]: data });
    }
  } catch {}
}

export async function loadAllTabData(): Promise<
  Map<number, Map<string, MediaEntry>>
> {
  const all = await getSessionData();
  const map = new Map<number, Map<string, MediaEntry>>();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const tabIdStr = key.slice(PREFIX.length);
      const tabId = parseInt(tabIdStr, 10);
      if (!isNaN(tabId)) {
        const mediaMap = new Map<string, MediaEntry>();

        if (Array.isArray(value)) {
          value.forEach((url: string) => {
            mediaMap.set(url, { format: 'm3u8' });
          });
        } else if (typeof value === 'object' && value !== null) {
          Object.entries(value).forEach(([url, entry]) => {
            if (typeof entry === 'string') {
              mediaMap.set(url, { format: entry });
            } else if (entry && typeof entry === 'object') {
              const e = entry as any;
              mediaMap.set(url, {
                ...e,
                format: e.format || 'm3u8',
                size: typeof e.size === 'number' ? e.size : undefined,
              });
            }
          });
        }

        map.set(tabId, mediaMap);
      }
    }
  }
  return map;
}

export async function saveTabList(
  tabId: number,
  mediaMap: Map<string, MediaEntry>
) {
  const obj: Record<string, MediaEntry> = {};
  mediaMap.forEach((entry, url) => {
    obj[url] = entry;
  });
  await enqueueWrite(() => setSessionData({ [tabKey(tabId)]: obj }));
}

export async function loadTabList(
  tabId: number
): Promise<Map<string, MediaEntry>> {
  const all = await getSessionData();
  const value = all[tabKey(tabId)];
  const mediaMap = new Map<string, MediaEntry>();
  if (Array.isArray(value)) {
    value.forEach((url: string) => {
      mediaMap.set(url, { format: 'm3u8' });
    });
  } else if (typeof value === 'object' && value !== null) {
    Object.entries(value).forEach(([url, entry]) => {
      if (typeof entry === 'string') {
        mediaMap.set(url, { format: entry });
      } else if (entry && typeof entry === 'object') {
        const e = entry as any;
        mediaMap.set(url, {
          ...e,
          format: e.format || 'm3u8',
          size: typeof e.size === 'number' ? e.size : undefined,
        });
      }
    });
  }
  return mediaMap;
}

export async function deleteTabList(tabId: number) {
  await enqueueWrite(() => removeSessionData(tabKey(tabId)));
}

function pageUrlKey(tabId: number) {
  return `${PAGE_URL_PREFIX}${tabId}`;
}

export async function saveTabPageUrl(
  tabId: number,
  url: string
): Promise<void> {
  await enqueueWrite(() => setSessionData({ [pageUrlKey(tabId)]: url }));
}

export async function loadTabPageUrls(): Promise<Map<number, string>> {
  const all = await getSessionData();
  const map = new Map<number, string>();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PAGE_URL_PREFIX)) {
      const tabId = parseInt(key.slice(PAGE_URL_PREFIX.length), 10);
      if (!isNaN(tabId) && typeof value === 'string' && value) {
        map.set(tabId, value);
      }
    }
  }
  return map;
}

export async function deleteTabPageUrl(tabId: number): Promise<void> {
  await enqueueWrite(() => removeSessionData(pageUrlKey(tabId)));
}
