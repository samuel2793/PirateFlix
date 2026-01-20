import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal, computed } from '@angular/core';
import { ɵcomputeMsgId as computeMsgId } from '@angular/localize';

type SupportedLang = 'en' | 'es';

interface TranslationState {
  lang: SupportedLang;
  translations: Record<string, string>;
  isLoading: boolean;
  version: number; // Para forzar re-renders
}

@Injectable({ providedIn: 'root' })
export class TranslationService {
  private readonly document = inject(DOCUMENT);
  
  // Estado interno de traducciones
  private readonly state = signal<TranslationState>({
    lang: this.getInitialLang(),
    translations: {},
    isLoading: false,
    version: 0,
  });

  // Señales públicas reactivas
  readonly currentLang = computed(() => this.state().lang);
  readonly isChangingLanguage = computed(() => this.state().isLoading);
  readonly version = computed(() => this.state().version);
  
  // Cache de traducciones por idioma
  private translationsCache: Map<SupportedLang, Record<string, string>> = new Map();

  constructor() {
    // Cargar traducciones iniciales
    this.loadTranslationsForLang(this.state().lang);
    // Pre-cargar el otro idioma para cambio instantáneo
    this.preloadAllTranslations();
  }

  /**
   * Pre-cargar ambos idiomas para cambio instantáneo
   */
  private preloadAllTranslations(): void {
    const langs: SupportedLang[] = ['en', 'es'];
    langs.forEach(lang => {
      if (lang !== this.state().lang) {
        // Cargar en background sin afectar el estado
        setTimeout(() => this.loadTranslationsForLang(lang), 200);
      }
    });
  }

  /**
   * Obtener traducción por clave original
   */
  translate(key: string): string {
    // Trigger reactivity
    const state = this.state();
    const msgId = computeMsgId(key);
    return state.translations[msgId] || key;
  }

  /**
   * Cambiar idioma con transición sin saltos (300ms total)
   * Swap en el punto medio cuando opacity=0.98
   */
  async setLang(lang: SupportedLang): Promise<void> {
    if (lang === this.state().lang) return;

    const docEl = this.document?.documentElement;
    if (!docEl) return;

    // Preservar estado del usuario
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const activeElement = this.document.activeElement as HTMLElement;
    const selection = window.getSelection();
    const selectionRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;

    // Congelar dimensiones de contenedores traducibles (width + height)
    this.freezeTranslatableDimensions();

    // Marcar inicio de transición
    this.state.update(s => ({ ...s, isLoading: true }));

    try {
      // Asegurar que las traducciones estén listas
      await this.loadTranslationsForLang(lang);

      // Iniciar animación continua (300ms total)
      docEl.classList.add('lang-transitioning');

      // Esperar hasta el punto medio (150ms) - cuando opacity=0.98
      await this.wait(150);

      // === SWAP en el punto medio ===
      try { localStorage.setItem('pirateflix_lang', lang); } catch {}

      docEl.lang = lang;
      docEl.classList.remove('lang-en', 'lang-es');
      docEl.classList.add(`lang-${lang}`);

      // Actualizar estado con nuevas traducciones
      const translations = this.translationsCache.get(lang) || {};
      this.state.update(s => ({
        ...s,
        lang,
        translations,
        version: s.version + 1,
      }));

      // Esperar segunda mitad de la animación (150ms)
      await this.wait(150);

      // Fin de transición
      docEl.classList.remove('lang-transitioning');
      this.unfreezeTranslatableDimensions();
      this.state.update(s => ({ ...s, isLoading: false }));

      // Restaurar estado del usuario
      requestAnimationFrame(() => {
        window.scrollTo(scrollX, scrollY);
        if (activeElement?.focus) {
          try { activeElement.focus(); } catch {}
        }
        if (selectionRange && selection) {
          try {
            selection.removeAllRanges();
            selection.addRange(selectionRange);
          } catch {}
        }
      });

    } catch (err) {
      console.error('Failed to change language:', err);
      this.state.update(s => ({ ...s, isLoading: false }));
    }
  }

  /**
   * Cargar traducciones para un idioma específico
   */
  private async loadTranslationsForLang(lang: SupportedLang): Promise<void> {
    // Verificar cache
    if (this.translationsCache.has(lang)) {
      return;
    }

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
      
      this.translationsCache.set(lang, translations);
      
      // Si es el idioma actual, actualizar estado e incrementar versión
      // para forzar re-render de los pipes de traducción
      if (lang === this.state().lang) {
        this.state.update(s => ({ ...s, translations, version: s.version + 1 }));
      }
    } catch (err) {
      console.error('Failed to load translations:', err);
    }
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

  /**
   * Utilidad: esperar N milisegundos
   */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Congelar dimensiones (width + height) de elementos traducibles
   * para evitar cualquier salto de layout durante el swap
   */
  private freezeTranslatableDimensions(): void {
    const elements = this.document.querySelectorAll('.translate-text');
    elements.forEach((el) => {
      const htmlEl = el as HTMLElement;
      const rect = htmlEl.getBoundingClientRect();
      // Congelar ambas dimensiones
      htmlEl.style.width = `${rect.width}px`;
      htmlEl.style.height = `${rect.height}px`;
      htmlEl.style.overflow = 'hidden';
      htmlEl.dataset['frozen'] = 'true';
    });
  }

  /**
   * Descongelar dimensiones tras la transición
   */
  private unfreezeTranslatableDimensions(): void {
    const elements = this.document.querySelectorAll('.translate-text[data-frozen]');
    elements.forEach((el) => {
      const htmlEl = el as HTMLElement;
      htmlEl.style.width = '';
      htmlEl.style.height = '';
      htmlEl.style.overflow = '';
      delete htmlEl.dataset['frozen'];
    });
  }
}

export type { SupportedLang };
