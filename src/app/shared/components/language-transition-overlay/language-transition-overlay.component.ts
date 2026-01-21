import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslationService } from '../../services/translation.service';

/**
 * Componente de overlay para transición suave de idioma
 * Se muestra brevemente durante el cambio de idioma
 */
@Component({
  selector: 'app-language-transition-overlay',
  standalone: true,
  imports: [CommonModule],
  // Sin overlay global - la transición se hace solo en los textos
  template: ``,
  styles: []
})
export class LanguageTransitionOverlayComponent {
  private readonly translation = inject(TranslationService);
  
  isChanging = this.translation.isChangingLanguage;
  
  currentLangFlag = computed(() => {
    const lang = this.translation.currentLang();
    return lang === 'es' ? '🇪🇸' : '🇬🇧';
  });
}
