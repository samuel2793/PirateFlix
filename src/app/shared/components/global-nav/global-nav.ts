import { Component, inject, computed } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { Router, RouterLink, NavigationEnd } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { filter } from 'rxjs/operators';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslatePipe } from '../../pipes/translate.pipe';

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
}
