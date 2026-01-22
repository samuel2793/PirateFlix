import { Component, inject, computed, signal, HostListener } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { Router, RouterLink, NavigationEnd } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { filter } from 'rxjs/operators';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { FirebaseAuthService } from '../../../core/services/firebase-auth';
import { LanguageService, SupportedLang } from '../../services/language.service';

@Component({
  selector: 'app-global-nav',
  standalone: true,
  imports: [CommonModule, RouterLink, MatIconModule, TranslatePipe],
  templateUrl: './global-nav.html',
  styleUrl: './global-nav.scss',
})
export class GlobalNavComponent {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly auth = inject(FirebaseAuthService);
  private readonly language = inject(LanguageService);

  authAvailable = this.auth.available;
  isAuthenticated = this.auth.isAuthenticated;
  userDisplayName = this.auth.displayName;
  userPhotoUrl = this.auth.photoUrl;

  // Language
  currentLang = this.language.currentLang;

  // Profile menu state
  profileMenuOpen = signal(false);
  languageSubmenuOpen = signal(false);

  // Track current route
  private readonly navigationEnd = toSignal(
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd))
  );

  // Computed route info
  currentUrl = computed(() => {
    this.navigationEnd(); // trigger reactivity
    return this.router.url;
  });

  isHome = computed(() => this.currentUrl() === '/' || this.currentUrl() === '');

  isDetails = computed(() => this.currentUrl().startsWith('/details'));

  isPerson = computed(() => this.currentUrl().startsWith('/person'));

  isPlayer = computed(() => this.currentUrl().startsWith('/play'));

  // Don't show nav on home or player
  showNav = computed(() => !this.isHome() && !this.isPlayer());

  // Back button logic
  canGoBack = computed(() => !this.isHome());

  toggleProfileMenu() {
    this.profileMenuOpen.update(v => !v);
    if (!this.profileMenuOpen()) {
      this.languageSubmenuOpen.set(false);
    }
  }

  closeProfileMenu() {
    this.profileMenuOpen.set(false);
    this.languageSubmenuOpen.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const profileMenu = target.closest('.profile-menu');
    if (!profileMenu && this.profileMenuOpen()) {
      this.closeProfileMenu();
    }
  }

  toggleLanguageSubmenu() {
    this.languageSubmenuOpen.update(v => !v);
  }

  changeLang(lang: SupportedLang) {
    this.language.setLang(lang);
  }

  navigateToProfile() {
    this.router.navigate(['/profile']);
  }

  navigateToSettings() {
    this.router.navigate(['/settings']);
  }

  goBack() {
    // Check if we have navigation state with return info
    const navigation = this.router.getCurrentNavigation();
    const state = window.history.state;
    
    // If we have return state from details/person page, navigate to home with state
    if (state?.returnTab || state?.returnQuery) {
      this.router.navigate(['/'], { 
        state: {
          activeTab: state.returnTab || 'movies',
          query: state.returnQuery || '',
          filter: state.returnFilter || 'movie',
          scroll: state.returnScroll || 0
        }
      });
    } else if (window.history.length > 1) {
      // Otherwise use browser back
      this.location.back();
    } else {
      // Fallback to home
      this.router.navigate(['/']);
    }
  }

  goHome() {
    this.router.navigate(['/']);
  }

  login() {
    void this.auth.signInWithGoogle();
  }

  logout() {
    void this.auth.signOut();
  }
}
