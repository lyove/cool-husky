import browser from 'webextension-polyfill';
import { detectFormatFromUrl } from '../../utils/detect';
import {
  extractDomImages,
  extractDomImagesInSubtree,
  type DomImageCandidate,
} from './image-extractor';

{
  // cached capture switches
  let mseCaptureEnabled = false;
  let dataImagesEnabled = false;

  if (!document.querySelector('script[data-m3u8-injected]')) {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('assets/js/injected.bundle.js');
    script.dataset.m3u8Injected = '1';
    (document.head || document.documentElement).appendChild(script);
  }

  browser.runtime
    .sendMessage({ type: 'GET_SETTINGS' })
    .then((s: any) => {
      mseCaptureEnabled = !!s?.enableMseCapture;
      dataImagesEnabled = !!s?.captureDataImages;
      window.postMessage(
        { type: 'COOLHUSKY_MSE_ENABLE', enabled: mseCaptureEnabled },
        '*'
      );
      window.postMessage(
        {
          type: 'COOLHUSKY_DATA_IMAGES_ENABLE',
          enabled: dataImagesEnabled,
          minSizeKB: s?.dataImageMinSizeKB ?? 50,
        },
        '*'
      );
      if (s?.enableDeepSearch) {
        window.postMessage(
          { type: 'COOLHUSKY_DEEP_SEARCH_ENABLE', enabled: true },
          '*'
        );
      }
    })
    .catch(() => {});

  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    if (event.data?.type === 'COOLHUSKY_PING') {
      window.postMessage(
        {
          type: 'COOLHUSKY_PONG',
          version: browser.runtime.getManifest().version,
        },
        '*'
      );
    }
  });

  // forward background messages to page
  browser.runtime.onMessage.addListener((msg: any) => {
    if (msg.type === 'COOLHUSKY_SOURCE_URL' && msg.sourceUrl) {
      window.postMessage(
        { type: 'COOLHUSKY_SOURCE_URL', sourceUrl: msg.sourceUrl },
        '*'
      );
    }
    if (msg.type === 'COOLHUSKY_PROXY_FETCH_RESPONSE') {
      window.postMessage(msg, '*');
    }
    if (msg.type === 'COOLHUSKY_NOTIFY_CLICK') {
      window.postMessage({ type: 'COOLHUSKY_NOTIFY_CLICK', tag: msg.tag }, '*');
    }
    if (msg.type === 'COOLHUSKY_SETTINGS_CHANGED') {
      if (msg.enableDeepSearch) {
        window.postMessage(
          { type: 'COOLHUSKY_DEEP_SEARCH_ENABLE', enabled: true },
          '*'
        );
      }
    }
    if (msg.type === 'COOLHUSKY_RUN_DEEP_SEARCH') {
      window.postMessage({ type: 'COOLHUSKY_DEEP_SEARCH_RUN' }, '*');
    }
    if (msg.type === 'COOLHUSKY_MSE_DOWNLOAD_TRIGGER') {
      const { captureId } = msg as { captureId: string };
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        if (e.data?.type === 'COOLHUSKY_MSE_DOWNLOAD_DATA') {
          handleMseDownload(e.data);
        }
      };
      window.postMessage(
        { type: 'COOLHUSKY_MSE_DOWNLOAD_REQUEST', captureId },
        '*',
        [channel.port2]
      );
    }
    if (msg.type === 'COOLHUSKY_SETTINGS_CHANGED') {
      mseCaptureEnabled = !!msg.enableMseCapture;
      dataImagesEnabled = !!msg.captureDataImages;
      window.postMessage(
        { type: 'COOLHUSKY_MSE_ENABLE', enabled: mseCaptureEnabled },
        '*'
      );
      window.postMessage(
        {
          type: 'COOLHUSKY_DATA_IMAGES_ENABLE',
          enabled: dataImagesEnabled,
          minSizeKB: msg.dataImageMinSizeKB ?? 50,
        },
        '*'
      );
    }
  });

  window.dispatchEvent(new CustomEvent('coolhusky:ready'));

  let currentTabId: number | undefined;
  const coolhuskyFetchControllers = new Map<string, AbortController>();

  // batch segments to reduce IPC
  const mediaBuffer: Array<{ url: string; format: string }> = [];
  let mediaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Douyin track pairing
  const douyinTracks = new Map<
    string,
    Array<{ url: string; role: 'video' | 'audio'; at: number }>
  >();
  // FNV-1a hash to group Douyin video/audio tracks by URL
  const douyinGroupKey = (url: string) => {
    let hash = 2166136261;
    for (let i = 0; i < url.length; i++) {
      hash = Math.imul(hash ^ url.charCodeAt(i), 16777619);
    }
    return `track_${(hash >>> 0).toString(36)}`;
  };
  const isDouyinCdnTrack = (
    value: string
  ): { key: string; role: 'video' | 'audio' } | undefined => {
    if (window.top !== window) {
      return undefined;
    }
    try {
      const parsed = new URL(value);
      if (
        !/\.(douyinvod|douyincdn|amemv|iesdouyin|snssdk|bytecdn|bytego|bytedance|toutiaovod|tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokcdn-in|tiktokv|muscdn|musical|byteoversea)\.(?:com|cn|net|us|eu|in|gg|io|ly)$/i.test(
          parsed.hostname
        )
      ) {
        return undefined;
      }
      const role = /(?:^|[-_/])media-audio(?:[-_/]|$)|\/audio[-_/]/i.test(
        parsed.pathname
      )
        ? 'audio'
        : /(?:^|[-_/])media-video(?:[-_/]|$)|\/video[-_/]/i.test(
              parsed.pathname
            )
          ? 'video'
          : undefined;
      const key =
        parsed.searchParams.get('l') ||
        parsed.searchParams.get('video_id') ||
        parsed.searchParams.get('aweme_id');
      return role && key ? { key, role } : undefined;
    } catch {
      return undefined;
    }
  };
  // Pair Douyin CDN video+audio tracks by query param key, 30s window
  const collectDouyinPlayerTrack = (url: string) => {
    const track = isDouyinCdnTrack(url);
    if (!track) {
      return;
    }
    const now = Date.now();
    const pending = (douyinTracks.get(track.key) || []).filter(
      (item) => now - item.at < 30_000
    );
    const oppositeIndex = pending.findIndex((item) => item.role !== track.role);
    if (oppositeIndex < 0) {
      pending.push({ url, role: track.role, at: now });
      douyinTracks.set(track.key, pending);
      return;
    }
    const opposite = pending.splice(oppositeIndex, 1)[0]!;
    douyinTracks.set(track.key, pending);
    const video = track.role === 'video' ? url : opposite.url;
    const audio = track.role === 'audio' ? url : opposite.url;
    const coverUrl = document.querySelector<HTMLMetaElement>(
      'meta[property="og:image"]'
    )?.content;
    const duration = document.querySelector('video')?.duration;
    browser.runtime
      .sendMessage({
        type: 'PLATFORM_MEDIA_FOUND',
        task: {
          provider: 'douyin',
          key: douyinGroupKey(video),
          referer: location.href,
          priority: 3,
          title:
            document.querySelector<HTMLMetaElement>('meta[property="og:title"]')
              ?.content ||
            document.title ||
            undefined,
          coverUrl: coverUrl || undefined,
          duration:
            Number.isFinite(duration) && duration! > 0 ? duration : undefined,
          candidates: [
            {
              url: video,
              format: detectFormatFromUrl(video),
              role: 'video',
              label: '视频',
            },
            {
              url: audio,
              format: detectFormatFromUrl(audio),
              role: 'audio',
              label: '音频',
            },
          ],
        },
      })
      .catch(() => {});
  };
  let tabIdFetching = false;
  async function ensureTabId(): Promise<number | undefined> {
    if (currentTabId) {
      return currentTabId;
    }
    if (tabIdFetching) {
      // wait for in-flight fetch
      while (tabIdFetching) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return currentTabId;
    }
    tabIdFetching = true;
    try {
      const tab = await browser.runtime.sendMessage({
        type: 'GET_CURRENT_TAB',
      });
      currentTabId = (tab as { id?: number } | undefined)?.id;
    } catch {}
    tabIdFetching = false;
    // flush buffered data once tabId is ready
    if (currentTabId && mediaBuffer.length > 0 && mediaFlushTimer === null) {
      mediaFlushTimer = setTimeout(flushMediaBuffer, 50);
    }
    return currentTabId;
  }
  function flushMediaBuffer() {
    mediaFlushTimer = null;
    if (mediaBuffer.length === 0 || !currentTabId) {
      return;
    }
    const batch = mediaBuffer.splice(0);
    browser.runtime
      .sendMessage({
        type: 'MEDIA_FOUND_BATCH',
        tabId: currentTabId,
        items: batch,
      })
      .catch(() => {});
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) {
      return;
    }

    // re-send settings to avoid races
    if (event.data?.type === 'COOLHUSKY_REQUEST_SETTINGS') {
      browser.runtime
        .sendMessage({ type: 'GET_SETTINGS' })
        .then((s: any) => {
          mseCaptureEnabled = !!s?.enableMseCapture;
          dataImagesEnabled = !!s?.captureDataImages;
          window.postMessage(
            { type: 'COOLHUSKY_MSE_ENABLE', enabled: mseCaptureEnabled },
            '*'
          );
          window.postMessage(
            {
              type: 'COOLHUSKY_DATA_IMAGES_ENABLE',
              enabled: dataImagesEnabled,
              minSizeKB: s?.dataImageMinSizeKB ?? 50,
            },
            '*'
          );
        })
        .catch(() => {});
    }

    if (
      event.data?.type === 'COOLHUSKY_M3U8_DETECTED' &&
      typeof event.data.url === 'string'
    ) {
      collectDouyinPlayerTrack(event.data.url);
      mediaBuffer.push({
        url: event.data.url,
        format: event.data.format || 'm3u8',
      });
      if (!currentTabId && !tabIdFetching) {
        ensureTabId();
      }
      if (mediaFlushTimer === null) {
        mediaFlushTimer = setTimeout(flushMediaBuffer, 50);
      }
      return;
    }

    if (
      event.data?.type === 'COOLHUSKY_BILIBILI_DASH_DETECTED' &&
      event.data.task
    ) {
      if (!currentTabId) {
        const tab = await browser.runtime.sendMessage({
          type: 'GET_CURRENT_TAB',
        });
        currentTabId = (tab as { id?: number } | undefined)?.id;
      }
      if (currentTabId) {
        browser.runtime.sendMessage({
          type: 'BILIBILI_DASH_FOUND',
          tabId: currentTabId,
          task: event.data.task,
        });
      }
      return;
    }

    if (
      event.data?.type === 'COOLHUSKY_PLATFORM_MEDIA_DETECTED' &&
      event.data.task
    ) {
      browser.runtime
        .sendMessage({ type: 'PLATFORM_MEDIA_FOUND', task: event.data.task })
        .catch(() => {});
      return;
    }

    if (event.data?.type === 'COOLHUSKY_MSE_STREAM_UPDATE') {
      if (!mseCaptureEnabled) {
        return;
      }
      if (!currentTabId) {
        const tab = await browser.runtime.sendMessage({
          type: 'GET_CURRENT_TAB',
        });
        currentTabId = (tab as { id?: number } | undefined)?.id;
      }
      if (currentTabId) {
        browser.runtime
          .sendMessage({
            type: 'MSE_STREAM_UPDATE',
            tabId: currentTabId,
            captureId: event.data.captureId,
            title: event.data.title,
            totalBytes: event.data.totalBytes,
            trackCount: event.data.trackCount,
            complete: event.data.complete,
          })
          .catch(() => {});
      }
      return;
    }

    if (
      event.data?.type === 'COOLHUSKY_FETCH' &&
      typeof event.data.url === 'string'
    ) {
      const {
        url,
        requestId,
        options,
        responseType = 'arraybuffer',
      } = event.data;
      const abortController = new AbortController();
      coolhuskyFetchControllers.set(requestId, abortController);
      try {
        const fetchOptions: RequestInit = {
          signal: abortController.signal,
          cache: 'no-store',
        };
        if (options?.headers) {
          // strip cache headers
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
          const clean: Record<string, string> = {};
          for (const [k, v] of Object.entries(options.headers)) {
            if (!CACHE_HEADER_NAMES.has(String(k).toLowerCase())) {
              clean[k] = v as string;
            }
          }
          fetchOptions.headers = clean;
        }
        const response = await fetch(url, fetchOptions);
        coolhuskyFetchControllers.delete(requestId);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        if (responseType === 'text') {
          const text = await response.text();
          window.postMessage(
            {
              type: 'COOLHUSKY_FETCH_RESPONSE',
              requestId,
              ok: response.ok,
              status: response.status,
              headers,
              text,
              responseType: 'text',
            },
            '*'
          );
        } else {
          const arrayBuffer = await response.arrayBuffer();
          window.postMessage(
            {
              type: 'COOLHUSKY_FETCH_RESPONSE',
              requestId,
              ok: response.ok,
              status: response.status,
              headers,
              buffer: arrayBuffer,
              responseType: 'arraybuffer',
            },
            '*',
            [arrayBuffer]
          );
        }
      } catch (err) {
        coolhuskyFetchControllers.delete(requestId);
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        window.postMessage(
          { type: 'COOLHUSKY_FETCH_RESPONSE', requestId, ok: false },
          '*'
        );
      }
    }

    if (
      event.data?.type === 'COOLHUSKY_FETCH_CANCEL' &&
      typeof event.data.requestId === 'string'
    ) {
      const ctrl = coolhuskyFetchControllers.get(event.data.requestId);
      if (ctrl) {
        ctrl.abort();
        coolhuskyFetchControllers.delete(event.data.requestId);
      }
    }

    if (
      event.data?.type === 'COOLHUSKY_PROXY_FETCH' &&
      typeof event.data.url === 'string'
    ) {
      const { url, requestId, responseType, options } = event.data;

      browser.runtime
        .sendMessage({
          type: 'PROXY_FETCH',
          url,
          options,
          requestId,
        })
        .then((resp: any) => {
          if (!resp || !resp.ok) {
            window.postMessage(
              {
                type: 'COOLHUSKY_PROXY_FETCH_RESPONSE',
                requestId,
                ok: false,
                status: resp?.status,
                error: resp?.error,
              },
              '*'
            );
            return;
          }
          const arrayBuffer = b64ToArrayBuffer(resp.data);
          const msg: any = {
            type: 'COOLHUSKY_PROXY_FETCH_RESPONSE',
            requestId,
            ok: true,
            status: resp.status,
            headers: resp.headers || {},
            buffer: arrayBuffer,
            responseType: responseType || 'arraybuffer',
          };
          if (responseType === 'text') {
            msg.text = new TextDecoder('utf-8').decode(
              new Uint8Array(arrayBuffer)
            );
          }
          window.postMessage(msg, '*', [arrayBuffer]);
        })
        .catch(() => {
          window.postMessage(
            {
              type: 'COOLHUSKY_PROXY_FETCH_RESPONSE',
              requestId,
              ok: false,
            },
            '*'
          );
        });
    }

    if (
      event.data?.type === 'COOLHUSKY_PROXY_FETCH_CANCEL' &&
      typeof event.data.requestId === 'string'
    ) {
      // cancel background proxy fetch
      browser.runtime
        .sendMessage({
          type: 'PROXY_FETCH_CANCEL',
          requestId: event.data.requestId,
        })
        .catch(() => {});
    }

    if (
      event.data?.type === 'COOLHUSKY_NOTIFY' &&
      typeof event.data.title === 'string'
    ) {
      const { title, body, tag, pageUrl } = event.data;
      browser.runtime
        .sendMessage({
          type: 'COOLHUSKY_NOTIFY',
          title,
          body,
          tag,
          pageUrl: pageUrl || window.location.href,
        })
        .then(() =>
          window.postMessage({ type: 'COOLHUSKY_NOTIFY_ACK', tag }, '*')
        )
        .catch(() => {
          /* unhandled */
        });
    }
  });

  function handleMseDownload(data: {
    captureId: string;
    title: string;
    tracks: Array<{ mimeType: string; buffers: ArrayBuffer[] }>;
  }) {
    try {
      const { title, tracks } = data;
      const safeTitle = (title || 'mse-capture')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .slice(0, 100);

      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]!;
        if (!track.buffers || !track.buffers.length) {
          continue;
        }

        const totalSize = track.buffers.reduce((s, b) => s + b.byteLength, 0);
        const merged = new Uint8Array(totalSize);
        let offset = 0;
        for (const buf of track.buffers) {
          merged.set(new Uint8Array(buf), offset);
          offset += buf.byteLength;
        }

        const isVideo = track.mimeType.startsWith('video/');
        const isAudio = track.mimeType.startsWith('audio/');
        const ext = isVideo ? 'mp4' : isAudio ? 'm4a' : 'bin';
        const suffix = tracks.length > 1 ? `_track${i + 1}` : '';
        const filename = `${safeTitle}${suffix}.${ext}`;

        const blob = new Blob([merged], {
          type: track.mimeType || 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 10000);
      }
    } catch {}
  }

  function b64ToArrayBuffer(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // DOM image extraction
  if (window.top === window.self && typeof document !== 'undefined') {
    const reportedImageUrls = new Set<string>();
    const dispatchImages = (candidates: DomImageCandidate[]): void => {
      const fresh = candidates.filter((c) => {
        if (reportedImageUrls.has(c.url)) {
          return false;
        }
        reportedImageUrls.add(c.url);
        return true;
      });
      if (!fresh.length) {
        return;
      }
      // chunk to avoid oversized messages
      for (let i = 0; i < fresh.length; i += 100) {
        const batch = fresh.slice(i, i + 100);
        browser.runtime
          .sendMessage({ type: 'MEDIA_FOUND_BATCH', items: batch })
          .catch(() => {});
      }
    };

    const scanPage = (): void => {
      try {
        dispatchImages(extractDomImages());
      } catch {}
    };
    const scanSubtree = (node: Node): void => {
      try {
        dispatchImages(extractDomImagesInSubtree(node));
      } catch {}
    };

    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          scanPage();
          // second pass for lazy images
          setTimeout(scanPage, 2500);
        },
        { once: true }
      );
    } else {
      scanPage();
      setTimeout(scanPage, 2500);
    }

    // incremental scan for lazy/dynamic images
    let pendingImageMutations: MutationRecord[] = [];
    let mutationTimer: number | null = null;
    const observer = new MutationObserver((mutations) => {
      pendingImageMutations.push(...mutations);
      if (mutationTimer !== null) {
        return;
      }
      mutationTimer = window.setTimeout(() => {
        mutationTimer = null;
        if (pendingImageMutations.length === 0) {
          return;
        }
        const batch = pendingImageMutations;
        pendingImageMutations = [];
        for (const m of batch) {
          if (m.type === 'childList') {
            for (const node of m.addedNodes) {
              scanSubtree(node);
            }
          } else if (m.type === 'attributes') {
            scanSubtree(m.target);
          }
        }
      }, 600);
    });
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'src',
          'srcset',
          'data-src',
          'data-original',
          'data-lazy-src',
          'data-lazy',
          'data-url',
          'data-original-src',
          'data-hi-res-src',
        ],
      });
    } catch {}
  }
}
