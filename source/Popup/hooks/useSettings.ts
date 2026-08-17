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
    browser.runtime
      .sendMessage({ type: 'GET_SETTINGS' })
      .then((res: unknown) => {
        if (!disposed && res) setSettings(res as Settings);
      })
      .catch(() => {});
    return (): void => {
      disposed = true;
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
