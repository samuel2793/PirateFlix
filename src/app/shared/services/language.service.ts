import { inject, Injectable, computed } from '@angular/core';
import { TranslationService, SupportedLang } from './translation.service';

/**
 * Servicio de idioma que delega al TranslationService
 * Mantiene compatibilidad con la API existente
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly translationService = inject(TranslationService);
  
  // Exponer señales del TranslationService
  readonly currentLang = this.translationService.currentLang;
  readonly isChangingLanguage = this.translationService.isChangingLanguage;

  /**
   * Cambiar idioma con transición suave (sin recarga de página)
   */
  setLang(lang: SupportedLang): void {
    this.translationService.setLang(lang);
  }

  /**
   * Obtener traducción reactiva
   */
  translate(key: string): string {
    return this.translationService.translate(key);
  }
}

export type { SupportedLang };
