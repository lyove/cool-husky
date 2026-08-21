import browser from 'webextension-polyfill';

export type SniffingGroup =
  'streaming' | 'video' | 'audio' | 'image' | 'document' | 'subtitle';

export interface SniffingRule {
  enabled: boolean;
  minSizeKB: number;
}

export type SniffingRules = Record<SniffingGroup, SniffingRule>;

export type OpenMode = 'sidepanel' | 'popup';

/**
 * A user-defined regex rule for matching or blocking URLs.
 * - action 'match': capture the URL as the given format (overrides detection)
 * - action 'block': never capture this URL
 */
export interface RegexRule {
  /** Raw regex source string, e.g. "https://.*\.example\.com/video". */
  pattern: string;
  /** Regex flags, e.g. "i". */
  flags: string;
  /** 'match' to force-capture as `format`, 'block' to suppress. */
  action: 'match' | 'block';
  /** Output format when action === 'match' (e.g. 'mp4', 'm3u8'). */
  format?: string;
  /** Whether the rule is active. */
  enabled: boolean;
}

export type RegexRules = RegexRule[];

/**
 * Per-format override layer. Keys are concrete format strings (e.g. 'mp4',
 * 'm3u8', 'mp3'). When a key is present, its values override the 6-group
 * defaults for that specific format. Missing fields fall back to the group.
 */
export interface FormatOverride {
  enabled?: boolean;
  minSizeKB?: number;
  /** Comparison operator for size filtering. Defaults to '>='. */
  operator?: '>=' | '>' | '<=' | '<' | '==' | '!=';
}

export type FormatOverrides = Record<string, FormatOverride>;

