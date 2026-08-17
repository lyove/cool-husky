import { useEffect, useRef, useState } from 'react';
import type HlsInstance from 'hls.js';
import type { MediaPlayerClass as DashPlayer } from 'dashjs';
import type mpegts from 'mpegts.js';

let hlsLoader: Promise<(typeof import('hls.js'))['default']> | null = null;
let dashLoader: Promise<typeof import('dashjs')> | null = null;
let mpegtsLoader: Promise<(typeof import('mpegts.js'))['default']> | null =
  null;

export const loadHls = (): Promise<(typeof import('hls.js'))['default']> => {
  hlsLoader ??= import('hls.js').then((module) => module.default);
  return hlsLoader;
};

export const loadDash = (): Promise<typeof import('dashjs')> => {
  dashLoader ??= import('dashjs');
  return dashLoader;
};

export const loadMpegts = (): Promise<
  (typeof import('mpegts.js'))['default']
> => {
  mpegtsLoader ??= import('mpegts.js').then((module) => module.default);
  return mpegtsLoader;
};

export interface StreamThumbnailItem {
  url: string;
  format: string;
  duration?: number;
}

export interface UseStreamThumbnailsOptions<T extends StreamThumbnailItem> {
  mediaList: T[];
  mediaByUrl: Map<string, T>;
  listContainerRef: React.RefObject<HTMLElement | null>;
  patchDuration: (item: T, duration: number) => T | undefined;
  persistMeta: (item: T) => void;
  captureFrame: (video: HTMLVideoElement) => string | undefined;
}

