import { CommonModule, ViewportScroller } from '@angular/common';
import { Component, inject, signal, computed, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { TmdbService } from '../../core/services/tmdb';

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

  // Trending
  movies = signal<any[]>([]);
  tv = signal<any[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  // Search
  query = signal<string>('');
  searchFilter = signal<SearchFilter>('movie');
  autoSearch = signal<boolean>(true);

  searchResults = signal<any[]>([]);
  searchLoading = signal(false);
  searchError = signal<string | null>(null);

  tabIndex = 0;

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
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  // UI helpers
  poster(path: string | null | undefined) {
    return this.tmdb.posterUrl(path);
  }

  posterOrPlaceholder(path: string | null | undefined) {
    return this.poster(path) || 'assets/placeholder.png';
  }

  title(item: any) {
    return item?.title ?? item?.name ?? '—';
  }

  labelMediaType(mt: string) {
    if (mt === 'movie') return 'Movie';
    if (mt === 'tv') return 'TV';
    if (mt === 'person') return 'Persona';
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

    if (item.media_type === 'person' && Array.isArray(item.known_for)) {
      const known = item.known_for.find(
        (k: any) => k.media_type === 'movie' || k.media_type === 'tv'
      );
      if (known) return this.openDetails(known.media_type, known.id);
    }
  }

  openDetails(type: 'movie' | 'tv', id: number) {
    this.router.navigate(['/details', type, id]);
  }

  scrollTo(id: string) {
    // Scroll simple a anchor
    this.scroller.scrollToAnchor(id);
  }
}
