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
import { useVideoThumbnails } from './hooks/useVideoThumbnails';
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
  isAudioFormat,
  isImageFormat,
  isStreamFormat,
  isVideoFormat,
  sanitizeDirectoryName,
} from './utils/formats';
import { isMergeableAudioFormat } from '../../utils/audio-merge';
import type {
  MediaItem,
  MetadataBatchItem,
  MetadataBatchResponse,
} from '../../utils/popup-types';
import MediaPlayerModal from './components/MediaPlayerModal/MediaPlayerModal';
import InlineMediaPlayer from './components/InlineMediaPlayer/InlineMediaPlayer';
import SettingsView from './components/SettingsView/SettingsView';
import TooltipProvider from './components/Tooltip/Tooltip';
import styles from './Popup.module.scss';

const METADATA_BATCH_SIZE = 200;

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

const AudioIcon = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
  </svg>
);

type SelectState = 'none' | 'some' | 'all';

const SelectAllIconSvg = ({
  state,
  size = 16,
}: {
  state: SelectState;
  size?: number;
}): ReactNode => {
  const filled = state !== 'none';
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect
        x="3.75"
        y="3.75"
        width="16.5"
        height="16.5"
        rx="3"
        ry="3"
        fill={filled ? 'currentColor' : 'none'}
      />
      {state === 'all' && (
        <path d="M8 12l2.5 2.5L16 9" stroke="#fff" strokeWidth={2.2} />
      )}
      {state === 'some' && (
        <path d="M8.5 12h7" stroke="#fff" strokeWidth={2.2} />
      )}
    </svg>
  );
};

const SortIconSvg = ({ desc }: { desc: boolean }): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    strokeWidth="1.5"
    fill="none"
    stroke="currentColor"
    style={desc ? undefined : { transform: 'scaleY(-1)' }}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4"
    />
  </svg>
);

const ExpandPlusIconSvg = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    strokeWidth="2"
    fill="none"
    stroke="currentColor"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
  </svg>
);

const ExpandMinusIconSvg = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    strokeWidth="2"
    fill="none"
    stroke="currentColor"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
  </svg>
);

const TrashIconSvg = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    strokeWidth="1.5"
    fill="none"
    stroke="currentColor"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
    />
  </svg>
);

const RefreshIconSvg = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12a9 9 0 01-9 9 9 9 0 010-18 9 9 0 017.1 3.5" />
    <path d="M21 3v6h-6" />
  </svg>
);

const FilterIconSvg = ({ active }: { active: boolean }): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill={active ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 5h18M7 12h10M10 19h4" />
  </svg>
);

const VideoIcon = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.361a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const FileIcon = (): ReactNode => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
    <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
  </svg>
);

const CopyIconSvg = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const PlayIconSvg = (): ReactNode => (
  <svg viewBox="0 0 1024 1024" width="1em" height="1em" stroke="currentColor">
    <path
      fill="#f0f0f0"
      d="M791.04 384L378.88 147.626667a145.92 145.92 0 0 0-218.88 128v474.453333A145.92 145.92 0 0 0 305.92 896a146.346667 146.346667 0 0 0 72.96-19.626667L791.04 640a145.92 145.92 0 0 0 0-252.586667z m-42.666667 178.773333l-412.16 239.786667a61.44 61.44 0 0 1-60.586666 0 60.586667 60.586667 0 0 1-30.293334-52.48V273.92a60.586667 60.586667 0 0 1 30.293334-52.48A64.426667 64.426667 0 0 1 305.92 213.333333a65.706667 65.706667 0 0 1 30.293333 8.106667l412.16 238.08a60.586667 60.586667 0 0 1 0 104.96z"
    />
  </svg>
);

const PauseIconSvg = (): ReactNode => (
  <svg viewBox="0 0 1024 1024" width="1em" height="1em" stroke="currentColor">
    <path
      fill="#f0f0f0"
      d="M682.666667 85.333333a128 128 0 0 0-128 128v597.333334a128 128 0 0 0 256 0V213.333333a128 128 0 0 0-128-128z m42.666666 725.333334a42.666667 42.666667 0 0 1-85.333333 0V213.333333a42.666667 42.666667 0 0 1 85.333333 0zM341.333333 85.333333a128 128 0 0 0-128 128v597.333334a128 128 0 0 0 256 0V213.333333a128 128 0 0 0-128-128z m42.666667 725.333334a42.666667 42.666667 0 0 1-85.333333 0V213.333333a42.666667 42.666667 0 0 1 85.333333 0z"
    />
  </svg>
);

const PreviewIconSvg = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
  </svg>
);

const DownloadIconSvg = (): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
  </svg>
);

