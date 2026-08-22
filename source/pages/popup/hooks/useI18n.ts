import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  subscribeAppearance,
  getCurrentLocale,
  getCurrentTheme,
  getCurrentDensity,
  getResolvedLocale,
  loadAppearance,
  saveAppearance,
  setLocale as setLocaleStore,
  setTheme as setThemeStore,
  setDensity as setDensityStore,
  t as translate,
  LOCALE_OPTIONS,
} from '../../../utils/i18n';
import type { DensityMode, LocaleCode, ThemeMode } from '../../../utils/i18n';

function getSnapshot(): string {
  return `${getCurrentLocale()}|${getCurrentTheme()}|${getCurrentDensity()}`;
}

export function useI18n(): {
  t: typeof translate;
  locale: LocaleCode;
  theme: ThemeMode;
  density: DensityMode;
  resolvedLocale: string;
  setLocale: (locale: LocaleCode) => Promise<void>;
  setTheme: (theme: ThemeMode) => Promise<void>;
  setDensity: (density: DensityMode) => Promise<void>;
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

  const setDensity = useCallback(
    async (density: DensityMode): Promise<void> => {
      setDensityStore(density);
      await saveAppearance();
    },
    []
  );

  return {
    t: translate,
    locale: getCurrentLocale(),
    theme: getCurrentTheme(),
    density: getCurrentDensity(),
    resolvedLocale: getResolvedLocale(),
    setLocale,
    setTheme,
    setDensity,
  };
}

export { LOCALE_OPTIONS };
