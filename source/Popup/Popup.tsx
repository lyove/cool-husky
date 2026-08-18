import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FC,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import browser from 'webextension-polyfill';
import {
  useMediaList,
  type MediaListItem,
  type MediaListItemPatch,
} from './hooks/useMediaList';
import {
  useMediaFilters,
  type ActiveTab,
  type StreamFlatItem,
  type StreamGroup,
} from './hooks/useMediaFilters';
import { useMediaActions } from './hooks/useMediaActions';
import { useI18n } from './hooks/useI18n';
import { useSettings } from './hooks/useSettings';
import {
  formatFileSize,
  formatItemSize,
  formatDuration,
  getFormatLabel,
  getMediaKey,
  getResolutionLabel,
  getRelativeTime,
  getDownloadFilename,
  getFileName,
  isImageFormat,
  isStreamFormat,
  isVideoFormat,
  sanitizeDirectoryName,
} from './utils/formats';
import type {
  MediaItem,
  MetadataBatchItem,
  MetadataBatchResponse,
} from '../utils/popup-types';
import MediaPlayerModal from './components/MediaPlayerModal/MediaPlayerModal';
import SettingsView from './components/SettingsView/SettingsView';
import styles from './Popup.module.scss';

const METADATA_BATCH_SIZE = 200;

/** Video formats that need media info fetched */
const VIDEO_FORMATS = new Set([
  'mp4',
  'webm',
  'mov',
  'mkv',
  'avi',
  'flv',
  'm4v',
  'ogv',
  '3gp',
]);

const isMobileBrowser = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const mobileCapabilityTip = /zh/i.test(navigator.language)
  ? '移动端提示：普通下载可用；直播录制和 MSE 下载可能受后台运行及内存限制。'
  : 'Mobile note: regular downloads are supported; live recording and MSE downloads may be limited by background execution and memory.';

// ────────────────────────────── Generic virtual list ──────────────────────────────

interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  estimateHeight: (item: T, index: number) => number;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  overscan?: number;
  gap?: number;
}

function VirtualList<T>({
  items,
  getKey,
  estimateHeight,
  renderItem,
  className,
  overscan = 10,
  gap = 0,
}: VirtualListProps<T>): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return (): void => ro.disconnect();
  }, []);

  const offsets = useMemo(() => {
    const arr = new Array<number>(items.length + 1);
    arr[0] = 0;
    for (let i = 0; i < items.length; i++) {
      arr[i + 1] = (arr[i] ?? 0) + estimateHeight(items[i]!, i) + gap;
    }
    return arr;
  }, [items, estimateHeight, gap]);

  const total = (offsets[items.length] ?? 0) - gap;

  let start = 0;
  while (start < items.length && (offsets[start + 1] ?? 0) <= scrollTop)
    start++;
  let end = start;
  const bottom = scrollTop + viewportHeight;
  while (end < items.length && (offsets[end + 1] ?? 0) <= bottom) end++;
  start = Math.max(0, start - overscan);
  end = Math.min(items.length, end + overscan);

  const vItem: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    vItem.push(
      <div
        key={getKey(items[i]!, i)}
        style={{
          position: 'absolute',
          top: offsets[i],
          left: 0,
          right: 0,
          paddingBottom: gap,
        }}
      >
        {renderItem(items[i]!, i)}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ overflowY: 'auto' }}
    >
      <div style={{ position: 'relative', height: total }}>{vItem}</div>
    </div>
  );
}

// ────────────────────────────── Image lightbox ──────────────────────────────

interface LightboxProps {
  images: MediaListItem[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
  onDownload: (item: MediaListItem) => void;
  onCopy: (url: string) => void;
  t: (key: string, substitutions?: string | string[]) => string;
}

const Lightbox: FC<LightboxProps> = ({
  images,
  index,
  onNavigate,
  onClose,
  onDownload,
  onCopy,
  t,
}) => {
  const current = images[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft')
        onNavigate((index - 1 + images.length) % images.length);
      else if (e.key === 'ArrowRight') onNavigate((index + 1) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onNavigate, onClose]);

  if (!current) return null;

  return (
    <div
      className={styles.lightbox}
      role="button"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Enter') onClose();
      }}
    >
      <div className={styles.lightboxHeader}>
        <span>
          {index + 1} / {images.length}
        </span>
        <div className={styles.lightboxActions}>
          <button
            type="button"
            className={styles.lightboxBtn}
            onClick={(e) => {
              e.stopPropagation();
              void onDownload(current);
            }}
          >
            {t('download')}
          </button>
          <button
            type="button"
            className={styles.lightboxBtn}
            onClick={(e) => {
              e.stopPropagation();
              void onCopy(current.url);
            }}
          >
            {t('copyLink')}
          </button>
          <button
            type="button"
            className={styles.lightboxBtn}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>
      <div className={styles.lightboxBody}>
        <button
          type="button"
          className={styles.lightboxNav}
          onClick={() =>
            onNavigate((index - 1 + images.length) % images.length)
          }
        >
          ‹
        </button>
        <img src={current.url} alt="" className={styles.lightboxImg} />
        <button
          type="button"
          className={styles.lightboxNav}
          onClick={() => onNavigate((index + 1) % images.length)}
        >
          ›
        </button>
      </div>
      <div className={styles.lightboxUrl}>{current.url}</div>
    </div>
  );
};

