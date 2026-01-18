import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';

type SupportedLang = 'en' | 'es';

@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly document = inject(DOCUMENT);
  currentLang = signal<SupportedLang>(this.getInitialLang());

  setLang(lang: SupportedLang) {
    if (lang === this.currentLang()) return;

    this.currentLang.set(lang);
    try {
      localStorage.setItem('pirateflix_lang', lang);
    } catch {}

    if (this.document?.documentElement) {
      this.document.documentElement.lang = lang;
      this.document.documentElement.classList.remove('lang-en', 'lang-es');
      this.document.documentElement.classList.add(`lang-${lang}`);
    }

    this.document?.location?.reload();
  }

  private getInitialLang(): SupportedLang {
    try {
      const saved = localStorage.getItem('pirateflix_lang');
      if (saved === 'es' || saved === 'en') return saved;
    } catch {}

    const docLang = this.document?.documentElement?.lang;
    if (docLang === 'es' || docLang === 'en') return docLang;

    return 'en';
  }
}

export type { SupportedLang };
