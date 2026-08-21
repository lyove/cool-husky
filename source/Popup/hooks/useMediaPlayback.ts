import { useCallback, useEffect, useRef, useState } from 'react';
import browser from 'webextension-polyfill';
import type HlsInstance from 'hls.js';
import type { MediaPlayerClass as DashPlayer } from 'dashjs';
import type { MediaItem } from '../../utils/popup-types';
import { createHlsProxyLoader } from '../utils/hlsProxyLoader';
import { loadDash, loadHls, loadMpegts } from './useStreamThumbnails';
import { useI18n } from './useI18n';

type MpegtsPlayer = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  attachMediaElement: (mediaElement: HTMLMediaElement) => void;
  load: () => void;
  destroy: () => void;
};

const IMAGE_FORMATS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'bmp',
  'ico',
  'apng',
]);
const AUDIO_FORMATS = new Set([
  'mp3',
  'aac',
  'wav',
  'ogg',
  'oga',
  'opus',
  'flac',
  'm4a',
  'wma',
  'amr',
  'mid',
  'midi',
  'aiff',
]);

const MAX_RECORD_BYTES = 500 * 1024 * 1024;

/**
 * Parse a CSS color string (#hex, rgb(), rgba()) into an [r, g, b] tuple.
 * Returns null when the value cannot be parsed.
 */
