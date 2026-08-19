import { useEffect, useMemo, useRef, useState } from 'react';
import { isMediaAllowed, type Settings } from '../../utils/settings';
import { FORMAT_GROUPS, getFormatLabel, getType } from '../utils/formats';
import type { MediaType } from '../utils/formats';
import type { MediaListItem } from './useMediaList';

export type ActiveTab = 'all' | Exclude<MediaType, 'other'>;

/** Streaming group (master + variants + separate audio tracks). */
export interface StreamGroup {
  id: string;
  master: MediaListItem | undefined;
  variants: MediaListItem[];
  audioItems: MediaListItem[];
  detectedAt?: number;
  isBilibiliDash: boolean;
}

/** Flat list item: a regular entry or a stream-group card. */
export type StreamFlatItem =
  | { kind: 'item'; item: MediaListItem }
  | { kind: 'group'; group: StreamGroup };

export interface UseMediaFiltersOptions {
  mediaList: MediaListItem[];
  settings: Settings | null;
}

export interface TypeOption {
  value: string;
  label: string;
  count: number;
  disabled: boolean;
}

export function useMediaFilters({
  mediaList,
  settings,
}: UseMediaFiltersOptions): {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  typeFilter: string;
  setTypeFilter: (value: string) => void;
  sizeFilter: { min: number; max: number };
  setSizeFilter: (value: { min: number; max: number }) => void;
  dimensionFilter: { minWidth: number; minHeight: number };
  setDimensionFilter: (value: { minWidth: number; minHeight: number }) => void;
  resolutionFilter: string;
  setResolutionFilter: (value: string) => void;
  sortOrder: 'asc' | 'desc';
  setSortOrder: (value: 'asc' | 'desc') => void;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  useRegex: boolean;
  setUseRegex: (value: boolean) => void;
  regexValid: boolean;
  searchError: string;
  clearSearch: () => void;
  tabCounts: Record<string, number>;
  enabledTabs: ActiveTab[];
  typeOptions: TypeOption[];
  filteredMediaList: MediaListItem[];
  filteredImageList: MediaListItem[];
  groupedStreamList: StreamGroup[];
  flatMediaList: StreamFlatItem[];
  mediaCatalog: {
    all: MediaListItem[];
    byType: Record<MediaType, MediaListItem[]>;
    counts: Record<string, number>;
  };
} {
  const [activeTab, setActiveTab] = useState<ActiveTab>('all');
  const [typeFilter, setTypeFilter] = useState('any');
  const [sizeFilter, setSizeFilter] = useState({ min: 0, max: 0 });
  const [dimensionFilter, setDimensionFilter] = useState({
    minWidth: 0,
    minHeight: 0,
  });
  const [resolutionFilter, setResolutionFilter] = useState('any');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [regexValid, setRegexValid] = useState(true);
  const [searchError, setSearchError] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = searchQuery.trim();
    if (useRegex && query) {
      try {
        new RegExp(query, 'i');
        setRegexValid(true);
        setSearchError('');
      } catch (error) {
        setRegexValid(false);
        setSearchError((error as Error).message);
      }
    } else {
      setRegexValid(true);
      setSearchError('');
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearchQuery(query);
      searchTimerRef.current = null;
    }, 120);
  }, [searchQuery, useRegex]);

  useEffect(
    () => (): void => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    },
    []
  );

  // Only byte-stream segments (.ts/.m4s chunk files that belong to a master
  // playlist) count as "segments" here. Variants (alternative renditions of an
  // HLS/DASH stream, e.g. 1080p vs 720p) are full media streams: hiding them
  // makes grouped video items "appear then vanish" once paired into a group
  // (Bilibili/Douyin separated tracks), so they must stay visible inside their
  // stream-group card.
  const isSegment = (item: MediaListItem): boolean =>
    item.groupRole === 'segment';

  const enabledTabs = useMemo<ActiveTab[]>(() => {
    if (!settings) {
      return ['all', 'stream', 'video', 'audio', 'image', 'doc'];
    }
    const tabs: ActiveTab[] = ['all'];
    if (settings.sniffingRules.streaming.enabled) tabs.push('stream');
    if (settings.sniffingRules.video.enabled) tabs.push('video');
    if (settings.sniffingRules.audio.enabled) tabs.push('audio');
    if (settings.sniffingRules.image.enabled) tabs.push('image');
    if (settings.sniffingRules.document.enabled) tabs.push('doc');
    return tabs;
  }, [settings]);

  // If the currently active tab becomes disabled, fall back to "all".
  useEffect(() => {
    if (activeTab !== 'all' && !enabledTabs.includes(activeTab)) {
      setActiveTab('all');
    }
  }, [activeTab, enabledTabs]);

  const mediaCatalog = useMemo(() => {
    const all: MediaListItem[] = [];
    const byType: Record<MediaType, MediaListItem[]> = {
      stream: [],
      video: [],
      audio: [],
      image: [],
      doc: [],
      other: [],
    };
    const counts = {
      all: 0,
      stream: 0,
      video: 0,
      audio: 0,
      image: 0,
      doc: 0,
    } as {
      all: number;
      stream: number;
      video: number;
      audio: number;
      image: number;
      doc: number;
      [key: string]: number;
    };

    for (const item of mediaList) {
      if (settings?.hideStreamSegments && isSegment(item)) continue;
      if (
        settings &&
        !isMediaAllowed(
          item.format,
          settings,
          item.category,
          item.groupRole
        )
      )
        continue;
      const type = getType(item.format, item.category, item.groupRole);
      all.push(item);
      byType[type].push(item);
      const isGroupChild =
        isSegment(item) ||
        item.groupRole === 'audio' ||
        item.groupRole === 'variant';
      if (!isGroupChild) counts.all++;
      if (type === 'stream') {
        if (!isGroupChild) counts.stream++;
      } else if (type !== 'other' && !isGroupChild) {
        counts[type]++;
      }
    }
    return { all, byType, counts };
  }, [mediaList, settings]);

  const compiledRegex = useMemo(() => {
    const query = debouncedSearchQuery;
    if (!useRegex || !query || !regexValid) return null;
    try {
      return new RegExp(query, 'i');
    } catch {
      return null;
    }
  }, [debouncedSearchQuery, useRegex, regexValid]);

  const filteredMediaList = useMemo(() => {
    let list =
      activeTab === 'all' ? mediaCatalog.all : mediaCatalog.byType[activeTab];
    if (typeFilter !== 'any') {
      list = list.filter((item) => item.format.toLowerCase() === typeFilter);
    }
    const query = debouncedSearchQuery;
    if (query && regexValid) {
      const regex = compiledRegex;
      const lowered = query.toLowerCase();
      list = list.filter((item) =>
        regex ? regex.test(item.url) : item.url.toLowerCase().includes(lowered)
      );
    }
    list = list.filter((item) => {
      if (sizeFilter.min > 0 && (item.size ?? 0) < sizeFilter.min * 1024)
        return false;
      if (sizeFilter.max > 0 && (item.size ?? 0) > sizeFilter.max * 1024)
        return false;
      if (activeTab === 'image') {
        if (
          dimensionFilter.minWidth > 0 &&
          (item.width ?? 0) < dimensionFilter.minWidth
        )
          return false;
        if (
          dimensionFilter.minHeight > 0 &&
          (item.height ?? 0) < dimensionFilter.minHeight
        )
          return false;
      }
      if (activeTab === 'video' && resolutionFilter !== 'any') {
        const height = Math.min(item.width ?? 0, item.height ?? 0);
        const minimums: Record<string, number> = {
          '8k': 4320,
          '4k': 2160,
          '1080p': 1080,
          '720p': 720,
          '480p': 480,
          '360p': 360,
        };
        if (resolutionFilter === 'sd') return height < 360;
        if ((minimums[resolutionFilter] ?? 0) > height) return false;
      }
      return true;
    });
    const direction = sortOrder === 'asc' ? 1 : -1;
    return [...list].sort(
      (a, b) => ((a.detectedAt ?? 0) - (b.detectedAt ?? 0)) * direction
    );
  }, [
    activeTab,
    mediaCatalog,
    typeFilter,
    debouncedSearchQuery,
    regexValid,
    compiledRegex,
    sizeFilter,
    dimensionFilter,
    resolutionFilter,
    sortOrder,
  ]);

  const filteredImageList = useMemo(
    () =>
      filteredMediaList.filter(
        (item) => getType(item.format, item.category) === 'image'
      ),
    [filteredMediaList]
  );

  const typeOptions = useMemo(() => {
    const tabMedia =
      activeTab === 'all' ? mediaCatalog.all : mediaCatalog.byType[activeTab];
    const counts: Record<string, number> = {};
    tabMedia.forEach((item) => {
      const format = item.format.toLowerCase();
      counts[format] = (counts[format] ?? 0) + 1;
    });
    const formats =
      activeTab === 'all'
        ? Object.values(FORMAT_GROUPS).flat()
        : FORMAT_GROUPS[activeTab];
    return [...new Set(formats)]
      .map((format) => {
        return {
          value: format,
          label: getFormatLabel(format),
          count: counts[format] ?? 0,
          disabled: !counts[format],
        };
      })
      .sort((a, b) =>
        a.disabled === b.disabled ? b.count - a.count : a.disabled ? 1 : -1
      );
  }, [activeTab, mediaCatalog]);

  const clearSearch = (): void => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    setSearchQuery('');
    setDebouncedSearchQuery('');
    setSearchError('');
  };

  /**
   * Streaming groups: master/variant/audio sharing the same groupId collapse into one card.
   * Ungrouped streams (no groupId/groupRole) are grouped by their own url.
   */
  const groupedStreamList = useMemo<StreamGroup[]>(() => {
    // Also collect standalone DASH audio tracks (groupRole 'audio', now typed
    // as audio) so they attach to their stream group or form an audio-only group.
    const streamItems = [
      ...mediaCatalog.byType.stream,
      ...mediaCatalog.byType.audio.filter((i) => i.groupRole === 'audio'),
    ];
    const groups: StreamGroup[] = [];
    const groupMap = new Map<string, StreamGroup>();
    const pendingAudio: MediaListItem[] = [];

    const ensureGroup = (id: string, item: MediaListItem): StreamGroup => {
      let group = groupMap.get(id);
      if (!group) {
        group = {
          id,
          master: undefined,
          variants: [],
          audioItems: [],
          detectedAt: item.detectedAt,
          isBilibiliDash: Boolean(
            item.groupLabel?.toLowerCase().includes('bilibili')
          ),
        };
        groupMap.set(id, group);
        groups.push(group);
      }
      if (item.detectedAt && (group.detectedAt ?? 0) < item.detectedAt) {
        group.detectedAt = item.detectedAt;
      }
      return group;
    };

    for (const item of streamItems) {
      if (item.groupRole === 'audio') {
        pendingAudio.push(item);
        continue;
      }
      if (item.groupRole === 'segment') continue;
      const masterId =
        item.groupMasterId ||
        (item.groupRole === 'master' ? item.groupId : undefined);
      const id = masterId || item.groupId || item.url;
      const group = ensureGroup(id, item);
      if (item.groupRole === 'variant') {
        group.variants.push(item);
      } else {
        // master or ungrouped stream
        if (!group.master) group.master = item;
      }
    }

    // Separate audio tracks (standalone DASH audio): attach to an existing group by groupId, otherwise form an audio-only group.
    for (const audio of pendingAudio) {
      if (audio.groupId && groupMap.has(audio.groupId)) {
        groupMap.get(audio.groupId)?.audioItems.push(audio);
      } else {
        const group = ensureGroup(
          audio.groupId || audio.groupLabel || audio.url,
          audio
        );
        group.audioItems.push(audio);
      }
    }

    // Sort variants by bandwidth, descending
    for (const group of groups) {
      group.variants.sort(
        (a, b) => (b.variantBandwidth ?? 0) - (a.variantBandwidth ?? 0)
      );
    }
    return groups;
  }, [mediaCatalog]);

  /**
   * Flat list (all tab): stream-group cards and regular entries sorted by detectedAt.
   */
  const flatMediaList = useMemo<StreamFlatItem[]>(() => {
    const entries: StreamFlatItem[] = [];
    if (activeTab === 'all' || activeTab === 'stream') {
      for (const group of groupedStreamList) {
        entries.push({ kind: 'group', group });
      }
    }
    for (const item of mediaCatalog.all) {
      if (getType(item.format, item.category, item.groupRole) === 'stream')
        continue;
      // Group audio tracks are shown inside their stream group card. Skip them
      // only when that card actually rendered them; if no card exists for an
      // audio track (e.g. its video master got filtered out), fall back to an
      // independent entry so audio never silently disappears from the list.
      if (item.groupRole === 'audio') {
        const inRenderedGroup = groupedStreamList.some((g) =>
          g.audioItems.some((a) => a.url === item.url)
        );
        if (inRenderedGroup) continue;
      }
      entries.push({ kind: 'item', item });
    }
    const direction = sortOrder === 'asc' ? 1 : -1;
    return entries.sort((a, b) => {
      const at =
        a.kind === 'group'
          ? (a.group.detectedAt ?? 0)
          : (a.item.detectedAt ?? 0);
      const bt =
        b.kind === 'group'
          ? (b.group.detectedAt ?? 0)
          : (b.item.detectedAt ?? 0);
      return (at - bt) * direction;
    });
  }, [activeTab, groupedStreamList, mediaCatalog, sortOrder]);

  return {
    activeTab,
    setActiveTab,
    typeFilter,
    setTypeFilter,
    sizeFilter,
    setSizeFilter,
    dimensionFilter,
    setDimensionFilter,
    resolutionFilter,
    setResolutionFilter,
    sortOrder,
    setSortOrder,
    searchQuery,
    setSearchQuery,
    useRegex,
    setUseRegex,
    regexValid,
    searchError,
    clearSearch,
    tabCounts: mediaCatalog.counts,
    enabledTabs,
    typeOptions,
    filteredMediaList,
    filteredImageList,
    groupedStreamList,
    flatMediaList,
    mediaCatalog,
  };
}
