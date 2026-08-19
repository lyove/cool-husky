import { useEffect, useState } from 'react';
import browser from 'webextension-polyfill';
import type { Settings } from '../../utils/settings';

export function useSettings(): {
  settings: Settings | null;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
} {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let disposed = false;
    const load = (): void => {
      browser.runtime
        .sendMessage({ type: 'GET_SETTINGS' })
        .then((res: unknown) => {
          if (!disposed && res) setSettings(res as Settings);
        })
        .catch(() => {});
    };
    load();
    // Keep settings fresh: toggling sniffing switches (e.g. image/doc) in the
    // options page must reflect live in the popup / sidepanel — counts, tabs
    // and filters are all derived from `settings`.
    const onChanged = (
      changes: Record<string, { newValue?: unknown }>,
      area: string
    ): void => {
      if (area === 'local' && changes['coolhusky_settings']) {
        load();
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return (): void => {
      disposed = true;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const saveSettings = async (patch: Partial<Settings>): Promise<void> => {
    const next = { ...(settings ?? {}), ...patch } as Settings;
    setSettings(next);
    await browser.runtime
      .sendMessage({ type: 'SAVE_SETTINGS', settings: next })
      .catch(() => {});
  };

  return { settings, saveSettings };
}
