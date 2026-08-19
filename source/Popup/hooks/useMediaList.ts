import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import browser from 'webextension-polyfill';
import type { RawMediaEntry } from '../../utils/popup-types';
import { getMediaKey } from '../utils/formats';

export interface MediaListItem {
  url: string;
  format: string;
  size?: number;
  width?: number;
  height?: number;
  detectedAt?: number;
  category?: string;
  requestHeaders?: Record<string, string>;
  captureId?: string;
  trackCount?: number;
  mseComplete?: boolean;
  groupId?: string;
  groupRole?: 'master' | 'variant' | 'audio' | 'segment';
  groupLabel?: string;
  groupMasterId?: string;
  variantBandwidth?: number;
  audioUrl?: string;
  audioOptions?: Array<{ url: string; label: string }>;
  duration?: number;
  coverUrl?: string;
  tabTitle?: string;
  isLiveStream?: boolean;
}

export type MediaListItemPatch = Partial<Omit<MediaListItem, 'url'>>;

function normalize(item: RawMediaEntry): MediaListItem {
  if (typeof item === 'string') {
    return { url: item, format: 'm3u8' };
  }
  return {
    url: item.url || '',
    format: item.format || 'm3u8',
    size: typeof item.size === 'number' ? item.size : undefined,
    width: typeof item.width === 'number' ? item.width : undefined,
    height: typeof item.height === 'number' ? item.height : undefined,
    detectedAt:
      typeof item.detectedAt === 'number' ? item.detectedAt : undefined,
    category: typeof item.category === 'string' ? item.category : undefined,
    requestHeaders:
      item.requestHeaders && typeof item.requestHeaders === 'object'
        ? item.requestHeaders
        : undefined,
    captureId: typeof item.captureId === 'string' ? item.captureId : undefined,
    trackCount:
      typeof item.trackCount === 'number' ? item.trackCount : undefined,
    mseComplete:
      typeof item.mseComplete === 'boolean' ? item.mseComplete : undefined,
    groupId: typeof item.groupId === 'string' ? item.groupId : undefined,
    groupRole: item.groupRole ?? undefined,
    groupLabel:
      typeof item.groupLabel === 'string' ? item.groupLabel : undefined,
    groupMasterId:
      typeof item.groupMasterId === 'string' ? item.groupMasterId : undefined,
    variantBandwidth:
      typeof item.variantBandwidth === 'number'
        ? item.variantBandwidth
        : undefined,
    audioUrl: typeof item.audioUrl === 'string' ? item.audioUrl : undefined,
    audioOptions: Array.isArray(item.audioOptions)
      ? item.audioOptions
      : undefined,
    duration: typeof item.duration === 'number' ? item.duration : undefined,
    coverUrl: typeof item.coverUrl === 'string' ? item.coverUrl : undefined,
    tabTitle: typeof item.tabTitle === 'string' ? item.tabTitle : undefined,
    isLiveStream:
      typeof item.isLiveStream === 'boolean' ? item.isLiveStream : undefined,
  };
}

export interface UseMediaListOptions {
  /** Callback after a coalesced LIST_UPDATED commit (e.g. to trigger batch metadata fetch). */
  onCommitted?: () => void;
  /** LIST_UPDATED coalescing window, default 80ms. */
  coalesceMs?: number;
  /** Reload the list whenever the active tab changes (used by the sidepanel). */
  followActiveTab?: boolean;
}

/**
 * React media list store (mirrors the source-side useMediaStore + useMediaList):
 * - LIST_UPDATED incremental refresh (80ms coalescing window, keeps fetched duration/width/height/size)
 * - replace / patchOne / patchMany / clear in-place updates
 * - byKey / indexByKey / byUrl indexes
 */
