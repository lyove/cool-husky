import { t } from '../../utils/i18n';

export type MediaType =
  | 'stream'
  | 'video'
  | 'audio'
  | 'image'
  | 'doc'
  | 'other';

export const STREAM_FORMATS = ['m3u8', 'mpd', 'mse', 'flv'];
export const VIDEO_DOWNLOAD_FORMATS = [
  'mp4',
  'webm',
  'mkv',
  'mov',
  'avi',
  'flv',
  'ts',
  'ogv',
  'm4v',
  'mp3',
  'aac',
  'ogg',
  'flac',
  'wav',
  '3gp',
  '3g2',
  'mpeg',
];
export const VIDEO_FORMATS = [
  'mp4',
  'webm',
  'mkv',
  'avi',
  'mov',
  'flv',
  'ogv',
  'ts',
  '3gp',
  '3g2',
  'mpeg',
  'm4v',
];
export const AUDIO_FORMATS = [
  'mp3',
  'm4a',
  'oga',
  'weba',
  'wav',
  'flac',
  'aac',
  'ogg',
];
export const IMAGE_FORMATS = [
  'gif',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
  'heic',
  'heif',
  'apng',
  'tiff',
];
export const DOC_FORMATS = [
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'txt',
  'md',
  'epub',
];
export const SUBTITLE_FORMATS = ['srt', 'vtt', 'ass', 'ssa'];

export const FORMAT_GROUPS: Record<Exclude<MediaType, 'other'>, string[]> = {
  stream: [...STREAM_FORMATS],
  video: [...VIDEO_FORMATS],
  audio: [...AUDIO_FORMATS],
  image: [...IMAGE_FORMATS],
  doc: [...DOC_FORMATS],
};

export function isStreamFormat(f: string): boolean {
  return STREAM_FORMATS.includes(f.toLowerCase());
}

export function isVideoFormat(f: string): boolean {
  return VIDEO_FORMATS.includes(f.toLowerCase());
}

export function isVideoDownloadFormat(f: string): boolean {
  return VIDEO_DOWNLOAD_FORMATS.includes(f.toLowerCase());
}

export function isImageFormat(f: string): boolean {
  return IMAGE_FORMATS.includes(f.toLowerCase());
}

export function isAudioFormat(f: string): boolean {
  return AUDIO_FORMATS.includes(f.toLowerCase());
}

export function isDocFormat(f: string): boolean {
  return DOC_FORMATS.includes(f.toLowerCase());
}

export function getType(
  format: string,
  category?: string,
  groupRole?: string
): MediaType {
  const f = format.toLowerCase();
  if (groupRole === 'audio') {
    return 'audio';
  }
  // category flag wins over format
  if (category === 'stream') {
    return 'stream';
  }
  if (f === 'mse') {
    return 'stream';
  }
  if (isStreamFormat(f)) {
    return 'stream';
  }
  if (isVideoFormat(f)) {
    return 'video';
  }
  if (isAudioFormat(f)) {
    return 'audio';
  }
  if (isImageFormat(f)) {
    return 'image';
  }
  if (isDocFormat(f)) {
    return 'doc';
  }
  if (category === 'image') {
    return 'image';
  }
  if (category === 'subtitle') {
    return 'doc';
  }
  return 'other';
}

export function getFormatLabel(format: string): string {
  if (!format) {
    return t('unknown');
  }
  const map: Record<string, string> = {
    m3u8: 'HLS',
    mpd: 'DASH',
    mse: 'MSE',
    mp4: 'MP4',
    mp3: 'MP3',
    webm: 'WebM',
    m4a: 'M4A',
    ogg: 'OGG',
    flac: 'FLAC',
    wav: 'WAV',
    aac: 'AAC',
    ts: 'TS',
    flv: 'FLV',
    png: 'PNG',
    jpg: 'JPG',
    jpeg: 'JPEG',
    gif: 'GIF',
    webp: 'WebP',
    svg: 'SVG',
    bmp: 'BMP',
    pdf: 'PDF',
    vtt: 'VTT',
    srt: 'SRT',
  };
  return map[format.toLowerCase()] ?? format.toUpperCase();
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'download';
}

