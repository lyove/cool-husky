import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  subscribeAppearance,
  getCurrentLocale,
  getCurrentTheme,
  getResolvedLocale,
  loadAppearance,
  saveAppearance,
  setLocale as setLocaleStore,
  setTheme as setThemeStore,
  t as translate,
  LOCALE_OPTIONS,
} from '../../../utils/i18n';
import type { LocaleCode, ThemeMode } from '../../../utils/i18n';

function getSnapshot(): string {
  return `${getCurrentLocale()}|${getCurrentTheme()}`;
}

export function useI18n(): {
  t: typeof translate;
  locale: LocaleCode;
  theme: ThemeMode;
  density: 'compact';
  resolvedLocale: string;
  setLocale: (locale: LocaleCode) => Promise<void>;
  setTheme: (theme: ThemeMode) => Promise<void>;
} {
  useSyncExternalStore(subscribeAppearance, getSnapshot);

  useEffect(() => {
    let disposed = false;
    void loadAppearance().then(() => {
      if (disposed) {
        return;
      }
    });
    return (): void => {
      disposed = true;
    };
  }, []);

  const setLocale = useCallback(async (locale: LocaleCode): Promise<void> => {
    setLocaleStore(locale);
    await saveAppearance();
  }, []);

  const setTheme = useCallback(async (theme: ThemeMode): Promise<void> => {
    setThemeStore(theme);
    await saveAppearance();
  }, []);

  return {
    t: translate,
    locale: getCurrentLocale(),
    theme: getCurrentTheme(),
    density: 'compact',
    resolvedLocale: getResolvedLocale(),
    setLocale,
    setTheme,
  };
}

export { LOCALE_OPTIONS };
