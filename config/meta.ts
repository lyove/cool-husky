// ============================================================================
// Single source of truth for app metadata
// ----------------------------------------------------------------------------
// All user-visible branding (name, full name, description, slogan, links,
// author, etc.) is derived from this file.
// ============================================================================

export const META = {
  /** Short brand name: popup header, welcome page title, tab titles, footer version */
  name: {
    en: 'CoolHusky',
    'en_GB': 'CoolHusky',
    'en_US': 'CoolHusky',
    zh_CN: '酷哈',
    zh_TW: '酷哈',
    de: 'CoolHusky',
    es: 'CoolHusky',
    ja: 'CoolHusky',
    ko: 'CoolHusky',
    ru: 'CoolHusky',
  },

  /** Full extension name: extName shown in toolbar / extension management page */
  fullName: {
    en: 'CoolHusky - Media Sniffer & Downloader',
    'en_GB': 'CoolHusky - Media Sniffer & Downloader',
    'en_US': 'CoolHusky - Media Sniffer & Downloader',
    zh_CN: '酷哈 - 智能网页媒体嗅探与下载工具',
    zh_TW: '酷哈 - 智能網頁影片/音訊/圖片下載器',
    de: 'CoolHusky: Video-, Audio- & Bild-Downloader',
    es: 'CoolHusky: Descargador de Videos, Música y Fotos',
    ja: 'CoolHusky - 動画・音楽・画像一括ダウンロード',
    ko: 'CoolHusky - 만능 동영상/오디오/이미지 다운로더',
    ru: 'CoolHusky — Сниффер медиа и загрузчик',
  },

  /** One-line description: extDescription shown in extension management page */
  description: {
    en: 'Auto-detect & download M3U8/HLS streams, videos, audio & images. Built-in player. Batch download. 100% local & private.',
    'en_GB':
      'Auto-detect & download M3U8/HLS streams, videos, audio & images. Built-in player. Batch download. 100% local & private.',
    'en_US':
      'Auto-detect & download M3U8/HLS streams, videos, audio & images. Built-in player. Batch download. 100% local & private.',
    zh_CN:
      '自动嗅探网页中的 M3U8/HLS 流媒体、视频、音频和图片，内置播放预览，支持批量下载，全程本地运行，隐私安全。',
    zh_TW:
      '自動嗅探網頁中的 M3U8/HLS 串流媒體、影片、音訊與圖片，內建播放預覽，支援批次下載，全程本機運行，隱私安全。',
    de: 'Automatische Erkennung und Download von M3U8/HLS-Streams, Videos, Audio und Bildern. Integrierter Player. Stapel-Download. 100% lokal und privat.',
    es: 'Detección y descarga automática de transmisiones M3U8/HLS, vídeos, audio e imágenes. Reproductor integrado. Descarga por lotes. 100% local y privado.',
    ja: 'M3U8/HLSストリーム、動画、音声、画像を自動検出。内蔵プレイヤーでプレビュー、一括ダウンロード対応。全てローカル処理でプライバシー安心。',
    ko: 'M3U8/HLS 스트리밍, 영상, 오디오 및 이미지를 자동 감지 및 다운로드. 내장 플레이어 지원. 일괄 다운로드. 100% 로컬 처리 및 개인정보 보호.',
    ru: 'Авто-поиск и загрузка M3U8/HLS-потоков, видео, аудио и изображений. Встроенный плеер. Пакетная загрузка. Всё локально и приватно.',
  },

  /** Slogan: welcome page subtitle (welcomeSubtitle) */
  slogan: {
    en: 'Smart Media Sniffer & Downloader',
    'en_GB': 'Smart Media Sniffer & Downloader',
    'en_US': 'Smart Media Sniffer & Downloader',
    zh_CN: '智能媒体嗅探与下载工具',
    zh_TW: '智慧媒體嗅探與下載工具',
    de: 'Intelligenter Medien-Sniffer und Downloader',
    es: 'Detector y Descargador Inteligente de Medios',
    ja: 'スマートメディアスニッファー＆ダウンローダー',
    ko: '지능형 미디어 스니퍼 및 다운로더',
    ru: 'Умный сниффер медиа и загрузчик',
  },

  /** Brand reference form used in long-form copy (welcome / tutorial / FAQ); usually the same as name */
  ref: {
    en: 'CoolHusky',
    'en_GB': 'CoolHusky',
    'en_US': 'CoolHusky',
    zh_CN: '酷哈',
    zh_TW: '酷哈',
    de: 'CoolHusky',
    es: 'CoolHusky',
    ja: 'CoolHusky',
    ko: 'CoolHusky',
    ru: 'CoolHusky',
  },

  /** Project homepage: manifest homepage_url, footer GitHub button */
  homepageUrl: 'https://github.com/lyove/cool-husky',

  /** Author: manifest author */
  author: 'lyove',

  /** Firefox extension ID (gecko.id). */
  firefoxId: 'coolhusky@coolhusky',
} as const;
