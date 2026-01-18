import { Component, inject, computed } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { Router, RouterLink, NavigationEnd } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { filter } from 'rxjs/operators';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
  selector: 'app-global-nav',
  standalone: true,
  imports: [CommonModule, RouterLink, MatIconModule],
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
    // If we have history, go back; otherwise go home
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigate(['/']);
    }
  }

  goHome() {
    this.router.navigate(['/']);
  }
}
