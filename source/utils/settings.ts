import browser from 'webextension-polyfill';

export type SniffingGroup =
  | 'streaming'
  | 'video'
  | 'audio'
  | 'image'
  | 'document'
  | 'subtitle';

export interface SniffingRule {
  enabled: boolean;
  minSizeKB: number;
}

export type SniffingRules = Record<SniffingGroup, SniffingRule>;

export type OpenMode = 'sidepanel' | 'popup';

export interface Settings {
  sniffingRules: SniffingRules;
  excludeDomains: string[];
  maxItems: number;
  enableMseCapture: boolean;
  /** Hide HLS/DASH segments (e.g. .ts/.m4s), showing only parent playlists (m3u8/mpd). */
  hideStreamSegments: boolean;
  /** Capture data: URL embedded images (only <img src="data:image/...">), off by default. */
  captureDataImages: boolean;
  /** Minimum byte threshold (KB) for data: images, filtering out tiny 1x1 pixel trackers. */
  dataImageMinSizeKB: number;
  /** How the toolbar icon opens the UI: 'sidepanel' (right dock) or 'popup' (floating). */
  openMode: OpenMode;
}

export const DEFAULT_MAX_ITEMS = 1000;

export const DEFAULT_SNIFFING_RULES: SniffingRules = {
  streaming: { enabled: true, minSizeKB: 0 },
  video: { enabled: true, minSizeKB: 100 },
  audio: { enabled: true, minSizeKB: 1 },
  image: { enabled: false, minSizeKB: 10 },
  document: { enabled: false, minSizeKB: 0 },
  subtitle: { enabled: false, minSizeKB: 0 },
};

export const DEFAULT_SETTINGS: Settings = {
  sniffingRules: {
    streaming: { ...DEFAULT_SNIFFING_RULES.streaming },
    video: { ...DEFAULT_SNIFFING_RULES.video },
    audio: { ...DEFAULT_SNIFFING_RULES.audio },
    image: { ...DEFAULT_SNIFFING_RULES.image },
    document: { ...DEFAULT_SNIFFING_RULES.document },
    subtitle: { ...DEFAULT_SNIFFING_RULES.subtitle },
  },
  excludeDomains: [],
  maxItems: DEFAULT_MAX_ITEMS,
  enableMseCapture: false,
  hideStreamSegments: true,
  captureDataImages: false,
  dataImageMinSizeKB: 50,
  openMode: 'sidepanel',
};

const SETTINGS_KEY = 'coolhusky_settings';

function toStringArray(val: any): string[] {
  if (Array.isArray(val)) return val.filter((v) => typeof v === 'string');
  if (val && typeof val === 'object')
    return Object.values(val).filter((v) => typeof v === 'string') as string[];
  return [];
}

function parseSniffingRules(stored: any): SniffingRules {
  const groups: SniffingGroup[] = [
    'streaming',
    'video',
    'audio',
    'image',
    'document',
    'subtitle',
  ];
  const result = {} as SniffingRules;
  for (const g of groups) {
    const def = DEFAULT_SNIFFING_RULES[g];
    const raw = stored?.[g];
    if (raw && typeof raw === 'object' && 'enabled' in raw) {
      result[g] = {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : def.enabled,
        minSizeKB:
          typeof raw.minSizeKB === 'number' ? raw.minSizeKB : def.minSizeKB,
      };
    } else if (typeof raw === 'boolean') {
      result[g] = { enabled: raw, minSizeKB: def.minSizeKB };
    } else {
      result[g] = { ...def };
    }
  }
  return result;
}

export async function loadSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as any;
  if (!stored || typeof stored !== 'object') {
    return {
      sniffingRules: { ...DEFAULT_SETTINGS.sniffingRules },
      excludeDomains: [...DEFAULT_SETTINGS.excludeDomains],
      maxItems: DEFAULT_SETTINGS.maxItems,
      enableMseCapture: DEFAULT_SETTINGS.enableMseCapture,
      hideStreamSegments: DEFAULT_SETTINGS.hideStreamSegments,
      captureDataImages: DEFAULT_SETTINGS.captureDataImages,
      dataImageMinSizeKB: DEFAULT_SETTINGS.dataImageMinSizeKB,
      openMode: DEFAULT_SETTINGS.openMode,
    };
  }
  const rawMax = stored.maxItems;
  const maxItems =
    typeof rawMax === 'number' && rawMax > 0
      ? Math.floor(rawMax)
      : DEFAULT_MAX_ITEMS;
  return {
    sniffingRules: parseSniffingRules(
      stored.sniffingRules ?? stored.sniffingGroups
    ),
    excludeDomains: toStringArray(stored.excludeDomains),
    maxItems,
    enableMseCapture:
      typeof stored.enableMseCapture === 'boolean'
        ? stored.enableMseCapture
        : false,
    hideStreamSegments:
      typeof stored.hideStreamSegments === 'boolean'
        ? stored.hideStreamSegments
        : true,
    captureDataImages:
      typeof stored.captureDataImages === 'boolean'
        ? stored.captureDataImages
        : false,
    dataImageMinSizeKB:
      typeof stored.dataImageMinSizeKB === 'number'
        ? stored.dataImageMinSizeKB
        : 50,
    openMode:
      stored.openMode === 'popup' || stored.openMode === 'sidepanel'
        ? stored.openMode
        : DEFAULT_SETTINGS.openMode,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({
    [SETTINGS_KEY]: {
      sniffingRules: settings.sniffingRules,
      excludeDomains: Array.from(settings.excludeDomains),
      maxItems: settings.maxItems,
      enableMseCapture: settings.enableMseCapture,
      hideStreamSegments: settings.hideStreamSegments,
      captureDataImages: settings.captureDataImages,
      dataImageMinSizeKB: settings.dataImageMinSizeKB,
      openMode: settings.openMode,
    },
  });
}

