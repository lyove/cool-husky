import { useEffect, useState, type ReactElement } from 'react';
import browser from 'webextension-polyfill';
import { loadAppearance } from '../utils/i18n';
import styles from './Welcome.module.scss';

const version = browser.runtime.getManifest().version;

const FAQ_KEYS = Array.from({ length: 9 }, (_, i) => {
  return {
    questionKey: `faq${i + 1}Q`,
    answerKey: `faq${i + 1}A`,
  };
});

function Welcome(): ReactElement {
  const [openFaqs, setOpenFaqs] = useState<boolean[]>(() =>
    FAQ_KEYS.map(() => false)
  );

  useEffect(() => {
    void loadAppearance();
  }, []);

  const t = (key: string): string => browser.i18n.getMessage(key) ?? '';

  const toggleFaq = (index: number): void => {
    setOpenFaqs((prev) => prev.map((open, i) => (i === index ? !open : open)));
  };

  return (
    <div className={styles.welcome}>
      <header className={styles.header}>
        <img className={styles.logo} src="/icon/128.png" alt="CoolHusky" />
        <h1 className={styles.title}>CoolHusky</h1>
        <p className={styles.version}>v{version}</p>
        <p className={styles.subtitle}>{t('welcomeSubtitle')}</p>
      </header>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>{t('changelogTitle')}</h2>
          <span className={styles.sectionBadge}>{t('changelogVersion')}</span>
        </div>
        <div>
          <h3 className={styles.subTitle}>{t('changelogFeaturesTitle')}</h3>
          <p className={`${styles.text} ${styles.preline}`}>
            {t('changelogFeatures')}
          </p>
          {/* <h3 className={styles.subTitle}>{t('changelogFixesTitle')}</h3>
          <p className={`${styles.text} ${styles.preline}`}>
            {t('changelogFixes')}
          </p> */}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t('tutorialTitle')}</h2>
        <div>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={styles.step}>
              <div className={styles.stepNum}>{i + 1}</div>
              <div>
                <h3 className={styles.stepTitle}>{t(`step${i + 1}Title`)}</h3>
                <p className={styles.stepDesc}>{t(`step${i + 1}Desc`)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t('faqTitle')}</h2>
        <div>
          {FAQ_KEYS.map((faq, index) => (
            <div key={faq.questionKey} className={styles.faq}>
              <button
                type="button"
                className={styles.faqQuestion}
                onClick={() => toggleFaq(index)}
              >
                <span>{t(faq.questionKey)}</span>
                <svg
                  className={`${styles.faqArrow} ${
                    openFaqs[index] ? styles.faqArrowOpen : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
              {openFaqs[index] && (
                <p className={styles.faqAnswer}>{t(faq.answerKey)}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.help}>
          <h3 className={styles.subTitle}>{t('needMoreHelp')}</h3>
          <p className={styles.text}>{t('needMoreHelpDesc')}</p>
          <a
            href="https://github.com/lyove/cool-husky/"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.githubBtn}
          >
            <svg
              className={styles.githubIcon}
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </a>
        </div>
      </section>

      <footer className={styles.footer}>CoolHusky v{version}</footer>
    </div>
  );
}

export default Welcome;