const RenameDownloadIconSvg = (): ReactNode => (
  <svg width="1em" height="1em" viewBox="0 0 1024 1024">
    <path
      d="M812.869818 414.068364L553.797818 150.900364v236.823272c0 18.618182 7.261091 26.344727 26.344727 26.344728h232.727273z m-257.861818 308.596363l-2.606545 75.031273 48.686545-49.524364 37.701818-38.632727a26.717091 26.717091 0 0 1 20.014546-8.192c14.522182 0 26.344727 10.426182 26.344727 25.879273a26.437818 26.437818 0 0 1-10.426182 20.945454L547.374545 867.234909c-7.261091 7.261091-13.591273 10.053818-20.48 10.053818-7.168 0-13.125818-2.792727-20.852363-10.053818L378.786909 748.171636a26.065455 26.065455 0 0 1-10.053818-20.945454c0-15.453091 10.984727-25.879273 25.972364-25.879273 7.261091 0 14.894545 2.699636 20.014545 8.192l37.701818 38.632727 48.593455 49.524364-2.792728-75.031273V550.912c0-14.987636 13.312-27.275636 28.765091-27.275636 14.894545 0 28.113455 12.288 28.113455 27.275636v171.752727z m197.818182 215.505455c47.290182 0 71.866182-25.506909 71.866182-71.400727V470.016h-251.345455c-49.524364 0-75.496727-24.576-75.496727-75.962182V139.077818h-197.352727c-47.197091 0-71.68 26.344727-71.68 71.773091v655.918546c0 45.893818 24.482909 71.400727 71.68 71.400727h452.328727z m-583.68-70.469818v-658.152728c0-85.922909 43.752727-129.582545 128.744727-129.582545h204.986182c44.497455 0 68.608 6.795636 98.210909 36.864L847.406545 366.778182c30.906182 31.371636 36.864 53.154909 36.864 103.237818v397.684364c0 85.922909-43.194182 130.048-128.651636 130.048H297.890909c-85.457455 0-128.651636-43.659636-128.651636-130.048z"
      fill="currentColor"
    />
  </svg>
);

const MergeIconSvg = (): ReactNode => (
  <svg viewBox="0 0 1024 1024" width="1em" height="1em">
    <path
      d="M960 768 64 768c-35.36 0-64-28.64-64-64L0 160c0-35.328 28.672-64 64-64l416.384 0L480.384 31.712C480.384 14.176 494.56 0 512 0c17.44 0 31.616 14.208 31.616 31.744L543.616 96 960 96c35.36 0 64 28.64 64 64l0 544C1024 739.328 995.328 768 960 768zM960 224c0-35.328-28.64-64-64-64L544 160l0 30.528-0.416 0 0 335.904 167.776-168.448c12.256-12.32 32.128-12.32 44.384 0 12.256 12.288 12.256 32.256 0 44.576l-219.904 220.736c-0.544 0.64-0.704 1.408-1.312 2.016-0.96 0.96-2.368 0.992-3.392 1.792-3.328 2.688-6.944 4.608-10.848 5.76-1.504 0.384-2.848 0.672-4.384 0.864-9.408 1.28-19.2-1.152-26.432-8.416-0.64-0.64-0.832-1.44-1.408-2.08L268.256 402.56C256 390.24 256 370.272 268.256 357.984c12.256-12.32 32.128-12.32 44.384 0l167.776 168.448L480.416 190.528 480 190.528 480 160 128 160C92.64 160 64 188.64 64 224l0 416c0 35.328 28.64 64 64 64l768 0c35.328 0 64-28.672 64-64L960 224zM96 832l832 0c8.672 0 32 8.544 32 17.248l0 32C960 889.92 936.672 896 928 896L96 896c-8.704 0-32-6.08-32-14.752l0-32C64 840.544 87.296 832 96 832zM160 960l704 0c8.672 0 32 7.552 32 16.256l0 32C896 1016.928 872.672 1024 864 1024L160 1024c-8.672 0-32-7.04-32-15.744l0-32C128 967.552 151.296 960 160 960z"
      fill="currentColor"
    />
  </svg>
);

function getFormatBadgeClass(fmt: string, streamLabel?: boolean): string {
  const f = fmt.toLowerCase();
  if (streamLabel) {
    return styles.formatBadgeStream ?? '';
  }
  if (isImageFormat(f)) {
    return styles.formatBadgeImage ?? '';
  }
  if (isAudioFormat(f)) {
    return styles.formatBadgeAudio ?? '';
  }
  if (isVideoFormat(f) || isStreamFormat(f)) {
    return styles.formatBadgeVideo ?? '';
  }
  return styles.formatBadgeDocument ?? '';
}

function isPlayableInlineFormat(fmt: string): boolean {
  return isAudioFormat(fmt) || isVideoFormat(fmt) || isStreamFormat(fmt);
}

interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  estimateHeight: (item: T, index: number) => number;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  overscan?: number;
  gap?: number;
}

// Virtual list with ResizeObserver-based height measurement
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
  const [measureTick, setMeasureTick] = useState(0);

  const measuredHeightsRef = useRef(new Map<number, number>());
  const itemObserversRef = useRef(
    new Map<number, { el: HTMLDivElement; ro: ResizeObserver }>()
  );

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

  useEffect(() => {
    const roMap = itemObserversRef.current;
    return (): void => {
      roMap.forEach(({ ro }) => ro.disconnect());
      roMap.clear();
    };
  }, []);

  const measureItem = useCallback(
    (el: HTMLDivElement, index: number): void => {
      const measured = el.getBoundingClientRect().height - gap;
      if (!(measured > 0)) {
        return;
      }
      const prev = measuredHeightsRef.current.get(index);
      if (prev !== undefined && Math.abs(prev - measured) < 0.5) {
        return;
      }
      measuredHeightsRef.current.set(index, measured);
      setMeasureTick((t) => t + 1);
    },
    [gap]
  );

  const offsets = useMemo(() => {
    void measureTick;
    const arr = new Array<number>(items.length + 1);
    arr[0] = 0;
    for (let i = 0; i < items.length; i++) {
      const h =
        measuredHeightsRef.current.get(i) ?? estimateHeight(items[i]!, i);
      arr[i + 1] = (arr[i] ?? 0) + h + gap;
    }
    return arr;
  }, [items, estimateHeight, gap, measureTick]);

  const total = Math.max(0, (offsets[items.length] ?? 0) - gap);

  let start = 0;
  while (start < items.length && (offsets[start + 1] ?? 0) <= scrollTop) {
    start++;
  }
  let end = start;
  const bottom = scrollTop + viewportHeight;
  while (end < items.length && (offsets[end + 1] ?? 0) <= bottom) {
    end++;
  }
  start = Math.max(0, start - overscan);
  end = Math.min(items.length, end + overscan);

  const vItem: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    vItem.push(
      <div
        key={getKey(items[i]!, i)}
        ref={(el) => {
          if (!el) {
            return;
          }
          measureItem(el, i);
          // re-measure on height change
          const prev = itemObserversRef.current.get(i);
          if (prev && prev.el !== el) {
            prev.ro.disconnect();
          }
          if (!prev || prev.el !== el) {
            const ro = new ResizeObserver(() => measureItem(el, i));
            ro.observe(el);
            itemObserversRef.current.set(i, { el, ro });
          }
        }}
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
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
        onNavigate((index - 1 + images.length) % images.length);
      } else if (e.key === 'ArrowRight') {
        onNavigate((index + 1) % images.length);
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onNavigate, onClose]);

  if (!current) {
    return null;
  }

  return (
    <div
      className={styles.lightbox}
      role="button"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          onClose();
        }
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
            {t('copyUrl')}
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

