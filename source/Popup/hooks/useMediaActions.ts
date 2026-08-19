import { useCallback, useEffect, useRef, useState } from 'react';
import browser from 'webextension-polyfill';
import { t } from '../../utils/i18n';
import {
  isAudioFormat,
  isImageFormat,
  // isStreamFormat,
  // isVideoDownloadFormat,
  getDownloadFilename,
  getBatchDownloadFilename,
  getMediaKey,
} from '../utils/formats';
import {
  isMergeableAudioFormat,
  mergeAudioItemsToWav,
  type MergeableAudioItem,
} from '../../utils/audio-merge';
import type { MediaListItem } from './useMediaList';

export interface DownloadOptions {
  item: MediaListItem;
  tabId?: number;
  filename?: string;
}

function decodeProxyImage(data: string): BlobPart {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes as unknown as BlobPart;
}

type ResourceKind = 'image' | 'audio' | 'document';

/**
 * React media actions (mirrors the source-side App.vue download/record/copy logic):
 * - Live streams (flv/ts without size) are recorded in real time on the popup side instead of downloaded
 * - Batch downloads can create subdirectories named after the current tab title
 * - Protected-resource downloads: referrer fallback + content-type checks to avoid saving hotlink-protection errors
 */
export function useMediaActions(onToast?: (message: string) => void): {
  downloadItem: (opts: DownloadOptions) => Promise<void>;
  copyUrl: (url: string) => Promise<boolean>;
  downloadBatch: (
    items: MediaListItem[],
    subDir?: string,
    tabId?: number,
    customNames?: Map<string, string>
  ) => Promise<void>;
  mergeAndDownload: (items: MediaListItem[], tabId?: number) => Promise<void>;
  downloading: boolean;
  merging: boolean;
  toggleLiveRecording: (item: MediaListItem) => void;
  isLiveRecording: (item: MediaListItem) => boolean;
  openShortcuts: () => Promise<void>;
} {
  const [downloading, setDownloading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [, setRecordingKeys] = useState<Set<string>>(new Set());
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const flvRecordingRef = useRef(
    new Map<
      string,
      { controller: AbortController; chunks: Uint8Array[]; startTime: number }
    >()
  );

  const showToast = useCallback((msg: string): void => {
    onToastRef.current?.(msg);
  }, []);

  // Terminate all in-flight recordings when the component unmounts (source-side legacy: no stop entry after clearing the list / switching views)
  useEffect(() => {
    const recordings = flvRecordingRef.current;
    return (): void => {
      recordings.forEach((r) => r.controller.abort());
      recordings.clear();
    };
  }, []);

  /** Protected resources (images/audio/documents) are fetched via the background proxy fetch, then downloaded by the browser */
  const downloadProtectedResource = useCallback(
    async (
      url: string,
      format: string,
      requestHeaders: Record<string, string> | undefined,
      filename: string,
      tabId: number | undefined,
      resourceKind: ResourceKind = 'document'
    ): Promise<void> => {
      // Referrer fallback: prefer request headers, then the current tab URL (source-side behavior)
      const tabUrl =
        tabId === undefined
          ? ''
          : (await browser.tabs.get(tabId).catch(() => undefined))?.url || '';
      const headers =
        requestHeaders && typeof requestHeaders === 'object'
          ? requestHeaders
          : undefined;
      const referrer = headers?.Referer || headers?.referer || tabUrl;
      // 30s timeout fallback: gives the user clear feedback when hotlink-protected sites hang occasionally (source-side had no timeout)
      const FETCH_TIMEOUT_MS = 30_000;
      const response = (await Promise.race([
        browser.runtime.sendMessage({
          type: 'PROXY_FETCH',
          url,
          options: { authHeaders: headers, referrer, proxyHeader: true },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('PROXY_FETCH timeout')),
            FETCH_TIMEOUT_MS
          )
        ),
      ])) as
        | {
            ok?: boolean;
            status?: number;
            data?: string;
            headers?: Record<string, string>;
          }
        | undefined;
      if (!response?.ok || !response.data) {
        throw new Error(`HTTP ${response?.status || 0}`);
      }
      const contentType =
        response.headers?.['content-type'] ||
        response.headers?.['Content-Type'] ||
        '';
      // Hotlink-protected pages may return 200; never save HTML error pages / type-mismatched responses
      const normalizedType = contentType.toLowerCase();
      const typeMatches =
        resourceKind === 'image'
          ? normalizedType.startsWith('image/')
          : resourceKind === 'audio'
            ? normalizedType.startsWith('audio/') ||
              normalizedType === 'application/ogg'
            : true;
      if (normalizedType === 'text/html' || !typeMatches) {
        throw new Error('unexpected protected resource response');
      }
      const f = format.toLowerCase();
      const blobType =
        contentType ||
        (resourceKind === 'image'
          ? `image/${f === 'jpg' ? 'jpeg' : f}`
          : resourceKind === 'audio'
            ? `audio/${f}`
            : 'application/octet-stream');
      const blob = new Blob([decodeProxyImage(response.data)], {
        type: blobType,
      });
      const blobUrl = URL.createObjectURL(blob);
      try {
        const id = await browser.downloads.download({
          url: blobUrl,
          filename,
          saveAs: false,
        });
        const onChanged = (delta: any): void => {
          if (delta.id !== id) return;
          if (
            delta.state?.current === 'complete' ||
            delta.state?.current === 'interrupted'
          ) {
            browser.downloads.onChanged.removeListener(onChanged);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
          }
        };
        browser.downloads.onChanged.addListener(onChanged);
      } catch {
        URL.revokeObjectURL(blobUrl);
        throw new Error('下载失败');
      }
    },
    []
  );

  /** Live streams (HTTP-FLV/MPEG-TS) recorded on the popup side: click again to stop */
  const toggleLiveRecording = useCallback(
    (item: MediaListItem): void => {
      const { url, format, requestHeaders } = item;
      const key = getMediaKey({ url, format });
      const existing = flvRecordingRef.current.get(key);
      if (existing) {
        existing.controller.abort();
        return;
      }
      const controller = new AbortController();
      const chunks: Uint8Array[] = [];
      const startTime = Date.now();
      flvRecordingRef.current.set(key, { controller, chunks, startTime });
      setRecordingKeys((prev) => new Set(prev).add(key));
      showToast(t('liveRecordingStarted') || '录制中…再次点击停止');
      void (async (): Promise<void> => {
        try {
          const headers: Record<string, string> = { ...requestHeaders };
          const resp = await fetch(url, {
            signal: controller.signal,
            headers,
            mode: 'cors',
          });
          if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
          const reader = resp.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
            // Safety cap: 500MB to avoid memory blow-up
            const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
            if (totalBytes > 500 * 1024 * 1024) {
              showToast(
                t('liveRecordingLimit') || '录制达到 500MB 上限，自动停止'
              );
              break;
            }
          }
        } catch (e: unknown) {
          if ((e as { name?: string })?.name !== 'AbortError') {
            showToast(t('liveRecordingError') || '录制失败');
          }
        } finally {
          const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
          if (totalBytes > 0) {
            const blob = new Blob(chunks as unknown as BlobPart[], {
              type: format === 'flv' ? 'video/x-flv' : 'video/mp2t',
            });
            const blobUrl = URL.createObjectURL(blob);
            const duration = ((Date.now() - startTime) / 1000).toFixed(0);
            const filename = `live-${duration}s-${Date.now().toString(36)}.${format}`;
            browser.downloads
              .download({ url: blobUrl, filename })
              .then(() => {
                showToast(t('downloadComplete') || '下载完成');
                setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
              })
              .catch(() => {
                showToast(t('docDownloadFailed'));
                URL.revokeObjectURL(blobUrl);
              });
          }
          flvRecordingRef.current.delete(key);
          setRecordingKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      })();
    },
    [showToast]
  );

  const isLiveRecording = useCallback(
    (item: MediaListItem): boolean =>
      flvRecordingRef.current.has(
        getMediaKey({ url: item.url, format: item.format })
      ),
    []
  );

  const downloadItem = useCallback(
    async ({ item, tabId, filename }: DownloadOptions): Promise<void> => {
      const { url, format, requestHeaders, captureId, isLiveStream } = item;
      if (format === 'mse') {
        if (!captureId) return;
        await browser.runtime.sendMessage({
          type: 'MSE_DOWNLOAD',
          captureId,
          tabId,
        });
        return;
      }
      // Live streams (HTTP-FLV/MPEG-TS without size): recorded on the popup side, cannot open a download page
      if (isLiveStream && (format === 'flv' || format === 'ts')) {
        toggleLiveRecording(item);
        return;
      }
      const finalName = filename ?? getDownloadFilename(url, format);
      // Opening the external downloader (OPEN_DOWNLOAD_PAGE) is not deployed yet; commented out for now
      // if (isStreamFormat(format) || isVideoDownloadFormat(format)) {
      //   await browser.runtime.sendMessage({
      //     type: 'OPEN_DOWNLOAD_PAGE',
      //     url,
      //     format,
      //     filename: finalName,
      //     requestHeaders,
      //   });
      // } else
      if (isImageFormat(format)) {
        await downloadProtectedResource(
          url,
          format,
          requestHeaders,
          finalName,
          tabId,
          'image'
        );
      } else if (isAudioFormat(format) || item.groupRole === 'audio') {
        await downloadProtectedResource(
          url,
          format,
          requestHeaders,
          finalName,
          tabId,
          'audio'
        );
      } else {
        await downloadProtectedResource(
          url,
          format,
          requestHeaders,
          finalName,
          tabId,
          'document'
        );
      }
    },
    [downloadProtectedResource, toggleLiveRecording]
  );

  const copyUrl = useCallback(async (url: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }, []);

  const downloadBatch = useCallback(
    async (
      items: MediaListItem[],
      subDir?: string,
      tabId?: number,
      customNames?: Map<string, string>
    ): Promise<void> => {
      setDownloading(true);
      try {
        const total = items.length;
        for (let i = 0; i < total; i++) {
          const item = items[i];
          if (!item) continue;
          // Live streams: record one by one
          if (
            item.isLiveStream &&
            (item.format === 'flv' || item.format === 'ts')
          ) {
            toggleLiveRecording(item);
            continue;
          }
          const filename = getBatchDownloadFilename(
            item.url,
            item.format,
            subDir,
            customNames?.get(item.url)
          );
          await downloadItem({ item, tabId, filename });
        }
      } finally {
        setDownloading(false);
      }
    },
    [downloadItem, toggleLiveRecording]
  );

  /**
   * Merge selected audio into a single WAV and download it.
   *
   * Ordering: `items` MUST already be in sniff order (the popup keeps mediaList
   * order and filters by selection, which preserves the original detection
   * sequence — e.g. sniff order 1..6, selecting 4/6/1/2 still merges as 1/2/4/6).
   * Non-mergeable items (video/image/unsupported formats) are silently skipped;
   * the caller validates the audio count and toasts the user.
   */
  const mergeAndDownload = useCallback(
    async (items: MediaListItem[], tabId?: number): Promise<void> => {
      const mergeable: MergeableAudioItem[] = items
        .filter((i) => isMergeableAudioFormat(i.format))
        .map((i) => {
          return {
            url: i.url,
            format: i.format,
            requestHeaders: i.requestHeaders,
          };
        });
      if (mergeable.length < 2) {
        showToast(t('mergeDownloadNeedTwo'));
        return;
      }
      setMerging(true);
      try {
        showToast(t('mergeDownloadStarted', String(mergeable.length)));
        const result = await mergeAudioItemsToWav(mergeable, tabId);
        const blobUrl = URL.createObjectURL(result.blob);
        try {
          await browser.downloads.download({
            url: blobUrl,
            filename: `merged-${mergeable.length}tracks-${Date.now().toString(36)}.wav`,
            saveAs: false,
          });
          showToast(t('mergeDownloadComplete', String(mergeable.length)));
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
        } catch {
          URL.revokeObjectURL(blobUrl);
          showToast(t('mergeDownloadFailed', 'download error'));
        }
      } catch (e: unknown) {
        const reason = (e as Error)?.message || 'unknown';
        showToast(t('mergeDownloadFailed', reason));
      } finally {
        setMerging(false);
      }
    },
    [showToast]
  );

  const openShortcuts = useCallback(async (): Promise<void> => {
    if (typeof (browser.commands as any)?.openShortcutSettings === 'function') {
      (browser.commands as any).openShortcutSettings();
      return;
    }
    const isFirefox = navigator.userAgent.includes('Firefox');
    await browser.tabs.create({
      url: isFirefox ? 'about:addons' : 'chrome://extensions/shortcuts',
    });
  }, []);

  return {
    downloadItem,
    copyUrl,
    downloadBatch,
    mergeAndDownload,
    downloading,
    merging,
    toggleLiveRecording,
    isLiveRecording,
    openShortcuts,
  };
}
