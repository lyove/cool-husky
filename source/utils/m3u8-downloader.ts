import browser from 'webextension-polyfill';
import { parseM3U8Manifest, extractSegmentUrls } from './stream-parser';

/**
 * M3U8 downloader: parses a manifest, fetches TS segments concurrently via the
 * background proxy (bypassing CORS/referrer), transmuxes TS → fMP4 with mux.js,
 * and returns a single merged Blob ready for download.
 *
 * Modeled on cat-catch's m3u8.downloader.js (concurrent fetch + mux.js
 * Transmuxer), but adapted to cool-husky's PROXY_FETCH bridge and React/TS
 * architecture.
 */

export interface M3u8DownloadProgress {
  phase: 'parsing' | 'downloading' | 'transmuxing' | 'merging' | 'done';
  current: number;
  total: number;
  failed: number;
}

export interface M3u8DownloadResult {
  blob: Blob;
  mime: string;
  ext: string;
  segmentCount: number;
}

const CONCURRENCY = 6;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60_000;

interface ProxyFetchResponse {
  ok?: boolean;
  status?: number;
  data?: string;
  headers?: Record<string, string>;
}

async function proxyFetchArrayBuffer(
  url: string,
  requestHeaders?: Record<string, string>,
  referrer?: string
): Promise<ArrayBuffer> {
  const response = (await Promise.race([
    browser.runtime.sendMessage({
      type: 'PROXY_FETCH',
      url,
      options: {
        authHeaders: requestHeaders,
        referrer,
        proxyHeader: true,
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('PROXY_FETCH timeout')),
        FETCH_TIMEOUT_MS
      )
    ),
  ])) as ProxyFetchResponse | undefined;

  if (!response?.ok || !response.data) {
    throw new Error(`HTTP ${response?.status || 0}`);
  }

  const binary = atob(response.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer.slice(0) as ArrayBuffer;
}

/** Fetch the raw text of a URL via the background proxy. */
async function proxyFetchText(
  url: string,
  requestHeaders?: Record<string, string>,
  referrer?: string
): Promise<string> {
  const ab = await proxyFetchArrayBuffer(url, requestHeaders, referrer);
  return new TextDecoder().decode(ab);
}

/** Concurrent worker pool over a list of items. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index] as T, index);
      }
    })
  );
  return results;
}

/**
 * Resolve the media playlist URL from a possibly-master manifest.
 * If the manifest is a master playlist, pick the highest-bandwidth variant.
 */
async function resolveMediaPlaylistUrl(
  m3u8Url: string,
  requestHeaders?: Record<string, string>,
  referrer?: string
): Promise<{ mediaUrl: string; isMaster: boolean }> {
  const text = await proxyFetchText(m3u8Url, requestHeaders, referrer);
  if (!text.includes('#EXTM3U')) {
    throw new Error('Not a valid M3U8 manifest');
  }
  const isMaster =
    text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA');
  if (!isMaster) {
    return { mediaUrl: m3u8Url, isMaster: false };
  }
  // Parse master via stream-parser to get the top-bandwidth variant URI.
  const parsed = await parseM3U8Manifest(
    m3u8Url,
    (u) => proxyFetchText(u, requestHeaders, referrer),
    requestHeaders
  );
  if (parsed.variants.length > 0) {
    // variants are sorted by bandwidth desc in parseM3U8Manifest
    return { mediaUrl: parsed.variants[0]!.uri, isMaster: true };
  }
  return { mediaUrl: m3u8Url, isMaster: true };
}

/**
 * Download an M3U8 stream, transmux TS segments to a single fMP4 Blob.
 *
 * @returns M3u8DownloadResult with the merged Blob (video/mp4).
 */
export async function downloadM3u8ToMp4(
  m3u8Url: string,
  requestHeaders?: Record<string, string>,
  referrer?: string,
  onProgress?: (p: M3u8DownloadProgress) => void
): Promise<M3u8DownloadResult> {
  // 1. Resolve media playlist (handle master playlists)
  onProgress?.({
    phase: 'parsing',
    current: 0,
    total: 0,
    failed: 0,
  });
  const { mediaUrl } = await resolveMediaPlaylistUrl(
    m3u8Url,
    requestHeaders,
    referrer
  );

  // 2. Fetch the media playlist and extract segment URLs
  const mediaText = await proxyFetchText(mediaUrl, requestHeaders, referrer);
  if (!mediaText.includes('#EXTM3U')) {
    throw new Error('Media playlist is not a valid M3U8');
  }
  const segmentUrls = extractSegmentUrls(mediaText, mediaUrl);
  if (segmentUrls.length === 0) {
    throw new Error('No segments found in M3U8 media playlist');
  }

  // 3. Concurrently download all segments with retry
  const segments: ArrayBuffer[] = new Array(segmentUrls.length);
  let failedCount = 0;
  let completed = 0;

  await mapWithConcurrency(segmentUrls, CONCURRENCY, async (segUrl, idx) => {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const buf = await proxyFetchArrayBuffer(
          segUrl,
          requestHeaders,
          referrer
        );
        segments[idx] = buf;
        completed++;
        onProgress?.({
          phase: 'downloading',
          current: completed,
          total: segmentUrls.length,
          failed: failedCount,
        });
        return;
      } catch (e) {
        lastError = e as Error;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    failedCount++;
    onProgress?.({
      phase: 'downloading',
      current: completed,
      total: segmentUrls.length,
      failed: failedCount,
    });
    // Leave a slot as empty; transmuxer will skip missing segments.
    segments[idx] = new ArrayBuffer(0);
    console.warn(
      `[m3u8-download] segment failed after retries: ${segUrl}`,
      lastError
    );
  });

  if (failedCount === segmentUrls.length) {
    throw new Error('All segments failed to download');
  }

  // 4. Transmux TS → fMP4 using mux.js, concatenating into one file.
  onProgress?.({
    phase: 'transmuxing',
    current: 0,
    total: segmentUrls.length,
    failed: failedCount,
  });

  // Dynamic import keeps mux.js out of the main bundle until needed.
  const muxjs = await import('mux.js');
  const Transmuxer = muxjs.mp4.Transmuxer;

  const transmuxer = new Transmuxer({
    remux: true,
    keepOriginalTimestamps: false,
  });

  const mp4Chunks: any[] = [];
  let initSegment: Uint8Array | null = null;

  // mux.js 7.x emits one 'data' event per push/flush with {type, initSegment, data}.
  // A single listener handles both the combined and separate-segment shapes.
  transmuxer.on('data', (segment: any) => {
    if (!segment) {
      return;
    }
    // Capture the init segment once (emitted with the first data event).
    if (segment.initSegment && !initSegment) {
      initSegment = new Uint8Array(segment.initSegment);
    }
    if (segment.data) {
      mp4Chunks.push(new Uint8Array(segment.data));
    }
  });

  let processed = 0;
  for (const seg of segments) {
    if (seg.byteLength === 0) {
      continue;
    }
    transmuxer.push(new Uint8Array(seg));
    processed++;
    onProgress?.({
      phase: 'transmuxing',
      current: processed,
      total: segmentUrls.length,
      failed: failedCount,
    });
  }
  transmuxer.flush();

  onProgress?.({
    phase: 'merging',
    current: segmentUrls.length,
    total: segmentUrls.length,
    failed: failedCount,
  });

  // 5. Assemble the final MP4: init segment first, then all data chunks.
  const parts: BlobPart[] = [];
  if (initSegment) {
    parts.push(initSegment as unknown as BlobPart);
  }
  for (const chunk of mp4Chunks) {
    if (chunk && chunk.length > 0) {
      parts.push(chunk as unknown as BlobPart);
    }
  }

  const blob = new Blob(parts, { type: 'video/mp4' });

  onProgress?.({
    phase: 'done',
    current: segmentUrls.length,
    total: segmentUrls.length,
    failed: failedCount,
  });

  return {
    blob,
    mime: 'video/mp4',
    ext: 'mp4',
    segmentCount: segmentUrls.length,
  };
}
