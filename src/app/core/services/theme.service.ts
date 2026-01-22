import { Injectable, signal, effect } from '@angular/core';

export type Theme = 'dark' | 'light' | 'system';
export type TextSize = 'small' | 'medium' | 'large';
export type AccentColor = 'gold' | 'red' | 'blue' | 'green' | 'purple' | 'orange' | 'cyan' | 'pink';

export interface ThemeSettings {
  theme: Theme;
  accentColor: AccentColor;
  textSize: TextSize;
  reduceMotion: boolean;
  highContrast: boolean;
}

const DEFAULT_SETTINGS: ThemeSettings = {
  theme: 'dark',
  accentColor: 'gold',
  textSize: 'medium',
  reduceMotion: false,
  highContrast: false,
};

// Accent color palettes - each with primary, dark (hover), and light variants
const ACCENT_COLORS: Record<AccentColor, { primary: string; dark: string; light: string; rgb: string }> = {
  gold: { primary: '#e5a00d', dark: '#c8890a', light: '#f5c518', rgb: '229, 160, 13' },
  red: { primary: '#e53935', dark: '#c62828', light: '#ef5350', rgb: '229, 57, 53' },
  blue: { primary: '#1e88e5', dark: '#1565c0', light: '#42a5f5', rgb: '30, 136, 229' },
  green: { primary: '#43a047', dark: '#2e7d32', light: '#66bb6a', rgb: '67, 160, 71' },
  purple: { primary: '#8e24aa', dark: '#6a1b9a', light: '#ab47bc', rgb: '142, 36, 170' },
  orange: { primary: '#fb8c00', dark: '#ef6c00', light: '#ffa726', rgb: '251, 140, 0' },
  cyan: { primary: '#00acc1', dark: '#00838f', light: '#26c6da', rgb: '0, 172, 193' },
  pink: { primary: '#d81b60', dark: '#ad1457', light: '#ec407a', rgb: '216, 27, 96' },
};

