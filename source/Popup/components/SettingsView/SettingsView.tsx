import { useEffect, useRef, useState } from 'react';
import type { FC, ReactNode } from 'react';
import type { Settings, SniffingGroup } from '../../../utils/settings';
import { DEFAULT_SETTINGS } from '../../../utils/settings';
import { useI18n, LOCALE_OPTIONS } from '../../hooks/useI18n';
import styles from './SettingsView.module.scss';

const GROUP_META: Array<{
  key: SniffingGroup;
  labelKey: string;
  icon: string;
}> = [
  { key: 'streaming', labelKey: 'streaming', icon: '📡' },
  { key: 'video', labelKey: 'video', icon: '🎥' },
  { key: 'audio', labelKey: 'audio', icon: '🎵' },
  { key: 'image', labelKey: 'image', icon: '🖼️' },
  { key: 'document', labelKey: 'document', icon: '📄' },
  { key: 'subtitle', labelKey: 'subtitleGroup', icon: '💬' },
];

const THEME_OPTIONS = [
  { value: 'system', icon: '💻', labelKey: 'themeSystem' },
  { value: 'light', icon: '☀️', labelKey: 'themeLight' },
  { value: 'dark', icon: '🌙', labelKey: 'themeDark' },
] as const;

const DENSITY_OPTIONS = [
  { value: 'comfortable', labelKey: 'densityComfortable' },
  { value: 'compact', labelKey: 'densityCompact' },
] as const;

const OPEN_MODE_OPTIONS = [
  { value: 'sidepanel', labelKey: 'openModeSidepanel' },
  { value: 'popup', labelKey: 'openModePopup' },
] as const;

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  color?: 'blue' | 'rose';
}

const Switch: FC<SwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  color = 'blue',
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    className={`${styles.switch} ${checked ? styles.switchOn : ''} ${
      checked && color === 'rose' ? styles.switchOnRose : ''
    }`}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.switchKnob} />
  </button>
);

interface CardProps {
  color: string;
  title: string;
  children: ReactNode;
}

const Card: FC<CardProps> = ({ color, title, children }) => (
  <section className={styles.card}>
    <div className={styles.cardHeader}>
      <span className={styles.cardBar} style={{ backgroundColor: color }} />
      <h3 className={styles.cardTitle}>{title}</h3>
    </div>
    <div className={styles.cardBody}>{children}</div>
  </section>
);

interface SettingsViewProps {
  settings: Settings | null;
  onSave: (patch: Partial<Settings>) => Promise<void>;
  onBack: () => void;
  onOpenShortcuts?: () => void;
}

