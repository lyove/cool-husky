let hlsLoader: Promise<(typeof import('hls.js'))['default']> | null = null;
let dashLoader: Promise<typeof import('dashjs')> | null = null;
let mpegtsLoader: Promise<(typeof import('mpegts.js'))['default']> | null =
  null;

export const loadHls = (): Promise<(typeof import('hls.js'))['default']> => {
  hlsLoader ??= import('hls.js').then((module) => module.default);
  return hlsLoader;
};

export const loadDash = (): Promise<typeof import('dashjs')> => {
  dashLoader ??= import('dashjs');
  return dashLoader;
};

export const loadMpegts = (): Promise<
  (typeof import('mpegts.js'))['default']
> => {
  mpegtsLoader ??= import('mpegts.js').then((module) => module.default);
  return mpegtsLoader;
};
