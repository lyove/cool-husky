declare module 'mux.js' {
  export interface TransmuxerOptions {
    remux?: boolean;
    keepOriginalTimestamps?: boolean;
    [key: string]: unknown;
  }
  export interface TransmuxerEvent {
    type?: string;
    initSegment?: ArrayBuffer | Uint8Array;
    data?: ArrayBuffer | Uint8Array;
  }
  export class Transmuxer {
    constructor(options?: TransmuxerOptions);
    on(event: 'data', callback: (segment: TransmuxerEvent) => void): void;
    push(data: Uint8Array): void;
    flush(): void;
    dispose?(): void;
  }
  export const mp4: {
    Transmuxer: new (options?: TransmuxerOptions) => Transmuxer;
  };
  export const flv: {
    Transmuxer: new (options?: TransmuxerOptions) => Transmuxer;
  };
}
