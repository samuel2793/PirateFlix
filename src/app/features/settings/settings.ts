import { CommonModule } from '@angular/common';
import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { LanguageService, SupportedLang } from '../../shared/services/language.service';
import { ThemeService, Theme, TextSize, AccentColor } from '../../core/services/theme.service';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { GlobalNavComponent } from '../../shared/components/global-nav/global-nav';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

type VideoQuality = 'auto' | '4k' | '1080p' | '720p' | '480p';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslatePipe,
    GlobalNavComponent,
    MatIconModule,
    MatButtonModule,
    MatSlideToggleModule,
    MatSnackBarModule,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly language = inject(LanguageService);
  private readonly themeService = inject(ThemeService);
  private readonly snackBar = inject(MatSnackBar);
  
  private readonly STORAGE_KEY = 'pirateflix_settings';

  // Language
  currentLang = this.language.currentLang;
  isChangingLanguage = this.language.isChangingLanguage;

  // Theme settings from service
  theme = this.themeService.theme;
  accentColor = this.themeService.accentColor;
  textSize = this.themeService.textSize;
  reduceMotion = this.themeService.reduceMotion;
  highContrast = this.themeService.highContrast;

  // Playback Settings
  autoplay = signal(true);
  autoplayNextEpisode = signal(true);
  skipIntro = signal(true);
  skipCredits = signal(false);
  videoQuality = signal<'auto' | '4k' | '1080p' | '720p' | '480p'>('auto');
  dataSaver = signal(false);
  previewsWhileBrowsing = signal(true);

  // Audio & Subtitles
  preferredAudioLang = signal('original');
  preferredSubtitleLang = signal('none');
  showSubtitles = signal(false);
  subtitleSize = signal<TextSize>('medium');

  // Accent color options
  accentColorOptions = this.themeService.getAccentColorOptions();

  videoQualityOptions: { value: VideoQuality; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: '4k', label: '4K Ultra HD' },
    { value: '1080p', label: '1080p Full HD' },
    { value: '720p', label: '720p HD' },
    { value: '480p', label: '480p SD' },
  ];

  themeOptions: { value: Theme; label: string; icon: string }[] = [
    { value: 'dark', label: 'Dark', icon: 'dark_mode' },
    { value: 'light', label: 'Light', icon: 'light_mode' },
    { value: 'system', label: 'System', icon: 'settings_brightness' },
  ];

  textSizeOptions: { value: TextSize; label: string }[] = [
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
  ];

  audioLanguages = [
    { value: 'original', label: 'Original' },
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'pt', label: 'Português' },
  ];

  subtitleLanguages = [
    { value: 'none', label: 'Off' },
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'pt', label: 'Português' },
  ];

  // Initialize - load saved settings
  ngOnInit() {
    this.loadSettings();
  }

  // Load settings from localStorage (only playback/audio settings)
  private loadSettings() {
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY);
      if (saved) {
        const settings = JSON.parse(saved);
        
        // Playback
        if (settings.autoplayNextEpisode !== undefined) this.autoplayNextEpisode.set(settings.autoplayNextEpisode);
        
        // Audio & Subtitles
        if (settings.preferredAudioLang) this.preferredAudioLang.set(settings.preferredAudioLang);
        if (settings.preferredSubtitleLang) this.preferredSubtitleLang.set(settings.preferredSubtitleLang);
        if (settings.showSubtitles !== undefined) this.showSubtitles.set(settings.showSubtitles);
        if (settings.subtitleSize) this.subtitleSize.set(settings.subtitleSize);
      }
    } catch (e) {
      console.error('Error loading settings:', e);
    }
  }

  // Language
  changeLang(lang: SupportedLang) {
    this.language.setLang(lang);
  }

  // Theme setters (delegated to ThemeService)
  setTheme(theme: Theme) {
    this.themeService.setTheme(theme);
    this.showNotification('Theme updated');
  }

  setAccentColor(color: AccentColor) {
    this.themeService.setAccentColor(color);
    this.showNotification('Accent color updated');
  }

  setTextSize(size: TextSize) {
    this.themeService.setTextSize(size);
    this.showNotification('Text size updated');
  }

  toggleReduceMotion(event: any) {
    this.themeService.setReduceMotion(event.checked);
    this.showNotification('Settings saved');
  }

  toggleHighContrast(event: any) {
    this.themeService.setHighContrast(event.checked);
    this.showNotification('Settings saved');
  }

  // Playback setters
  setVideoQuality(quality: VideoQuality) {
    this.videoQuality.set(quality);
    this.saveSettings();
  }

  toggleAutoplayNextEpisode(event: any) {
    this.autoplayNextEpisode.set(event.checked);
    this.saveSettings();
  }

  // Audio setters
  setSubtitleSize(size: TextSize) {
    this.subtitleSize.set(size);
    this.saveSettings();
  }

  setAudioLang(lang: string) {
    this.preferredAudioLang.set(lang);
    this.saveSettings();
  }

  setSubtitleLang(lang: string) {
    this.preferredSubtitleLang.set(lang);
    this.showSubtitles.set(lang !== 'none');
    this.saveSettings();
  }

  // Save playback/audio settings to localStorage
  private saveSettings() {
    const settings = {
      autoplayNextEpisode: this.autoplayNextEpisode(),
      preferredAudioLang: this.preferredAudioLang(),
      preferredSubtitleLang: this.preferredSubtitleLang(),
      showSubtitles: this.showSubtitles(),
      subtitleSize: this.subtitleSize(),
    };
    
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
      this.showNotification('Settings saved');
    } catch (e) {
      console.error('Error saving settings:', e);
      this.showNotification('Error saving settings');
    }
  }

  // Reset all settings
  resetToDefaults() {
    // Reset theme settings
    this.themeService.resetToDefaults();
    
    // Reset playback/audio settings
    this.autoplayNextEpisode.set(true);
    this.preferredAudioLang.set('original');
    this.preferredSubtitleLang.set('none');
    this.showSubtitles.set(false);
    this.subtitleSize.set('medium');
    
    // Clear localStorage
    localStorage.removeItem(this.STORAGE_KEY);
    
    this.showNotification('Settings reset to defaults');
  }

  private showNotification(message: string) {
    this.snackBar.open(message, '', {
      duration: 2000,
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
    });
  }

  goBack() {
    this.router.navigate(['/']);
  }
}
