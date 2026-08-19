import { useCallback, useEffect, useRef, useState } from 'react';
import browser from 'webextension-polyfill';
import type HlsInstance from 'hls.js';
import type { MediaPlayerClass as DashPlayer } from 'dashjs';
import type mpegts from 'mpegts.js';
import type { MediaItem } from '../../utils/popup-types';
import { createHlsProxyLoader } from '../utils/hlsProxyLoader';
import { loadDash, loadHls, loadMpegts } from './useStreamThumbnails';
import { useI18n } from './useI18n';

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
  const hlsInstance = useRef<HlsInstance | null>(null);
  const dashInstance = useRef<DashPlayer | null>(null);
  const flvInstance = useRef<mpegts.Player | null>(null);
  const recording = useRef<RecordingState | null>(null);
  const [error, setError] = useState<string>('');
  const [drm, setDrm] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
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

  const attachSeparatedAudio = useCallback(async (): Promise<void> => {
    const audioUrl = item.audioUrl || item.audioOptions?.[0]?.url;
    if (!audioUrl || separatedAudioRef.current) return;
    const video = videoRef.current;
    if (!video || !video.isConnected) return;
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
    if (!video.isConnected || separatedAudioRef.current) return;
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
    if (!video.paused) syncPlay();
  }, [item, currentTabId]);

  const disposeSeparatedAudio = useCallback((): void => {
    const audioEl = separatedAudioRef.current;
    if (!audioEl) return;
    const video = videoRef.current;
    if (video) {
      video.removeEventListener('play', audioEl.play);
      video.removeEventListener('pause', audioEl.pause);
    }
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
    separatedAudioRef.current = null;
  }, []);

  useEffect(() => {
    if (!isAudio) return;
    const audio = audioRef.current;
    const canvas = spectrumCanvasRef.current;
    if (!audio || !canvas) return;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let raf = 0;
    const start = (): void => {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return;
      try {
        ctx = new AudioCtx();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source = ctx.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(ctx.destination);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const g = canvas.getContext('2d');
        const draw = (): void => {
          raf = requestAnimationFrame(draw);
          if (!analyser || !g) return;
          analyser.getByteFrequencyData(data);
          // Sync the canvas backing store to the element's displayed size (DPR-aware)
          // so the spectrum fills the full container width with no right-side gap.
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
          // Adaptive bar count + gap: derive both from the actual canvas width so the
          // bars always fill the full width regardless of how wide the player is.
          // Target ~10px bar width in CSS pixels; gap is ~20% of bar width.
          const targetCssBarWidth = 10;
          const gapRatio = 0.2;
          let barCount = Math.max(16, Math.round(cssW / targetCssBarWidth));
          // Clamp to frequency bins so each bar maps to at least one bin.
          barCount = Math.min(barCount, data.length);
          // Only the low-frequency bins carry meaningful energy in most audio; the
          // high-frequency half is near-zero and would render the right side blank.
          // Map the full bar count onto the low-frequency slice so every bar has height.
          const usableBins = Math.max(8, Math.floor(data.length * 0.5));
          const cssBarWidth = cssW / barCount;
          const gap = Math.max(1, Math.round(cssBarWidth * gapRatio * dpr));
          const totalGap = (barCount - 1) * gap;
          const barWidth = Math.floor((w - totalGap) / barCount);
          // Absorb rounding remainder into the last bar → last bar's right edge = w.
          const lastBarExtra = w - totalGap - barWidth * barCount;
          const gradient = g.createLinearGradient(0, h, 0, 0);
          gradient.addColorStop(0, '#2a5fff');
          gradient.addColorStop(1, '#8fb3ff');
          g.fillStyle = gradient;
          for (let i = 0; i < barCount; i++) {
            const startBin = Math.floor((i * usableBins) / barCount);
            const endBin = Math.floor(((i + 1) * usableBins) / barCount);
            let sum = 0;
            for (let j = startBin; j < endBin; j++) {
              sum += data[j] ?? 0;
            }
            const avg = sum / Math.max(1, endBin - startBin);
            const v = avg / 255;
            const barHeight = h * v;
            const bw = i === barCount - 1 ? barWidth + lastBarExtra : barWidth;
            const x = i * (barWidth + gap);
            const y = h - barHeight;
            g.beginPath();
            g.roundRect(x, y, bw, barHeight, Math.min(bw / 2, 3 * dpr));
            g.fill();
          }
        };
        draw();
      } catch {
        // AudioContext unavailable: silently degrade
      }
    };
    audio.addEventListener('play', start, { once: true });
    if (!audio.paused) start();
    return (): void => {
      audio.removeEventListener('play', start);
      if (raf) cancelAnimationFrame(raf);
      if (source) source.disconnect();
      if (analyser) analyser.disconnect();
      if (ctx) void ctx.close();
    };
  }, [isAudio, item.url]);

  useEffect(() => {
    if (isImage) {
      void loadImage();
      return (): void => {
        setImgSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
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
    if (!video) return;
    let cancelled = false;

    const startPlayback = async (): Promise<void> => {
      try {
        const ctx = await getPlaybackContext();
        if (cancelled) return;
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
          if (cancelled) return;
          if (!Hls.isSupported()) {
            setError(t('hlsUnsupported'));
            return;
          }
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
              if (hlsInstance.current === hls)
                void video.play().catch(() => {});
            });
            hls.on(Hls.Events.ERROR, (_e, data) => {
              if (!data.fatal || hlsInstance.current !== hls) return;
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
          if (cancelled) return;
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
          if (cancelled) return;
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
          if (cancelled) return;
          video.src = item.url;
          void video.play().catch(() => {});
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? t('playError') + e.message : t('playFail')
          );
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
    if (!isLive) return;
    const timer = setInterval(() => {
      if (recording.current) {
        setRecordingSec(
          Math.round((Date.now() - recording.current.startTime) / 1000)
        );
      }
    }, 1000);
    return (): void => clearInterval(timer);
  }, [isLive]);

  const isRecording = recording.current !== null;

  const startLiveRecording = useCallback((): void => {
    if (recording.current) {
      recording.current.controller.abort();
      return;
    }
    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    const startTime = Date.now();
    recording.current = { chunks, controller, startTime };
    setRecordingSec(0);
    const headers: Record<string, string> = { ...item.requestHeaders };
    (async (): Promise<void> => {
      try {
        const resp = await fetch(item.url, {
          signal: controller.signal,
          headers,
          cache: 'no-store',
        });
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
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
            .catch(() => {
              URL.revokeObjectURL(blobUrl);
            });
        }
        recording.current = null;
        setRecordingSec(0);
      }
    })();
  }, [item, format, t]);

  const stopLiveRecording = useCallback((): void => {
    if (recording.current) {
      recording.current.controller.abort();
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
  };
}
