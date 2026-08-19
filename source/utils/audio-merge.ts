import audioBufferToWav from 'audiobuffer-to-wav';
import browser from 'webextension-polyfill';

/**
 * Audio merge utilities (Route B: pure Web Audio API + audiobuffer-to-wav).
 *
 * Why this route:
 * - Sniffed audio formats vary (mp3 / m4a / aac / wav / flac / ogg …). Byte-stream
 *   concatenation (stream copy) requires identical codec params and silently breaks
 *   otherwise, so it is unsuitable for a mix of formats.
 * - decodeAudioData() normalises every supported format to PCM AudioBuffer, so we can
 *   concatenate across formats safely and render a single WAV via OfflineAudioContext.
 *
 * Ordering contract:
 *   The caller MUST pass `items` already sorted in sniff order (the order they were
 *   detected on the page). We do NOT re-sort here — the popup preserves mediaList
 *   order and filters by selection, which keeps the original sniff sequence. A
 *   stable detectedAt fallback is applied in the popup before calling.
 */

export interface MergeableAudioItem {
  url: string;
  format: string;
  requestHeaders?: Record<string, string>;
}

export interface MergeProgress {
  /** 1-based index of the file currently being fetched/decoded. */
  current: number;
  total: number;
  phase: 'fetching' | 'decoding' | 'rendering' | 'encoding' | 'done';
}

/** Formats we attempt to merge. Superset of Popup AUDIO_FORMATS (adds opus). */
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

/** base64 (as returned by PROXY_FETCH) → ArrayBuffer. */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  // decodeAudioData needs a copy-backed ArrayBuffer it can detach.
  return bytes.buffer.slice(0) as ArrayBuffer;
}

/**
 * Fetch one audio resource via the background PROXY_FETCH (carries referer/cookie
 * so hotlink-protected audio still downloads). Returns an ArrayBuffer.
 */
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

/**
 * Decode an ArrayBuffer to AudioBuffer. Safari/older Chrome reject some containers
 * (e.g. m4a/aac on occasion); we surface a typed error so the caller can skip.
 */
async function decodeToArrayBuffer(
  ctx: BaseAudioContext,
  arrayBuffer: ArrayBuffer
): Promise<AudioBuffer> {
  // decodeAudioData detaches the ArrayBuffer; clone first so a failure can be retried
  // by the caller if ever needed.
  const data = arrayBuffer.slice(0);
  try {
    // Promise form (Chrome/FF). Safari <14 uses callback form, but MV3 targets are modern.
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

/**
 * Fetch, decode, and concatenate `items` (in the given order) into a single WAV Blob.
 *
 * @param items  Audio items already ordered in sniff sequence.
 * @param tabId  Active tab id (for PROXY_FETCH referer fallback).
 * @param onProgress Optional progress callback.
 */
export async function mergeAudioItemsToWav(
  items: MergeableAudioItem[],
  tabId: number | undefined,
  onProgress?: (p: MergeProgress) => void
): Promise<MergeResult> {
  if (!items.length) throw new Error('no-items');

  // Use a regular AudioContext for decoding. OfflineAudioContext is only for rendering.
  const AudioCtor: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtor) throw new Error('no-audio-context');
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
    // Close the decode context to free its resources once all decoding is done.
    decodeCtx.close?.().catch(() => {});
  }

  if (!buffers.length) throw new Error('no-decoded-buffers');

  // Render target params: take the first buffer's sample rate as the reference and
  // resample is handled by OfflineAudioContext when sources have different rates.
  const sampleRate = buffers[0]!.sampleRate;
  const maxChannels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const channels = Math.max(1, Math.min(maxChannels, 2)); // clamp to stereo
  const totalLength = buffers.reduce((s, b) => {
    // If a buffer has a different sample rate, its length in the target rate differs.
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
  if (!OfflineCtor) throw new Error('no-offline-audio-context');
  const offline = new OfflineCtor(channels, totalLength, sampleRate);

  let offsetFrames = 0;
  for (const buf of buffers) {
    const src = offline.createBufferSource();
    src.buffer = buf;
    src.connect(offline.destination);
    // start(when) schedules playback at the given absolute time (seconds).
    src.start(offsetFrames / sampleRate);
    // Advance by this buffer's duration in the target sample rate.
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
