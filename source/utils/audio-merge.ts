import audioBufferToWav from 'audiobuffer-to-wav';
import browser from 'webextension-polyfill';

export interface MergeableAudioItem {
  url: string;
  format: string;
  requestHeaders?: Record<string, string>;
}

export interface MergeProgress {
  current: number;
  total: number;
  phase: 'fetching' | 'decoding' | 'rendering' | 'encoding' | 'done';
}

const MERGEABLE_FORMATS = new Set([
  'mp3',
  'm4a',
  'oga',
  'weba',
  'wav',
  'flac',
  'aac',
  'ogg',
  'opus',
]);

export function isMergeableAudioFormat(f: string): boolean {
  return MERGEABLE_FORMATS.has(f.toLowerCase());
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer.slice(0) as ArrayBuffer;
}

// Fetch via background proxy to bypass CORS, with 60s timeout
async function fetchAudioArrayBuffer(
  item: MergeableAudioItem,
  tabId: number | undefined
): Promise<ArrayBuffer> {
  const tabUrl =
    tabId === undefined
      ? ''
      : (await browser.tabs.get(tabId).catch(() => undefined))?.url || '';
  const headers =
    item.requestHeaders && typeof item.requestHeaders === 'object'
      ? item.requestHeaders
      : undefined;
  const referrer = headers?.Referer || headers?.referer || tabUrl;

  const FETCH_TIMEOUT_MS = 60_000;
  const response = (await Promise.race([
    browser.runtime.sendMessage({
      type: 'PROXY_FETCH',
      url: item.url,
      options: { authHeaders: headers, referrer, proxyHeader: true },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('PROXY_FETCH timeout')),
        FETCH_TIMEOUT_MS
      )
    ),
  ])) as { ok?: boolean; status?: number; data?: string } | undefined;

  if (!response?.ok || !response.data) {
    throw new Error(`HTTP ${response?.status || 0}`);
  }
  return base64ToArrayBuffer(response.data);
}

async function decodeToArrayBuffer(
  ctx: BaseAudioContext,
  arrayBuffer: ArrayBuffer
): Promise<AudioBuffer> {
  const data = arrayBuffer.slice(0);
  try {
    return await ctx.decodeAudioData(data);
  } catch {
    throw new Error('decode-failed');
  }
}

export interface MergeResult {
  blob: Blob;
  sampleRate: number;
  durationSec: number;
}

export async function mergeAudioItemsToWav(
  items: MergeableAudioItem[],
  tabId: number | undefined,
  onProgress?: (p: MergeProgress) => void
): Promise<MergeResult> {
  if (!items.length) {
    throw new Error('no-items');
  }

  const AudioCtor: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtor) {
    throw new Error('no-audio-context');
  }
  const decodeCtx = new AudioCtor();

  const buffers: AudioBuffer[] = [];
  try {
    for (let i = 0; i < items.length; i++) {
      onProgress?.({ current: i + 1, total: items.length, phase: 'fetching' });
      const ab = await fetchAudioArrayBuffer(items[i]!, tabId);
      onProgress?.({ current: i + 1, total: items.length, phase: 'decoding' });
      const buf = await decodeToArrayBuffer(decodeCtx, ab);
      buffers.push(buf);
    }
  } finally {
    decodeCtx.close?.().catch(() => {});
  }

  if (!buffers.length) {
    throw new Error('no-decoded-buffers');
  }

  const sampleRate = buffers[0]!.sampleRate;
  const maxChannels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const channels = Math.max(1, Math.min(maxChannels, 2)); // clamp stereo
  // Resample mismatched sample rates by scaling length proportionally
  const totalLength = buffers.reduce((s, b) => {
    const scaled =
      b.sampleRate === sampleRate
        ? b.length
        : Math.round((b.length * sampleRate) / b.sampleRate);
    return s + scaled;
  }, 0);

  onProgress?.({
    current: items.length,
    total: items.length,
    phase: 'rendering',
  });
  const OfflineCtor: typeof OfflineAudioContext =
    (window as any).OfflineAudioContext ||
    (window as any).webkitOfflineAudioContext;
  if (!OfflineCtor) {
    throw new Error('no-offline-audio-context');
  }
  const offline = new OfflineCtor(channels, totalLength, sampleRate);

  let offsetFrames = 0;
  for (const buf of buffers) {
    const src = offline.createBufferSource();
    src.buffer = buf;
    src.connect(offline.destination);
    src.start(offsetFrames / sampleRate);
    const scaled =
      buf.sampleRate === sampleRate
        ? buf.length
        : Math.round((buf.length * sampleRate) / buf.sampleRate);
    offsetFrames += scaled;
  }

  const rendered = await offline.startRendering();
  onProgress?.({
    current: items.length,
    total: items.length,
    phase: 'encoding',
  });
  const wav = audioBufferToWav(rendered) as ArrayBuffer;
  const blob = new Blob([wav], { type: 'audio/wav' });
  onProgress?.({ current: items.length, total: items.length, phase: 'done' });
  return { blob, sampleRate, durationSec: rendered.duration };
}