// ────────────────────────────── Image hover preview ──────────────────────────────

interface HoverPreviewState {
  item: MediaListItem;
  left: number;
  top: number;
  above: boolean;
}

const PREVIEW_WIDTH = 216;
const PREVIEW_HEIGHT = 165;
const PREVIEW_DELAY = 120;
const PREVIEW_HIDE_DELAY = 80;

interface HoverPreviewProps {
  state: HoverPreviewState | null;
}

/**
 * Media-card hover preview. only video/image/stream items get a preview,
 * it appears below the card (or above it when there is not enough room) after a short delay, and hides shortly
 * after the pointer leaves the card.
 */
const HoverPreview: FC<HoverPreviewProps> = ({ state }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [state?.item.url]);

  if (!state) return null;
  const { item } = state;
  const fmt = item.format.toLowerCase();
  const isImg = isImageFormat(fmt);
  const isVid = isVideoFormat(fmt);
  const isStream = isStreamFormat(fmt) || fmt === 'mse';

  const resolution = getResolutionLabel(item.width, item.height);
  const duration = formatDuration(item.duration);

  return (
    <div
      className={styles.hoverPreview}
      style={{
        left: state.left,
        top: state.top,
        transformOrigin: state.above ? '50% 100%' : '50% 0%',
      }}
    >
      <div className={styles.hoverPreviewMedia}>
        {failed || (!isImg && !isVid && !isStream) ? (
          <div className={styles.hoverPreviewFallback}>
            {getFormatLabel(item.format).toUpperCase()}
          </div>
        ) : isVid ? (
          <video
            src={item.url}
            preload="metadata"
            muted
            playsInline
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={item.url}
            alt=""
            onError={() => setFailed(true)}
            draggable={false}
          />
        )}
      </div>
      <div className={styles.hoverPreviewInfo}>
        <div className={styles.hoverPreviewName} title={item.url}>
          {getFileName(item.url)}
        </div>
        <div className={styles.hoverPreviewMeta}>
          <span className={styles.formatBadge}>
            {getFormatLabel(item.format)}
          </span>
          {resolution && <span className={styles.metaTag}>{resolution}</span>}
          {item.size != null && (
            <span className={styles.metaTag}>{formatFileSize(item.size)}</span>
          )}
          {duration && <span className={styles.metaTag}>{duration}</span>}
        </div>
      </div>
    </div>
  );
};

// ────────────────────────────── Main component ──────────────────────────────

interface PopupProps {
  embedded?: boolean;
  /** Reload the media list when the active tab changes (sidepanel mode). */
  followActiveTab?: boolean;
}

interface TabDef {
  key: ActiveTab;
  label: string;
}

const TAB_DEFS: TabDef[] = [
  { key: 'all', label: 'tabAll' },
  { key: 'stream', label: 'tabStream' },
  { key: 'video', label: 'tabVideo' },
  { key: 'audio', label: 'tabAudio' },
  { key: 'image', label: 'tabImage' },
  { key: 'doc', label: 'tabDoc' },
];

const RESOLUTION_OPTIONS = ['8k', '4k', '1440p', '1080p', '720p', '480p'];

