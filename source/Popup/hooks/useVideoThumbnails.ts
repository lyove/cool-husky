import { useCallback, useRef, useState } from 'react';

export interface ProbedVideoMetadata {
  duration?: number;
  width?: number;
  height?: number;
}

export interface VideoThumbState {
  /** URLs that have successfully produced a usable first-frame thumbnail */
  successUrls: Set<string>;
  /** URLs that failed to load as a thumbnail */
  failedUrls: Set<string>;
  /** Probed metadata keyed by URL */
  metadataByUrl: Map<string, ProbedVideoMetadata>;
}

export function useVideoThumbnails(): {
  isSuccess: (url: string) => boolean;
  isFailed: (url: string) => boolean;
  getMetadata: (url: string) => ProbedVideoMetadata | undefined;
  markSuccess: (url: string) => void;
  markFailed: (url: string) => void;
  onVideoLoadedData: (
    event: React.SyntheticEvent<HTMLVideoElement>,
    url: string
  ) => void;
} {
  const [state, setState] = useState<VideoThumbState>({
    successUrls: new Set(),
    failedUrls: new Set(),
    metadataByUrl: new Map(),
  });

  // Keep a stable ref so callbacks are memoized and still observe current state
  const stateRef = useRef(state);
  stateRef.current = state;

  const isSuccess = useCallback(
    (url: string) => stateRef.current.successUrls.has(url),
    []
  );
  const isFailed = useCallback(
    (url: string) => stateRef.current.failedUrls.has(url),
    []
  );
  const getMetadata = useCallback(
    (url: string) => stateRef.current.metadataByUrl.get(url),
    []
  );

  const markSuccess = useCallback((url: string) => {
    setState((prev) => {
      if (prev.successUrls.has(url)) return prev;
      const nextSuccess = new Set(prev.successUrls);
      const nextFailed = new Set(prev.failedUrls);
      nextSuccess.add(url);
      nextFailed.delete(url);
      return {
        successUrls: nextSuccess,
        failedUrls: nextFailed,
        metadataByUrl: prev.metadataByUrl,
      };
    });
  }, []);

  const markFailed = useCallback((url: string) => {
    setState((prev) => {
      if (prev.failedUrls.has(url)) return prev;
      const nextSuccess = new Set(prev.successUrls);
      const nextFailed = new Set(prev.failedUrls);
      nextFailed.add(url);
      nextSuccess.delete(url);
      return {
        successUrls: nextSuccess,
        failedUrls: nextFailed,
        metadataByUrl: prev.metadataByUrl,
      };
    });
  }, []);

  const setMetadata = useCallback(
    (url: string, metadata: ProbedVideoMetadata) => {
      setState((prev) => {
        if (
          prev.metadataByUrl.get(url)?.duration === metadata.duration &&
          prev.metadataByUrl.get(url)?.width === metadata.width &&
          prev.metadataByUrl.get(url)?.height === metadata.height
        ) {
          return prev;
        }
        const next = new Map(prev.metadataByUrl);
        next.set(url, metadata);
        return {
          successUrls: prev.successUrls,
          failedUrls: prev.failedUrls,
          metadataByUrl: next,
        };
      });
    },
    []
  );

  // Seek to a small non-zero time so the first meaningful frame is shown,
  // mirroring the flowpick reference behaviour, and also probe metadata that
  // the background may have failed to extract (e.g. CORS-protected MP4s).
  const onVideoLoadedData = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>, url: string) => {
      const video = event.currentTarget;
      try {
        if (
          video.readyState >= 2 &&
          isFinite(video.duration) &&
          video.duration > 0 &&
          video.currentTime < 0.05
        ) {
          video.currentTime = 0.1;
        }
        setMetadata(url, {
          duration:
            isFinite(video.duration) && video.duration > 0
              ? video.duration
              : undefined,
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
        });
        markSuccess(url);
      } catch {
        markFailed(url);
      }
    },
    [markFailed, markSuccess, setMetadata]
  );

  return {
    isSuccess,
    isFailed,
    getMetadata,
    markSuccess,
    markFailed,
    onVideoLoadedData,
  };
}
