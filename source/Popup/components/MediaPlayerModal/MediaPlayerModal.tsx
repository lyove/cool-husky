import { useCallback, useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import browser from 'webextension-polyfill';
import type HlsInstance from 'hls.js';
import type { MediaPlayerClass as DashPlayer } from 'dashjs';
import type mpegts from 'mpegts.js';
import type { MediaItem } from '../../../utils/popup-types';
import { createHlsProxyLoader } from '../../utils/hlsProxyLoader';
import { loadDash, loadHls, loadMpegts } from '../../hooks/useStreamThumbnails';
import { useI18n } from '../../hooks/useI18n';
import { getFormatLabel } from '../../utils/formats';
import styles from './MediaPlayerModal.module.scss';

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

interface MediaPlayerModalProps {
  item: MediaItem;
  currentTabId?: number;
  onClose: () => void;
}

interface PlaybackContext {
  referrer: string;
  drm: boolean;
}

export interface RecordingState {
  chunks: Uint8Array[];
  controller: AbortController;
  startTime: number;
}

const MediaPlayerModal: FC<MediaPlayerModalProps> = ({
  item,
  currentTabId,
  onClose,
}) => {
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

  // Separate audio track: play audioUrl in sync with a video-only track (e.g. Bilibili DASH)
  const attachSeparatedAudio = useCallback(async (): Promise<void> => {
    const audioUrl = item.audioUrl || item.audioOptions?.[0]?.url;
    if (!audioUrl || separatedAudioRef.current) return;
    const video = videoRef.current;
    if (!video || !video.isConnected) return;
    // Install Referer/CORS rules for the audio CDN so the browser can fetch it directly
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
      // A failed optional separated audio track must not affect video playback
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

  // Audio spectrum visualization (AudioContext + AnalyserNode + canvas)
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
          const w = canvas.width;
          const h = canvas.height;
          g.clearRect(0, 0, w, h);
          const barWidth = w / data.length;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] ?? 0) / 255;
            g.fillStyle = `rgba(0,120,255,${0.4 + v * 0.6})`;
            g.fillRect(i * barWidth, h - h * v, barWidth - 1, h * v);
          }
        };
        draw();
      } catch {
        // AudioContext unavailable (e.g. private mode): silently degrade to a silent spectrum
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

  // Initialize the player
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
      setError(t('msePreviewTip'));
      return;
    }

    if (isAudio) {
      // Audio uses native playback, relying on DNR-injected auth headers
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
          // Try direct connection first (relies on DNR-injected Referer/CORS rules);
          // on NETWORK_ERROR due to CORS/403/hotlink protection, automatically switch to the background proxy loader (source-side proxyFallback behavior)
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
              isLive: isLive,
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
          // Regular direct-link video: if it is a video-only track (e.g. Bilibili DASH separated video),
          // play the separated audio track in sync first
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

  // Live-recording timer
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

  const handleClose = useCallback((): void => {
    if (recording.current) recording.current.controller.abort();
    onClose();
  }, [onClose]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={handleClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') handleClose();
      }}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') handleClose();
        }}
      >
        <header className={styles.header}>
          <div className={styles.headerInfo}>
            <span className={styles.formatBadge}>
              {getFormatLabel(item.format)}
            </span>
            <span className={styles.title} title={item.url}>
              {item.url}
            </span>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={handleClose}
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          {drm && <p className={styles.drmWarning}>{t('drmProtected')}</p>}
          {error && <p className={styles.error}>{error}</p>}

          {isImage && imgSrc && (
            <img className={styles.image} src={imgSrc} alt="" />
          )}

          {!isImage && !isMse && isAudio && (
            <div className={styles.audioWrap}>
              <audio
                ref={audioRef}
                controls
                autoPlay
                src={item.url}
                className={styles.audio}
              />
              <canvas
                ref={spectrumCanvasRef}
                width={512}
                height={128}
                className={styles.spectrum}
              />
            </div>
          )}

          {!isImage && !isMse && !isAudio && (
            <video ref={videoRef} controls autoPlay className={styles.video} />
          )}

          {isLive && (
            <button
              type="button"
              className={`${styles.recordBtn} ${isRecording ? styles.recording : ''}`}
              onClick={startLiveRecording}
            >
              {isRecording
                ? `${t('stopRecording')} (${recordingSec}s)`
                : t('startRecording')}
            </button>
          )}

          {isMse && <p className={styles.hint}>{t('mseDownloadTip')}</p>}
        </div>
      </div>
    </div>
  );
};

export default MediaPlayerModal;
