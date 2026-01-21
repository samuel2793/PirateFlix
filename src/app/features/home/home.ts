import { CommonModule, ViewportScroller, DOCUMENT } from '@angular/common';
import { Component, inject, signal, computed, OnDestroy, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { TmdbService } from '../../core/services/tmdb';
import { LanguageService, SupportedLang } from '../../shared/services/language.service';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { FirebaseAuthService } from '../../core/services/firebase-auth';

import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatListModule } from '@angular/material/list';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

type SearchFilter = 'all' | 'movie' | 'tv' | 'person';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslatePipe,

    MatToolbarModule,
    MatSidenavModule,
    MatIconModule,
    MatMenuModule,
    MatListModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatTabsModule,
    MatTooltipModule,
    MatAutocompleteModule,
    MatSlideToggleModule,
  ],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomeComponent implements OnDestroy {
  private readonly tmdb = inject(TmdbService);
  private readonly router = inject(Router);
  private readonly scroller = inject(ViewportScroller);
  private readonly language = inject(LanguageService);
  private readonly document = inject(DOCUMENT);
  private readonly elementRef = inject(ElementRef);
  private readonly auth = inject(FirebaseAuthService);

  authAvailable = this.auth.available;
  isAuthenticated = this.auth.isAuthenticated;
  userDisplayName = this.auth.displayName;

  // Language
  currentLang = this.language.currentLang;
  isChangingLanguage = this.language.isChangingLanguage;

  changeLang(lang: SupportedLang) {
    this.language.setLang(lang);
  }

  login() {
    void this.auth.signInWithGoogle();
  }

  logout() {
    void this.auth.signOut();
  }

  // Trending
  movies = signal<any[]>([]);
  tv = signal<any[]>([]);
  loading = signal(true);
  refreshing = signal(false);
  error = signal<string | null>(null);
  lastRefresh = signal<Date | null>(null);

  // Search
  query = signal<string>('');
  searchFilter = signal<SearchFilter>('movie');
  autoSearch = signal<boolean>(true);

  searchResults = signal<any[]>([]);
  searchLoading = signal(false);
  searchError = signal<string | null>(null);

  tabIndex = 0;

  // Active tab: 'movies' | 'tv' | 'search'
  activeTab = signal<'movies' | 'tv' | 'search'>('movies');

  // Grid size (content density): 1 = small, 2 = medium, 3 = large
  gridSize = signal<number>(this.loadGridSize());
  private gridTransitioningState = signal(false);

  gridTransitioning() {
    return this.gridTransitioningState();
  }

  private loadGridSize(): number {
    try {
      const saved = localStorage.getItem('pirateflix_gridSize');
      return saved ? Math.min(3, Math.max(1, Number(saved))) : 2;
    } catch {
      return 2;
    }
  }

  setGridSize(size: number) {
    if (size === this.gridSize()) return;
    
    // Respetar prefers-reduced-motion
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    
    if (prefersReducedMotion) {
      // Sin animación, cambio instantáneo
      this.gridSize.set(size);
      try { localStorage.setItem('pirateflix_gridSize', String(size)); } catch {}
      return;
    }
    
    // === FLIP Animation ===
    const grids = this.elementRef.nativeElement.querySelectorAll('.content-grid');
    if (!grids.length) {
      this.gridSize.set(size);
      try { localStorage.setItem('pirateflix_gridSize', String(size)); } catch {}
      return;
    }
    
    // Preservar scroll
    const scrollY = window.scrollY;
    
    // FIRST: Capturar posiciones iniciales de todas las cards
    const cardPositions = new Map<HTMLElement, DOMRect>();
    grids.forEach((grid: Element) => {
      const cards = grid.querySelectorAll('.grid-card');
      cards.forEach((card: Element) => {
        const el = card as HTMLElement;
        cardPositions.set(el, el.getBoundingClientRect());
      });
    });
    
    // Marcar transición activa (deshabilita hover/clicks)
    this.gridTransitioningState.set(true);
    
    // Cambiar el tamaño del grid
    this.gridSize.set(size);
    try { localStorage.setItem('pirateflix_gridSize', String(size)); } catch {}
    
    // LAST + INVERT + PLAY: En el siguiente frame
    requestAnimationFrame(() => {
      cardPositions.forEach((firstRect, card) => {
        // LAST: Nueva posición
        const lastRect = card.getBoundingClientRect();
        
        // INVERT: Calcular diferencia
        const deltaX = firstRect.left - lastRect.left;
        const deltaY = firstRect.top - lastRect.top;
        const scaleX = firstRect.width / lastRect.width;
        const scaleY = firstRect.height / lastRect.height;
        
        // Si no hay cambio significativo, skip
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1 && 
            Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01) {
          return;
        }
        
        // Preparar para animación
        card.style.willChange = 'transform';
        card.style.transformOrigin = 'top left';
        
        // Aplicar transformación inversa (posición original)
        card.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`;
        card.style.transition = 'none';
        
        // PLAY: Forzar reflow y animar a posición final
        card.offsetHeight; // Force reflow
        
        card.style.transition = 'transform 280ms cubic-bezier(0.4, 0, 0.2, 1)';
        card.style.transform = '';
      });
      
      // Restaurar scroll
      window.scrollTo(0, scrollY);
      
      // Limpiar después de la animación
      setTimeout(() => {
        cardPositions.forEach((_, card) => {
          card.style.willChange = '';
          card.style.transformOrigin = '';
          card.style.transform = '';
          card.style.transition = '';
        });
        this.gridTransitioningState.set(false);
      }, 300);
    });
  }

  // Skeletons
  skeletonCount = Array(12).fill(0);

  // Derived
  hasSearch = computed(() => this.query().trim().length > 0);

  searchResultsFiltered = computed(() => {
    const f = this.searchFilter();
    const all = this.searchResults();
    if (f === 'all') return all;
    return all.filter((r) => r.media_type === f);
  });

  // Autocomplete: top N
  searchResultsTop = computed(() => this.searchResultsFiltered().slice(0, 8));

  // Debounce
  private debounceTimer: any = null;
  private searchSeq = 0;

  constructor() {
    this.refreshTrending();
    
    // Restore state if returning from details/person page
    const state = this.router.getCurrentNavigation()?.extras?.state || window.history.state;
    if (state?.activeTab) {
      this.activeTab.set(state.activeTab);
    }
    if (state?.query) {
      this.query.set(state.query);
      this.doSearch();
    }
    if (state?.filter) {
      this.searchFilter.set(state.filter);
    }
    if (state?.scroll) {
      // Restore scroll after view initializes
      setTimeout(() => window.scrollTo(0, state.scroll), 100);
    }
  }

  ngOnDestroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  async refreshTrending() {
    this.loading.set(true);
    this.error.set(null);

    try {
      const [m, t] = await Promise.all([
        this.tmdb.trending('movie', 'day').toPromise(),
        this.tmdb.trending('tv', 'day').toPromise(),
      ]);

      this.movies.set(m?.results ?? []);
      this.tv.set(t?.results ?? []);
      this.lastRefresh.set(new Date());
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async softRefresh() {
    if (this.refreshing()) return;
    
    this.refreshing.set(true);
    this.error.set(null);

    // Delay mínimo para que la animación se vea suave
    const minDelay = new Promise(resolve => setTimeout(resolve, 800));

    try {
      const [m, t] = await Promise.all([
        this.tmdb.trending('movie', 'day').toPromise(),
        this.tmdb.trending('tv', 'day').toPromise(),
        minDelay, // Esperar al menos 800ms para una animación fluida
      ]);

      this.movies.set(m?.results ?? []);
      this.tv.set(t?.results ?? []);
      this.lastRefresh.set(new Date());
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.refreshing.set(false);
    }
  }

  // UI helpers
  getMovieHero() {
    return this.movies()[0] || null;
  }

  getMovieHeroBackdrop() {
    const item = this.getMovieHero();
    return item ? this.tmdb.backdropUrl(item.backdrop_path) : '';
  }

  getTvHero() {
    return this.tv()[0] || null;
  }

  getTvHeroBackdrop() {
    const item = this.getTvHero();
    return item ? this.tmdb.backdropUrl(item.backdrop_path) : '';
  }

  getHeroItem() {
    return this.movies()[0] || null;
  }

  getHeroBackdrop() {
    const item = this.getHeroItem();
    return item ? this.tmdb.backdropUrl(item.backdrop_path) : '';
  }

  poster(path: string | null | undefined) {
    return this.tmdb.posterUrl(path);
  }

  posterOrPlaceholder(path: string | null | undefined) {
    return this.poster(path) || 'assets/placeholders/placeholder_movie.png';
  }

  title(item: any) {
    return item?.title ?? item?.name ?? '—';
  }

  labelMediaType(mt: string) {
    if (mt === 'movie') return 'Movie';
    if (mt === 'tv') return 'TV';
    if (mt === 'person') return 'Person';
    return mt ?? '—';
  }

  // Search actions
  setQuery(v: string) {
    this.query.set(v ?? '');
    if (!this.query().trim().length) {
      this.searchResults.set([]);
      this.searchError.set(null);
      this.searchLoading.set(false);
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      return;
    }

    if (this.autoSearch()) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.doSearch(), 350);
    }
  }

  setSearchFilter(v: SearchFilter) {
    this.searchFilter.set((v ?? 'movie') as SearchFilter);
  }

  clearSearch() {
    this.query.set('');
    this.searchResults.set([]);
    this.searchError.set(null);
    this.searchLoading.set(false);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  async doSearch() {
    const q = this.query().trim();
    if (!q) return;

    const seq = ++this.searchSeq;

    this.searchLoading.set(true);
    this.searchError.set(null);

    try {
      const resp: any = await this.tmdb.searchMulti(q).toPromise();

      // movie/tv/person
      const results = (resp?.results ?? []).filter(
        (r: any) => r.media_type === 'movie' || r.media_type === 'tv' || r.media_type === 'person'
      );

      // Si llegó una búsqueda más nueva, ignora esta
      if (seq !== this.searchSeq) return;

      this.searchResults.set(results);
    } catch (e) {
      if (seq !== this.searchSeq) return;
      this.searchError.set(String(e));
    } finally {
      if (seq === this.searchSeq) this.searchLoading.set(false);
    }
  }

  onAutoPick(item: any) {
    this.openDetailsForResult(item);
  }

  openDetailsForResult(item: any) {
    if (item.media_type === 'movie') return this.openDetails('movie', item.id);
    if (item.media_type === 'tv') return this.openDetails('tv', item.id);
    if (item.media_type === 'person') return this.openPerson(item.id);
  }

  openDetails(type: 'movie' | 'tv', id: number) {
    // Store current tab/query/filter state for back navigation
    const state = {
      returnTab: this.activeTab(),
      returnQuery: this.query(),
      returnFilter: this.searchFilter(),
      returnScroll: window.scrollY
    };
    this.router.navigate(['/details', type, id], { state });
  }

  openPerson(id: number) {
    const state = {
      returnTab: this.activeTab(),
      returnQuery: this.query(),
      returnFilter: this.searchFilter(),
      returnScroll: window.scrollY
    };
    this.router.navigate(['/person', id], { state });
  }

  scrollTo(id: string) {
    // Scroll simple a anchor
    this.scroller.scrollToAnchor(id);
  }
}
