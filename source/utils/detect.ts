export function normalizeUrl(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.toString();
  if (typeof Request !== 'undefined' && value instanceof Request)
    return value.url;
  return null;
}

// Media format configuration
const MEDIA_FORMATS = {
  // Video formats
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

  // Audio formats
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
  // Some servers report MP3 as audio/mp3 or audio/x-mpeg instead of audio/mpeg
  'audio/mp3': 'mp3',
  'audio/x-mpeg': 'mp3',
  'audio/mpeg3': 'mp3',
  // OGG audio is occasionally served as application/ogg
  'application/ogg': 'oga',

  // Streaming formats
  'application/x-mpegurl': 'm3u8',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
  'application/x-mpegURL': 'm3u8',
  // HLS audio playlists sometimes use audio/* MIME types
  'audio/mpegurl': 'm3u8',
  'audio/x-mpegurl': 'm3u8',

  // Images
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

// File extension to format mapping
const EXTENSION_MAP: Record<string, string> = {
  // Video
  '.mp4': 'mp4',
  // '.m4v': 'mp4',
  '.webm': 'webm',
  '.ogv': 'ogv',
  '.flv': 'flv',
  '.mkv': 'mkv',
  '.mov': 'mov',
  '.avi': 'avi',
  '.3gp': '3gp',
  '.3g2': '3g2',
  // '.ts': 'ts',
  '.mpeg': 'mpeg',
  '.mpg': 'mpeg',

  // Audio
  '.mp3': 'mp3',
  '.m4a': 'm4a',
  '.oga': 'oga',
  '.weba': 'weba',
  '.wav': 'wav',
  '.flac': 'flac',
  '.aac': 'aac',

  // Streaming
  '.m3u8': 'm3u8',
  '.m3u': 'm3u8',
  '.mpd': 'mpd',

  // Images
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

// Supported media types (used for filtering)
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

// Excluded media types (DASH/HLS segment formats, not shown individually)
// Note: .m4a is intentionally NOT excluded — it is a complete MPEG-4 audio file,
// commonly used by Ximalaya (xmcdn) and other audio platforms. Only container
// fragments (.m4s/.m4f/...) and MPEG-2 transport segments (.ts) are excluded.
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

// Minimum file size (1MB) for application/octet-stream to be treated as media; below this threshold it is not media
export const MIN_OCTET_STREAM_SIZE = 1 * 1024 * 1024;

// Known media CDN domain signatures (fallback recognition by domain for extension-less URLs with octet-stream)
// Douyin/TikTok/ByteDance: douyinvod, bytecdn, byteimg, bytego, bytedns, amemv, iesdouyin, snssdk,
// tiktokcdn, tiktokv, byteoversea, ...
// Other common media CDNs: polyv, qiniu(my-qiniu), ks-cdn(Kuaishou), taobao/alicdn
const MEDIA_CDN_PATTERNS: RegExp[] = [
  /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokcdn-in|tiktokv|muscdn|musical|byteoversea)\.(?:com|cn|net|org|us|eu|in|gg|io|ly)\b/i,
  /\.(pstatp|toutiaovod|ixigua|xituovod|西瓜视频)\.(?:com|cn)\b/i,
  /\.(ks-yxcdn|kwaixiaodian|yx-fes|kscdn|qiniucdn|qcloudcdn)\.(?:com|cn)\b/i,
  /\.(polyv|videocc|myqcloud|alicdn|taobao|mmcdn)\.(?:com|cn)\b/i,
  // Ximalaya audio CDN: aod.cos.tx.xmcdn.com / audio.xmcdn.com etc.
  /\.(xmcdn|ximalaya)\.(?:com|net|cn|org)\b/i,
];

export function isKnownMediaCdn(url: string): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return MEDIA_CDN_PATTERNS.some((re) => re.test(hostname));
  } catch {
    return MEDIA_CDN_PATTERNS.some((re) => re.test(url));
  }
}

// Known AUDIO-only CDN signatures (e.g. Ximalaya's xmcdn, Tencent Cloud COS).
// Extension-less audio URLs served as application/octet-stream must be
// classified as audio, not video. Tencent COS buckets (*.myqcloud.com) are
// commonly used by Ximalaya AIGC tools (aigc.ximalaya.com) to host audio
// previews, whose URLs often carry no file extension.
const AUDIO_CDN_PATTERNS: RegExp[] = [
  /\.(xmcdn|ximalaya)\.(?:com|net|cn|org)\b/i,
  /\.(myqcloud)\.(?:com|cn)\b/i,
];

