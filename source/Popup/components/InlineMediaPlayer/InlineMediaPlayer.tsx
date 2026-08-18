import type { FC } from 'react';
import type { MediaItem } from '../../../utils/popup-types';
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

const InlineMediaPlayer: FC<InlineMediaPlayerProps> = ({
  item,
  currentTabId,
}) => {
  const { audioRef, videoRef, spectrumCanvasRef, error } = useMediaPlayback(
    item,
    currentTabId
  );

  const format = item.format.toLowerCase();
  const isAudio = AUDIO_FORMATS.has(format);
  const isMse = format === 'mse';

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
        <video ref={videoRef} controls autoPlay className={styles.video} />
      )}
    </div>
  );
};

export default InlineMediaPlayer;
