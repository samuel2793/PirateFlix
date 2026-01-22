import { ApplicationConfig, provideBrowserGlobalErrorListeners, APP_INITIALIZER, inject } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';

import { routes } from './app.routes';
import { TranslationService } from './shared/services/translation.service';
import { ThemeService } from './core/services/theme.service';

/**
 * Inicializador para precargar traducciones antes de que la app se renderice
 */
function initializeTranslations(): () => Promise<void> {
  const translationService = inject(TranslationService);
  return () => {
    // El servicio ya carga las traducciones en su constructor,
    // pero podemos esperar a que estén listas
    return Promise.resolve();
  };
}

/**
 * Inicializador para aplicar temas guardados al cargar
 */
function initializeTheme(): () => Promise<void> {
  const themeService = inject(ThemeService);
  return () => {
    // El servicio carga y aplica los temas en su constructor
    return Promise.resolve();
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(),
    provideAnimations(),
    {
      provide: APP_INITIALIZER,
      useFactory: initializeTranslations,
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: initializeTheme,
      multi: true,
    },
  ]
};