const SIZE_OPERATORS: Record<string, (a: number, b: number) => boolean> = {
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '<': (a, b) => a < b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

export interface Settings {
  sniffingRules: SniffingRules;
  excludeDomains: string[];
  maxItems: number;
  enableMseCapture: boolean;
  hideStreamSegments: boolean;
  captureDataImages: boolean;
  dataImageMinSizeKB: number;
  openMode: OpenMode;
  enableDeepSearch: boolean;
  regexRules: RegexRules;
  formatOverrides: FormatOverrides;
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
  enableDeepSearch: false,
  regexRules: [],
  formatOverrides: {},
};

const SETTINGS_KEY = 'coolhusky_settings';

function toStringArray(val: any): string[] {
  if (Array.isArray(val)) {
    return val.filter((v) => typeof v === 'string');
  }
  if (val && typeof val === 'object') {
    return Object.values(val).filter((v) => typeof v === 'string') as string[];
  }
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
      enableDeepSearch: DEFAULT_SETTINGS.enableDeepSearch,
      regexRules: [],
      formatOverrides: {},
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
    enableDeepSearch:
      typeof stored.enableDeepSearch === 'boolean'
        ? stored.enableDeepSearch
        : false,
    regexRules: Array.isArray(stored.regexRules)
      ? stored.regexRules
          .filter((r: any) => r && typeof r === 'object')
          .map((r: any) => {
            return {
              pattern: typeof r.pattern === 'string' ? r.pattern : '',
              flags: typeof r.flags === 'string' ? r.flags : 'i',
              action: r.action === 'block' ? 'block' : 'match',
              format: typeof r.format === 'string' ? r.format : undefined,
              enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
            };
          })
      : [],
    formatOverrides:
      stored.formatOverrides && typeof stored.formatOverrides === 'object'
        ? Object.entries(stored.formatOverrides).reduce((acc, [key, val]) => {
            if (val && typeof val === 'object') {
              const v = val as Record<string, unknown>;
              acc[key] = {
                enabled: typeof v.enabled === 'boolean' ? v.enabled : undefined,
                minSizeKB:
                  typeof v.minSizeKB === 'number' ? v.minSizeKB : undefined,
                operator:
                  v.operator && SIZE_OPERATORS[v.operator as string]
                    ? (v.operator as FormatOverride['operator'])
                    : undefined,
              };
            }
            return acc;
          }, {} as FormatOverrides)
        : {},
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
      enableDeepSearch: settings.enableDeepSearch,
      regexRules: Array.isArray(settings.regexRules) ? settings.regexRules : [],
      formatOverrides:
        settings.formatOverrides && typeof settings.formatOverrides === 'object'
          ? settings.formatOverrides
          : {},
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
  if (f === 'mse') {
    return 'streaming';
  }
  if (STREAMING_FORMATS.includes(f)) {
    return 'streaming';
  }
  if (VIDEO_FORMATS.includes(f)) {
    return 'video';
  }
  if (AUDIO_FORMATS.includes(f)) {
    return 'audio';
  }
  if (IMAGE_FORMATS.includes(f)) {
    return 'image';
  }
  if (DOCUMENT_FORMATS.includes(f)) {
    return 'document';
  }
  if (SUBTITLE_FORMATS.includes(f)) {
    return 'subtitle';
  }
  return null;
}

export function isFormatAllowed(format: string, settings: Settings): boolean {
  const f = format.toLowerCase();
  // Per-format override takes precedence over group default.
  const override = settings.formatOverrides?.[f];
  if (override && typeof override.enabled === 'boolean') {
    return override.enabled;
  }
  const group = getFormatGroup(f);
  if (!group) {
    return false;
  }
  return settings.sniffingRules[group].enabled;
}

export function isMediaAllowed(
  format: string,
  settings: Settings,
  category?: string,
  _groupRole?: string
): boolean {
  const f = format.toLowerCase();

  const isStreamUi =
    category === 'stream' ||
    f === 'mse' ||
    f === 'flv' ||
    STREAMING_FORMATS.includes(f);
  if (isStreamUi && !settings.sniffingRules.streaming.enabled) {
    return false;
  }

  const group = getFormatGroup(f);
  if (!group) {
    return false;
  }
  return settings.sniffingRules[group].enabled;
}

export function isSizeAllowed(
  format: string,
  contentLength: number | undefined,
  settings: Settings
): boolean {
  if (contentLength === undefined) {
    return true;
  }
  const f = format.toLowerCase();
  // Per-format override takes precedence: use its minSizeKB + operator.
  const override = settings.formatOverrides?.[f];
  if (override && typeof override.minSizeKB === 'number') {
    const thresholdBytes = override.minSizeKB * 1024;
    const op = override.operator ?? '>=';
    const fn = SIZE_OPERATORS[op] ?? SIZE_OPERATORS['>='];
    return fn
      ? fn(contentLength, thresholdBytes)
      : contentLength >= thresholdBytes;
  }
  const group = getFormatGroup(f);
  if (!group) {
    return true;
  }
  const minSizeKB = settings.sniffingRules[group].minSizeKB;
  if (minSizeKB <= 0) {
    return true;
  }
  return contentLength >= minSizeKB * 1024;
}

// Hardcoded exclusions not exposed in user settings
const _HIDDEN_EXCLUDED_DOMAINS = ['youtube.com'];

function matchesExcludedDomain(hostname: string, domain: string): boolean {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (!d) {
    return false;
  }
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return host === d || host.endsWith(`.${d}`);
}

export function isDomainExcluded(url: string, settings: Settings): boolean {
  try {
    const hostname = new URL(url).hostname;
    const userExcluded = settings.excludeDomains.some((domain) =>
      matchesExcludedDomain(hostname, domain)
    );
    if (userExcluded) {
      return true;
    }
    return _HIDDEN_EXCLUDED_DOMAINS.some((domain) =>
      matchesExcludedDomain(hostname, domain)
    );
  } catch {
    return false;
  }
}

/**
 * Result of evaluating regex rules against a URL.
 * - 'block': the URL should be suppressed entirely.
 * - { format }: the URL should be force-captured as this format.
 * - null: no rule matched, fall through to normal detection.
 */
export type RegexMatchResult = 'block' | { format: string } | null;

/**
 * Evaluate user-defined regex rules against a URL.
 * Returns the first matching rule's action, or null if none match.
 */
export function matchRegexRules(
  url: string,
  settings: Settings
): RegexMatchResult {
  if (!settings.regexRules || settings.regexRules.length === 0) {
    return null;
  }
  for (const rule of settings.regexRules) {
    if (!rule.enabled || !rule.pattern) {
      continue;
    }
    try {
      const re = new RegExp(rule.pattern, rule.flags || 'i');
      if (re.test(url)) {
        if (rule.action === 'block') {
          return 'block';
        }
        if (rule.format) {
          return { format: rule.format };
        }
      }
    } catch {
      // invalid regex — skip this rule
      continue;
    }
  }
  return null;
}
