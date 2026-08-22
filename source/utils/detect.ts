export function normalizeUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (typeof Request !== 'undefined' && value instanceof Request) {
    return value.url;
  }
  return null;
}

const MEDIA_FORMATS = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-flv': 'flv',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/mp2t': 'ts',
  'video/mpeg': 'mpeg',

  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'oga',
  'audio/webm': 'weba',
  'audio/x-wav': 'wav',
  'audio/wav': 'wav',
  'audio/x-flac': 'flac',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/mp3': 'mp3',
  'audio/x-mpeg': 'mp3',
  'audio/mpeg3': 'mp3',
  'application/ogg': 'oga',

  'application/x-mpegurl': 'm3u8',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
  'application/x-mpegURL': 'm3u8',
  'audio/mpegurl': 'm3u8',
  'audio/x-mpegurl': 'm3u8',

  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/apng': 'apng',
  'image/tiff': 'tiff',
};

const EXTENSION_MAP: Record<string, string> = {
  '.mp4': 'mp4',
  '.webm': 'webm',
  '.ogv': 'ogv',
  '.flv': 'flv',
  '.mkv': 'mkv',
  '.mov': 'mov',
  '.avi': 'avi',
  '.3gp': '3gp',
  '.3g2': '3g2',
  '.mpeg': 'mpeg',
  '.mpg': 'mpeg',

  '.mp3': 'mp3',
  '.m4a': 'm4a',
  '.oga': 'oga',
  '.weba': 'weba',
  '.wav': 'wav',
  '.flac': 'flac',
  '.aac': 'aac',

  '.m3u8': 'm3u8',
  '.m3u': 'm3u8',
  '.mpd': 'mpd',

  '.gif': 'gif',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.png': 'png',
  '.webp': 'webp',
  '.svg': 'svg',
  '.avif': 'avif',
  '.bmp': 'bmp',
  '.ico': 'ico',
  '.heic': 'heic',
  '.heif': 'heif',
  '.apng': 'apng',
  '.tiff': 'tiff',
  '.tif': 'tiff',
};

export const SUPPORTED_MEDIA_TYPES = [
  'm3u8',
  'mpd',
  'mp4',
  'webm',
  'ogv',
  'flv',
  'mkv',
  'mov',
  'avi',
  '3gp',
  '3g2',
  'mpeg',
  'mp3',
  'm4a',
  'oga',
  'weba',
  'wav',
  'flac',
  'aac',
  'gif',
  'jpg',
  'png',
  'webp',
  'svg',
  'avif',
  'bmp',
  'ico',
  'heic',
  'heif',
  'apng',
  'tiff',
];

// Fragment extensions that are never standalone media files
const EXCLUDED_EXTENSIONS = [
  '.m4s',
  '.m4v',
  '.m4f',
  '.m4i',
  '.cmfv',
  '.cmfa',
  '.cmft',
  '.ts',
];

// Avoid false positives from tiny octet-stream responses
export const MIN_OCTET_STREAM_SIZE = 1 * 1024 * 1024;

const MEDIA_CDN_PATTERNS: RegExp[] = [
  /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokcdn-in|tiktokv|muscdn|musical|byteoversea)\.(?:com|cn|net|org|us|eu|in|gg|io|ly)\b/i,
  /\.(pstatp|toutiaovod|ixigua|xituovod|西瓜视频)\.(?:com|cn)\b/i,
  /\.(ks-yxcdn|kwaixiaodian|yx-fes|kscdn|qiniucdn|qcloudcdn)\.(?:com|cn)\b/i,
  /\.(polyv|videocc|myqcloud|alicdn|taobao|mmcdn)\.(?:com|cn)\b/i,
  /\.(xmcdn|ximalaya)\.(?:com|net|cn|org)\b/i,
];

export function isKnownMediaCdn(url: string): boolean {
  if (!url) {
    return false;
  }
  try {
    const hostname = new URL(url).hostname;
    return MEDIA_CDN_PATTERNS.some((re) => re.test(hostname));
  } catch {
    return MEDIA_CDN_PATTERNS.some((re) => re.test(url));
  }
}

const AUDIO_CDN_PATTERNS: RegExp[] = [
  /\.(xmcdn|ximalaya)\.(?:com|net|cn|org)\b/i,
  /\.(myqcloud)\.(?:com|cn)\b/i,
];

export function isKnownAudioCdn(url: string): boolean {
  if (!url) {
    return false;
  }
  try {
    const hostname = new URL(url).hostname;
    return AUDIO_CDN_PATTERNS.some((re) => re.test(hostname));
  } catch {
    return AUDIO_CDN_PATTERNS.some((re) => re.test(url));
  }
}

function isExcludedExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return EXCLUDED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function detectMediaFromContentType(contentType: string): string | null {
  if (!contentType) {
    return null;
  }

  const normalizedType = contentType.toLowerCase().split(';')[0]!.trim();
  const exact = (MEDIA_FORMATS as Record<string, string>)[normalizedType];
  if (exact) {
    return exact;
  }

  if (normalizedType.startsWith('audio/')) {
    return 'aac';
  }
  if (normalizedType.startsWith('video/')) {
    return 'mp4';
  }
  return null;
}

// Parse Content-Disposition filename (RFC 5987 and plain)
function parseContentDispositionFilename(
  contentDisposition: string
): string | null {
  if (!contentDisposition) {
    return null;
  }
  const lower = contentDisposition.toLowerCase();
  if (!lower.includes('attachment') && !lower.includes('inline')) {
    return null;
  }

  let filename: string | null = null;
  const rfc5987 = contentDisposition.match(
    /filename\*\s*=\s*(?:[^']*'[^']*')?([^;"\s]+)/i
  );
  if (rfc5987?.[1]) {
    try {
      filename = decodeURIComponent(rfc5987[1]);
    } catch {
      filename = rfc5987[1];
    }
  }

  if (!filename) {
    const plain =
      contentDisposition.match(/filename\s*=\s*"([^"]+)"/i) ??
      contentDisposition.match(/filename\s*=\s*([^;"\s]+)/i);
    if (plain?.[1]) {
      try {
        filename = decodeURIComponent(plain[1]);
      } catch {
        filename = plain[1];
      }
    }
  }

  return filename;
}

export function detectMediaFromContentDisposition(
  contentDisposition: string
): string | null {
  const filename = parseContentDispositionFilename(contentDisposition);
  if (!filename) {
    return null;
  }

  const ext = ('.' + filename.split('.').pop()!.toLowerCase()) as string;
  return EXTENSION_MAP[ext] ?? null;
}

const DATA_IMAGE_PREFIX = /^data:image\/([a-z0-9.+-]+)\s*(?:;([^,]*))?\s*,/i;
export function detectDataImageUrl(url: string): string | null {
  if (!url || !url.startsWith('data:')) {
    return null;
  }
  const match = url.match(DATA_IMAGE_PREFIX);
  if (!match) {
    return null;
  }
  const subtype = match[1]!.toLowerCase();
  const map: Record<string, string> = {
    png: 'png',
    jpeg: 'jpg',
    jpg: 'jpg',
    gif: 'gif',
    webp: 'webp',
    'svg+xml': 'svg',
    bmp: 'bmp',
    'x-icon': 'ico',
    'vnd.microsoft.icon': 'ico',
    avif: 'avif',
    heic: 'heic',
    heif: 'heif',
    apng: 'apng',
    tiff: 'tiff',
    tif: 'tiff',
  };
  return map[subtype] || null;
}

// Estimate decoded byte size of data: URLs (base64 or percent-encoded)
export function estimateDataUrlBytes(url: string): number {
  if (!url || !url.startsWith('data:')) {
    return 0;
  }
  const commaIdx = url.indexOf(',');
  if (commaIdx < 0) {
    return 0;
  }
  const meta = url.slice(0, commaIdx);
  const payload = url.slice(commaIdx + 1);
  if (meta.includes('base64')) {
    const cleaned = payload.replace(/\s/g, '');
    const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
    return Math.floor((cleaned.length * 3) / 4) - padding;
  }
  try {
    return decodeURIComponent(payload).length;
  } catch {
    return payload.length;
  }
}

export function detectMediaFromUrl(url: string): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();

    if (isExcludedExtension(pathname)) {
      return null;
    }

    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      if (pathname.endsWith(ext)) {
        return format;
      }
    }

    const lastSegment = pathname.split('/').pop() || '';
    const lastSegmentWithoutQuery = lastSegment.split('?')[0]!;
    const cleanSegment = lastSegmentWithoutQuery.split(/[~@]/)[0] || '';
    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      if (lastSegmentWithoutQuery.endsWith(ext) || cleanSegment.endsWith(ext)) {
        return format;
      }
    }

    const searchParams = parsed.searchParams;
    for (const [key, value] of searchParams) {
      const lowerKey = key.toLowerCase();
      const lowerValue = value.toLowerCase();

      if (
        lowerKey.includes('url') ||
        lowerKey.includes('file') ||
        lowerKey.includes('path') ||
        lowerKey.includes('stream')
      ) {
        for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
          if (
            lowerValue.includes(ext) &&
            (format === 'm3u8' || format === 'mpd')
          ) {
            return format;
          }
        }
      }
    }

    return null;
  } catch {
    const lowerUrl = url.toLowerCase();

    if (isExcludedExtension(lowerUrl)) {
      return null;
    }

    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      const extPattern = new RegExp(`\\${ext}(?:[?#]|$)`, 'i');
      if (extPattern.test(lowerUrl)) {
        return format;
      }
    }

    return null;
  }
}