export function useMediaList(options?: UseMediaListOptions): {
  mediaList: MediaListItem[];
  mediaByKey: Map<string, MediaListItem>;
  mediaByUrl: Map<string, MediaListItem>;
  currentTabId: number | undefined;
  currentTabTitle: string;
  listLoaded: boolean;
  clearList: () => Promise<void>;
  refreshPage: () => Promise<void>;
  replace: (list: RawMediaEntry[]) => void;
  patchOne: (key: string, patch: MediaListItemPatch) => void;
  patchMany: (patches: Map<string, MediaListItemPatch>) => void;
  removeKeys: (keys: Iterable<string>) => void;
  clear: () => void;
} {
  const [mediaList, setMediaList] = useState<MediaListItem[]>([]);
  const [currentTabId, setCurrentTabId] = useState<number | undefined>(
    undefined
  );
  const [currentTabTitle, setCurrentTabTitle] = useState('');
  const [listLoaded, setListLoaded] = useState(false);
  const sessionRef = useRef(0);
  const tabIdRef = useRef<number | undefined>(undefined);
  const onCommittedRef = useRef(options?.onCommitted);
  const coalesceMsRef = useRef(options?.coalesceMs ?? 80);
  const followActiveTabRef = useRef(options?.followActiveTab ?? false);
  const pendingRef = useRef<RawMediaEntry[] | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  onCommittedRef.current = options?.onCommitted;

  const mediaByKey = useMemo(() => {
    const m = new Map<string, MediaListItem>();
    mediaList.forEach((i) => m.set(getMediaKey(i), i));
    return m;
  }, [mediaList]);

  const mediaIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    mediaList.forEach((i, idx) => m.set(getMediaKey(i), idx));
    return m;
  }, [mediaList]);

  const mediaByUrl = useMemo(() => {
    const m = new Map<string, MediaListItem>();
    mediaList.forEach((i) => {
      if (!m.has(i.url)) m.set(i.url, i);
    });
    return m;
  }, [mediaList]);

  // Expose latest indexes to callbacks (avoid stale closures).
  const lookupRef = useRef({ indexByKey: mediaIndexByKey, byKey: mediaByKey });
  lookupRef.current = { indexByKey: mediaIndexByKey, byKey: mediaByKey };

  const replace = useCallback((list: RawMediaEntry[]): void => {
    setMediaList(list.map(normalize));
  }, []);

  const patchOne = useCallback(
    (key: string, patch: MediaListItemPatch): void => {
      setMediaList((prev) => {
        const index = lookupRef.current.indexByKey.get(key);
        if (index === undefined) return prev;
        const next = prev.slice();
        next[index] = { ...next[index]!, ...patch };
        return next;
      });
    },
    []
  );

  const patchMany = useCallback(
    (patches: Map<string, MediaListItemPatch>): void => {
      if (!patches.size) return;
      setMediaList((prev) => {
        const next = prev.slice();
        let changed = false;
        for (const [key, patch] of patches) {
          const index = lookupRef.current.indexByKey.get(key);
          if (index === undefined) continue;
          next[index] = { ...next[index]!, ...patch };
          changed = true;
        }
        return changed ? next : prev;
      });
    },
    []
  );

  const clear = useCallback((): void => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    pendingRef.current = null;
    setMediaList([]);
  }, []);

  const removeKeys = useCallback((keys: Iterable<string>): void => {
    const toRemove = new Set(keys);
    if (!toRemove.size) return;
    setMediaList((prev) => {
      const next = prev.filter((i) => !toRemove.has(getMediaKey(i)));
      return next.length === prev.length ? prev : next;
    });
  }, []);

  const flush = useCallback((): void => {
    flushTimerRef.current = null;
    const rawList = pendingRef.current;
    pendingRef.current = null;
    if (!rawList) return;
    setMediaList((prev) => {
      const oldByKey = new Map(prev.map((i) => [getMediaKey(i), i]));
      return rawList.map((raw) => {
        const item = normalize(raw);
        const old = oldByKey.get(getMediaKey(item));
        if (!old) return item;
        return {
          ...item,
          duration: item.duration || old.duration,
          width: item.width || old.width,
          height: item.height || old.height,
          size: item.size || old.size,
        };
      });
    });
    onCommittedRef.current?.();
  }, []);

  const loadMediaList = useCallback(
    async (targetTabId?: number): Promise<void> => {
      const session = ++sessionRef.current;
      try {
        // Resolve the active tab AND fetch the list in ONE background round
        // trip. Resolving via `tabs.query` from an embedded page (sidepanel)
        // can return a stale/other window, which left the list empty when
        // media had been captured before the panel opened.
        const resp = (await browser.runtime.sendMessage({
          type: 'GET_LIST',
          tabId: targetTabId,
        })) as
          | {
              tabId?: number;
              title?: string;
              list?: RawMediaEntry[];
            }
          | undefined;
        if (session !== sessionRef.current) return;
        const resolvedTabId = resp?.tabId;
        if (resolvedTabId === undefined || resolvedTabId < 0) {
          setListLoaded(true);
          return;
        }
        tabIdRef.current = resolvedTabId;
        setCurrentTabId(resolvedTabId);
        if (resp?.title) setCurrentTabTitle(resp.title);
        replace(resp?.list ?? []);
      } catch {
        // background not ready yet — keep current state
      } finally {
        if (session === sessionRef.current) setListLoaded(true);
      }
    },
    [replace]
  );

  const handleListUpdate = useCallback(
    (msg: unknown): void => {
      const m = msg as {
        type?: string;
        tabId?: number;
        list?: RawMediaEntry[];
      };
      if (m?.type !== 'LIST_UPDATED') return;
      if (!Array.isArray(m.list)) return;
      if (m.tabId === undefined || m.tabId < 0) return;
      if (m.tabId !== tabIdRef.current) {
        if (
          followActiveTabRef.current &&
          document.visibilityState === 'visible'
        ) {
          tabIdRef.current = m.tabId;
          setCurrentTabId(m.tabId);
          void loadMediaList(m.tabId);
        }
        return;
      }
      pendingRef.current = m.list;
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flush, coalesceMsRef.current);
      }
    },
    [flush, loadMediaList]
  );

  useEffect(() => {
    void loadMediaList();
    const onMessage = (msg: unknown): void => handleListUpdate(msg);
    const onTabUpdated = (
      tabId: number,
      changeInfo: { title?: string }
    ): void => {
      if (tabId !== tabIdRef.current) {
        return;
      }
      if (changeInfo.title) {
        setCurrentTabTitle(changeInfo.title);
      }
    };
    const onTabActivated = (info: { tabId: number }): void => {
      if (!followActiveTabRef.current) return;
      if (info.tabId !== tabIdRef.current) void loadMediaList(info.tabId);
    };
    // active tab changed there).
    const onVisibilityChange = (): void => {
      if (!followActiveTabRef.current) return;
      if (document.visibilityState === 'visible') void loadMediaList();
    };
    // The sidepanel bridges the background's port push (SIDEPANEL_TAB_ID →
    // LIST_UPDATED) through this custom event. Replay any push that arrived
    // before React mounted.
    const onPanelList = (e: Event): void => {
      handleListUpdate((e as CustomEvent).detail);
    };
    window.addEventListener('coolhusky:panel-list', onPanelList);
    const pendingPanelList = (window as any).__coolhuskyPanelList;
    if (pendingPanelList) handleListUpdate(pendingPanelList);
    browser.runtime.onMessage.addListener(onMessage);
    browser.tabs.onUpdated.addListener(onTabUpdated);
    browser.tabs.onActivated.addListener(onTabActivated);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return (): void => {
      window.removeEventListener('coolhusky:panel-list', onPanelList);
      browser.runtime.onMessage.removeListener(onMessage);
      browser.tabs.onUpdated.removeListener(onTabUpdated);
      browser.tabs.onActivated.removeListener(onTabActivated);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      pendingRef.current = null;
    };
  }, [loadMediaList, handleListUpdate]);

  const clearList = useCallback(async (): Promise<void> => {
    if (tabIdRef.current === undefined) return;
    await browser.runtime.sendMessage({
      type: 'CLEAR_LIST',
      tabId: tabIdRef.current,
    });
    clear();
  }, [clear]);

  const refreshPage = useCallback(async (): Promise<void> => {
    if (tabIdRef.current === undefined) return;
    await browser.tabs.reload(tabIdRef.current);
  }, []);

  return {
    mediaList,
    mediaByKey,
    mediaByUrl,
    currentTabId,
    currentTabTitle,
    listLoaded,
    clearList,
    refreshPage,
    replace,
    patchOne,
    patchMany,
    removeKeys,
    clear,
  };
}