function parseRgb(color: string): [number, number, number] | null {
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) {
    let hex = trimmed.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (hex.length !== 6) {
      return null;
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)
      ? null
      : [r, g, b];
  }
  const match = trimmed.match(/rgba?\(([^)]+)\)/i);
  if (!match) {
    return null;
  }
  const parts = match[1]!.split(',').map((p) => parseFloat(p));
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) {
    return null;
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

/**
 * Linearly mix two CSS colors and return an #rrggbb string.
 * `ratio` is the weight of `to` (0 = fully `from`, 1 = fully `to`).
 */
function mixColor(from: string, to: string, ratio: number): string {
  const a = parseRgb(from) ?? [59, 130, 246]; // fallback: primary blue
  const b = parseRgb(to) ?? [255, 255, 255];
  const t = Math.max(0, Math.min(1, ratio));
  const r = Math.round(a[0]! + (b[0]! - a[0]!) * t);
  const g = Math.round(a[1]! + (b[1]! - a[1]!) * t);
  const bl = Math.round(a[2]! + (b[2]! - a[2]!) * t);
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export interface PlaybackContext {
  referrer: string;
  drm: boolean;
}

export interface RecordingState {
  chunks: Uint8Array[];
  controller: AbortController;
  startTime: number;
}

export interface UseMediaPlaybackResult {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  spectrumCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  imgSrc: string;
  error: string;
  drm: boolean;
  recordingSec: number;
  isRecording: boolean;
  startLiveRecording: () => void;
  stopLiveRecording: () => void;
  setMediaVolume: (volume: number) => void;
  toggleMuted: () => void;
}

export function useMediaPlayback(
  item: MediaItem,
  currentTabId?: number
): UseMediaPlaybackResult {
  const { t } = useI18n();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const separatedAudioRef = useRef<HTMLAudioElement | null>(null);
  const separatedAudioHandlersRef = useRef<{
    syncPlay: () => void;
    syncPause: () => void;
    syncTime: () => void;
    syncRate: () => void;
    onAudioError: () => void;
  } | null>(null);
  const hlsInstance = useRef<HlsInstance | null>(null);
  const dashInstance = useRef<DashPlayer | null>(null);
  const flvInstance = useRef<MpegtsPlayer | null>(null);
  const recording = useRef<RecordingState | null>(null);
  const [error, setError] = useState<string>('');
  const [drm, setDrm] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const [recordingActive, setRecordingActive] = useState(false);
  const [imgSrc, setImgSrc] = useState<string>('');

  const format = item.format.toLowerCase();
  const isImage = IMAGE_FORMATS.has(format);
  const isAudio = AUDIO_FORMATS.has(format);
  const isLive =
    Boolean(item.isLiveStream) && (format === 'flv' || format === 'ts');
  const isMse = format === 'mse';

  const getPlaybackContext = useCallback(async (): Promise<PlaybackContext> => {
    const tabUrl =
      currentTabId === undefined
        ? undefined
        : (await browser.tabs.get(currentTabId).catch(() => undefined))?.url;
    const referrer =
      item.requestHeaders?.referer ||
      item.requestHeaders?.Referer ||
      tabUrl ||
      '';
    const response = (await browser.runtime
      .sendMessage({
        type: 'PREPARE_MEDIA_PLAYBACK',
        url: item.url,
        format: item.format,
        referrer,
        requestHeaders: item.requestHeaders,
      })
      .catch(() => undefined)) as { ok?: boolean; drm?: boolean } | undefined;
    return { referrer, drm: response?.drm === true };
  }, [item, currentTabId]);

  const loadImage = useCallback(async (): Promise<void> => {
    const tabUrl =
      currentTabId === undefined
        ? ''
        : (await browser.tabs.get(currentTabId).catch(() => undefined))?.url ||
          '';
    const headers =
      item.requestHeaders && typeof item.requestHeaders === 'object'
        ? item.requestHeaders
        : undefined;
    const referrer = headers?.Referer || headers?.referer || tabUrl;
    const response = (await browser.runtime
      .sendMessage({
        type: 'PROXY_FETCH',
        url: item.url,
        options: { authHeaders: headers, referrer, proxyHeader: true },
      })
      .catch(() => undefined)) as
      | { ok?: boolean; data?: string; headers?: Record<string, string> }
      | undefined;
    if (!response?.ok || !response.data) {
      setError(t('imageLoadError'));
      return;
    }
    const contentType =
      response.headers?.['content-type'] ||
      response.headers?.['Content-Type'] ||
      'image/*';
    if (!contentType.toLowerCase().startsWith('image/')) {
      setError(t('imageLoadError'));
      return;
    }
    const blob = new Blob(
      [Uint8Array.from(atob(response.data), (c) => c.charCodeAt(0))],
      {
        type: contentType,
      }
    );
    setImgSrc(URL.createObjectURL(blob));
  }, [item, currentTabId, t]);

  // Syncs a separate audio track to video element with play/pause/seek handlers
  const attachSeparatedAudio = useCallback(async (): Promise<void> => {
    const audioUrl = item.audioUrl || item.audioOptions?.[0]?.url;
    if (!audioUrl || separatedAudioRef.current) {
      return;
    }
    const video = videoRef.current;
    if (!video || !video.isConnected) {
      return;
    }
    const tabUrl =
      currentTabId === undefined
        ? ''
        : (await browser.tabs.get(currentTabId).catch(() => undefined))?.url ||
          '';
    const referrer =
      item.requestHeaders?.referer || item.requestHeaders?.Referer || tabUrl;
    await browser.runtime
      .sendMessage({
        type: 'PREPARE_MEDIA_PLAYBACK',
        url: audioUrl,
        format: item.format,
        referrer,
        requestHeaders: item.requestHeaders,
      })
      .catch(() => {});
    if (!video.isConnected || separatedAudioRef.current) {
      return;
    }
    const audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.src = audioUrl;
    const syncTime = (): void => {
      if (Math.abs(audioEl.currentTime - video.currentTime) > 0.18) {
        audioEl.currentTime = video.currentTime;
      }
    };
    const syncPlay = (): void => {
      syncTime();
      audioEl.play().catch(() => {});
    };
    const syncPause = (): void => audioEl.pause();
    const syncRate = (): void => {
      audioEl.playbackRate = video.playbackRate;
    };
    const onAudioError = (): void => {
      console.warn('[CoolHusky] separated preview audio failed:', audioUrl);
    };
    video.addEventListener('play', syncPlay);
    video.addEventListener('pause', syncPause);
    video.addEventListener('seeking', syncTime);
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('ratechange', syncRate);
    audioEl.addEventListener('error', onAudioError);
    separatedAudioRef.current = audioEl;
    separatedAudioHandlersRef.current = {
      syncPlay,
      syncPause,
      syncTime,
      syncRate,
      onAudioError,
    };
    if (!video.paused) {
      syncPlay();
    }
  }, [item, currentTabId]);

  const disposeSeparatedAudio = useCallback((): void => {
    const audioEl = separatedAudioRef.current;
    const handlers = separatedAudioHandlersRef.current;
    const video = videoRef.current;
    if (video && handlers) {
      video.removeEventListener('play', handlers.syncPlay);
      video.removeEventListener('pause', handlers.syncPause);
      video.removeEventListener('seeking', handlers.syncTime);
      video.removeEventListener('timeupdate', handlers.syncTime);
      video.removeEventListener('ratechange', handlers.syncRate);
      audioEl?.removeEventListener('error', handlers.onAudioError);
    }
    audioEl?.pause();
    audioEl?.removeAttribute('src');
    audioEl?.load();
    separatedAudioRef.current = null;
    separatedAudioHandlersRef.current = null;
  }, []);

  // Audio spectrum visualizer via Web Audio API analyser node
  useEffect(() => {
    if (!isAudio) {
      return;
    }
    const audio = audioRef.current;
    const canvas = spectrumCanvasRef.current;
    if (!audio || !canvas) {
      return;
    }
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let raf = 0;
    let started = false;
    let drawing = false;
    let g: CanvasRenderingContext2D | null = null;
    let data = new Uint8Array(0);
    const BAR_COUNT = 40;
    const center = (BAR_COUNT - 1) / 2;
    const envelope = new Float32Array(BAR_COUNT);
    for (let k = 0; k < BAR_COUNT; k++) {
      const d = Math.abs(k - center) / center;
      envelope[k] = 0.3 + 0.7 * Math.cos(d * Math.PI * 0.5);
    }
    let frame = 0;
    // Cache the theme accent color once (read in setup) instead of calling
    // getComputedStyle on every animation frame — that would force a style
    // recalcation 60 times per second.
    let accentColor = '#3b82f6';
    let topColor = mixColor(accentColor, '#ffffff', 0.45);
    const draw = (): void => {
      if (!drawing) {
        return;
      }
      raf = requestAnimationFrame(draw);
      if (!analyser || !g) {
        return;
      }
      analyser.getByteFrequencyData(data);
      let total = 0;
      for (let j = 0; j < data.length; j++) {
        total += data[j] ?? 0;
      }
      const loudness = total / data.length / 255;
      const peak = Math.max(0.2, Math.min(1, 0.35 + loudness * 1.8));
      const cssW = canvas.clientWidth || canvas.width;
      const cssH = canvas.clientHeight || canvas.height;
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.round(cssW * dpr);
      const targetH = Math.round(cssH * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      const w = canvas.width;
      const h = canvas.height;
      g.clearRect(0, 0, w, h);
      const gap = Math.round(4 * dpr);
      const barWidth = Math.max(
        1,
        Math.floor((w - (BAR_COUNT - 1) * gap) / BAR_COUNT)
      );
      const stride = (w - barWidth) / (BAR_COUNT - 1);
      const gradient = g.createLinearGradient(0, h, 0, 0);
      gradient.addColorStop(0, accentColor);
      gradient.addColorStop(1, topColor);
      g.fillStyle = gradient;
      frame++;
      for (let i = 0; i < BAR_COUNT; i++) {
        const jit =
          Math.sin(frame * 0.22 + i * 1.9) * 0.5 +
          Math.sin(frame * 0.13 + i * 0.7) * 0.5;
        const jitter01 = jit * 0.5 + 0.5;
        const env = envelope[i]!;
        const v = Math.max(
          0.04,
          Math.min(peak, peak * (env * 0.6 + env * 0.4 * jitter01))
        );
        const barHeight = h * v;
        const x = i * stride;
        const y = h - barHeight;
        g.beginPath();
        g.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, 3 * dpr));
        g.fill();
      }
    };
    const setup = (): void => {
      if (started) {
        return;
      }
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) {
        return;
      }
      try {
        ctx = new AudioCtx();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source = ctx.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(ctx.destination);
        data = new Uint8Array(analyser.frequencyBinCount);
        g = canvas.getContext('2d');
        // Read the theme accent color once at setup so the spectrum bars
        // match the playback control bar in both light and dark mode.
        accentColor =
          getComputedStyle(canvas).getPropertyValue('--fp-accent').trim() ||
          '#3b82f6';
        topColor = mixColor(accentColor, '#ffffff', 0.45);
        started = true;
      } catch {
        // AudioContext unavailable
      }
    };
    const startDrawing = (): void => {
      if (!started || drawing) {
        return;
      }
      drawing = true;
      draw();
    };
    const stopDrawing = (): void => {
      drawing = false;
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = 0;
      if (g) {
        g.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
    const onPlay = (): void => {
      setup();
      startDrawing();
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', stopDrawing);
    audio.addEventListener('ended', stopDrawing);
    if (!audio.paused) {
      onPlay();
    }
    return (): void => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', stopDrawing);
      audio.removeEventListener('ended', stopDrawing);
      if (raf) {
        cancelAnimationFrame(raf);
      }
      if (source) {
        source.disconnect();
      }
      if (analyser) {
        analyser.disconnect();
      }
      if (ctx) {
        void ctx.close();
      }
    };
  }, [isAudio, item.url]);

  useEffect(() => {
    if (isImage) {
      void loadImage();
      return (): void => {
        setImgSrc((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev);
          }
          return '';
        });
      };
    }

    if (isMse) {
      setError(t('mseDownloadTip'));
      return;
    }

    if (isAudio) {
      void getPlaybackContext();
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }
    let cancelled = false;

    const startPlayback = async (): Promise<void> => {
      try {
        const ctx = await getPlaybackContext();
        if (cancelled) {
          return;
        }
        setDrm(ctx.drm);
        if (ctx.drm) {
          setError(t('drmProtected'));
          return;
        }

        if (format === 'm3u8') {
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = item.url;
            void video.play().catch(() => {});
            return;
          }
          const Hls = await loadHls();
          if (cancelled) {
            return;
          }
          if (!Hls.isSupported()) {
            setError(t('hlsUnsupported'));
            return;
          }
          // HLS with proxy fallback on network error
          let proxyFallbackStarted = false;
          const startHls = (useProxy: boolean): void => {
            const previous = hlsInstance.current;
            if (previous) {
              previous.destroy();
              hlsInstance.current = null;
            }
            video.pause();
            video.removeAttribute('src');
            video.load();
            const hls = new Hls({
              enableWorker: true,
              backBufferLength: 90,
              maxBufferLength: 30,
              ...(useProxy
                ? {
                    loader: createHlsProxyLoader({
                      requestHeaders: item.requestHeaders,
                      referrer: ctx.referrer,
                    }),
                  }
                : {}),
            });
            hlsInstance.current = hls;
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (hlsInstance.current === hls) {
                void video.play().catch(() => {});
              }
            });
            hls.on(Hls.Events.ERROR, (_e, data) => {
              if (!data.fatal || hlsInstance.current !== hls) {
                return;
              }
              if (
                data.type === Hls.ErrorTypes.NETWORK_ERROR &&
                !useProxy &&
                !proxyFallbackStarted
              ) {
                proxyFallbackStarted = true;
                queueMicrotask(() => startHls(true));
                return;
              }
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                hls.startLoad();
              } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
              } else {
                setError(t('playError') + (data.details || ''));
              }
            });
            hls.loadSource(item.url);
            hls.attachMedia(video);
          };
          startHls(false);
        } else if (format === 'mpd') {
          const dashjs = await loadDash();
          if (cancelled) {
            return;
          }
          const dash = dashjs.MediaPlayer().create();
          dashInstance.current = dash;
          dash.initialize(video, item.url, false);
          dash.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
            void video.play().catch(() => {});
          });
          dash.on(dashjs.MediaPlayer.events.ERROR, () => {
            setError(t('playFail'));
          });
        } else if (format === 'flv' || format === 'ts') {
          const mts = await loadMpegts();
          if (cancelled) {
            return;
          }
          if (!mts.isSupported()) {
            setError(t('flvUnsupported'));
            return;
          }
          const player = mts.createPlayer(
            {
              type: format === 'ts' ? 'mpegts' : 'flv',
              url: item.url,
              isLive,
            },
            {
              enableWorker: true,
              lazyLoad: false,
              autoCleanupSourceBuffer: true,
              headers: item.requestHeaders ?? {},
            }
          );
          flvInstance.current = player;
          player.on(mts.Events.ERROR, () => {
            setError(t('playFail'));
          });
          player.attachMediaElement(video);
          player.load();
          void video.play().catch(() => {});
        } else {
          await attachSeparatedAudio();
          if (cancelled) {
            return;
          }
          video.src = item.url;
          void video.play().catch(() => {});
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? t('playError') + e.message : t('playFail')
          );
        }
      }
    };

    void startPlayback();

    return (): void => {
      cancelled = true;
      hlsInstance.current?.destroy();
      hlsInstance.current = null;
      dashInstance.current?.destroy();
      dashInstance.current = null;
      flvInstance.current?.destroy();
      flvInstance.current = null;
      disposeSeparatedAudio();
      if (recording.current) {
        recording.current.controller.abort();
        recording.current = null;
        setRecordingActive(false);
      }
    };
  }, [
    item,
    currentTabId,
    format,
    isImage,
    isMse,
    isAudio,
    isLive,
    getPlaybackContext,
    loadImage,
    attachSeparatedAudio,
    disposeSeparatedAudio,
    t,
  ]);

  useEffect(() => {
    if (!isLive) {
      return;
    }
    const timer = setInterval(() => {
      if (recording.current) {
        setRecordingSec(
          Math.round((Date.now() - recording.current.startTime) / 1000)
        );
      }
    }, 1000);
    return (): void => clearInterval(timer);
  }, [isLive]);

  const isRecording = recordingActive;

  const startLiveRecording = useCallback((): void => {
    if (recording.current) {
      recording.current.controller.abort();
      return;
    }
    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    const startTime = Date.now();
    recording.current = { chunks, controller, startTime };
    setRecordingActive(true);
    setRecordingSec(0);
    const headers: Record<string, string> = { ...item.requestHeaders };
    (async (): Promise<void> => {
      try {
        const resp = await fetch(item.url, {
          signal: controller.signal,
          headers,
          cache: 'no-store',
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            chunks.push(value);
          }
          const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
          if (totalBytes > MAX_RECORD_BYTES) {
            setError(t('liveRecordingLimit'));
            break;
          }
        }
      } catch (e: unknown) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          setError(t('liveRecordingError'));
        }
      } finally {
        const totalBytes = chunks.reduce((s, c) => s + c.length, 0);
        if (totalBytes > 0) {
          const blob = new Blob(chunks as unknown as BlobPart[], {
            type: 'video/x-flv',
          });
          const blobUrl = URL.createObjectURL(blob);
          const filename = `recording_${startTime}.${format}`;
          browser.downloads
            .download({ url: blobUrl, filename, saveAs: false })
            .then((downloadId) => {
              // Revoke the object URL once the download settles so we don't
              // leak it on success (previously only revoked on failure).
              const onChanged = (delta: {
                id?: number;
                state?: { current?: string };
              }): void => {
                if (delta.id !== downloadId) {
                  return;
                }
                if (
                  delta.state?.current === 'complete' ||
                  delta.state?.current === 'interrupted'
                ) {
                  URL.revokeObjectURL(blobUrl);
                  browser.downloads.onChanged.removeListener(onChanged);
                }
              };
              browser.downloads.onChanged.addListener(onChanged);
            })
            .catch(() => {
              URL.revokeObjectURL(blobUrl);
            });
        }
        recording.current = null;
        setRecordingActive(false);
        setRecordingSec(0);
      }
    })();
  }, [item, format, t]);

  const stopLiveRecording = useCallback((): void => {
    if (recording.current) {
      recording.current.controller.abort();
    }
  }, []);

  // Applies volume/mute to the active media element and the separated
  // audio track (if any) so the slider always affects audible output.
  const setMediaVolume = useCallback((next: number): void => {
    const clamped = Math.min(1, Math.max(0, next));
    const primary = videoRef.current ?? audioRef.current;
    if (primary) {
      primary.volume = clamped;
      primary.muted = clamped === 0;
    }
    if (separatedAudioRef.current) {
      separatedAudioRef.current.volume = clamped;
      separatedAudioRef.current.muted = clamped === 0;
    }
  }, []);

  const toggleMuted = useCallback((): void => {
    const primary = videoRef.current ?? audioRef.current;
    if (!primary) {
      return;
    }
    const next = !primary.muted;
    primary.muted = next;
    if (separatedAudioRef.current) {
      separatedAudioRef.current.muted = next;
    }
  }, []);

  return {
    audioRef,
    videoRef,
    spectrumCanvasRef,
    imgSrc,
    error,
    drm,
    recordingSec,
    isRecording,
    startLiveRecording,
    stopLiveRecording,
    setMediaVolume,
    toggleMuted,
  };
}