export function isKnownAudioCdn(url: string): boolean {
  if (!url) return false;
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

// Detect media format from content-type
export function detectMediaFromContentType(contentType: string): string | null {
  if (!contentType) return null;

  const normalizedType = contentType.toLowerCase().split(';')[0]!.trim();
  const exact = (MEDIA_FORMATS as Record<string, string>)[normalizedType];
  if (exact) return exact;

  // Wildcard fallback: audio/* and video/* variants not listed in the exact
  // map (e.g. audio/x-wav variants, video/x-ms-wmv) are still media content.
  // Prefer a neutral container so the file remains downloadable even when the
  // precise codec is unknown. (Inspired by Media-Extractor's type rules.)
  if (normalizedType.startsWith('audio/')) return 'aac';
  if (normalizedType.startsWith('video/')) return 'mp4';
  return null;
}

// Parse the filename out of a Content-Disposition header.
// Supports both filename="foo.mp4" and filename*=UTF-8''foo.mp4 forms.
// Returns null when the header is missing, has no attachment/inline directive,
// or carries no parseable filename.
function parseContentDispositionFilename(
  contentDisposition: string
): string | null {
  if (!contentDisposition) return null;
  const lower = contentDisposition.toLowerCase();
  if (!lower.includes('attachment') && !lower.includes('inline')) return null;

  // Prefer matching filename*=UTF-8''xxx or filename*=xxx
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

  // Fall back to filename="xxx" or filename=xxx
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

// Detect media format from Content-Disposition filename. Many CDNs serve
// extension-less URLs as application/octet-stream but expose the real file
// name (e.g. attachment; filename="song.mp4") in this header — reading it
// lets us capture media that URL/type detection would otherwise drop.
// (Inspired by Media-Extractor's response-header sniffing.)
export function detectMediaFromContentDisposition(
  contentDisposition: string
): string | null {
  const filename = parseContentDispositionFilename(contentDisposition);
  if (!filename) return null;

  const ext = ('.' + filename.split('.').pop()!.toLowerCase()) as string;
  return EXTENSION_MAP[ext] ?? null;
}

// data: URL embedded image detection
// Parses data:image/png;base64,... and returns the image format (png/jpg/gif/webp/svg)
// Returns null for non-data: URLs or non-image types
const DATA_IMAGE_PREFIX = /^data:image\/([a-z0-9.+-]+)\s*(?:;([^,]*))?\s*,/i;
export function detectDataImageUrl(url: string): string | null {
  if (!url || !url.startsWith('data:')) return null;
  const match = url.match(DATA_IMAGE_PREFIX);
  if (!match) return null;
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

// Estimate the byte size of a data: URL (actual bytes after base64 decoding)
export function estimateDataUrlBytes(url: string): number {
  if (!url || !url.startsWith('data:')) return 0;
  const commaIdx = url.indexOf(',');
  if (commaIdx < 0) return 0;
  const meta = url.slice(0, commaIdx);
  const payload = url.slice(commaIdx + 1);
  // base64 encoding: every 4 chars ≈ 3 bytes, ignoring padding and newlines
  if (meta.includes('base64')) {
    const cleaned = payload.replace(/\s/g, '');
    const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
    return Math.floor((cleaned.length * 3) / 4) - padding;
  }
  // URL encoding: decoded length approximates char count
  try {
    return decodeURIComponent(payload).length;
  } catch {
    return payload.length;
  }
}

// Detect media format from URL (stricter detection to avoid false positives)
export function detectMediaFromUrl(url: string): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();

    // Exclude DASH/HLS segment formats
    if (isExcludedExtension(pathname)) {
      return null;
    }

    // Only check the complete file extension at the end of the path
    // Avoid matching keywords in the middle of the URL path or in query params
    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      // Strict match: path must end with the extension
      if (pathname.endsWith(ext)) {
        return format;
      }
    }

    // For extension-less URLs, check common media file path patterns
    const lastSegment = pathname.split('/').pop() || '';

    // Check common media file naming patterns (e.g. video.mp4?token=xxx)
    // In this case the extension may appear before query params
    const lastSegmentWithoutQuery = lastSegment.split('?')[0]!;
    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      if (lastSegmentWithoutQuery.endsWith(ext)) {
        return format;
      }
    }

    // Check for streaming playlists (m3u8/mpd usually specified in query params)
    const searchParams = parsed.searchParams;
    for (const [key, value] of searchParams) {
      const lowerKey = key.toLowerCase();
      const lowerValue = value.toLowerCase();

      // Check common streaming params
      if (
        lowerKey.includes('url') ||
        lowerKey.includes('file') ||
        lowerKey.includes('path') ||
        lowerKey.includes('stream')
      ) {
        // Check whether the value contains a streaming extension
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
    // If URL parsing fails, do a conservative detection
    const lowerUrl = url.toLowerCase();

    // Exclude DASH/HLS segment formats
    if (isExcludedExtension(lowerUrl)) {
      return null;
    }

    // Only check obvious extension patterns (preceded by a dot, followed by query params or end)
    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      const extPattern = new RegExp(`\\${ext}(?:[?#]|$)`, 'i');
      if (extPattern.test(lowerUrl)) {
        return format;
      }
    }

    return null;
  }
}

