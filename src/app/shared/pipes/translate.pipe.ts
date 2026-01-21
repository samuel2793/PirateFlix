import { Pipe, PipeTransform, inject, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { TranslationService } from '../services/translation.service';
import { effect } from '@angular/core';

/**
 * Pipe reactivo para traducciones dinámicas
 * Uso: {{ 'Hello World' | t }}
 */
@Pipe({
  name: 't',
  standalone: true,
  pure: false, // Impure para re-evaluar cuando cambia el idioma
})
export class TranslatePipe implements PipeTransform, OnDestroy {
  private readonly translation = inject(TranslationService);
  private readonly cdr = inject(ChangeDetectorRef);
  private lastVersion = -1;
  private lastKey = '';
  private lastValue = '';
  private effectRef: ReturnType<typeof effect> | null = null;

  constructor() {
    // Forzar detección de cambios cuando cambia el idioma
    this.effectRef = effect(() => {
      const version = this.translation.version();
      if (version !== this.lastVersion) {
        this.lastVersion = version;
        this.cdr.markForCheck();
      }
    });
  }

  transform(key: string): string {
    // Si la clave o versión cambió, recalcular
    const version = this.translation.version();
    if (key !== this.lastKey || version !== this.lastVersion) {
      this.lastKey = key;
      this.lastVersion = version;
      this.lastValue = this.translation.translate(key);
    }
    return this.lastValue;
  }

  ngOnDestroy(): void {
    // Effects se limpian automáticamente, pero por seguridad
    this.effectRef = null;
  }
}
