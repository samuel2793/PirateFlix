import { CommonModule, ViewportScroller, DOCUMENT } from '@angular/common';
import { Component, inject, signal, computed, OnDestroy, ElementRef, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { TmdbService } from '../../core/services/tmdb';
import { CollectionsService, Collection, MediaItem } from '../../core/services/collections.service';
import { LanguageService, SupportedLang } from '../../shared/services/language.service';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { FirebaseAuthService } from '../../core/services/firebase-auth';
import { UserDataService } from '../../core/services/user-data.service';
import { CollectionRowComponent } from '../../shared/components/collection-row/collection-row';
import {
  DEFAULT_TORRENT_PROVIDER,
  TORRENT_PROVIDER_OPTIONS,
  TorrentProviderId,
  normalizeTorrentProvider,
  resolveTorrentProviderForPlayback,
} from '../../core/config/torrent-providers';

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
    CollectionRowComponent,

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
  private readonly collectionsService = inject(CollectionsService);
  readonly router = inject(Router);
  private readonly scroller = inject(ViewportScroller);
  private readonly language = inject(LanguageService);
  private readonly document = inject(DOCUMENT);
  private readonly elementRef = inject(ElementRef);
  private readonly auth = inject(FirebaseAuthService);
  private readonly userData = inject(UserDataService);
  private readonly SETTINGS_STORAGE_KEY = 'pirateflix_settings';
  private languageContentRefreshInFlight = false;

  // Collections
  collections = this.collectionsService.collections;
  collectionsLoading = this.collectionsService.loading;
  collectionsError = this.collectionsService.error;

  // Hero carousel state
  heroIndex = signal(0);
  private heroTimer: any = null;
  private readonly HERO_INTERVAL = 8000; // 8 seconds between slides
  private readonly HERO_MAX_ITEMS = 8; // show up to 8 items

  /** Top items across all collections, sorted by popularity/vote */
  heroItems = computed(() => {
    const cols = this.collections();
    if (!cols.length) return [];
    // Gather all items from all collections
    const allItems: MediaItem[] = [];
    const seen = new Set<string>();
    for (const col of cols) {
      for (const item of (col.items || [])) {
        const key = `${item.media_type}-${item.id}`;
        if (!seen.has(key) && item.backdrop_path) {
          seen.add(key);
          allItems.push(item);
        }
      }
    }
    // Sort by popularity descending
    allItems.sort((a, b) => (b.popularity ?? b.vote_average ?? 0) - (a.popularity ?? a.vote_average ?? 0));
    return allItems.slice(0, this.HERO_MAX_ITEMS);
  });

  currentHeroItem = computed(() => {
    const items = this.heroItems();
    if (!items.length) return null;
    return items[this.heroIndex() % items.length] ?? null;
  });

  authAvailable = this.auth.available;
  isAuthenticated = this.auth.isAuthenticated;
  userDisplayName = computed(() => {
    // Prefer Firestore profile name over Auth name
    const profile = this.userData.profile();
    if (profile?.displayName) return profile.displayName;
    return this.auth.displayName();
  });
  userPhotoUrl = computed(() => {
    // Prefer Firestore profile photo over Auth photo
    const profile = this.userData.profile();
    if (profile?.photoURL) return profile.photoURL;
    return this.auth.photoUrl();
  });
  private readonly providerTick = signal(0);

  currentTorrentProvider = computed(() => {
    this.providerTick();
    const configured = this.getConfiguredTorrentProvider();
    return resolveTorrentProviderForPlayback(configured, this.isAuthenticated());
  });

  currentTorrentProviderLogo = computed(() => {
    const provider = this.currentTorrentProvider();
    return (
      TORRENT_PROVIDER_OPTIONS.find((option) => option.value === provider)?.logoPath ||
      TORRENT_PROVIDER_OPTIONS.find((option) => option.value === DEFAULT_TORRENT_PROVIDER)
        ?.logoPath ||
      'assets/providers/piratebay.svg'
    );
  });

  currentTorrentProviderLabel = computed(() => {
    const provider = this.currentTorrentProvider();
    return (
      TORRENT_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ||
      'Torrent provider'
    );
  });

  // User initials for default avatar
  userInitials = computed(() => {
    const name = this.userDisplayName();
    if (!name) return '?';
    
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) {
      return (words[0][0] + words[words.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  });

  // Profile menu state
  profileMenuOpen = signal(false);
  languageSubmenuOpen = signal(false);

  // Language
  currentLang = this.language.currentLang;
  isChangingLanguage = this.language.isChangingLanguage;

  toggleProfileMenu() {
    this.refreshProviderBadge();
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

  @HostListener('window:focus')
  onWindowFocus() {
    this.refreshProviderBadge();
  }

  @HostListener('window:storage', ['$event'])
  onStorageChange(event: StorageEvent) {
    if (event.key === this.SETTINGS_STORAGE_KEY) {
      this.refreshProviderBadge();
    }
  }

  @HostListener('window:pirateflix-settings-updated')
  onSettingsUpdated() {
    this.refreshProviderBadge();
  }

  @HostListener('window:pirateflix-language-updated')
  onLanguageUpdated() {
    void this.reloadLocalizedContent();
  }

  toggleLanguageSubmenu() {
    this.languageSubmenuOpen.update(v => !v);
  }

  navigateToProfile() {
    this.router.navigate(['/profile']);
  }

  navigateToSettings() {
    this.router.navigate(['/settings']);
  }

  changeLang(lang: SupportedLang) {
    this.language.setLang(lang);
  }

  login() {
    void this.auth.signInWithGoogle();
  }

  logout() {
    void this.auth.signOut();
  }

  private refreshProviderBadge() {
    this.providerTick.update((value) => value + 1);
  }

  private getConfiguredTorrentProvider(): TorrentProviderId {
    try {
      const raw = localStorage.getItem(this.SETTINGS_STORAGE_KEY);
      if (!raw) return DEFAULT_TORRENT_PROVIDER;
      const parsed = JSON.parse(raw);
      return normalizeTorrentProvider(parsed?.torrentProvider, DEFAULT_TORRENT_PROVIDER);
    } catch {
      return DEFAULT_TORRENT_PROVIDER;
    }
  }

  private async reloadLocalizedContent() {
    if (this.languageContentRefreshInFlight) return;
    this.languageContentRefreshInFlight = true;
    try {
      await Promise.all([this.refreshTrending(), this.loadCollections()]);
      if (this.query().trim()) {
        await this.doSearch();
      }
    } finally {
      this.languageContentRefreshInFlight = false;
    }
  }

  // Grid size cycling for single toggle button
  cycleGridSize() {
    const current = this.gridSize();
    const next = current === 3 ? 1 : current + 1;
    this.setGridSize(next);
  }

  getGridIcon(): string {
    const size = this.gridSize();
    if (size === 1) return 'grid_view';
    if (size === 2) return 'view_comfy';
    return 'view_module';
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

  // Active tab: 'home' | 'movies' | 'tv' | 'search'
  activeTab = signal<'home' | 'movies' | 'tv' | 'search'>('home');

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
    this.loadCollections();
    this.startHeroRotation();
    
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

  async loadCollections() {
    await this.collectionsService.loadAllCollections();
  }

  // Get collections filtered by type for each tab
  movieCollections = computed(() => {
    return this.collections().filter(c => 
      c.mediaType === 'movie' || c.mediaType === 'mixed'
    );
  });

  tvCollections = computed(() => {
    return this.collections().filter(c => 
      c.mediaType === 'tv' || c.mediaType === 'mixed'
    );
  });

  onCollectionItemClick(item: MediaItem | undefined) {
    if (!item) return;
    this.router.navigate(['/details', item.media_type, item.id]);
  }

  ngOnDestroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.stopHeroRotation();
  }

  // --- Hero carousel ---
  startHeroRotation() {
    this.stopHeroRotation();
    this.heroTimer = setInterval(() => {
      if (this.activeTab() !== 'home') return; // only rotate on home tab
      const items = this.heroItems();
      if (items.length > 1) {
        this.heroIndex.update(i => (i + 1) % items.length);
      }
    }, this.HERO_INTERVAL);
  }

  stopHeroRotation() {
    if (this.heroTimer) {
      clearInterval(this.heroTimer);
      this.heroTimer = null;
    }
  }

  goToHeroSlide(index: number) {
    this.heroIndex.set(index);
    // Reset timer so it doesn't jump immediately after manual nav
    this.startHeroRotation();
  }

  heroNext() {
    const items = this.heroItems();
    if (items.length > 1) {
      this.heroIndex.update(i => (i + 1) % items.length);
      this.startHeroRotation();
    }
  }

  heroPrev() {
    const items = this.heroItems();
    if (items.length > 1) {
      this.heroIndex.update(i => (i - 1 + items.length) % items.length);
      this.startHeroRotation();
    }
  }

  playHeroItem(item: MediaItem | null | undefined) {
    if (!item) return;
    this.router.navigate(['/play', item.media_type, item.id]);
  }

  infoHeroItem(item: MediaItem | null | undefined) {
    if (!item) return;
    this.router.navigate(['/details', item.media_type, item.id]);
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

  getCollectionHeroBackdrop() {
    const item = this.currentHeroItem();
    if (item?.backdrop_path) {
      return this.tmdb.backdropUrl(item.backdrop_path);
    }
    // Fallback to first trending movie backdrop
    return this.getMovieHeroBackdrop();
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