const STORAGE_KEY = 'pirateflix_theme';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  // Signals for reactive state
  readonly theme = signal<Theme>(DEFAULT_SETTINGS.theme);
  readonly accentColor = signal<AccentColor>(DEFAULT_SETTINGS.accentColor);
  readonly textSize = signal<TextSize>(DEFAULT_SETTINGS.textSize);
  readonly reduceMotion = signal<boolean>(DEFAULT_SETTINGS.reduceMotion);
  readonly highContrast = signal<boolean>(DEFAULT_SETTINGS.highContrast);
  
  // Computed effective theme (resolves 'system' to actual theme)
  readonly effectiveTheme = signal<'dark' | 'light'>('dark');

  private mediaQuery: MediaQueryList | null = null;
  private boundMediaQueryHandler: (() => void) | null = null;

  constructor() {
    // Load saved settings immediately
    this.loadSettings();
    
    // Listen for system theme changes
    if (typeof window !== 'undefined') {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this.boundMediaQueryHandler = () => {
        if (this.theme() === 'system') {
          this.updateEffectiveTheme();
          this.applyAllSettings();
        }
      };
      this.mediaQuery.addEventListener('change', this.boundMediaQueryHandler);
    }

    // Effect to apply theme whenever any setting changes
    effect(() => {
      // Read all signals to track them
      this.theme();
      this.accentColor();
      this.textSize();
      this.reduceMotion();
      this.highContrast();
      this.effectiveTheme();
      // Apply settings
      this.applyAllSettings();
    });
  }

  private loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const settings: Partial<ThemeSettings> = JSON.parse(saved);
        if (settings.theme) this.theme.set(settings.theme);
        if (settings.accentColor) this.accentColor.set(settings.accentColor);
        if (settings.textSize) this.textSize.set(settings.textSize);
        if (settings.reduceMotion !== undefined) this.reduceMotion.set(settings.reduceMotion);
        if (settings.highContrast !== undefined) this.highContrast.set(settings.highContrast);
      }
      this.updateEffectiveTheme();
      this.applyAllSettings();
    } catch (e) {
      console.error('Error loading theme settings:', e);
    }
  }

  private saveSettings() {
    const settings: ThemeSettings = {
      theme: this.theme(),
      accentColor: this.accentColor(),
      textSize: this.textSize(),
      reduceMotion: this.reduceMotion(),
      highContrast: this.highContrast(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error('Error saving theme settings:', e);
    }
  }

  private updateEffectiveTheme() {
    const theme = this.theme();
    if (theme === 'system') {
      const prefersDark = this.mediaQuery?.matches ?? true;
      this.effectiveTheme.set(prefersDark ? 'dark' : 'light');
    } else {
      this.effectiveTheme.set(theme);
    }
  }

  private applyAllSettings() {
    if (typeof document === 'undefined') return;
    
    const root = document.documentElement;
    const effective = this.effectiveTheme();
    const accent = ACCENT_COLORS[this.accentColor()];
    const size = this.textSize();
    const motion = this.reduceMotion();
    const contrast = this.highContrast();

    // Apply theme
    root.setAttribute('data-theme', effective);
    
    // Apply accent color CSS variables (both long and short forms for compatibility)
    root.style.setProperty('--accent-primary', accent.primary);
    root.style.setProperty('--accent-primary-dark', accent.dark);
    root.style.setProperty('--accent-primary-light', accent.light);
    root.style.setProperty('--accent-primary-rgb', accent.rgb);
    // Short forms used by components
    root.style.setProperty('--accent-dark', accent.dark);
    root.style.setProperty('--accent-light', accent.light);
    root.style.setProperty('--accent-rgb', accent.rgb);
    root.style.setProperty('--accent-muted', `rgba(${accent.rgb}, 0.12)`);
    
    // Apply text size
    root.setAttribute('data-text-size', size);
    
    // Apply reduce motion
    if (motion) {
      root.classList.add('reduce-motion');
    } else {
      root.classList.remove('reduce-motion');
    }
    
    // Apply high contrast
    if (contrast) {
      root.classList.add('high-contrast');
    } else {
      root.classList.remove('high-contrast');
    }
  }

  // Public setters
  setTheme(theme: Theme) {
    this.theme.set(theme);
    this.updateEffectiveTheme();
    this.saveSettings();
  }

  setAccentColor(color: AccentColor) {
    this.accentColor.set(color);
    this.saveSettings();
  }

  setTextSize(size: TextSize) {
    this.textSize.set(size);
    this.saveSettings();
  }

  setReduceMotion(reduce: boolean) {
    this.reduceMotion.set(reduce);
    this.saveSettings();
  }

  setHighContrast(contrast: boolean) {
    this.highContrast.set(contrast);
    this.saveSettings();
  }

  resetToDefaults() {
    this.theme.set(DEFAULT_SETTINGS.theme);
    this.accentColor.set(DEFAULT_SETTINGS.accentColor);
    this.textSize.set(DEFAULT_SETTINGS.textSize);
    this.reduceMotion.set(DEFAULT_SETTINGS.reduceMotion);
    this.highContrast.set(DEFAULT_SETTINGS.highContrast);
    this.updateEffectiveTheme();
    localStorage.removeItem(STORAGE_KEY);
  }

  // Get available accent colors for UI
  getAccentColorOptions(): { value: AccentColor; label: string; color: string }[] {
    return [
      { value: 'gold', label: 'Gold', color: ACCENT_COLORS.gold.primary },
      { value: 'orange', label: 'Orange', color: ACCENT_COLORS.orange.primary },
      { value: 'red', label: 'Red', color: ACCENT_COLORS.red.primary },
      { value: 'pink', label: 'Pink', color: ACCENT_COLORS.pink.primary },
      { value: 'purple', label: 'Purple', color: ACCENT_COLORS.purple.primary },
      { value: 'blue', label: 'Blue', color: ACCENT_COLORS.blue.primary },
      { value: 'cyan', label: 'Cyan', color: ACCENT_COLORS.cyan.primary },
      { value: 'green', label: 'Green', color: ACCENT_COLORS.green.primary },
    ];
  }
}
