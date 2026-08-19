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
  /** Page/API supplied poster, used when a stream itself has no thumbnail. */
  coverUrl?: string;
  /** Page title when the resource was sniffed (shown in the list, avoids stale titles after navigation). */
  tabTitle?: string;
  /** Live-stream flag (true when HTTP-FLV/MPEG-TS lacks Content-Length/Duration). */
  isLiveStream?: boolean;
}

function tabKey(tabId: number) {
  return `${PREFIX}${tabId}`;
}

const useSessionStorage =
  typeof browser !== 'undefined' && !!browser.storage?.session;

/**
 * Writes are serialized through a promise chain. Fire-and-forget saveTabList
 * calls from addMedia can otherwise race: with several concurrent
 * storage.session.set() calls the browser may complete them out of order and a
 * stale snapshot overwrites a newer one, losing freshly sniffed entries.
 * Queuing guarantees the final stored state matches the last call, and every
 * write issued before the service worker is terminated has a chance to land.
 */
let writeChain: Promise<void> = Promise.resolve();
function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(fn).catch(() => {});
  return writeChain;
}

/**
 * Read merged session data. storage.session is the primary store (survives
 * service-worker restarts within a browser session); if it is unavailable,
 * empty or errored, fall back to the `coolhusky__session__` snapshot kept in
 * storage.local (also the Firefox path where storage.session is unsupported).
 */
const SESSION_SNAPSHOT_KEY = 'coolhusky__session__';

async function getSessionData(): Promise<Record<string, any>> {
  let data: Record<string, any> = {};
  if (useSessionStorage) {
    try {
      const session = await browser.storage.session.get(null);
      if (session && typeof session === 'object') {
        data = { ...session };
      }
    } catch {
      /* session storage unavailable — fall through to the local snapshot */
    }
  }
  try {
    const local = await browser.storage.local.get(SESSION_SNAPSHOT_KEY);
    const localData = local[SESSION_SNAPSHOT_KEY] as
      | Record<string, any>
      | undefined;
    if (localData && typeof localData === 'object') {
      // Local entries override session ones (they are newer when session writes
      // fell back to local).
      return { ...data, ...localData };
    }
  } catch {
    /* ignore */
  }
  return data;
}

async function setSessionData(data: Record<string, any>): Promise<void> {
  if (useSessionStorage) {
    try {
      await browser.storage.session.set(data);
      return;
    } catch {
      // Session storage may be unavailable or quota-exceeded — persist the
      // snapshot in the local fallback so a service-worker restart does not
      // lose the list.
    }
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
  // Also drop the keys from the local fallback snapshot, otherwise deleted
  // tabs would resurrect from the local copy after a service-worker restart.
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
  } catch {
    /* ignore */
  }
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
              // Keep grouping/task metadata across service-worker restarts.
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
  // Snapshot synchronously (call order = snapshot order), then serialize the
  // actual writes through the chain to prevent out-of-order overwrites.
  const obj: Record<string, MediaEntry> = {};
  mediaMap.forEach((entry, url) => {
    obj[url] = entry;
  });
  await enqueueWrite(() => setSessionData({ [tabKey(tabId)]: obj }));
}

/** Restore a single tab's snapshot from session storage. */
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

/**
 * Persist each tab's current page URL. The in-memory `tabPageUrls` map in the
 * service worker is lost whenever the worker is evicted (MV3 idle shutdown);
 * without this, the next `tabs.onUpdated` loading event has no previous URL to
 * compare against and the same-site check fails, wiping the sniffed list on
 * e.g. Douyin modal open/close. Storing the URL lets the worker restore it on
 * wake-up so same-site navigations keep their media.
 */
export async function saveTabPageUrl(
  tabId: number,
  url: string
): Promise<void> {
  await enqueueWrite(() => setSessionData({ [pageUrlKey(tabId)]: url }));
}

/** Restore the persisted page URLs for all known tabs. */
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