export function detectFormatFromUrl(url: string): string | null {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) {
    return 'm3u8';
  }
  if (/\.mpd(?:[?#]|$)/i.test(url)) {
    return 'mpd';
  }
  if (/\.flv|\/flv/i.test(url)) {
    return 'flv';
  }
  const audioMatch = /\.(m4a|aac|mp3|oga|weba|wav|flac)(?:[?#]|$)/i.exec(url);
  if (audioMatch) {
    return audioMatch[1]!.toLowerCase();
  }
  return null;
}

export function detectMedia(
  url: string,
  contentType?: string | null,
  contentLength?: number,
  contentDisposition?: string | null
): string | null {
  if (url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (isExcludedExtension(pathname)) {
        return null;
      }
    } catch {
      if (isExcludedExtension(url.toLowerCase())) {
        return null;
      }
    }
  }

  if (contentType) {
    const normalized = contentType.toLowerCase().split(';')[0]!.trim();

    if (normalized === 'application/octet-stream') {
      const urlFmt = detectMediaFromUrl(url);
      if (urlFmt) {
        return urlFmt;
      }

      if (contentDisposition) {
        const cdFmt = detectMediaFromContentDisposition(contentDisposition);
        if (cdFmt) {
          return cdFmt;
        }
      }

      if (isKnownAudioCdn(url)) {
        return 'm4a';
      }
      const sizeOk =
        contentLength === undefined || contentLength >= MIN_OCTET_STREAM_SIZE;
      if (sizeOk && isKnownMediaCdn(url)) {
        return 'mp4';
      }
      return null;
    }

    const contentTypeFormat = detectMediaFromContentType(contentType);
    if (contentTypeFormat) {
      return contentTypeFormat;
    }
  }

  const urlFmt = detectMediaFromUrl(url);
  if (urlFmt) {
    return urlFmt;
  }
  if (contentDisposition) {
    return detectMediaFromContentDisposition(contentDisposition);
  }
  return null;
}

export type MediaCategory = 'media' | 'stream' | 'document' | 'subtitle';

const DOC_FORMATS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'application/epub+zip': 'epub',
  'text/csv': 'csv',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
};

const SUBTITLE_FORMATS: Record<string, string> = {
  'application/x-subrip': 'srt',
  'text/vtt': 'vtt',
  'text/x-ssa': 'ssa',
  'text/x-ass': 'ass',
  'application/ttml+xml': 'ttml',
};

const DOC_EXTENSION_MAP: Record<string, string> = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.xls': 'xls',
  '.xlsx': 'xlsx',
  '.ppt': 'ppt',
  '.pptx': 'pptx',
  '.epub': 'epub',
  '.csv': 'csv',
  '.rtf': 'rtf',
  '.srt': 'srt',
  '.vtt': 'vtt',
  '.ass': 'ass',
  '.ssa': 'ssa',
  '.ttml': 'ttml',
};

const SUBTITLE_CODES = ['srt', 'vtt', 'ass', 'ssa', 'ttml'];

export function detectDocFromContentType(contentType: string): string | null {
  if (!contentType) {
    return null;
  }
  const normalized = contentType.toLowerCase().split(';')[0]!.trim();
  return DOC_FORMATS[normalized] || SUBTITLE_FORMATS[normalized] || null;
}

export function detectDocFromUrl(url: string): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (pathname.endsWith(ext)) {
        return format;
      }
    }
    const lastSegment = pathname.split('/').pop()?.split('?')[0] || '';
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (lastSegment.endsWith(ext)) {
        return format;
      }
    }
    return null;
  } catch {
    const lower = url.toLowerCase();
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (new RegExp(`\\${ext}(?:[?#]|$)`, 'i').test(lower)) {
        return format;
      }
    }
    return null;
  }
}

export function detectDocFromContentDisposition(
  contentDisposition: string
): string | null {
  const filename = parseContentDispositionFilename(contentDisposition);
  if (!filename) {
    return null;
  }

  const ext = ('.' + filename.split('.').pop()!.toLowerCase()) as string;
  return DOC_EXTENSION_MAP[ext] ?? null;
}

export function detectDoc(
  url: string,
  contentType?: string | null,
  contentDisposition?: string | null
): { format: string; category: MediaCategory } | null {
  if (url) {
    try {
      if (isExcludedExtension(new URL(url).pathname.toLowerCase())) {
        return null;
      }
    } catch {
      if (isExcludedExtension(url.toLowerCase())) {
        return null;
      }
    }
  }

  let format: string | null = null;
  if (contentType) {
    format = detectDocFromContentType(contentType);
  }
  if (!format && contentDisposition) {
    format = detectDocFromContentDisposition(contentDisposition);
  }
  if (!format) {
    format = detectDocFromUrl(url);
  }
  if (!format) {
    return null;
  }

  const category: MediaCategory = SUBTITLE_CODES.includes(format)
    ? 'subtitle'
    : 'document';
  return { format, category };
}