export function useStreamThumbnails<T extends StreamThumbnailItem>(
  options: UseStreamThumbnailsOptions<T>
): {
  cache: Map<string, string>;
  failed: Set<string>;
  version: number;
  touch: (url: string) => string | undefined;
  store: (url: string, data: string) => void;
  observe: (el: unknown, item: T) => void;
  resetObserver: () => void;
} {
  const hlsInstances = useRef(new Map<string, HlsInstance>());
  const dashInstances = useRef(new Map<string, DashPlayer>());
  const mpegtsInstances = useRef(new Map<string, mpegts.Player>());
  const cache = useRef(new Map<string, string>());
  const failed = useRef(new Set<string>());
  const failureAttempts = useRef(new Map<string, number>());
  const failureTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  const queue = useRef(
    new Map<string, { item: T; video: HTMLVideoElement; priority: number }>()
  );
  const active = useRef(new Set<string>());
  const timeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const observed = useRef(new Map<string, HTMLVideoElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  const disposed = useRef(false);
  const [version, setVersion] = useState(0);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const CACHE_LIMIT = 50;
  const CACHE_MEMORY_LIMIT = 12 * 1024 * 1024;
  const CONCURRENCY = 2;
  const TIMEOUT_MS = 12_000;
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 15_000;
  const MAX_COOLDOWN_MS = 5 * 60_000;

  const bump = (): void => setVersion((v) => v + 1);

  function touch(url: string): string | undefined {
    const data = cache.current.get(url);
    if (!data) return undefined;
    const newest = [...cache.current.keys()].at(-1);
    if (newest !== url) {
      const next = new Map(cache.current);
      next.delete(url);
      next.set(url, data);
      cache.current = next;
    }
    return data;
  }

  function clearFailure(url: string): void {
    const timer = failureTimers.current.get(url);
    if (timer) clearTimeout(timer);
    failureTimers.current.delete(url);
    failureAttempts.current.delete(url);
    if (failed.current.has(url)) {
      const next = new Set(failed.current);
      next.delete(url);
      failed.current = next;
      bump();
    }
  }

  function store(url: string, data: string): void {
    clearFailure(url);
    const next = new Map(cache.current);
    next.delete(url);
    next.set(url, data);
    const estimatedBytes = (): number => {
      let total = 0;
      next.forEach((value, key) => {
        total += (value.length + key.length) * 2;
      });
      return total;
    };
    while (next.size > CACHE_LIMIT || estimatedBytes() > CACHE_MEMORY_LIMIT) {
      const oldest = next.keys().next().value;
      if (oldest === undefined) break;
      next.delete(oldest);
    }
    cache.current = next;
    bump();
  }

  function cleanup(url: string): void {
    const timeout = timeouts.current.get(url);
    if (timeout) clearTimeout(timeout);
    timeouts.current.delete(url);
    const hls = hlsInstances.current.get(url);
    if (hls) {
      hls.destroy();
      hlsInstances.current.delete(url);
    }
    const dash = dashInstances.current.get(url);
    if (dash) {
      dash.destroy();
      dashInstances.current.delete(url);
    }
    const mts = mpegtsInstances.current.get(url);
    if (mts) {
      try {
        mts.destroy();
      } catch {}
      mpegtsInstances.current.delete(url);
    }
    const video = observed.current.get(url);
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.removeAttribute('data-hls-attached');
      video.removeAttribute('data-dash-attached');
      video.load();
    }
    active.current.delete(url);
    queue.current.delete(url);
    queueMicrotask(pump);
  }

  function markFailure(url: string): void {
    if (failed.current.has(url)) return;
    const attempts = Math.min(
      (failureAttempts.current.get(url) ?? 0) + 1,
      MAX_RETRIES
    );
    failureAttempts.current.set(url, attempts);
    failed.current = new Set(failed.current).add(url);
    bump();
    cleanup(url);
    const previous = failureTimers.current.get(url);
    if (previous) clearTimeout(previous);
    const cooldown =
      attempts >= MAX_RETRIES
        ? MAX_COOLDOWN_MS
        : RETRY_BASE_MS * 2 ** (attempts - 1);
    failureTimers.current.set(
      url,
      setTimeout(() => {
        failureTimers.current.delete(url);
        const next = new Set(failed.current);
        next.delete(url);
        failed.current = next;
        if (attempts >= MAX_RETRIES) failureAttempts.current.delete(url);
        bump();
      }, cooldown)
    );
  }

  async function setup(item: T, video: HTMLVideoElement): Promise<void> {
    const url = item.url;
    if (
      hlsInstances.current.has(url) ||
      dashInstances.current.has(url) ||
      mpegtsInstances.current.has(url)
    ) {
      return;
    }
    let durationResolved = Boolean(item.duration);
    const persistDuration = (duration: number): void => {
      if (!Number.isFinite(duration) || duration <= 0 || durationResolved)
        return;
      durationResolved = true;
      const updated = optionsRef.current.patchDuration(item, duration);
      if (updated) optionsRef.current.persistMeta(updated);
      if (cache.current.has(url)) queueMicrotask(() => cleanup(url));
    };
    const ready = (): void => {
      persistDuration(video.duration);
      try {
        video.pause();
        video.currentTime = 0.1;
      } catch {}
    };
    const seeked = (): void => {
      if (cache.current.has(url)) {
        if (durationResolved) cleanup(url);
        return;
      }
      const frame = optionsRef.current.captureFrame(video);
      if (frame) {
        store(url, frame);
        if (durationResolved) cleanup(url);
      }
    };
    video.addEventListener('loadeddata', ready, { once: true });
    video.addEventListener('seeked', seeked, { once: true });
    const current = (): boolean =>
      !disposed.current && active.current.has(url) && video.isConnected;
    try {
      if (item.format === 'm3u8') {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          return;
        }
        const Hls = await loadHls();
        if (!current()) return;
        if (!Hls.isSupported()) {
          markFailure(url);
          return;
        }
        const hls = new Hls({ enableWorker: true, maxBufferLength: 5 });
        hlsInstances.current.set(url, hls);
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, ready);
        hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          persistDuration(data.details.totalduration);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) markFailure(url);
        });
      } else if (item.format === 'mpd') {
        const dashjs = await loadDash();
        if (!current()) return;
        const dash = dashjs.MediaPlayer().create();
        dashInstances.current.set(url, dash);
        dash.initialize(video, url, false);
        dash.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
          persistDuration(dash.duration());
          ready();
        });
        dash.on(dashjs.MediaPlayer.events.ERROR, () => markFailure(url));
      } else if (item.format === 'flv' || item.format === 'ts') {
        const mts = await loadMpegts();
        if (!current()) return;
        if (!mts.isSupported()) {
          markFailure(url);
          return;
        }
        const player = mts.createPlayer(
          {
            type: item.format === 'ts' ? 'mpegts' : 'flv',
            url: url,
            isLive: !item.duration,
          },
          {
            enableWorker: true,
            lazyLoad: false,
            autoCleanupSourceBuffer: true,
          }
        );
        mpegtsInstances.current.set(url, player);
        player.on(mts.Events.ERROR, () => markFailure(url));
        player.on(mts.Events.LOADING_COMPLETE, () => {
          if (!durationResolved && Number.isFinite(video.duration))
            persistDuration(video.duration);
        });
        player.attachMediaElement(video);
        player.load();
        video.addEventListener(
          'loadedmetadata',
          () => {
            if (Number.isFinite(video.duration) && video.duration > 0) {
              persistDuration(video.duration);
            } else {
              ready();
            }
          },
          { once: true }
        );
      }
    } catch {
      if (current()) markFailure(url);
    }
  }

  function pump(): void {
    if (disposed.current) return;
    while (active.current.size < CONCURRENCY && queue.current.size) {
      const entry = [...queue.current.entries()].reduce<
        | [string, { item: T; video: HTMLVideoElement; priority: number }]
        | undefined
      >(
        (best, candidate) =>
          !best || candidate[1].priority < best[1].priority ? candidate : best,
        undefined
      );
      if (!entry) break;
      const [url, task] = entry;
      queue.current.delete(url);
      if (
        !task.video.isConnected ||
        (cache.current.has(url) && task.item.duration) ||
        failed.current.has(url)
      ) {
        continue;
      }
      active.current.add(url);
      timeouts.current.set(
        url,
        setTimeout(() => markFailure(url), TIMEOUT_MS)
      );
      void setup(task.item, task.video);
    }
  }

  function enqueue(item: T, video: HTMLVideoElement, priority = 0): void {
    const url = item.url;
    if (
      disposed.current ||
      (cache.current.has(url) && item.duration) ||
      failed.current.has(url)
    ) {
      return;
    }
    if (
      active.current.has(url) ||
      hlsInstances.current.has(url) ||
      dashInstances.current.has(url) ||
      mpegtsInstances.current.has(url)
    ) {
      return;
    }
    const queued = queue.current.get(url);
    if (!queued || priority < queued.priority || queued.video !== video) {
      queue.current.set(url, { item, video, priority });
    }
    pump();
  }

  function resetObserver(): void {
    observer.current?.disconnect();
    observer.current = null;
  }

  function ensureObserver(): void {
    if (observer.current || !optionsRef.current.listContainerRef.current)
      return;
    observer.current = new IntersectionObserver(
      (entries) => {
        const root =
          optionsRef.current.listContainerRef.current?.getBoundingClientRect();
        const center = root
          ? (root.top + root.bottom) / 2
          : window.innerHeight / 2;
        for (const entry of entries) {
          const video = entry.target as HTMLVideoElement;
          const url = video.dataset.streamThumbUrl;
          if (!url) continue;
          const item = optionsRef.current.mediaByUrl.get(url);
          if (entry.isIntersecting && item) {
            enqueue(
              item,
              video,
              Math.abs(
                (entry.boundingClientRect.top +
                  entry.boundingClientRect.bottom) /
                  2 -
                  center
              )
            );
          } else {
            queue.current.delete(url);
            if (active.current.has(url)) cleanup(url);
          }
        }
      },
      {
        root: optionsRef.current.listContainerRef.current,
        rootMargin: '240px 0px',
        threshold: 0.01,
      }
    );
  }

  function observe(el: unknown, item: T): void {
    const previous = observed.current.get(item.url);
    if (previous && previous !== el) observer.current?.unobserve(previous);
    if (!(el instanceof HTMLVideoElement)) {
      observed.current.delete(item.url);
      queue.current.delete(item.url);
      if (active.current.has(item.url)) cleanup(item.url);
      return;
    }
    ensureObserver();
    el.dataset.streamThumbUrl = item.url;
    observed.current.set(item.url, el);
    observer.current?.observe(el);
  }

  useEffect(() => {
    const urls = new Set(options.mediaList.map((item) => item.url));
    for (const url of [
      ...hlsInstances.current.keys(),
      ...dashInstances.current.keys(),
      ...mpegtsInstances.current.keys(),
      ...queue.current.keys(),
    ]) {
      if (!urls.has(url)) cleanup(url);
    }
    // Only clean up entries no longer in the list; internal player instances are managed by refs
  }, [options.mediaList]);

  useEffect(() => {
    disposed.current = false;
    return (): void => {
      disposed.current = true;
      resetObserver();
      queue.current.clear();
      timeouts.current.forEach(clearTimeout);
      timeouts.current.clear();
      failureTimers.current.forEach(clearTimeout);
      failureTimers.current.clear();
      failureAttempts.current.clear();
      active.current.clear();
      hlsInstances.current.forEach((instance) => instance.destroy());
      hlsInstances.current.clear();
      dashInstances.current.forEach((instance) => instance.destroy());
      dashInstances.current.clear();
      mpegtsInstances.current.forEach((instance) => {
        try {
          instance.destroy();
        } catch {}
      });
      mpegtsInstances.current.clear();
      observed.current.clear();
    };
  }, []);

  return {
    cache: cache.current,
    failed: failed.current,
    version,
    touch,
    store,
    observe,
    resetObserver,
  };
}
