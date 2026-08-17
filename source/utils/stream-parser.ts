export interface VariantStream {
  uri: string;
  bandwidth?: number;
  resolution?: string;
  label: string;
  audioUri?: string;
}

export interface ParsedManifest {
  type: 'hls-master' | 'hls-media' | 'dash' | 'unknown';
  variants: VariantStream[];
  /** Total duration in seconds. May be unavailable for live streams. */
  duration?: number;
  /** Estimated total size in bytes, derived by sampling segment size × segment count. */
  estimatedSize?: number;
}

function resolveUrl(base: string, rel: string): string {
  if (!rel) return base;
  try {
    if (rel.startsWith('http://') || rel.startsWith('https://')) return rel;
    if (rel.startsWith('//')) return new URL(base).protocol + rel;
    if (rel.startsWith('/')) return new URL(base).origin + rel;
    return base.substring(0, base.lastIndexOf('/') + 1) + rel;
  } catch {
    return rel;
  }
}

function formatBandwidth(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} Kbps`;
  return `${bps} bps`;
}

function makeVariantLabel(resolution?: string, bandwidth?: number): string {
  const height = resolution
    ? parseInt(resolution.split(/[xX×]/)[1] ?? '0', 10)
    : 0;
  const parts: string[] = [];
  if (height > 0) parts.push(`${height}p`);
  else if (resolution) parts.push(resolution);
  if (bandwidth) parts.push(formatBandwidth(bandwidth));
  return parts.join(' · ') || 'Unknown';
}

/**
 * Sum the durations of all #EXTINF entries in an m3u8 media playlist.
 * Only VOD streams (with #EXT-X-ENDLIST) have a fixed duration; live streams change dynamically, so the current accumulated value is returned for reference.
 */
function sumExtinf(text: string): number | undefined {
  let total = 0;
  let found = false;
  for (const line of text.split('\n')) {
    const m = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (m) {
      total += parseFloat(m[1]!);
      found = true;
    }
  }
  return found ? total : undefined;
}

/**
 * Extract all segment URLs from a media playlist text (non-empty lines not starting with #).
 */
function extractSegmentUrls(text: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    urls.push(resolveUrl(baseUrl, t));
  }
  return urls;
}

/**
 * For media playlists using #EXT-X-BYTERANGE, directly sum each segment's byte-range length (n) as the total size.
 * All segments point to different ranges of the same resource, so total = Σ of each range length, no network requests needed.
 * The result is close to the real total (ignoring the EXT-X-MAP init segment, usually only a few KB).
 * Returns undefined for playlists without byterange.
 */
function computeByterangeTotalSize(
  text: string,
  baseUrl: string
): number | undefined {
  if (!text.includes('#EXT-X-BYTERANGE')) return undefined;
  let total = 0;
  let found = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('#EXT-X-BYTERANGE:')) continue;
    const m = /^#EXT-X-BYTERANGE:(\d+)/.exec(t);
    if (m) {
      total += parseInt(m[1]!, 10);
      found = true;
    }
  }
  // baseUrl is kept for future extension (e.g. uniqueness check); here we only sum lengths
  void baseUrl;
  return found ? total : undefined;
}

/**
 * Fetch the segment size (bytes); returns undefined on failure.
 * Strategy: HEAD first (saves bandwidth), falling back to GET + Range: bytes=0-0 when HEAD fails or has no content-length.
 *   - 206 response: parse Content-Range: bytes 0-0/12345 → 12345
 *   - 200 response: use Content-Length (entire file size)
 *   - Cancel the body immediately to avoid downloading the full segment
 */
async function fetchSegmentSize(
  url: string,
  headers: Record<string, string>
): Promise<number | undefined> {
  const parseContentRange = (v: string | null): number | undefined => {
    if (!v) return undefined;
    const m = v.match(/\/(\d+)$/);
    return m?.[1] ? parseInt(m[1], 10) : undefined;
  };

  try {
    // 1) HEAD
    const headResp = await fetch(url, {
      method: 'HEAD',
      headers,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (headResp.ok) {
      const cl = headResp.headers.get('content-length');
      if (cl) return parseInt(cl, 10);
      const cr = parseContentRange(headResp.headers.get('content-range'));
      if (cr) return cr;
    }

    // 2) HEAD failed / no length → GET + Range: bytes=0-0
    const getResp = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (getResp.status === 206) {
      const cr = parseContentRange(getResp.headers.get('content-range'));
      if (cr) return cr;
    }
    if (getResp.status === 200) {
      const cl = getResp.headers.get('content-length');
      if (cl) return parseInt(cl, 10);
    }
    // Cancel body download (avoid pulling the whole segment when no Range)
    try {
      await getResp.body?.cancel();
    } catch {}
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Estimate the total size (bytes) of an entire media playlist by sampling multiple segments.
 * - Pick several evenly-spaced positions (start / 1/4 / middle / 3/4 / end) and fetch segment sizes concurrently;
 * - Use the average of successful samples × total segment count as the estimate.
 * - Multi-point sampling avoids a single failure (e.g. CDN without Range / no content-length / 403) leaving the whole playlist without a size.
 * Returns undefined if all samples fail.
 */
async function estimateSizeFromSegments(
  segUrls: string[],
  fetchHeaders: Record<string, string>
): Promise<number | undefined> {
  if (segUrls.length === 0) return undefined;

  const pickIndex = (ratio: number) =>
    Math.max(
      0,
      Math.min(segUrls.length - 1, Math.floor(segUrls.length * ratio))
    );
  const positions = Array.from(new Set([0, 0.25, 0.5, 0.75, 1].map(pickIndex)));

  const sizes: number[] = [];
  await Promise.all(
    positions.map(async (idx) => {
      const segSize = await fetchSegmentSize(segUrls[idx]!, fetchHeaders);
      if (segSize && segSize > 0) sizes.push(segSize);
    })
  );

  if (sizes.length > 0) {
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    return Math.round(avg * segUrls.length);
  }

  // Fallback: when no lightweight probe yields content-length (CDN doesn't return / doesn't support Range),
  // previously a whole segment was downloaded to measure bytes — a single estimate on a 10MB+ TS segment used 10MB of traffic.
  // Now use Range: bytes=0-1048575 to cap at 1MB, estimating from the ratio or content-range.
  try {
    const mid = segUrls[pickIndex(0.5)]!;
    const rangeResp = await fetch(mid, {
      headers: { ...fetchHeaders, Range: 'bytes=0-1048575' },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (rangeResp.status === 206) {
      // CDN supports Range: prefer the content-range total (precise)
      const cr = rangeResp.headers.get('content-range');
      const crMatch = cr ? /\/(\d+)$/.exec(cr) : null;
      if (crMatch) {
        const total = parseInt(crMatch[1]!, 10);
        if (total > 0) {
          try {
            await rangeResp.body?.cancel();
          } catch {}
          return Math.round(total * segUrls.length);
        }
      }
      // No total (content-range is */* form): cannot estimate, cancel body
      try {
        await rangeResp.body?.cancel();
      } catch {}
      return undefined;
    }
    if (rangeResp.ok) {
      // 200: CDN doesn't support Range, returns the full segment. Estimate from content-length without downloading the body
      const cl = rangeResp.headers.get('content-length');
      try {
        await rangeResp.body?.cancel();
      } catch {}
      if (cl) {
        const n = parseInt(cl, 10);
        if (n > 0) return Math.round(n * segUrls.length);
      }
    }
  } catch {
    // Ignore: degrade to no estimate
  }
  return undefined;
}

/**
 * Parse an ISO 8601 duration (e.g. PT1H30M10.5S) into seconds.
 * Used for the DASH mediaPresentationDuration attribute.
 */
function parseIsoDuration(iso: string): number | undefined {
  const m =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(
      iso
    );
  if (!m) return undefined;
  const years = parseInt(m[1] ?? '0', 10);
  const months = parseInt(m[2] ?? '0', 10);
  const days = parseInt(m[3] ?? '0', 10);
  const hours = parseInt(m[4] ?? '0', 10);
  const minutes = parseInt(m[5] ?? '0', 10);
  const seconds = parseFloat(m[6] ?? '0');
  const total =
    years * 365 * 86400 +
    months * 30 * 86400 +
    days * 86400 +
    hours * 3600 +
    minutes * 60 +
    seconds;
  return total > 0 ? total : undefined;
}

export async function parseM3U8Manifest(
  url: string,
  fetchText: (u: string) => Promise<string>,
  fetchHeaders?: Record<string, string>
): Promise<ParsedManifest> {
  let text: string;
  try {
    text = await fetchText(url);
  } catch {
    return { type: 'unknown', variants: [] };
  }

  if (!text.includes('#EXTM3U')) {
    return { type: 'unknown', variants: [] };
  }

  const isMaster =
    text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA');

  if (!isMaster) {
    // media playlist (single bitrate) — estimate size
    const duration = sumExtinf(text);
    const segUrls = extractSegmentUrls(text, url);
    // 1) byterange form: sum each range length directly, most accurate and reliable
    // 2) otherwise multi-point sampling averaged × count (single-point sampling often fails due to CDN blocking, leaving no size)
    const estimatedSize =
      computeByterangeTotalSize(text, url) ??
      (await estimateSizeFromSegments(segUrls, fetchHeaders ?? {}));
    return { type: 'hls-media', variants: [], duration, estimatedSize };
  }

  const variants: VariantStream[] = [];
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const audioGroupUris = new Map<string, string>();
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
      const groupIdMatch = /GROUP-ID="([^"]+)"/.exec(line);
      const uriMatch = /URI="([^"]+)"/.exec(line);
      if (groupIdMatch && uriMatch) {
        audioGroupUris.set(groupIdMatch[1]!, resolveUrl(url, uriMatch[1]!));
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const nextLine = lines[i + 1];
    if (!nextLine || nextLine.startsWith('#')) continue;

    const variantUri = resolveUrl(url, nextLine);
    const bwMatch = /BANDWIDTH=(\d+)/.exec(line);
    const resMatch = /RESOLUTION=(\d+[xX×]\d+)/i.exec(line);
    const audioGroupMatch = /AUDIO="([^"]+)"/.exec(line);

    const bandwidth = bwMatch ? parseInt(bwMatch[1]!, 10) : undefined;
    const resolution = resMatch ? resMatch[1] : undefined;
    const audioUri = audioGroupMatch
      ? audioGroupUris.get(audioGroupMatch[1]!)
      : undefined;

    variants.push({
      uri: variantUri,
      bandwidth,
      resolution,
      label: makeVariantLabel(resolution, bandwidth),
      audioUri,
    });
  }

  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));

  // master playlist: try to fetch the top-bitrate variant's media playlist for its duration;
  // if that variant has no bandwidth, also try sampling segment sizes to estimate
  let duration: number | undefined;
  let estimatedSize: number | undefined;
  if (variants.length > 0) {
    try {
      const topVariant = variants[0]!;
      const mediaText = await fetchText(topVariant.uri);
      if (mediaText.includes('#EXTM3U')) {
        duration = sumExtinf(mediaText);
        if (!topVariant.bandwidth && duration && duration > 0) {
          // Variant without bandwidth: prefer byterange summing; otherwise multi-point segment sampling averaged × count
          estimatedSize = computeByterangeTotalSize(mediaText, topVariant.uri);
          if (estimatedSize === undefined) {
            const segUrls = extractSegmentUrls(mediaText, topVariant.uri);
            estimatedSize = await estimateSizeFromSegments(
              segUrls,
              fetchHeaders ?? {}
            );
          }
        }
      }
    } catch {
      /* Ignore; duration stays undefined */
    }
  }

  return { type: 'hls-master', variants, duration, estimatedSize };
}

export async function parseDashManifest(
  url: string,
  fetchText: (u: string) => Promise<string>
): Promise<ParsedManifest> {
  let text: string;
  try {
    text = await fetchText(url);
  } catch {
    return { type: 'unknown', variants: [] };
  }

  if (!text.includes('<MPD') && !text.includes('<mpd')) {
    return { type: 'unknown', variants: [] };
  }

  // Read <MPD mediaPresentationDuration="PT1H30M10.5S">
  let duration: number | undefined;
  const durMatch = /mediaPresentationDuration="([^"]+)"/.exec(text);
  if (durMatch) {
    duration = parseIsoDuration(durMatch[1]!);
  }

  const variants: VariantStream[] = [];

  let adaptationBlocks: string[] = [];
  const videoByContent = [
    ...text.matchAll(
      /<AdaptationSet[^>]*contentType="video"[^>]*>([\s\S]*?)<\/AdaptationSet>/gi
    ),
  ];
  const videoByMime = [
    ...text.matchAll(
      /<AdaptationSet[^>]*mimeType="video[^"]*"[^>]*>([\s\S]*?)<\/AdaptationSet>/gi
    ),
  ];
  const allVideoAdapt =
    videoByContent.length > 0 ? videoByContent : videoByMime;
  adaptationBlocks = allVideoAdapt.map((m) => m[1] ?? '');

  if (adaptationBlocks.length === 0) {
    const allAdapt = [
      ...text.matchAll(/<AdaptationSet[^>]*>([\s\S]*?)<\/AdaptationSet>/gi),
    ];
    adaptationBlocks = allAdapt.map((m) => m[1] ?? '');
  }

  for (const block of adaptationBlocks) {
    const repMatches = [
      ...block.matchAll(/<Representation\s([^>]*?)(?:\/>|>)/gi),
    ];
    for (const rep of repMatches) {
      const attrs = rep[1] ?? '';
      const bwMatch = /bandwidth="(\d+)"/i.exec(attrs);
      const wMatch = /width="(\d+)"/i.exec(attrs);
      const hMatch = /height="(\d+)"/i.exec(attrs);
      if (!bwMatch) continue;
      const bandwidth = parseInt(bwMatch[1]!, 10);
      const width = wMatch ? wMatch[1] : undefined;
      const height = hMatch ? hMatch[1] : undefined;
      const resolution = width && height ? `${width}x${height}` : undefined;
      variants.push({
        uri: url,
        bandwidth,
        resolution,
        label: makeVariantLabel(resolution, bandwidth),
      });
    }
  }

  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));

  return { type: 'dash', variants, duration };
}