const HoverPreview: FC<HoverPreviewProps> = ({ state }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [state?.item.url]);

  if (!state) {
    return null;
  }
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
        <div
          className={styles.hoverPreviewName}
          title={item.tabTitle || item.url}
        >
          {item.tabTitle || getFileName(item.url)}
        </div>
        <div className={styles.hoverPreviewMeta}>
          <span
            className={`${styles.formatBadge} ${getFormatBadgeClass(item.format)}`}
          >
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

interface PopupProps {
  embedded?: boolean;
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
  const { t, locale, density } = useI18n();
  const { settings, saveSettings } = useSettings();
  const {
    isFailed: isVideoThumbFailed,
    getMetadata: getVideoMetadata,
    onVideoLoadedData,
    markFailed: markVideoThumbFailed,
  } = useVideoThumbnails();

  const [showSettings, setShowSettings] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [previewItem, setPreviewItem] = useState<MediaListItem | null>(null);
  const [playingItem, setPlayingItem] = useState<MediaListItem | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [editingUrl, setEditingUrl] = useState('');
  const [editingName, setEditingName] = useState('');
  const [customNames, setCustomNames] = useState<Map<string, string>>(
    new Map()
  );
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const [showMergeConfirm, setShowMergeConfirm] = useState(false);
  const [mergeConfirmCount, setMergeConfirmCount] = useState(0);
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
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  }, []);

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
    enabledTabs,
    typeOptions,
    filteredMediaList,
    filteredImageList,
    groupedStreamList,
    flatMediaList,
    mediaCatalog,
  } = filters;

  const tabIdRef = useRef(currentTabId);
  tabIdRef.current = currentTabId;
  const mediaByKeyRef = useRef(mediaByKey);
  mediaByKeyRef.current = mediaByKey;
  const patchManyRef = useRef(patchMany);
  patchManyRef.current = patchMany;
  const removeKeysRef = useRef(removeKeys);
  removeKeysRef.current = removeKeys;

  // Batched metadata fetch: chunked, cancellable, skips failed/blob URLs
  useEffect(() => {
    fetchMetadataRef.current = (): void => {
      const tabId = tabIdRef.current;
      if (tabId === undefined) {
        return;
      }
      const requests: MetadataBatchItem[] = [];
      for (const item of mediaByKeyRef.current.values()) {
        const key = getMediaKey(item);
        if (failedMetadataKeysRef.current.has(key)) {
          continue;
        }
        if (item.url.startsWith('blob:') || item.url.startsWith('data:')) {
          continue;
        }
        if (item.url.includes('blob.chromium.org')) {
          continue;
        }
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
        if (!needMediaInfo && !needSize) {
          continue;
        }
        requests.push({
          key,
          url: item.url,
          format: item.format,
          requestHeaders: item.requestHeaders,
          needMediaInfo,
          needSize,
        });
      }
      if (!requests.length) {
        return;
      }
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
            if (tabIdRef.current !== tabId) {
              return;
            }
            if (!resp?.ok || !Array.isArray(resp.items)) {
              continue;
            }
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
              if (result.width) {
                patch.width = result.width;
              }
              if (result.height) {
                patch.height = result.height;
              }
              if (result.duration) {
                patch.duration = result.duration;
              }
              if (typeof result.size === 'number') {
                patch.size = result.size;
              }
              if (Object.keys(patch).length) {
                patches.set(result.key, patch);
              }
            }
          }
          if (removedKeys.size) {
            removeKeysRef.current(removedKeys);
          }
          patchManyRef.current(patches);
          const byKey = mediaByKeyRef.current;
          for (const [key, patch] of patches) {
            const item = byKey.get(key);
            if (!item) {
              continue;
            }
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
          // cancelled or network error
        }
      })();
    };
  }, []);

  const toggleSelectItem = useCallback((key: string): void => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const itemKeysOfGroup = useCallback((group: StreamGroup): string[] => {
    const keys: string[] = [];
    const push = (i?: MediaListItem): void => {
      if (i) {
        keys.push(getMediaKey(i));
      }
    };
    push(group.master);
    for (const v of group.variants) {
      push(v);
    }
    for (const a of group.audioItems) {
      push(a);
    }
    return keys;
  }, []);

  const toggleSelectGroup = useCallback(
    (group: StreamGroup): void => {
      const keys = itemKeysOfGroup(group);
      setSelectedUrls((prev) => {
        const next = new Set(prev);
        const allSelected = keys.every((k) => next.has(k));
        for (const k of keys) {
          if (allSelected) {
            next.delete(k);
          } else {
            next.add(k);
          }
        }
        return next;
      });
    },
    [itemKeysOfGroup]
  );

  const visibleItemKeys = useMemo(() => {
    const keys: string[] = [];
    if (activeTab === 'all') {
      for (const entry of flatMediaList) {
        if (entry.kind === 'group') {
          keys.push(...itemKeysOfGroup(entry.group));
        } else {
          keys.push(getMediaKey(entry.item));
        }
      }
    } else if (activeTab === 'stream') {
      for (const group of groupedStreamList) {
        keys.push(...itemKeysOfGroup(group));
      }
    } else if (activeTab === 'image') {
      for (const item of filteredImageList) {
        keys.push(getMediaKey(item));
      }
    } else {
      for (const item of filteredMediaList) {
        keys.push(getMediaKey(item));
      }
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
  const someVisibleSelected =
    visibleItemKeys.length > 0 &&
    !allVisibleSelected &&
    visibleItemKeys.some((k) => selectedUrls.has(k));

  const toggleSelectAll = useCallback((): void => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const k of visibleItemKeys) {
          next.delete(k);
        }
      } else {
        for (const k of visibleItemKeys) {
          next.add(k);
        }
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
    if (!selectedItems.length) {
      return;
    }
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

  const handleDownloadBatchRenamed = useCallback((): void => {
    const selectedItems = mediaList.filter((i) =>
      selectedUrls.has(getMediaKey(i))
    );
    if (!selectedItems.length) {
      return;
    }
    showToast(t('downloadBatchRenamedStarted') || '已开始重命名下载');
    void actions
      .downloadBatchRenamed(selectedItems, tabIdRef.current)
      .catch(() => {});
  }, [mediaList, selectedUrls, showToast, t, actions]);

  const handleMergeDownload = useCallback((): void => {
    const audioItems = mediaList.filter(
      (i) =>
        selectedUrls.has(getMediaKey(i)) && isMergeableAudioFormat(i.format)
    );
    if (!audioItems.length) {
      showToast(t('mergeDownloadNoAudio'));
      return;
    }
    if (audioItems.length < 2) {
      showToast(t('mergeDownloadNeedTwo'));
      return;
    }
    setMergeConfirmCount(audioItems.length);
    setShowMergeConfirm(true);
  }, [mediaList, selectedUrls, showToast, t]);

  const confirmMergeDownload = useCallback((): void => {
    setShowMergeConfirm(false);
    const audioItems = mediaList.filter(
      (i) =>
        selectedUrls.has(getMediaKey(i)) && isMergeableAudioFormat(i.format)
    );
    if (audioItems.length < 2) {
      return;
    }
    void actions.mergeAndDownload(audioItems, tabIdRef.current).catch(() => {});
  }, [mediaList, selectedUrls, actions]);

  const handleCopyUrl = useCallback(
    async (url: string): Promise<void> => {
      const ok = await actions.copyUrl(url);
      if (ok) {
        showToast(t('copyTips'));
      }
    },
    [actions, showToast, t]
  );

  const getDisplayName = useCallback(
    (item: MediaListItem): string =>
      customNames.get(item.url) ||
      (item.tabTitle && item.tabTitle.trim() ? item.tabTitle : '') ||
      getFileName(item.url) ||
      'download',
    [customNames]
  );

  const startRename = useCallback(
    (item: MediaListItem): void => {
      setEditingUrl(item.url);
      setEditingName(
        customNames.get(item.url) ||
          (item.tabTitle && item.tabTitle.trim() ? item.tabTitle : '') ||
          getFileName(item.url) ||
          ''
      );
    },
    [customNames]
  );

  const confirmRename = useCallback((): void => {
    if (!editingUrl) {
      return;
    }
    const name = editingName.trim();
    setCustomNames((prev) => {
      const next = new Map(prev);
      if (name) {
        next.set(editingUrl, name);
      } else {
        next.delete(editingUrl);
      }
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
      if (e.key === 'Enter') {
        confirmRename();
      } else if (e.key === 'Escape') {
        cancelRename();
      }
    },
    [confirmRename, cancelRename]
  );

  const toggleGroup = useCallback(
    (id: string): void => {
      if (expandedGroups.has(id)) {
        // 折叠分组：暂停归零该分组内正在播放/预览的媒体
        const group = flatMediaList.find(
          (e): e is Extract<StreamFlatItem, { kind: 'group' }> =>
            e.kind === 'group' && e.group.id === id
        )?.group;
        if (group) {
          const keys = itemKeysOfGroup(group);
          const inGroup = (item: MediaListItem | null): boolean =>
            item !== null && keys.includes(getMediaKey(item));
          setPlayingItem((prev) => (inGroup(prev) ? null : prev));
          setPreviewItem((prev) => (inGroup(prev) ? null : prev));
          setHoverPreview((prev) => (prev && inGroup(prev.item) ? null : prev));
        }
      }
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [expandedGroups, flatMediaList, itemKeysOfGroup]
  );

  const estimateFlatHeight = useCallback(
    (entry: StreamFlatItem): number => {
      if (entry.kind === 'group') {
        const group = entry.group;
        const base = density === 'comfortable' ? 60 : 52;
        if (!expandedGroups.has(group.id)) {
          return base;
        }
        const rowH = density === 'comfortable' ? 38 : 34;
        const masterRows =
          group.master && /^https?:\/\//i.test(group.master.url || '') ? 1 : 0;
        return (
          base +
          masterRows * rowH +
          group.variants.length * rowH +
          group.audioItems.length * rowH +
          8
        );
      }
      return density === 'comfortable' ? 98 : 82;
    },
    [expandedGroups, density]
  );

  const estimateItemHeight = useCallback(
    (): number => (density === 'comfortable' ? 98 : 82),
    [density]
  );

  const imageColumns = useMemo(() => {
    const cols: MediaListItem[][] = [[], []];
    filteredImageList.forEach((item, i) => cols[i % 2]!.push(item));
    return cols;
  }, [filteredImageList]);

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
      if (hoverEnterTimerRef.current) {
        clearTimeout(hoverEnterTimerRef.current);
      }
      if (hoverLeaveTimerRef.current) {
        clearTimeout(hoverLeaveTimerRef.current);
      }
    };
    return cleanup;
  }, []);

  const renderItemCard = useCallback(
    (item: MediaListItem): ReactNode => {
      const key = getMediaKey(item);
      const selected = selectedUrls.has(key);
      const isLive =
        item.isLiveStream && (item.format === 'flv' || item.format === 'ts');
      const isRecording = actions.isLiveRecording(item);
      const isEditing = editingUrl === item.url;
      const displayName = getDisplayName(item);
      const fmt = item.format.toLowerCase();
      const hasThumbnail = Boolean(item.coverUrl) || isImageFormat(fmt);
      const canVideoThumb = isVideoFormat(fmt) && !isStreamFormat(fmt);
      const showVideoThumb =
        canVideoThumb && !hasThumbnail && !isVideoThumbFailed(item.url);
      const probedMeta = getVideoMetadata(item.url);
      const effectiveDuration =
        item.duration && item.duration > 0
          ? item.duration
          : probedMeta?.duration;
      const effectiveWidth =
        item.width && item.width > 0 ? item.width : probedMeta?.width;
      const effectiveHeight =
        item.height && item.height > 0 ? item.height : probedMeta?.height;
      const showDuration = Boolean(effectiveDuration && effectiveDuration > 0);

      const thumbnailFallbackType = isAudioFormat(fmt)
        ? 'audio'
        : isVideoFormat(fmt) || isStreamFormat(fmt)
          ? 'video'
          : 'file';

      let hostname = '';
      try {
        hostname = new URL(item.url).hostname;
      } catch {
        hostname = '';
      }

      return (
        <div
          className={`${styles.item} ${selected ? styles.itemSelected : ''}`}
        >
          <label className={styles.itemCheckbox}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => toggleSelectItem(key)}
              onClick={(e) => e.stopPropagation()}
            />
          </label>
          <div
            className={styles.thumbnailWrap}
            onMouseEnter={(e) => handleCardHover(e, item)}
            onMouseLeave={handleCardLeave}
          >
            {hasThumbnail ? (
              <img
                src={item.coverUrl || item.url}
                alt=""
                className={styles.thumbnailImg}
                loading="lazy"
              />
            ) : showVideoThumb ? (
              <video
                src={item.url}
                className={styles.thumbnailImg}
                preload="metadata"
                muted
                playsInline
                onLoadedData={(e) => onVideoLoadedData(e, item.url)}
                onError={() => markVideoThumbFailed(item.url)}
              />
            ) : (
              <div
                className={`${styles.thumbnailFallback} ${
                  thumbnailFallbackType === 'audio'
                    ? styles.thumbnailAudio
                    : thumbnailFallbackType === 'video'
                      ? styles.thumbnailVideo
                      : styles.thumbnailFile
                }`}
              >
                {thumbnailFallbackType === 'audio' ? (
                  <AudioIcon />
                ) : thumbnailFallbackType === 'video' ? (
                  <VideoIcon />
                ) : (
                  <FileIcon />
                )}
              </div>
            )}
            {showDuration && (
              <span className={styles.thumbnailDuration}>
                {formatDuration(effectiveDuration)}
              </span>
            )}
          </div>

          <div className={styles.itemMain}>
            <div className={styles.itemBody}>
              <div className={styles.itemTitleRow}>
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
                    className={styles.itemName}
                    title={item.tabTitle || item.url}
                    role="button"
                    tabIndex={0}
                    onDoubleClick={() => startRename(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        startRename(item);
                      }
                    }}
                  >
                    {displayName}
                  </span>
                )}
                <span className={styles.itemTime}>
                  {getRelativeTime(item.detectedAt, t)}
                </span>
              </div>
              <div className={styles.itemMeta}>
                <span
                  className={`${styles.formatBadge} ${getFormatBadgeClass(fmt)}`}
                >
                  {getFormatLabel(item.format)}
                </span>
                {formatItemSize(item) && (
                  <span className={styles.sizeBadge}>
                    {formatItemSize(item)}
                  </span>
                )}
                {showDuration && (
                  <span className={styles.metaTag}>
                    {formatDuration(effectiveDuration)}
                  </span>
                )}
                {getResolutionLabel(effectiveWidth, effectiveHeight) && (
                  <span className={styles.metaTag}>
                    {getResolutionLabel(effectiveWidth, effectiveHeight)}
                  </span>
                )}
                {hostname && (
                  <span className={styles.metaTag} title={item.url}>
                    {hostname}
                  </span>
                )}
                <span
                  className={styles.itemUrl}
                  title={item.url}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCopyUrl(item.url);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleCopyUrl(item.url);
                    }
                  }}
                >
                  {item.url}
                </span>
              </div>
            </div>

            <div className={styles.itemActions}>
              <button
                type="button"
                className={styles.actionBtnCopy}
                onClick={() => void handleCopyUrl(item.url)}
                data-tooltip={t('copyUrl')}
              >
                <CopyIconSvg />
              </button>
              <button
                type="button"
                className={styles.actionBtnPrimary}
                onClick={() => {
                  if (isImageFormat(fmt)) {
                    const index = filteredImageList.indexOf(item);
                    if (index >= 0) {
                      setLightboxIndex(index);
                    }
                  } else if (isPlayableInlineFormat(fmt)) {
                    setPlayingItem((prev) =>
                      prev?.url === item.url ? null : item
                    );
                  } else {
                    setPreviewItem(item);
                  }
                }}
                data-tooltip={
                  isImageFormat(fmt)
                    ? t('preview')
                    : playingItem?.url === item.url
                      ? t('pause')
                      : t('play')
                }
              >
                {isImageFormat(fmt) ? (
                  <PreviewIconSvg />
                ) : playingItem?.url === item.url ? (
                  <PauseIconSvg />
                ) : (
                  <PlayIconSvg />
                )}
              </button>
              {isLive ? (
                <button
                  type="button"
                  className={`${styles.actionBtnSuccess} ${isRecording ? styles.actionBtnRecording : ''}`}
                  onClick={() => actions.toggleLiveRecording(item)}
                  data-tooltip={
                    isRecording ? t('stopRecording') : t('startRecording')
                  }
                >
                  {isRecording ? '⏹' : '⏺'}
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.actionBtnSuccess}
                  onClick={() => void handleDownloadItem(item)}
                  data-tooltip={t('download')}
                >
                  <DownloadIconSvg />
                </button>
              )}
            </div>
          </div>
          {playingItem?.url === item.url && (
            <div className={styles.inlinePlayer}>
              <InlineMediaPlayer
                item={playingItem}
                currentTabId={currentTabId}
              />
            </div>
          )}
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
      filteredImageList,
      setLightboxIndex,
      playingItem,
      setPlayingItem,
      currentTabId,
      isVideoThumbFailed,
      getVideoMetadata,
      onVideoLoadedData,
      markVideoThumbFailed,
    ]
  );

  const renderGroupCard = useCallback(
    (group: StreamGroup): ReactNode => {
      const expanded = expandedGroups.has(group.id);
      const keys = itemKeysOfGroup(group);
      const allSelected =
        keys.length > 0 && keys.every((k) => selectedUrls.has(k));
      const someSelected =
        keys.length > 0 &&
        !allSelected &&
        keys.some((k) => selectedUrls.has(k));
      const master = group.master;
      const syntheticMasterUrl = Boolean(
        master && !/^https?:\/\//i.test(master.url || '')
      );
      const realVariant = group.variants.find((v) =>
        /^https?:\/\//i.test(v.url || '')
      );
      const masterSource =
        syntheticMasterUrl && realVariant
          ? {
              ...master,
              url: realVariant.url,
              format: realVariant.format,
              size: realVariant.size,
            }
          : master;
      const hasChildren =
        group.variants.length > 0 || group.audioItems.length > 0;
      const totalSize = keys.reduce((sum, k) => {
        const item = mediaByKey.get(k);
        return sum + (item?.size || 0);
      }, 0);

      const masterFmt = master?.format.toLowerCase() ?? '';
      const groupIconType = master
        ? isAudioFormat(masterFmt)
          ? 'audio'
          : isVideoFormat(masterFmt) || isStreamFormat(masterFmt)
            ? 'video'
            : 'file'
        : 'video';
      const hasGroupThumbnail =
        Boolean(master?.coverUrl) || isImageFormat(masterFmt);
      const canGroupVideoThumb =
        master && isVideoFormat(masterFmt) && !isStreamFormat(masterFmt);
      const showGroupVideoThumb =
        canGroupVideoThumb &&
        !hasGroupThumbnail &&
        !isVideoThumbFailed(masterSource?.url ?? '');

      const renderRow = (item: MediaListItem): ReactNode => {
        const key = getMediaKey(item);
        const isSelected = selectedUrls.has(key);
        const probedMeta = getVideoMetadata(item.url);
        const effectiveWidth =
          item.width && item.width > 0 ? item.width : probedMeta?.width;
        const effectiveHeight =
          item.height && item.height > 0 ? item.height : probedMeta?.height;
        const res = getResolutionLabel(effectiveWidth, effectiveHeight);
        const effectiveDuration =
          item.duration && item.duration > 0
            ? item.duration
            : probedMeta?.duration;
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
            <span
              className={`${styles.formatBadge} ${getFormatBadgeClass(item.format)}`}
            >
              {getFormatLabel(item.format)}
            </span>
            {res && <span className={styles.metaTag}>{res}</span>}
            {effectiveDuration && effectiveDuration > 0 && (
              <span className={styles.metaTag}>
                {formatDuration(effectiveDuration)}
              </span>
            )}
            {item.variantBandwidth !== undefined && (
              <span className={styles.metaTag}>
                {Math.round(item.variantBandwidth / 1024)} kbps
              </span>
            )}
            <span
              className={styles.variantName}
              title={item.tabTitle || item.url}
            >
              {getDisplayName(item)}
            </span>
            <span className={styles.itemSize}>{formatItemSize(item)}</span>
            <div className={styles.variantActions}>
              <button
                type="button"
                className={styles.actionBtnCopy}
                onClick={() => void handleCopyUrl(item.url)}
                data-tooltip={t('copyUrl')}
              >
                <CopyIconSvg />
              </button>
              <button
                type="button"
                className={styles.actionBtnPrimary}
                onClick={() => {
                  if (isPlayableInlineFormat(item.format.toLowerCase())) {
                    setPlayingItem((prev) =>
                      prev?.url === item.url ? null : item
                    );
                  } else {
                    setPreviewItem(item);
                  }
                }}
                data-tooltip={
                  playingItem?.url === item.url ? t('pause') : t('play')
                }
              >
                {playingItem?.url === item.url ? (
                  <PauseIconSvg />
                ) : (
                  <PlayIconSvg />
                )}
              </button>
              <button
                type="button"
                className={styles.actionBtnSuccess}
                onClick={() => void handleDownloadItem(item)}
                data-tooltip={t('download')}
              >
                <DownloadIconSvg />
              </button>
            </div>
            {playingItem?.url === item.url && (
              <div className={styles.inlinePlayer}>
                <InlineMediaPlayer
                  item={playingItem}
                  currentTabId={currentTabId}
                />
              </div>
            )}
          </div>
        );
      };

      return (
        <div className={styles.groupCard}>
          <div className={styles.groupHeader}>
            <button
              type="button"
              className={`${styles.groupSelect} ${
                allSelected || someSelected ? styles.groupSelectActive : ''
              }`}
              onClick={() => toggleSelectGroup(group)}
              title={allSelected ? t('deselectAll') : t('selectAll')}
            >
              <SelectAllIconSvg
                state={allSelected ? 'all' : someSelected ? 'some' : 'none'}
                size={22}
              />
            </button>
            <div
              className={styles.thumbnailWrap}
              onMouseEnter={(e) => {
                if (masterSource) {
                  handleCardHover(e, masterSource);
                }
              }}
              onMouseLeave={handleCardLeave}
            >
              {hasGroupThumbnail ? (
                <img
                  src={master?.coverUrl || masterSource?.url}
                  alt=""
                  className={styles.thumbnailImg}
                  loading="lazy"
                />
              ) : showGroupVideoThumb && masterSource ? (
                <video
                  src={masterSource.url}
                  className={styles.thumbnailImg}
                  preload="metadata"
                  muted
                  playsInline
                  onLoadedData={(e) => onVideoLoadedData(e, masterSource.url)}
                  onError={() => markVideoThumbFailed(masterSource.url)}
                />
              ) : (
                <div
                  className={`${styles.thumbnailFallback} ${
                    groupIconType === 'audio'
                      ? styles.thumbnailAudio
                      : groupIconType === 'video'
                        ? styles.thumbnailVideo
                        : styles.thumbnailFile
                  }`}
                >
                  {groupIconType === 'audio' ? (
                    <AudioIcon />
                  ) : groupIconType === 'video' ? (
                    <VideoIcon />
                  ) : (
                    <FileIcon />
                  )}
                </div>
              )}
            </div>
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
                title={master?.tabTitle || master?.url}
                onDoubleClick={() => {
                  if (master) {
                    startRename(master);
                  }
                }}
              >
                {master
                  ? getDisplayName(master)
                  : group.variants[0]?.groupLabel || group.id}
              </span>
            )}
            <span className={styles.itemSize}>{formatFileSize(totalSize)}</span>
            {masterSource && !hasChildren && (
              <div className={styles.groupHeaderActions}>
                <button
                  type="button"
                  className={styles.actionBtnPrimary}
                  onClick={() => {
                    if (
                      isPlayableInlineFormat(masterSource.format.toLowerCase())
                    ) {
                      setPlayingItem((prev) =>
                        prev?.url === masterSource.url ? null : masterSource
                      );
                    } else {
                      setPreviewItem(masterSource);
                    }
                  }}
                  data-tooltip={
                    playingItem?.url === masterSource.url
                      ? t('pause')
                      : t('play')
                  }
                >
                  {playingItem?.url === masterSource.url ? (
                    <PauseIconSvg />
                  ) : (
                    <PlayIconSvg />
                  )}
                </button>
                <button
                  type="button"
                  className={styles.actionBtnSuccess}
                  onClick={() => void handleDownloadItem(masterSource)}
                  data-tooltip={t('download')}
                >
                  <DownloadIconSvg />
                </button>
              </div>
            )}
            {hasChildren && (
              <button
                type="button"
                className={styles.expandBtn}
                onClick={() => toggleGroup(group.id)}
              >
                {expanded ? <ExpandMinusIconSvg /> : <ExpandPlusIconSvg />}
              </button>
            )}
          </div>
          {masterSource &&
            !hasChildren &&
            playingItem?.url === masterSource.url && (
              <div className={styles.inlinePlayer}>
                <InlineMediaPlayer
                  item={playingItem}
                  currentTabId={currentTabId}
                />
              </div>
            )}
          {expanded && hasChildren && (
            <div className={styles.groupBody}>
              {master && !syntheticMasterUrl && renderRow(master)}
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
      handleCopyUrl,
      editingUrl,
      editingName,
      startRename,
      confirmRename,
      onRenameKeyDown,
      setEditingName,
      t,
      handleCardHover,
      handleCardLeave,
      playingItem,
      setPlayingItem,
      currentTabId,
      setPreviewItem,
      isVideoThumbFailed,
      getVideoMetadata,
      onVideoLoadedData,
      markVideoThumbFailed,
    ]
  );

  const renderFlatItem = useCallback(
    (entry: StreamFlatItem): ReactNode =>
      entry.kind === 'group'
        ? renderGroupCard(entry.group)
        : renderItemCard(entry.item),
    [renderGroupCard, renderItemCard]
  );

  const tabDefs = useMemo(
    () =>
      TAB_DEFS.filter((tab) => enabledTabs.includes(tab.key)).map((tab) => {
        return { ...tab, label: t(tab.label) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, locale, enabledTabs]
  );

  useEffect(() => {
    setPreviewItem(null);
    setPlayingItem(null);
    setHoverPreview(null);
    setLightboxIndex(-1);
    setExpandedGroups(new Set());
  }, [activeTab]);

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

  const visibleTabs = useMemo(() => tabDefs, [tabDefs]);

  const navigateLightbox = useCallback((index: number): void => {
    setLightboxIndex(index);
  }, []);

  let listBody: ReactNode;
  if (activeTab === 'image') {
    listBody = (
      <div className={styles.masonry}>
        {imageColumns.map((column, colIndex) => (
          <div
            key={colIndex === 0 ? 'col-left' : 'col-right'}
            className={styles.masonryCol}
          >
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
      <TooltipProvider>
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
                    <h1 className={styles.title}>{t('title')}</h1>
                    <p className={styles.subtitle}>{t('subtitle')}</p>
                  </div>
                </div>
                <p className={styles.greeting} title={currentTabTitle}>
                  {t('siteName')} {currentTabTitle}
                </p>
                {isMobileBrowser && !hideMobileTip && (
                  <div className={styles.mobileBanner}>
                    <span>{mobileCapabilityTip}</span>
                    <button
                      type="button"
                      onClick={() => setHideMobileTip(true)}
                    >
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
              <div className={styles.actionToolbar}>
                <div className={styles.actionToolbarLeft}>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${
                      allVisibleSelected || someVisibleSelected
                        ? styles.selectAllActive
                        : ''
                    }`}
                    onClick={toggleSelectAll}
                    disabled={!visibleItemKeys.length}
                    data-tooltip={
                      allVisibleSelected ? t('deselectAll') : t('selectAll')
                    }
                  >
                    <SelectAllIconSvg
                      state={
                        allVisibleSelected
                          ? 'all'
                          : someVisibleSelected
                            ? 'some'
                            : 'none'
                      }
                    />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => void handleDownloadBatch()}
                    disabled={!selectedCount || actions.downloading}
                    data-tooltip={t('downloadSelected')}
                  >
                    <DownloadIconSvg />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => void handleDownloadBatchRenamed()}
                    disabled={!selectedCount || actions.downloading}
                    data-tooltip={t('downloadBatchRenamed')}
                  >
                    <RenameDownloadIconSvg />
                  </button>
                  {activeTab === 'audio' && (
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => void handleMergeDownload()}
                      disabled={
                        !selectedCount || actions.downloading || actions.merging
                      }
                      data-tooltip={t('mergeDownload')}
                    >
                      <MergeIconSvg />
                    </button>
                  )}
                  <span className={styles.toolbarDivider} />
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() =>
                      setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')
                    }
                    data-tooltip={t('sort')}
                  >
                    <SortIconSvg desc={sortOrder === 'desc'} />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => void clearList()}
                    data-tooltip={t('clear')}
                  >
                    <TrashIconSvg />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => void refreshPage()}
                    data-tooltip={t('refresh')}
                  >
                    <RefreshIconSvg />
                  </button>
                </div>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${
                    showFilters ? styles.filterToolbarBtnActive : ''
                  }`}
                  onClick={() => setShowFilters(!showFilters)}
                  data-tooltip={t('filter')}
                >
                  <FilterIconSvg active={showFilters} />
                </button>
              </div>

              <div
                className={`${styles.searchFilter} ${
                  showFilters ? styles.searchFilterExpanded : ''
                }`}
              >
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
                    data-tooltip={t('searchRegexTitle')}
                  >
                    .*
                  </button>
                  {searchQuery && (
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={clearSearch}
                      data-tooltip={t('searchClear')}
                    >
                      ✕
                    </button>
                  )}
                </div>
                {!regexValid && searchError && (
                  <p className={styles.searchError}>{searchError}</p>
                )}
                {showFilters && (
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
                  </div>
                )}
              </div>
            </div>

            {listBody}

            <footer className={styles.footer}>
              <div className={styles.footerLeft}>
                <button
                  type="button"
                  className={styles.settingsBtn}
                  onClick={() => setShowSettings(true)}
                  data-tooltip={t('settings')}
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
              <div className={styles.footerRight}>
                <span className={styles.listSummary}>
                  {t('found')} {mediaCatalog.all.length} {t('item')}
                </span>
                {selectedCount > 0 && (
                  <span className={styles.listSummarySelected}>
                    {' '}
                    · {selectedCount} {t('selected')}
                  </span>
                )}
              </div>
            </footer>
          </>
        )}

        {showMergeConfirm && (
          <div
            className={styles.overlay}
            onClick={() => setShowMergeConfirm(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setShowMergeConfirm(false);
              }
            }}
            role="presentation"
          >
            <div
              className={styles.confirmDialog}
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setShowMergeConfirm(false);
                }
              }}
            >
              <div className={styles.confirmTitle}>
                {t('mergeDownloadConfirm')}
              </div>
              <div className={styles.confirmDesc}>
                {t('mergeDownloadConfirmDesc', [String(mergeConfirmCount)])}
              </div>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={styles.confirmCancelBtn}
                  onClick={() => setShowMergeConfirm(false)}
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  className={styles.confirmOkBtn}
                  onClick={() => void confirmMergeDownload()}
                >
                  {t('mergeDownloadOk')}
                </button>
              </div>
            </div>
          </div>
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
      </TooltipProvider>
    </div>
  );
}