/**
 * Infer a format label from a raw media URL (used when pairing Douyin/TikTok
 * separated audio/video streams). Covers HLS/DASH/FLV and common audio
 * extensions; anything else falls back to mp4.
 */
export function detectFormatFromUrl(url: string): string {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'm3u8';
  if (/\.mpd(?:[?#]|$)/i.test(url)) return 'mpd';
  if (/\.flv|\/flv/i.test(url)) return 'flv';
  const audioMatch = /\.(m4a|aac|mp3|oga|weba|wav|flac)(?:[?#]|$)/i.exec(url);
  if (audioMatch) return audioMatch[1]!.toLowerCase();
  return 'mp4';
}

// Detect whether it is a supported media format
export function isMediaFormat(value: unknown): boolean {
  const url = normalizeUrl(value);
  if (!url) return false;

  const format = detectMediaFromUrl(url);
  return format !== null && SUPPORTED_MEDIA_TYPES.includes(format);
}

// Detect whether it is a video format
export function isVideoFormat(value: unknown): boolean {
  const url = normalizeUrl(value);
  if (!url) return false;

  const format = detectMediaFromUrl(url);
  const videoFormats = ['mp4', 'webm'];
  return format !== null && videoFormats.includes(format);
}

// Detect whether it is an audio format
export function isAudioFormat(value: unknown): boolean {
  const url = normalizeUrl(value);
  if (!url) return false;

  const format = detectMediaFromUrl(url);
  const audioFormats = ['mp3', 'm4a', 'oga', 'weba', 'wav', 'flac', 'aac'];
  return format !== null && audioFormats.includes(format);
}

// Detect whether it is an image format
export function isImageFormat(value: unknown): boolean {
  const url = normalizeUrl(value);
  if (!url) return false;

  const format = detectMediaFromUrl(url);
  const imageFormats = [
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
  return format !== null && imageFormats.includes(format);
}

// Backwards-compatible M3U8 detection function
export function isM3U8(value: unknown): boolean {
  const url = normalizeUrl(value);
  if (!url) return false;

  const format = detectMediaFromUrl(url);
  return format === 'm3u8';
}

// Combined detection: prefer content-type, fall back to URL detection
// contentLength: file size in bytes, used for application/octet-stream size filtering
// contentDisposition: Content-Disposition header value; when the URL has no
// usable extension and the type is generic, the attachment filename is the
// most reliable remaining signal (inspired by Media-Extractor).
export function detectMedia(
  url: string,
  contentType?: string | null,
  contentLength?: number,
  contentDisposition?: string | null
): string | null {
  // 0. Exclude DASH/HLS segments first
  if (url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (isExcludedExtension(pathname)) return null;
    } catch {
      if (isExcludedExtension(url.toLowerCase())) return null;
    }
  }

  // 1. Prefer Content-Type detection (most accurate)
  if (contentType) {
    const normalized = contentType.toLowerCase().split(';')[0]!.trim();

    // application/octet-stream: generic binary stream with no type info.
    // The URL extension is the most reliable signal, so check it FIRST regardless
    // of size — small audio files (ringtones, sound effects, preview clips) would
    // otherwise be dropped below the size threshold.
    if (normalized === 'application/octet-stream') {
      const urlFmt = detectMediaFromUrl(url);
      if (urlFmt) return urlFmt;

      // Extension-less URLs: the Content-Disposition attachment filename is the
      // next most reliable signal (e.g. attachment; filename="song.mp4").
      if (contentDisposition) {
        const cdFmt = detectMediaFromContentDisposition(contentDisposition);
        if (cdFmt) return cdFmt;
      }

      // Extension-less URLs from known CDNs: audio CDNs (e.g. Ximalaya xmcdn)
      // default to m4a regardless of size; generic media CDNs (Douyin/ByteDance/
      // Kuaishou etc.) are treated as video and still require a meaningful size
      // to avoid false positives.
      if (isKnownAudioCdn(url)) return 'm4a';
      const sizeOk =
        contentLength === undefined || contentLength >= MIN_OCTET_STREAM_SIZE;
      if (sizeOk && isKnownMediaCdn(url)) return 'mp4';
      return null;
    }

    const contentTypeFormat = detectMediaFromContentType(contentType);
    if (contentTypeFormat) return contentTypeFormat;
  }

  // 2. Fallback: URL detection, then Content-Disposition filename
  const urlFmt = detectMediaFromUrl(url);
  if (urlFmt) return urlFmt;
  if (contentDisposition)
    return detectMediaFromContentDisposition(contentDisposition);
  return null;
}

// ============ Document / Subtitle format detection ============
export type MediaCategory = 'media' | 'stream' | 'document' | 'subtitle';

// Document (Office / PDF) Content-Type to short-code mapping
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

// Subtitle Content-Type to short-code mapping
const SUBTITLE_FORMATS: Record<string, string> = {
  'application/x-subrip': 'srt',
  'text/vtt': 'vtt',
  'text/x-ssa': 'ssa',
  'text/x-ass': 'ass',
  'application/ttml+xml': 'ttml',
};

// Document / subtitle file extension to short-code mapping
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

// Detect document/subtitle format from content-type
export function detectDocFromContentType(contentType: string): string | null {
  if (!contentType) return null;
  const normalized = contentType.toLowerCase().split(';')[0]!.trim();
  return DOC_FORMATS[normalized] || SUBTITLE_FORMATS[normalized] || null;
}

// Detect document/subtitle format from URL (strict extension match)
export function detectDocFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (pathname.endsWith(ext)) return format;
    }
    const lastSegment = pathname.split('/').pop()?.split('?')[0] || '';
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (lastSegment.endsWith(ext)) return format;
    }
    return null;
  } catch {
    const lower = url.toLowerCase();
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (new RegExp(`\\${ext}(?:[?#]|$)`, 'i').test(lower)) return format;
    }
    return null;
  }
}

