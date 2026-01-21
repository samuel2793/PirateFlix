import { Component, signal } from '@angular/core';
import { RouterOutlet, ChildrenOutletContexts } from '@angular/router';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { slideAnimation } from './core/animations/route-animations';
import { IntroComponent } from './features/intro/intro';
import { GlobalNavComponent } from './shared/components/global-nav/global-nav';
import { LanguageTransitionOverlayComponent } from './shared/components/language-transition-overlay/language-transition-overlay.component';

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    RouterOutlet,
    MatToolbarModule,
    MatSidenavModule,
    MatIconModule,
    MatButtonModule,
    MatListModule,
    IntroComponent,
    GlobalNavComponent,
    LanguageTransitionOverlayComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  animations: [slideAnimation],
})
export class App {
  protected readonly title = signal('pirateflix');
  showMainContent = signal(false);

  private readonly INTRO_KEY = 'pirateflix_intro_seen';

  constructor(private contexts: ChildrenOutletContexts) {
    // Check if intro was already seen
    this.checkIntroStatus();
  }

  private checkIntroStatus(): void {
    try {
      if (localStorage.getItem(this.INTRO_KEY) === 'true') {
        this.showMainContent.set(true);
      }
    } catch {
      this.showMainContent.set(true);
    }
  }

  onIntroComplete(): void {
    this.showMainContent.set(true);
  }

  getRouteAnimationData() {
    return this.contexts.getContext('primary')?.route?.snapshot?.data?.['animation'];
  }
}
