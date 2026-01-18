import { registerLocaleData } from '@angular/common';
import { clearTranslations, loadTranslations, ɵcomputeMsgId as computeMsgId } from '@angular/localize';
import localeEs from '@angular/common/locales/es';

type SupportedLang = 'en' | 'es';

const LANGUAGE_STORAGE_KEY = 'pirateflix_lang';

const getInitialLang = (): SupportedLang => {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === 'en' || saved === 'es') return saved;
  } catch {}

  const docLang = document?.documentElement?.lang;
  if (docLang === 'en' || docLang === 'es') return docLang;

  return 'en';
};

const loadRuntimeTranslations = async (lang: SupportedLang) => {
  if (document?.documentElement) {
    document.documentElement.lang = lang;
    document.documentElement.classList.remove('lang-en', 'lang-es');
    document.documentElement.classList.add(`lang-${lang}`);
  }

  clearTranslations();

  try {
    const response = await fetch(`/i18n/${lang}.json`, { cache: 'no-store' });
    if (!response.ok) {
      console.warn(`Missing translations for ${lang}`);
      return;
    }
    const raw = (await response.json()) as Record<string, string>;
    const translations: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      translations[computeMsgId(key)] = value;
    }
    loadTranslations(translations);
  } catch (err) {
    console.error('Failed to load translations:', err);
  }
};

(async () => {
  const lang = getInitialLang();
  registerLocaleData(localeEs);
  await loadRuntimeTranslations(lang);

  const [{ bootstrapApplication }, { appConfig }, { App }] = await Promise.all([
    import('@angular/platform-browser'),
    import('./app/app.config'),
    import('./app/app'),
  ]);

  bootstrapApplication(App, appConfig).catch((err) => console.error(err));
})();