const SettingsView: FC<SettingsViewProps> = ({
  settings,
  onSave,
  onBack,
  onOpenShortcuts,
}) => {
  const { t, locale, theme, density, setLocale, setTheme, setDensity } =
    useI18n();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [excludeDomainsText, setExcludeDomainsText] = useState('');
  const [regexRulesText, setRegexRulesText] = useState('');
  const [formatOverridesText, setFormatOverridesText] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef<Settings | null>(null);
  draftRef.current = draft;
  const excludeTextRef = useRef(excludeDomainsText);
  excludeTextRef.current = excludeDomainsText;
  const regexTextRef = useRef(regexRulesText);
  regexTextRef.current = regexRulesText;
  const formatOverridesTextRef = useRef(formatOverridesText);
  formatOverridesTextRef.current = formatOverridesText;

  useEffect(() => {
    if (settings && !draft) {
      setDraft({ ...settings });
      setExcludeDomainsText(settings.excludeDomains.join('\n'));
      setRegexRulesText(
        (settings.regexRules || [])
          .map((r) => {
            const target = r.action === 'block' ? 'block' : r.format || 'mp4';
            return `/${r.pattern}/${r.flags} => ${target}`;
          })
          .join('\n')
      );
      setFormatOverridesText(
        Object.entries(settings.formatOverrides || {})
          .map(([fmt, o]) => {
            const parts: string[] = [fmt];
            if (typeof o.enabled === 'boolean') {
              parts.push(`enabled=${o.enabled}`);
            }
            if (typeof o.minSizeKB === 'number') {
              parts.push(`minSizeKB=${o.minSizeKB}`);
            }
            if (o.operator) {
              parts.push(`operator=${o.operator}`);
            }
            return parts.join(', ');
          })
          .join('\n')
      );
    }
  }, [settings, draft]);

  useEffect(
    () => (): void => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    },
    []
  );

  const autoSave = (): void => {
    const snapshot = draftRef.current;
    if (!snapshot) {
      return;
    }
    const domains = excludeTextRef.current
      .split(/[\n,]/)
      .map((s) =>
        s
          .trim()
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
      )
      .filter(Boolean);
    // Parse regex rules text: one rule per line, format: /pattern/flags => ext|block
    const regexRules = regexTextRef.current
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^\/(.+)\/([gimsuy]*)\s*=>\s*(\S+)\s*$/);
        if (!m) {
          return null;
        }
        const [, pattern, flags, target] = m;
        if (target === 'block') {
          return {
            pattern: pattern || '',
            flags: flags || 'i',
            action: 'block' as const,
            enabled: true,
          };
        }
        return {
          pattern: pattern || '',
          flags: flags || 'i',
          action: 'match' as const,
          format: target || 'mp4',
          enabled: true,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    // Parse format overrides text: one per line, e.g. "mp4, enabled=false, minSizeKB=100, operator=>="
    const formatOverrides: Record<string, any> = {};
    formatOverridesTextRef.current
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const tokens = line.split(',').map((s) => s.trim());
        const fmt = tokens[0]?.toLowerCase();
        if (!fmt) {
          return;
        }
        const o: Record<string, unknown> = {};
        for (const tok of tokens.slice(1)) {
          const m = tok.match(/^(\w+)\s*=\s*(.+)$/);
          if (!m) {
            continue;
          }
          const [, key, val] = m;
          if (key === 'enabled') {
            o.enabled = val === 'true';
          } else if (key === 'minSizeKB') {
            const n = Number(val);
            if (!isNaN(n)) {
              o.minSizeKB = n;
            }
          } else if (key === 'operator') {
            o.operator = val;
          }
        }
        if (Object.keys(o).length > 0) {
          formatOverrides[fmt] = o;
        }
      });
    const patch: Partial<Settings> = {
      ...snapshot,
      excludeDomains: domains,
      regexRules,
      formatOverrides,
    };
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      void onSave(patch).then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1200);
      });
    }, 300);
  };

  const patchDraft = (patch: Partial<Settings>): void => {
    if (!draft) {
      return;
    }
    const next = { ...draft, ...patch };
    draftRef.current = next;
    setDraft(next);
    autoSave();
  };

  const patchRule = (
    key: SniffingGroup,
    rulePatch: Partial<{ enabled: boolean; minSizeKB: number }>
  ): void => {
    if (!draft) {
      return;
    }
    const next = {
      ...draft,
      sniffingRules: {
        ...draft.sniffingRules,
        [key]: { ...draft.sniffingRules[key], ...rulePatch },
      },
    };
    draftRef.current = next;
    setDraft(next);
    autoSave();
  };

  const handleReset = async (): Promise<void> => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    setConfirmReset(false);
    const next = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
    setDraft(next);
    setExcludeDomainsText('');
    setRegexRulesText('');
    setFormatOverridesText('');
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    await onSave({ ...next, excludeDomains: [] });
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  if (!draft) {
    return null;
  }

  return (
    <div className={styles.settings}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button type="button" className={styles.backBtn} onClick={onBack}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className={styles.backIcon}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 19.5 8.25 12l7.5-7.5"
              />
            </svg>
          </button>
          <h2 className={styles.title}>{t('settings')}</h2>
        </div>
        <span
          className={`${styles.saveBadge} ${saved ? styles.saveBadgeShow : ''}`}
        >
          {saved ? t('saved') : ''}
        </span>
      </header>

      <div className={styles.body}>
        {/* Appearance */}
        <Card color="#8b5cf6" title={t('appearance')}>
          <div className={styles.field}>
            <p className={styles.fieldLabel}>{t('openMode')}</p>
            <div className={styles.segment}>
              {OPEN_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`${styles.segmentBtn} ${
                    draft.openMode === opt.value ? styles.segmentBtnActive : ''
                  }`}
                  onClick={() =>
                    patchDraft({ openMode: opt.value as Settings['openMode'] })
                  }
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
            <p className={styles.desc}>{t('openModeDesc')}</p>
          </div>
          <div className={styles.field}>
            <p className={styles.fieldLabel}>{t('theme')}</p>
            <div className={styles.segment}>
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`${styles.segmentBtn} ${
                    theme === opt.value ? styles.segmentBtnActive : ''
                  }`}
                  onClick={() => void setTheme(opt.value)}
                >
                  <span className={styles.segmentIcon}>{opt.icon}</span>
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.field}>
            <p className={styles.fieldLabel}>{t('density')}</p>
            <div className={styles.segment}>
              {DENSITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`${styles.segmentBtn} ${
                    density === opt.value ? styles.segmentBtnActive : ''
                  }`}
                  onClick={() => void setDensity(opt.value)}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.field}>
            <p className={styles.fieldLabel}>{t('language')}</p>
            <select
              className={styles.select}
              value={locale}
              onChange={(e) => void setLocale(e.target.value as typeof locale)}
            >
              {LOCALE_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  {opt.nativeLabel}
                </option>
              ))}
            </select>
          </div>
        </Card>

        {/* Sniffing Groups */}
        <Card color="#3b82f6" title={t('sniffingRules')}>
          <div className={styles.ruleHead}>
            <span>{t('type')}</span>
            <span>{t('sniff')}</span>
            <span>{t('minSizeKB')}</span>
          </div>
          {GROUP_META.map((group) => {
            const rule = draft.sniffingRules[group.key];
            return (
              <div key={group.key} className={styles.ruleRow}>
                <span className={styles.ruleLabel}>
                  <span className={styles.ruleIcon}>{group.icon}</span>
                  {t(group.labelKey)}
                </span>
                <Switch
                  checked={rule.enabled}
                  onChange={(next) => patchRule(group.key, { enabled: next })}
                />
                <span className={styles.minSize}>
                  <input
                    className={styles.numberInput}
                    type="number"
                    min={0}
                    disabled={!rule.enabled}
                    value={rule.minSizeKB}
                    onChange={(e) =>
                      patchRule(group.key, {
                        minSizeKB: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                  />
                  {t('kb')}
                </span>
              </div>
            );
          })}
        </Card>

        {/* Max Items */}
        <Card color="#eab308" title={t('maxItems')}>
          <div className={styles.maxItemsRow}>
            <input
              className={styles.numberInput}
              type="number"
              min={10}
              max={5000}
              step={10}
              value={draft.maxItems}
              onChange={(e) =>
                patchDraft({ maxItems: Number(e.target.value) || 10 })
              }
            />
          </div>
          <p className={styles.desc}>{t('maxItemsDesc')}</p>
        </Card>

        {/* MSE Capture */}
        <Card color="#f43f5e" title={t('capture')}>
          <div className={styles.switchRow}>
            <div>
              <p className={styles.rowTitle}>{t('enableMseCapture')}</p>
              <p className={styles.desc}>{t('enableMseCaptureDesc')}</p>
            </div>
            <Switch
              checked={draft.enableMseCapture}
              onChange={(next) => patchDraft({ enableMseCapture: next })}
              color="rose"
            />
          </div>
          <div className={styles.switchRow}>
            <div>
              <p className={styles.rowTitle}>{t('hideStreamSegments')}</p>
              <p className={styles.desc}>{t('hideStreamSegmentsDesc')}</p>
            </div>
            <Switch
              checked={draft.hideStreamSegments}
              onChange={(next) => patchDraft({ hideStreamSegments: next })}
              color="rose"
            />
          </div>
          <div className={styles.switchRow}>
            <div>
              <p className={styles.rowTitle}>{t('captureDataImages')}</p>
              <p className={styles.desc}>{t('captureDataImagesDesc')}</p>
            </div>
            <Switch
              checked={draft.captureDataImages}
              onChange={(next) => patchDraft({ captureDataImages: next })}
              color="rose"
            />
          </div>
          <div className={styles.switchRow}>
            <div>
              <p className={styles.rowTitle}>{t('deepSearch')}</p>
              <p className={styles.desc}>{t('deepSearchStarted')}</p>
            </div>
            <Switch
              checked={draft.enableDeepSearch}
              onChange={(next) => patchDraft({ enableDeepSearch: next })}
              color="rose"
            />
          </div>
          {draft.captureDataImages && (
            <div className={styles.minSizeRow}>
              <span>{t('dataImageMinSizeKB')}</span>
              <span className={styles.minSize}>
                <input
                  className={styles.numberInput}
                  type="number"
                  min={0}
                  value={draft.dataImageMinSizeKB}
                  onChange={(e) =>
                    patchDraft({
                      dataImageMinSizeKB: Math.max(
                        0,
                        Number(e.target.value) || 0
                      ),
                    })
                  }
                />
                {t('kb')}
              </span>
            </div>
          )}
        </Card>

        {/* Exclude Domains */}
        <Card color="#ef4444" title={t('excludeDomains')}>
          <textarea
            className={styles.textarea}
            rows={4}
            placeholder={t('excludeDomainsPlaceholder')}
            value={excludeDomainsText}
            onChange={(e) => {
              setExcludeDomainsText(e.target.value);
              autoSave();
            }}
          />
          <p className={styles.desc}>{t('excludeDomainsDesc')}</p>
        </Card>

        {/* Regex Rules */}
        <Card color="#10b981" title={t('regexRules')}>
          <textarea
            className={styles.textarea}
            rows={4}
            placeholder={t('regexRulesPlaceholder')}
            value={regexRulesText}
            onChange={(e) => {
              setRegexRulesText(e.target.value);
              autoSave();
            }}
          />
          <p className={styles.desc}>{t('regexRulesDesc')}</p>
        </Card>

        {/* Advanced Format Overrides */}
        <Card color="#0ea5e9" title={t('advancedFormatOverrides')}>
          <textarea
            className={styles.textarea}
            rows={3}
            placeholder={
              'mp4, enabled=true, minSizeKB=100, operator=>=\nm3u8, enabled=true'
            }
            value={formatOverridesText}
            onChange={(e) => {
              setFormatOverridesText(e.target.value);
              autoSave();
            }}
          />
          <p className={styles.desc}>{t('advancedFormatOverridesDesc')}</p>
        </Card>

        {/* Keyboard Shortcuts */}
        {onOpenShortcuts && (
          <Card color="#6366f1" title={t('keyboardShortcuts')}>
            <p className={styles.desc}>{t('keyboardShortcutsDesc')}</p>
            <button
              type="button"
              className={styles.openShortcutsBtn}
              onClick={onOpenShortcuts}
            >
              {t('open')}
            </button>
          </Card>
        )}

        {/* Reset */}
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.resetBtn} ${confirmReset ? styles.resetBtnDanger : ''}`}
            onClick={() => void handleReset()}
          >
            {confirmReset && (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className={styles.resetIcon}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                />
              </svg>
            )}
            {confirmReset ? t('resetConfirm') : t('resetToDefaults')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsView;