// Hashes data: URLs and long query-string filenames to short stable names
export function getFileName(url: string): string {
  try {
    if (url.startsWith('data:')) {
      let h = 0;
      for (let i = 0; i < url.length; i++) {
        h = (h * 31 + url.charCodeAt(i)) >>> 0;
      }
      return `image-${h.toString(36).slice(0, 8)}`;
    }

    const pathname = decodeURIComponent(new URL(url).pathname);
    const last = pathname.split('/').pop() || '';

    if (last.length > 48 || /[=?&]/.test(last)) {
      const extMatch = last.match(
        /\.(mp4|m3u8|webm|mov|m4v|mp3|m4a|ts|png|jpe?g|webp|gif|svg|pdf|mkv|avi|flv|ogg|wav|aac)(?=$|&|\?)/i
      );
      const ext = extMatch && extMatch[1] ? extMatch[1].toLowerCase() : '';
      let h = 0;
      for (let i = 0; i < url.length; i++) {
        h = (h * 31 + url.charCodeAt(i)) >>> 0;
      }
      const short = h.toString(36).slice(0, 6);
      return ext ? `media-${short}.${ext}` : `media-${short}`;
    }

    const withoutQuery = last.split('?')[0] || '';
    const dot = withoutQuery.lastIndexOf('.');
    return dot > 0 ? withoutQuery.slice(0, dot) : withoutQuery;
  } catch {
    return url.split('/').pop() || url;
  }
}

export function ensureFileExtension(filename: string, format: string): string {
  const ext = format.toLowerCase();
  const base = sanitizeFilename(filename);
  if (ext && !base.toLowerCase().endsWith(`.${ext}`)) {
    return `${base}.${ext}`;
  }
  return base;
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes === 0) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return value % 1 === 0
    ? `${value} ${units[i]}`
    : `${value.toFixed(1)} ${units[i]}`;
}

// Prefixes ~ for stream formats whose size is approximate
export function formatItemSize(item: {
  format?: string;
  size?: number;
}): string {
  if (!item.size) {
    return '';
  }
  const base = formatFileSize(item.size);
  const f = (item.format ?? '').toLowerCase();
  return ['m3u8', 'mpd', 'ism', 'flv', 'mpegts'].includes(f)
    ? `~${base}`
    : base;
}

// Composite key: captureId|groupId|groupRole|format|url for dedup
export function getMediaKey(item: {
  captureId?: string;
  groupId?: string;
  groupRole?: string;
  format: string;
  url: string;
}): string {
  return [
    item.captureId || '',
    item.groupId || '',
    item.groupRole || '',
    item.format.toLowerCase(),
    item.url,
  ].join('|');
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null || isNaN(seconds)) {
    return '';
  }
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function getResolutionLabel(
  width?: number,
  height?: number
): string | null {
  if (!width || !height) {
    return null;
  }
  const h = Math.min(width, height);
  if (h >= 4320) {
    return '8K';
  }
  if (h >= 2160) {
    return '4K';
  }
  if (h >= 1440) {
    return '1440p';
  }
  if (h >= 1080) {
    return '1080p';
  }
  if (h >= 720) {
    return '720p';
  }
  if (h >= 480) {
    return '480p';
  }
  return null;
}

export function getRelativeTime(
  ts?: number,
  tFn: (key: string, substitutions?: string | string[]) => string = t
): string {
  if (!ts) {
    return '';
  }
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) {
    return tFn('timeJustNow');
  }
  if (diff < 60) {
    return tFn('timeSecondsAgo', String(diff));
  }
  if (diff < 3600) {
    return tFn('timeMinutesAgo', String(Math.floor(diff / 60)));
  }
  if (diff < 86400) {
    return tFn('timeHoursAgo', String(Math.floor(diff / 3600)));
  }
  return tFn('timeDaysAgo', String(Math.floor(diff / 86400)));
}

export function sanitizeDirectoryName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'download';
}

export function getDownloadFilename(
  url: string,
  format: string,
  customName?: string
): string {
  const baseName = customName || getFileName(url) || 'download';
  return ensureFileExtension(baseName, format);
}

export function getBatchDownloadFilename(
  url: string,
  format: string,
  subDir?: string,
  customName?: string
): string {
  const baseName = customName || getFileName(url) || 'download';
  const filename = ensureFileExtension(baseName, format);
  return subDir ? `${subDir}/${filename}` : filename;
}

// Current date prefix for renamed downloads, e.g. 2026-08-21
export function getDatePrefix(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Renamed download filename in sniffing order: YYYY-MM-DD-index.ext
export function getRenamedBatchFilename(
  datePrefix: string,
  index: number,
  total: number,
  format: string
): string {
  const width = Math.max(2, String(total).length);
  const seq = String(index).padStart(width, '0');
  return `${datePrefix}-${seq}.${format.toLowerCase()}`;
}
