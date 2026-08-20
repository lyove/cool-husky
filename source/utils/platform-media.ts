export interface PlatformMediaCandidate {
  url: string;
  format?: string;
  role?: 'video' | 'audio';
  label?: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  duration?: number;
}

export interface PlatformMediaTask {
  provider: string;
  key: string;
  title?: string;
  coverUrl?: string;
  duration?: number;
  referer?: string;
  priority?: number;
  candidates: PlatformMediaCandidate[];
}