// Parse filename from Content-Disposition header, extract extension and map to format
// Supports both filename="foo.pdf" and filename*=UTF-8''foo.pdf forms
export function detectDocFromContentDisposition(
  contentDisposition: string
): string | null {
  const filename = parseContentDispositionFilename(contentDisposition);
  if (!filename) return null;

  // Extract extension and look up document/subtitle mapping
  const ext = ('.' + filename.split('.').pop()!.toLowerCase()) as string;
  return DOC_EXTENSION_MAP[ext] ?? null;
}

// Combined document/subtitle detection: content-type first, then Content-Disposition, then URL extension
export function detectDoc(
  url: string,
  contentType?: string | null,
  contentDisposition?: string | null
): { format: string; category: MediaCategory } | null {
  // Exclude DASH/HLS segments so .m4s etc. are not misidentified as documents
  if (url) {
    try {
      if (isExcludedExtension(new URL(url).pathname.toLowerCase())) return null;
    } catch {
      if (isExcludedExtension(url.toLowerCase())) return null;
    }
  }

  let format: string | null = null;
  if (contentType) format = detectDocFromContentType(contentType);
  if (!format && contentDisposition)
    format = detectDocFromContentDisposition(contentDisposition);
  if (!format) format = detectDocFromUrl(url);
  if (!format) return null;

  const category: MediaCategory = SUBTITLE_CODES.includes(format)
    ? 'subtitle'
    : 'document';
  return { format, category };
}
