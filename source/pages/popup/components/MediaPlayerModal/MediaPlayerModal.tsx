import { useCallback } from 'react';
import type { FC } from 'react';
import type { MediaItem } from '../../../../utils/popup-types';
import { useMediaPlayback } from '../../hooks/useMediaPlayback';
import { useI18n } from '../../hooks/useI18n';
import { getFormatLabel } from '../../utils/formats';
import styles from './MediaPlayerModal.module.scss';

interface MediaPlayerModalProps {
  item: MediaItem;
  currentTabId?: number;
  onClose: () => void;
}

const MediaPlayerModal: FC<MediaPlayerModalProps> = ({
  item,
  currentTabId,
  onClose,
}) => {
  const { t } = useI18n();
  const {
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
  } = useMediaPlayback(item, currentTabId);

  const format = item.format.toLowerCase();
  const isImage =
    format === 'png' ||
    format === 'jpg' ||
    format === 'jpeg' ||
    format === 'gif' ||
    format === 'webp' ||
    format === 'svg' ||
    format === 'avif' ||
    format === 'bmp' ||
    format === 'ico' ||
    format === 'apng';
  const isAudio =
    format === 'mp3' ||
    format === 'aac' ||
    format === 'wav' ||
    format === 'ogg' ||
    format === 'oga' ||
    format === 'opus' ||
    format === 'flac' ||
    format === 'm4a' ||
    format === 'wma' ||
    format === 'amr' ||
    format === 'mid' ||
    format === 'midi' ||
    format === 'aiff';
  const isLive =
    Boolean(item.isLiveStream) && (format === 'flv' || format === 'ts');
  const isMse = format === 'mse';

  const handleClose = useCallback((): void => {
    stopLiveRecording();
    onClose();
  }, [onClose, stopLiveRecording]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={handleClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          handleClose();
        }
      }}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            handleClose();
          }
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