export default function Popup({
  embedded,
  followActiveTab,
}: PopupProps): ReactNode {
  const { t, density } = useI18n();
  const { settings, saveSettings } = useSettings();

  // ── UI state ──
  const [showSettings, setShowSettings] = useState(false);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [previewItem, setPreviewItem] = useState<MediaListItem | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [editingUrl, setEditingUrl] = useState('');
  const [editingName, setEditingName] = useState('');
  const [customNames, setCustomNames] = useState<Map<string, string>>(
    new Map()
  );
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(
    null
  );
  const hoverEnterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hideMobileTip, setHideMobileTip] = useState(false);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedMetadataKeysRef = useRef<Set<string>>(new Set());
  const metadataTaskSeqRef = useRef(0);
  const activeMetadataTaskRef = useRef<string | null>(null);

  const showToast = useCallback((msg: string): void => {
    setToast({ msg, id: Date.now() });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // ── Media store / actions ──
  const fetchMetadataRef = useRef<() => void>(() => {});
  const {
    mediaList,
    mediaByKey,
    currentTabId,
    currentTabTitle,
    clearList,
    refreshPage,
    patchMany,
    removeKeys,
  } = useMediaList({
    onCommitted: () => fetchMetadataRef.current(),
    followActiveTab,
  });
  const actions = useMediaActions(showToast);

  const filters = useMediaFilters({ mediaList, settings });
  const {
    activeTab,
    setActiveTab,
    typeFilter,
    setTypeFilter,
    sizeFilter,
    setSizeFilter,
    dimensionFilter,
    setDimensionFilter,
    resolutionFilter,
    setResolutionFilter,
    sortOrder,
    setSortOrder,
    searchQuery,
    setSearchQuery,
    useRegex,
    setUseRegex,
    regexValid,
    searchError,
    clearSearch,
    tabCounts,
    typeOptions,
    filteredMediaList,
    filteredImageList,
    groupedStreamList,
    flatMediaList,
    mediaCatalog,
  } = filters;

  // Refs expose the latest values to callbacks / effects
  const tabIdRef = useRef(currentTabId);
  tabIdRef.current = currentTabId;
  const mediaByKeyRef = useRef(mediaByKey);
  mediaByKeyRef.current = mediaByKey;
  const patchManyRef = useRef(patchMany);
  patchManyRef.current = patchMany;
  const removeKeysRef = useRef(removeKeys);
  removeKeysRef.current = removeKeys;

  // ── Batch metadata fetch (mirrors source-side fetchAllMetadataBatch + updateMediaMeta) ──
  useEffect(() => {
    fetchMetadataRef.current = (): void => {
      const tabId = tabIdRef.current;
      if (tabId === undefined) return;
      const requests: MetadataBatchItem[] = [];
      for (const item of mediaByKeyRef.current.values()) {
        const key = getMediaKey(item);
        if (failedMetadataKeysRef.current.has(key)) continue;
        if (item.url.startsWith('blob:') || item.url.startsWith('data:'))
          continue;
        if (item.url.includes('blob.chromium.org')) continue;
        const f = item.format.toLowerCase();
        const needMediaInfo = VIDEO_FORMATS.has(f)
          ? !item.width || !item.height || !item.duration
          : f === 'm4a' ||
              f === 'mp3' ||
              f === 'ogg' ||
              f === 'aac' ||
              f === 'opus' ||
              f === 'wav' ||
              f === 'flac'
            ? !item.duration
            : f === 'm3u8' || f === 'mpd' || f === 'ism' || f === 'flv'
              ? !item.duration
              : false;
        const needSize =
          !item.size &&
          !(item.format === 'mse') &&
          (VIDEO_FORMATS.has(f) ||
            f === 'm3u8' ||
            f === 'mpd' ||
            f === 'ism' ||
            f === 'ts' ||
            f === 'flv');
        if (!needMediaInfo && !needSize) continue;
        requests.push({
          key,
          url: item.url,
          format: item.format,
          requestHeaders: item.requestHeaders,
          needMediaInfo,
          needSize,
        });
      }
      if (!requests.length) return;
      const taskId = `metadata:${tabId}:${Date.now()}:${metadataTaskSeqRef.current++}`;
      const previousTask = activeMetadataTaskRef.current;
      activeMetadataTaskRef.current = taskId;
      if (previousTask) {
        void browser.runtime
          .sendMessage({
            type: 'CANCEL_MEDIA_METADATA_BATCH',
            taskId: previousTask,
          })
          .catch(() => {});
      }
      void (async (): Promise<void> => {
        const removedKeys = new Set<string>();
        const patches = new Map<string, MediaListItemPatch>();
        try {
          for (
            let offset = 0;
            offset < requests.length;
            offset += METADATA_BATCH_SIZE
          ) {
            const chunk = requests.slice(offset, offset + METADATA_BATCH_SIZE);
            const resp = (await browser.runtime.sendMessage({
              type: 'GET_MEDIA_METADATA_BATCH',
              taskId,
              tabId,
              items: chunk,
            })) as MetadataBatchResponse | undefined;
            if (tabIdRef.current !== tabId) return;
            if (!resp?.ok || !Array.isArray(resp.items)) continue;
            for (const result of resp.items) {
              if (result.removed) {
                removedKeys.add(result.key);
                continue;
              }
              if (result.error) {
                failedMetadataKeysRef.current.add(result.key);
                continue;
              }
              const patch: MediaListItemPatch = {};
              if (result.width) patch.width = result.width;
              if (result.height) patch.height = result.height;
              if (result.duration) patch.duration = result.duration;
              if (typeof result.size === 'number') patch.size = result.size;
              if (Object.keys(patch).length) patches.set(result.key, patch);
            }
          }
          if (removedKeys.size) removeKeysRef.current(removedKeys);
          patchManyRef.current(patches);
          // Persist fetched metadata (source-side updateMediaMeta)
          const byKey = mediaByKeyRef.current;
          for (const [key, patch] of patches) {
            const item = byKey.get(key);
            if (!item) continue;
            void browser.runtime
              .sendMessage({
                type: 'UPDATE_MEDIA_META',
                tabId,
                url: item.url,
                ...patch,
              })
              .catch(() => {});
          }
        } catch {
          // Task cancelled or network error: fail silently
        }
      })();
    };
  }, []);

  // ── Selection / batch ──
  const toggleSelectItem = useCallback((key: string): void => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const itemKeysOfGroup = useCallback((group: StreamGroup): string[] => {
    const keys: string[] = [];
    const push = (i?: MediaListItem): void => {
      if (i) keys.push(getMediaKey(i));
    };
    push(group.master);
    for (const v of group.variants) push(v);
    for (const a of group.audioItems) push(a);
    return keys;
  }, []);

  const toggleSelectGroup = useCallback(
    (group: StreamGroup): void => {
      const keys = itemKeysOfGroup(group);
      setSelectedUrls((prev) => {
        const next = new Set(prev);
        const allSelected = keys.every((k) => next.has(k));
        for (const k of keys) {
          if (allSelected) next.delete(k);
          else next.add(k);
        }
        return next;
      });
    },
    [itemKeysOfGroup]
  );

  /** Keys of all visible list entries (for select-all) */
  const visibleItemKeys = useMemo(() => {
    const keys: string[] = [];
    if (activeTab === 'all') {
      for (const entry of flatMediaList) {
        if (entry.kind === 'group') keys.push(...itemKeysOfGroup(entry.group));
        else keys.push(getMediaKey(entry.item));
      }
    } else if (activeTab === 'stream') {
      for (const group of groupedStreamList)
        keys.push(...itemKeysOfGroup(group));
    } else if (activeTab === 'image') {
      for (const item of filteredImageList) keys.push(getMediaKey(item));
    } else {
      for (const item of filteredMediaList) keys.push(getMediaKey(item));
    }
    return keys;
  }, [
    activeTab,
    flatMediaList,
    groupedStreamList,
    filteredImageList,
    filteredMediaList,
    itemKeysOfGroup,
  ]);

  const allVisibleSelected =
    visibleItemKeys.length > 0 &&
    visibleItemKeys.every((k) => selectedUrls.has(k));

  const toggleSelectAll = useCallback((): void => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const k of visibleItemKeys) next.delete(k);
      } else {
        for (const k of visibleItemKeys) next.add(k);
      }
      return next;
    });
  }, [allVisibleSelected, visibleItemKeys]);

  const selectedCount = selectedUrls.size;

  const handleDownloadItem = useCallback(
    async (item: MediaListItem): Promise<void> => {
      try {
        await actions.downloadItem({
          item,
          tabId: tabIdRef.current,
          filename: getDownloadFilename(
            item.url,
            item.format,
            customNames.get(item.url)
          ),
        });
      } catch {
        showToast(t('docDownloadFailed'));
      }
    },
    [actions, customNames, showToast, t]
  );

  const handleDownloadBatch = useCallback((): void => {
    const selectedItems = mediaList.filter((i) =>
      selectedUrls.has(getMediaKey(i))
    );
    if (!selectedItems.length) return;
    showToast(t('downloadBatchStarted') || '已开始批量下载');
    const subDir = sanitizeDirectoryName(currentTabTitle);
    void actions
      .downloadBatch(selectedItems, subDir, tabIdRef.current, customNames)
      .catch(() => {});
  }, [
    mediaList,
    selectedUrls,
    showToast,
    t,
    currentTabTitle,
    actions,
    customNames,
  ]);

  const handleCopyUrl = useCallback(
    async (url: string): Promise<void> => {
      const ok = await actions.copyUrl(url);
      if (ok) showToast(t('copiedUrl'));
    },
    [actions, showToast, t]
  );

  // ── Rename ──
  const getDisplayName = useCallback(
    (item: MediaListItem): string =>
      customNames.get(item.url) || getFileName(item.url) || 'download',
    [customNames]
  );

  const startRename = useCallback(
    (item: MediaListItem): void => {
      setEditingUrl(item.url);
      setEditingName(customNames.get(item.url) || getFileName(item.url) || '');
    },
    [customNames]
  );

  const confirmRename = useCallback((): void => {
    if (!editingUrl) return;
    const name = editingName.trim();
    setCustomNames((prev) => {
      const next = new Map(prev);
      if (name) next.set(editingUrl, name);
      else next.delete(editingUrl);
      return next;
    });
    setEditingUrl('');
    setEditingName('');
  }, [editingUrl, editingName]);

  const cancelRename = useCallback((): void => {
    setEditingUrl('');
    setEditingName('');
  }, []);

  const onRenameKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter') confirmRename();
      else if (e.key === 'Escape') cancelRename();
    },
    [confirmRename, cancelRename]
  );

  // ── Stream group expansion ──
  const toggleGroup = useCallback((id: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Virtual list height estimation ──
  const estimateFlatHeight = useCallback(
    (entry: StreamFlatItem): number => {
      if (entry.kind === 'group') {
        const group = entry.group;
        const base = density === 'comfortable' ? 60 : 52;
        if (!expandedGroups.has(group.id)) {
          return base;
        }
        const rowH = density === 'comfortable' ? 38 : 34;
        return (
          base +
          group.variants.length * rowH +
          group.audioItems.length * rowH +
          8
        );
      }
      return density === 'comfortable' ? 104 : 92;
    },
    [expandedGroups, density]
  );

  const estimateItemHeight = useCallback(
    (): number => (density === 'comfortable' ? 104 : 92),
    [density]
  );

  // ── Image masonry (two columns) ──
  const imageColumns = useMemo(() => {
    const cols: MediaListItem[][] = [[], []];
    filteredImageList.forEach((item, i) => cols[i % 2]!.push(item));
    return cols;
  }, [filteredImageList]);

  // ── Hover preview (-style) ──
  // Only video / image / stream items get a preview. It appears below the card
  // (or above when there is not enough room) after a short delay, and hides
  // shortly after the pointer leaves the card.
  const handleCardHover = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>, item: MediaListItem): void => {
      const fmt = item.format.toLowerCase();
      if (
        !isVideoFormat(fmt) &&
        !isImageFormat(fmt) &&
        !isStreamFormat(fmt) &&
        fmt !== 'mse'
      ) {
        return;
      }
      if (hoverLeaveTimerRef.current) {
        clearTimeout(hoverLeaveTimerRef.current);
        hoverLeaveTimerRef.current = null;
      }
      if (hoverEnterTimerRef.current) {
        clearTimeout(hoverEnterTimerRef.current);
        hoverEnterTimerRef.current = null;
      }
      const target = e.currentTarget as HTMLElement;
      hoverEnterTimerRef.current = setTimeout(() => {
        const rect = target.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom - 6;
        const above = spaceBelow < PREVIEW_HEIGHT;
        // 弹框水平居中于卡片（无缩略图时视觉更自然），并限制在视口内
        const left = Math.min(
          Math.max(8, rect.left + rect.width / 2 - PREVIEW_WIDTH / 2),
          window.innerWidth - PREVIEW_WIDTH - 8
        );
        const top = above
          ? Math.max(8, rect.top - PREVIEW_HEIGHT - 6)
          : rect.bottom + 6;
        setHoverPreview({
          item,
          left,
          top,
          above,
        });
        hoverEnterTimerRef.current = null;
      }, PREVIEW_DELAY);
    },
    []
  );

  const handleCardLeave = useCallback((): void => {
    if (hoverEnterTimerRef.current) {
      clearTimeout(hoverEnterTimerRef.current);
      hoverEnterTimerRef.current = null;
    }
    hoverLeaveTimerRef.current = setTimeout(() => {
      setHoverPreview(null);
      hoverLeaveTimerRef.current = null;
    }, PREVIEW_HIDE_DELAY);
  }, []);

  useEffect(() => {
    const cleanup = (): void => {
      if (hoverEnterTimerRef.current) clearTimeout(hoverEnterTimerRef.current);
      if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
    };
    return cleanup;
  }, []);

  // ── Render: regular media card ──
  const renderItemCard = useCallback(
    (item: MediaListItem): ReactNode => {
      const key = getMediaKey(item);
      const selected = selectedUrls.has(key);
      const isLive =
        item.isLiveStream && (item.format === 'flv' || item.format === 'ts');
      const isRecording = actions.isLiveRecording(item);
      const resolution = getResolutionLabel(item.width, item.height);
      const isEditing = editingUrl === item.url;
      const displayName = getDisplayName(item);
      return (
        <div
          className={`${styles.item} ${selected ? styles.itemSelected : ''}`}
          onMouseEnter={(e) => handleCardHover(e, item)}
          onMouseLeave={handleCardLeave}
        >
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => toggleSelectItem(key)}
            />
          </label>
          <div className={styles.itemBody}>
            <div className={styles.itemMain}>
              <span className={styles.formatBadge}>
                {getFormatLabel(item.format)}
              </span>
              {isEditing ? (
                <input
                  className={styles.renameInput}
                  value={editingName}
                  autoFocus
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={confirmRename}
                  onKeyDown={onRenameKeyDown}
                />
              ) : (
                <span
                  className={styles.itemUrl}
                  title={item.url}
                  onDoubleClick={() => startRename(item)}
                >
                  {displayName}
                </span>
              )}
            </div>
            <div className={styles.itemMeta}>
              {resolution && (
                <span className={styles.metaTag}>{resolution}</span>
              )}
              {item.category && (
                <span className={styles.metaTag}>{item.category}</span>
              )}
              {item.groupLabel && (
                <span className={styles.metaTag}>{item.groupLabel}</span>
              )}
              {item.trackCount !== undefined && (
                <span className={styles.metaTag}>
                  {item.trackCount} {t('tracks')}
                </span>
              )}
              {item.mseComplete !== undefined && (
                <span className={styles.metaTag}>
                  {item.mseComplete ? '✓' : '●'}
                </span>
              )}
              {formatDuration(item.duration)}
              {getRelativeTime(item.detectedAt, t)}
              <span className={styles.itemSize}>{formatItemSize(item)}</span>
            </div>
          </div>
          <div className={styles.itemActions}>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => setPreviewItem(item)}
              title={t('play')}
            >
              ▶
            </button>
            {isLive ? (
              <button
                type="button"
                className={`${styles.actionBtn} ${isRecording ? styles.actionBtnRecording : ''}`}
                onClick={() => actions.toggleLiveRecording(item)}
                title={isRecording ? t('stopRecording') : t('startRecording')}
              >
                {isRecording ? '⏹' : '⏺'}
              </button>
            ) : (
              <button
                type="button"
                className={styles.actionBtn}
                onClick={() => void handleDownloadItem(item)}
                title={t('download')}
              >
                ⬇
              </button>
            )}
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => void handleCopyUrl(item.url)}
              title={t('copyLink')}
            >
              ⧉
            </button>
          </div>
        </div>
      );
    },
    [
      selectedUrls,
      actions,
      editingUrl,
      editingName,
      getDisplayName,
      confirmRename,
      onRenameKeyDown,
      handleDownloadItem,
      handleCopyUrl,
      toggleSelectItem,
      startRename,
      t,
      handleCardHover,
      handleCardLeave,
    ]
  );

  // ── Render: stream group card ──
  const renderGroupCard = useCallback(
    (group: StreamGroup): ReactNode => {
      const expanded = expandedGroups.has(group.id);
      const keys = itemKeysOfGroup(group);
      const allSelected =
        keys.length > 0 && keys.every((k) => selectedUrls.has(k));
      const master = group.master;
      const hasChildren =
        group.variants.length > 0 || group.audioItems.length > 0;
      const totalSize = keys.reduce((sum, k) => {
        const item = mediaByKey.get(k);
        return sum + (item?.size || 0);
      }, 0);

      const renderRow = (item: MediaListItem): ReactNode => {
        const key = getMediaKey(item);
        const isSelected = selectedUrls.has(key);
        const res = getResolutionLabel(item.width, item.height);
        return (
          <div
            className={`${styles.variantRow} ${isSelected ? styles.itemSelected : ''}`}
            key={key}
          >
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleSelectItem(key)}
              />
            </label>
            <span className={styles.formatBadge}>
              {getFormatLabel(item.format)}
            </span>
            {res && <span className={styles.metaTag}>{res}</span>}
            {item.variantBandwidth !== undefined && (
              <span className={styles.metaTag}>
                {Math.round(item.variantBandwidth / 1024)} kbps
              </span>
            )}
            <span className={styles.variantName} title={item.url}>
              {getDisplayName(item)}
            </span>
            <span className={styles.itemSize}>{formatItemSize(item)}</span>
            <div className={styles.variantActions}>
              <button
                type="button"
                className={styles.actionBtn}
                onClick={() => setPreviewItem(item)}
                title={t('play')}
              >
                ▶
              </button>
              <button
                type="button"
                className={styles.actionBtn}
                onClick={() => void handleDownloadItem(item)}
                title={t('download')}
              >
                ⬇
              </button>
            </div>
          </div>
        );
      };

      return (
        <div
          className={styles.groupCard}
          onMouseEnter={(e) => {
            if (master) handleCardHover(e, master);
          }}
          onMouseLeave={handleCardLeave}
        >
          <div className={styles.groupHeader}>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => toggleSelectGroup(group)}
              />
            </label>
            <span className={styles.formatBadge}>
              {master ? getFormatLabel(master.format) : 'STREAM'}
            </span>
            {master && editingUrl === master.url ? (
              <input
                className={styles.renameInput}
                value={editingName}
                autoFocus
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={confirmRename}
                onKeyDown={onRenameKeyDown}
              />
            ) : (
              <span
                className={styles.groupName}
                title={master?.url}
                onDoubleClick={() => {
                  if (master) startRename(master);
                }}
              >
                {master
                  ? getDisplayName(master)
                  : group.variants[0]?.groupLabel || group.id}
              </span>
            )}
            <span className={styles.itemSize}>{formatFileSize(totalSize)}</span>
            {hasChildren && (
              <button
                type="button"
                className={styles.expandBtn}
                onClick={() => toggleGroup(group.id)}
              >
                {expanded ? '▾' : '▸'}
              </button>
            )}
          </div>
          {expanded && hasChildren && (
            <div className={styles.groupBody}>
              {master && renderRow(master)}
              {group.variants.map(renderRow)}
              {group.audioItems.map(renderRow)}
            </div>
          )}
        </div>
      );
    },
    [
      expandedGroups,
      itemKeysOfGroup,
      selectedUrls,
      mediaByKey,
      getDisplayName,
      toggleSelectItem,
      toggleSelectGroup,
      toggleGroup,
      handleDownloadItem,
      editingUrl,
      editingName,
      startRename,
      confirmRename,
      onRenameKeyDown,
      setEditingName,
      t,
      handleCardHover,
      handleCardLeave,
    ]
  );

  const renderFlatItem = useCallback(
    (entry: StreamFlatItem): ReactNode =>
      entry.kind === 'group'
        ? renderGroupCard(entry.group)
        : renderItemCard(entry.item),
    [renderGroupCard, renderItemCard]
  );

  // ── Tab definitions (dynamic via i18n) ──
  const tabDefs = useMemo(
    () =>
      TAB_DEFS.map((tab) => {
        return { ...tab, label: t(tab.label) };
      }),
    [t]
  );

  const resolutionOptions = useMemo(
    () =>
      RESOLUTION_OPTIONS.map((r) => {
        return {
          value: r,
          label: r === '8k' ? '8K' : r === '4k' ? '4K' : r.toUpperCase(),
        };
      }),
    []
  );

  // Always show the full tab bar (all / stream / video / audio / image / doc),
  // even when a type has 0 items, so the popup header matches the reference UI.
  const visibleTabs = useMemo(() => tabDefs, [tabDefs]);

  // ── Lightbox keyboard navigation ──
  const navigateLightbox = useCallback((index: number): void => {
    setLightboxIndex(index);
  }, []);

  // List body
  let listBody: ReactNode;
  if (activeTab === 'image') {
    listBody = (
      <div className={styles.masonry}>
        {imageColumns.map((column, colIndex) => (
          // Fixed two-column layout: stable column index makes a safe key
          // eslint-disable-next-line react/no-array-index-key
          <div key={colIndex} className={styles.masonryCol}>
            {column.map((item) => {
              const actualIndex = filteredImageList.indexOf(item);
              return (
                <div
                  key={getMediaKey(item)}
                  className={styles.masonryItem}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigateLightbox(actualIndex)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigateLightbox(actualIndex);
                    }
                  }}
                >
                  <img src={item.url} alt="" loading="lazy" />
                  <div className={styles.masonryMeta}>
                    <span>{getFormatLabel(item.format)}</span>
                    <span>{formatItemSize(item)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  } else if (activeTab === 'stream') {
    listBody = (
      <div className={styles.list}>
        {groupedStreamList.length ? (
          groupedStreamList.map((g) => renderGroupCard(g))
        ) : (
          <div className={styles.empty}>
            {t('notFound')}
            <br />
            {t('playTips')}
          </div>
        )}
      </div>
    );
  } else if (activeTab === 'all') {
    listBody = flatMediaList.length ? (
      <VirtualList
        className={styles.listVirtual}
        items={flatMediaList}
        getKey={(entry) =>
          entry.kind === 'group'
            ? `group:${entry.group.id}`
            : `item:${getMediaKey(entry.item)}`
        }
        estimateHeight={estimateFlatHeight}
        renderItem={renderFlatItem}
        gap={density === 'comfortable' ? 10 : 6}
      />
    ) : (
      <div className={styles.empty}>
        {t('notFound')}
        <br />
        {t('playTips')}
      </div>
    );
  } else {
    listBody = filteredMediaList.length ? (
      <VirtualList
        className={styles.listVirtual}
        items={filteredMediaList}
        getKey={(item) => getMediaKey(item)}
        estimateHeight={estimateItemHeight}
        renderItem={(item) => renderItemCard(item)}
        gap={density === 'comfortable' ? 10 : 6}
      />
    ) : (
      <div className={styles.empty}>
        {t('notFound')}
        <br />
        {t('playTips')}
      </div>
    );
  }

  return (
    <div
      className={`${styles.popup} ${embedded ? styles.popupEmbedded : ''} ${
        showSettings ? styles.popupSettings : ''
      } ${density === 'comfortable' ? styles.densityComfortable : ''}`}
    >
      {showSettings ? (
        <SettingsView
          settings={settings}
          onSave={saveSettings}
          onBack={() => setShowSettings(false)}
          onOpenShortcuts={() => void actions.openShortcuts()}
        />
      ) : (
        <>
          {!embedded && (
            <header className={styles.header}>
              <div className={styles.headerTop}>
                <div>
                  <h1 className={styles.title}>CoolHusky</h1>
                  <p className={styles.subtitle}>{t('subtitle')}</p>
                </div>
              </div>
              <p className={styles.greeting} title={currentTabTitle}>
                {currentTabTitle}
              </p>
              {isMobileBrowser && !hideMobileTip && (
                <div className={styles.mobileBanner}>
                  <span>{mobileCapabilityTip}</span>
                  <button type="button" onClick={() => setHideMobileTip(true)}>
                    ✕
                  </button>
                </div>
              )}
            </header>
          )}

          <div className={styles.toolbar}>
            <div className={styles.tabs}>
              {visibleTabs.map((tab) => (
                <button
                  type="button"
                  key={tab.key}
                  data-tab={tab.key}
                  className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}({tabCounts[tab.key] ?? 0})
                </button>
              ))}
            </div>
            <div className={styles.searchRow}>
              <input
                className={styles.searchInput}
                type="search"
                placeholder={t('searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button
                type="button"
                className={`${styles.iconBtn} ${useRegex ? styles.iconBtnActive : ''}`}
                onClick={() => setUseRegex(!useRegex)}
                title={t('regexToggle')}
              >
                .*
              </button>
              {searchQuery && (
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={clearSearch}
                  title={t('clearSearch')}
                >
                  ✕
                </button>
              )}
            </div>
            {!regexValid && searchError && (
              <p className={styles.searchError}>{searchError}</p>
            )}
            <div className={styles.filterRow}>
              {activeTab === 'video' && typeOptions.length > 1 && (
                <select
                  className={styles.select}
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as never)}
                >
                  {typeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
              {(activeTab === 'all' ||
                activeTab === 'video' ||
                activeTab === 'audio' ||
                activeTab === 'doc') && (
                <div className={styles.sizeFilter}>
                  <input
                    className={styles.sizeInput}
                    type="number"
                    min={0}
                    placeholder={t('min')}
                    value={sizeFilter.min || ''}
                    onChange={(e) =>
                      setSizeFilter({
                        ...sizeFilter,
                        min: Number(e.target.value) || 0,
                      })
                    }
                  />
                  <span className={styles.sizeUnit}>-</span>
                  <input
                    className={styles.sizeInput}
                    type="number"
                    min={0}
                    placeholder={t('max')}
                    value={sizeFilter.max || ''}
                    onChange={(e) =>
                      setSizeFilter({
                        ...sizeFilter,
                        max: Number(e.target.value) || 0,
                      })
                    }
                  />
                  <span className={styles.sizeUnit}>KB</span>
                </div>
              )}
              {activeTab === 'image' && (
                <div className={styles.sizeFilter}>
                  <input
                    className={styles.sizeInput}
                    type="number"
                    min={0}
                    placeholder={t('width')}
                    value={dimensionFilter.minWidth || ''}
                    onChange={(e) =>
                      setDimensionFilter({
                        ...dimensionFilter,
                        minWidth: Number(e.target.value) || 0,
                      })
                    }
                  />
                  <span className={styles.sizeUnit}>×</span>
                  <input
                    className={styles.sizeInput}
                    type="number"
                    min={0}
                    placeholder={t('height')}
                    value={dimensionFilter.minHeight || ''}
                    onChange={(e) =>
                      setDimensionFilter({
                        ...dimensionFilter,
                        minHeight: Number(e.target.value) || 0,
                      })
                    }
                  />
                  <span className={styles.sizeUnit}>px</span>
                </div>
              )}
              {activeTab === 'video' && (
                <select
                  className={styles.select}
                  value={resolutionFilter}
                  onChange={(e) => setResolutionFilter(e.target.value)}
                >
                  <option value="any">{t('any')}</option>
                  {resolutionOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
              <div className={styles.sortGroup}>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.sortBtn}`}
                  onClick={() =>
                    setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')
                  }
                  title={t('sort')}
                >
                  {sortOrder === 'desc' ? '↓' : '↑'}
                </button>
              </div>
            </div>
          </div>

          <div className={styles.listHeader}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
                disabled={!visibleItemKeys.length}
              />
              {t('selectAll')}
            </label>
            <span className={styles.listSummary}>
              {t('found')} {mediaCatalog.all.length} {t('item')}
            </span>
          </div>

          {listBody}

          <footer className={styles.footer}>
            <div className={styles.footerLeft}>
              <button
                type="button"
                className={styles.settingsBtn}
                onClick={() => setShowSettings(true)}
                title={t('settings')}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className={styles.settingsIcon}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                  />
                </svg>
              </button>
            </div>
            <div className={styles.footerActions}>
              <button
                type="button"
                className={styles.footerBtn}
                onClick={() => void handleDownloadBatch()}
                disabled={!selectedCount || actions.downloading}
              >
                {actions.downloading ? '…' : t('downloadSelected')}
              </button>
              <button
                type="button"
                className={styles.footerBtn}
                onClick={() => void clearList()}
                title={t('clearList')}
              >
                {t('clear')}
              </button>
              <button
                type="button"
                className={styles.footerBtn}
                onClick={() => void refreshPage()}
                title={t('refresh')}
              >
                {t('refresh')}
              </button>
            </div>
            <div className={styles.footerRight}>
              <span>
                {t('found')} {mediaCatalog.all.length} {t('item')}
              </span>
              {selectedCount > 0 && (
                <span>
                  {'  '}
                  {selectedCount} {t('selected')}
                </span>
              )}
            </div>
          </footer>
        </>
      )}

      {toast && (
        <div key={toast.id} className={styles.toast}>
          {toast.msg}
        </div>
      )}

      {previewItem && (
        <MediaPlayerModal
          item={previewItem as MediaItem}
          currentTabId={currentTabId}
          onClose={() => setPreviewItem(null)}
        />
      )}

      {lightboxIndex >= 0 && (
        <Lightbox
          images={filteredImageList}
          index={lightboxIndex}
          onNavigate={navigateLightbox}
          onClose={() => setLightboxIndex(-1)}
          onDownload={(item) => void handleDownloadItem(item)}
          onCopy={(url) => void handleCopyUrl(url)}
          t={t}
        />
      )}

      <HoverPreview state={hoverPreview} />
    </div>
  );
}