export const STREAMING_FORMATS = ['m3u8', 'mpd'];
export const VIDEO_FORMATS = [
  'mp4',
  'webm',
  'ogv',
  'flv',
  'mkv',
  'mov',
  'avi',
  '3gp',
  '3g2',
  'ts',
  'mpeg',
];
export const AUDIO_FORMATS = [
  'mp3',
  'm4a',
  'oga',
  'weba',
  'wav',
  'flac',
  'aac',
];
export const IMAGE_FORMATS = [
  'gif',
  'jpg',
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
export const DOCUMENT_FORMATS = [
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
];
export const SUBTITLE_FORMATS = ['srt', 'vtt', 'ass', 'ssa'];

export function getFormatGroup(format: string): SniffingGroup | null {
  const f = format.toLowerCase();
  // Synthetic MSE streams are surfaced as streaming resources so the
  // streaming sniff switch and minSizeKB rule apply to them as well.
  if (f === 'mse') return 'streaming';
  if (STREAMING_FORMATS.includes(f)) return 'streaming';
  if (VIDEO_FORMATS.includes(f)) return 'video';
  if (AUDIO_FORMATS.includes(f)) return 'audio';
  if (IMAGE_FORMATS.includes(f)) return 'image';
  if (DOCUMENT_FORMATS.includes(f)) return 'document';
  if (SUBTITLE_FORMATS.includes(f)) return 'subtitle';
  return null;
}

export function isFormatAllowed(format: string, settings: Settings): boolean {
  const group = getFormatGroup(format.toLowerCase());
  if (!group) return false;
  return settings.sniffingRules[group].enabled;
}

/**
 * Whether an already-captured item should be shown / counted.
 * Unlike `isFormatAllowed`, this also respects the UI display type:
 * entries with `category: 'stream'` (e.g. grouped Douyin/Bilibili tasks)
 * are shown under the Stream tab and must therefore obey the streaming
 * switch, even though their underlying format is a plain mp4/webm.
 */
export function isMediaAllowed(
  format: string,
  settings: Settings,
  category?: string,
  _groupRole?: string
): boolean {
  const f = format.toLowerCase();

  // UI-type gate: items displayed as streams must obey the streaming switch.
  // Must mirror getType(): flv is grouped under the Stream tab as well, even
  // though it also lives in the video format list.
  const isStreamUi =
    category === 'stream' ||
    f === 'mse' ||
    f === 'flv' ||
    STREAMING_FORMATS.includes(f);
  if (isStreamUi && !settings.sniffingRules.streaming.enabled) {
    return false;
  }

  // Underlying format gate: mp4 still needs video switch, m4a needs audio, etc.
  const group = getFormatGroup(f);
  if (!group) return false;
  return settings.sniffingRules[group].enabled;
}

export function isSizeAllowed(
  format: string,
  contentLength: number | undefined,
  settings: Settings
): boolean {
  if (contentLength === undefined) return true;
  const group = getFormatGroup(format.toLowerCase());
  if (!group) return true;
  const minSizeKB = settings.sniffingRules[group].minSizeKB;
  if (minSizeKB <= 0) return true;
  return contentLength >= minSizeKB * 1024;
}

const _HIDDEN_EXCLUDED_DOMAINS = ['youtube.com'];

function matchesExcludedDomain(hostname: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^www\./, '');
  if (!d) return false;
  const host = hostname.toLowerCase().replace(/^www\./, '');
  // Match the registrable domain itself (youtube.com) or any of its subdomains
  // (www. / m. / music.youtube.com). A plain equality check would miss
  // www.youtube.com, making the exclusion silently ineffective.
  return host === d || host.endsWith(`.${d}`);
}

export function isDomainExcluded(url: string, settings: Settings): boolean {
  try {
    const hostname = new URL(url).hostname;
    const userExcluded = settings.excludeDomains.some((domain) =>
      matchesExcludedDomain(hostname, domain)
    );
    if (userExcluded) return true;
    return _HIDDEN_EXCLUDED_DOMAINS.some((domain) =>
      matchesExcludedDomain(hostname, domain)
    );
  } catch {
    return false;
  }
}
