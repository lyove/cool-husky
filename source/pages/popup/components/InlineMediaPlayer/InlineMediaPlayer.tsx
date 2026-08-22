import type { FC, ReactElement } from 'react';
import React, { useEffect, useRef, useState } from 'react';
import type { MediaItem } from '../../../../utils/popup-types';
import { useMediaPlayback } from '../../hooks/useMediaPlayback';
import styles from './InlineMediaPlayer.module.scss';

interface InlineMediaPlayerProps {
  item: MediaItem;
  currentTabId?: number;
}

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

const formatTime = (seconds: number): string => {
  const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = Math.floor(safeSeconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s
      .toString()
      .padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const PlayIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
  </svg>
);

const VolumeIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
  </svg>
);

const MuteIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
  </svg>
);

const DownloadIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
  </svg>
);

const InlineMediaPlayer: FC<InlineMediaPlayerProps> = ({
  item,
  currentTabId,
}) => {
  const {
    audioRef,
    videoRef,
    spectrumCanvasRef,
    error,
    setMediaVolume,
    toggleMuted,
  } = useMediaPlayback(item, currentTabId);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const progressRef = useRef<HTMLDivElement>(null);

  const format = item.format.toLowerCase();
  const isAudio = AUDIO_FORMATS.has(format);
  const isMse = format === 'mse';

  useEffect(() => {
    const media = isAudio ? audioRef.current : videoRef.current;
    if (!media) {
      return;
    }

    const handlePlay = (): void => setIsPlaying(true);
    const handlePause = (): void => setIsPlaying(false);
    const handleTimeUpdate = (): void => setCurrentTime(media.currentTime);
    const handleLoadedMetadata = (): void => {
      setDuration(media.duration);
      setVolume(media.volume);
      setIsMuted(media.muted);
    };
    const handleVolumeChange = (): void => {
      setVolume(media.volume);
      setIsMuted(media.muted);
    };

    media.addEventListener('play', handlePlay);
    media.addEventListener('pause', handlePause);
    media.addEventListener('timeupdate', handleTimeUpdate);
    media.addEventListener('loadedmetadata', handleLoadedMetadata);
    media.addEventListener('volumechange', handleVolumeChange);

    if (media.readyState >= 1) {
      setDuration(media.duration);
    }
    setVolume(media.volume);
    setIsMuted(media.muted);

    return (): void => {
      media.removeEventListener('play', handlePlay);
      media.removeEventListener('pause', handlePause);
      media.removeEventListener('timeupdate', handleTimeUpdate);
      media.removeEventListener('loadedmetadata', handleLoadedMetadata);
      media.removeEventListener('volumechange', handleVolumeChange);
    };
  }, [isAudio, audioRef, videoRef]);

  const togglePlay = (): void => {
    const media = isAudio ? audioRef.current : videoRef.current;
    if (!media) {
      return;
    }
    if (media.paused || media.ended) {
      media.play().catch(() => {});
    } else {
      media.pause();
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const media = isAudio ? audioRef.current : videoRef.current;
    const track = progressRef.current;
    if (!media || !track || !Number.isFinite(media.duration)) {
      return;
    }
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (e.clientX - rect.left) / rect.width)
    );
    media.currentTime = ratio * media.duration;
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setMediaVolume(Number(e.target.value));
  };

  const handleVolumeSliderClick = (
    e: React.MouseEvent<HTMLDivElement>
  ): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (e.clientX - rect.left) / rect.width)
    );
    handleVolumeChange({
      target: { value: String(ratio) },
    } as React.ChangeEvent<HTMLInputElement>);
  };

  const handleVolumeSliderKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>
  ): void => {
    const isIncrease = e.key === 'ArrowRight' || e.key === 'ArrowUp';
    const isDecrease = e.key === 'ArrowLeft' || e.key === 'ArrowDown';
    if (!isIncrease && !isDecrease) {
      return;
    }
    e.preventDefault();
    const delta = isIncrease ? 0.05 : -0.05;
    const next = Math.min(1, Math.max(0, (isMuted ? 0 : volume) + delta));
    handleVolumeChange({
      target: { value: String(next) },
    } as React.ChangeEvent<HTMLInputElement>);
  };

  const toggleMute = (): void => {
    toggleMuted();
  };

  const handleDownload = (): void => {
    const url = item.url;
    if (!url) {
      return;
    }
    const ext = (item.format || 'mp4').toLowerCase();
    const basename = url.split('/').pop()?.split('?')[0] || '';
    const filename = basename.endsWith(`.${ext}`)
      ? basename
      : `download.${ext}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={styles.player}>
      {error && <p className={styles.error}>{error}</p>}

      {!isMse && isAudio && (
        <div className={styles.audioWrap}>
          <canvas
            ref={spectrumCanvasRef}
            width={512}
            height={96}
            className={styles.spectrum}
          />
          <audio
            ref={audioRef}
            controls
            autoPlay
            src={item.url}
            className={styles.audio}
          />
        </div>
      )}

      {!isMse && !isAudio && (
        <div className={styles.videoWrap}>
          <video ref={videoRef} autoPlay className={styles.video} playsInline />
          <div className={styles.customControls}>
            <button
              type="button"
              className={styles.controlBtn}
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>

            <span className={styles.time}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <div
              ref={progressRef}
              className={styles.progressWrap}
              onClick={handleSeek}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  const video = videoRef.current;
                  if (!video || !Number.isFinite(video.duration)) {
                    return;
                  }
                  const step = video.duration * 0.05;
                  const nextTime =
                    e.key === ' '
                      ? video.currentTime + step
                      : video.currentTime;
                  video.currentTime = Math.min(
                    video.duration,
                    Math.max(0, nextTime)
                  );
                }
              }}
              role="slider"
              tabIndex={0}
              aria-label="Video progress"
              aria-valuenow={currentTime}
              aria-valuemin={0}
              aria-valuemax={duration}
            >
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <button
              type="button"
              className={styles.controlBtn}
              onClick={toggleMute}
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
            </button>

            <div
              className={styles.volumeSlider}
              onClick={handleVolumeSliderClick}
              role="slider"
              tabIndex={0}
              aria-label="Volume"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={isMuted ? 0 : volume}
              onKeyDown={handleVolumeSliderKeyDown}
            >
              <div className={styles.volumeTrack}>
                <div
                  className={styles.volumeFill}
                  style={{ width: `${(isMuted ? 0 : volume) * 100}%` }}
                />
              </div>
              <div
                className={styles.volumeHandle}
                style={{ left: `${(isMuted ? 0 : volume) * 100}%` }}
              />
            </div>

            <button
              type="button"
              className={styles.controlBtn}
              onClick={handleDownload}
              aria-label="Download"
            >
              <DownloadIcon />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default InlineMediaPlayer;
