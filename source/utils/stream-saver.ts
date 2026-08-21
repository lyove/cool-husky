/**
 * Stream-based file saving utilities.
 *
 * Problem: the existing download path (PROXY_FETCH → base64 → Blob →
 * browser.downloads) holds the entire file in memory (~4x size overhead).
 * Large M3U8 merges or long recordings can OOM the popup.
 *
 * Solution: two-tier strategy.
 *  1. File System Access API (`showSaveFilePicker` + `createWritable`):
 *     streams chunks directly to disk with negligible memory. Available in
 *     Chrome/Edge 86+. Requires a user gesture (called from a click handler).
 *  2. Fallback: Blob + browser.downloads.download (original path), used when
 *     the File System Access API is unavailable (Firefox, older browsers).
 *
 * Note on MV3: `showSaveFilePicker` is available in extension popup/sidepanel
 * pages in Chromium. Firefox does not support it, so the fallback is mandatory.
 */

import browser from 'webextension-polyfill';

export interface StreamSaveOptions {
  /** Suggested file name (with extension). */
  filename: string;
  /** MIME type for the saved file. */
  mime: string;
  /** Suggested starting size for the writable (pre-allocates on disk). */
  suggestedSize?: number;
}

export interface WritableStreamLike {
  write: (chunk: BlobPart) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}

/**
 * Whether the current environment supports the File System Access API.
 * Checked lazily so it does not crash Firefox/older browsers at import time.
 */
export function supportsFileSystemAccess(): boolean {
  return (
    typeof (window as any).showSaveFilePicker === 'function' &&
    typeof (window as any).FileSystemWritableFileStream !== 'undefined'
  );
}

/**
 * Open a user-chosen file for streaming writes via the File System Access API.
 * Throws if the API is unavailable or the user cancels the picker.
 *
 * Must be called from a user-gesture context (e.g. a click handler).
 */
export async function openWritableStream(
  options: StreamSaveOptions
): Promise<WritableStreamLike> {
  if (!supportsFileSystemAccess()) {
    throw new Error('File System Access API not supported');
  }
  const ext = options.filename.split('.').pop() || 'bin';
  const handle = await (window as any).showSaveFilePicker({
    suggestedName: options.filename,
    types: [
      {
        description: options.filename,
        accept: { [options.mime]: [`.${ext}`] },
      },
    ],
  });
  const writable = await handle.createWritable({
    keepExistingData: false,
  });
  if (options.suggestedSize && writable.truncate) {
    try {
      await writable.truncate(options.suggestedSize);
    } catch {
      // truncate is advisory; ignore if unsupported
    }
  }
  return {
    write: (chunk: BlobPart) => writable.write(chunk),
    close: () => writable.close(),
    abort: () => writable.abort(),
  };
}

/**
 * Save a Blob to disk. Uses File System Access API when available and a
 * gesture is provided; otherwise falls back to browser.downloads with a
 * blob URL.
 *
 * @param blob  The data to save.
 * @param options  Filename + MIME.
 * @param useStreamPicker  When true, try showSaveFilePicker first (needs gesture).
 * @returns true if saved successfully.
 */
export async function saveBlob(
  blob: Blob,
  options: StreamSaveOptions,
  useStreamPicker = false
): Promise<boolean> {
  // 1. Try streaming directly to disk (zero memory copy).
  if (useStreamPicker && supportsFileSystemAccess()) {
    try {
      const stream = await openWritableStream(options);
      await stream.write(blob);
      await stream.close();
      return true;
    } catch (e) {
      // User cancelled the picker or write failed — fall back below.
      if ((e as Error)?.name === 'AbortError') {
        return false;
      }
      // continue to fallback
    }
  }

  // 2. Fallback: blob URL + browser.downloads (in-memory).
  const blobUrl = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({
      url: blobUrl,
      filename: options.filename,
      saveAs: false,
    });
    // Revoke after the download has time to start. The caller does not need
    // to wait for completion; the browser holds a reference to the blob URL.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
    return true;
  } catch {
    URL.revokeObjectURL(blobUrl);
    return false;
  }
}

/**
 * Pipe a ReadableStream of BlobParts into a writable file handle with
 * backpressure-aware chunked writes. This is the core of memory-efficient
 * large-file saving: only one chunk is held in memory at a time.
 *
 * Falls back to buffering the whole stream into a Blob (and then saveBlob)
 * when File System Access is unavailable.
 */
export async function pipeStreamToDisk(
  stream: ReadableStream<Uint8Array>,
  options: StreamSaveOptions,
  usePicker = false
): Promise<boolean> {
  if (usePicker && supportsFileSystemAccess()) {
    try {
      const writable = await openWritableStream(options);
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            await writable.write(value as BlobPart);
          }
        }
      } finally {
        reader.releaseLock();
      }
      await writable.close();
      return true;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        return false;
      }
      // fall through to buffer fallback
    }
  }

  // Fallback: buffer entire stream into a single Blob, then save.
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const blob = new Blob(chunks as BlobPart[], { type: options.mime });
  return saveBlob(blob, options, false);
}
