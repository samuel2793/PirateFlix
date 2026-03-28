import { Component, inject, signal, computed, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatMenuModule } from '@angular/material/menu';

import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { TmdbService } from '../../core/services/tmdb';
import { 
  CollectionsService, 
  Collection, 
  MediaItem, 
  CollectionFilters, 
  SortOption,
  COLLECTION_DEFINITIONS,
  MOVIE_GENRES,
  FILTER_PRESETS
} from '../../core/services/collections.service';

type ViewMode = 'grid' | 'list';

@Component({
  selector: 'app-collection',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatMenuModule,
    TranslatePipe
  ],
  templateUrl: './collection.html',
  styleUrl: './collection.scss'
})
export class CollectionComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly tmdb = inject(TmdbService);
  private readonly collectionsService = inject(CollectionsService);

  // Collection data
  collectionId = signal<string>('');
  collectionMeta = computed(() => {
    const id = this.collectionId();
    return COLLECTION_DEFINITIONS.find(c => c.id === id);
  });

  items = signal<MediaItem[]>([]);
  loading = signal(true);
  loadingMore = signal(false);
  error = signal<string | null>(null);
  hasMore = signal(true);
  page = signal(1);

  // Filters
  activeFilters = signal<CollectionFilters>({});
  sortBy = signal<SortOption>('popularity');
  viewMode = signal<ViewMode>('grid');

  // Filter options
  genres = Object.entries(MOVIE_GENRES).map(([id, name]) => ({ id: Number(id), name }));
  years = this.generateYears();
  languages = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' }
  ];
  presets = FILTER_PRESETS;

  sortOptions: { value: SortOption; label: string }[] = [
    { value: 'popularity', label: 'Popularidad' },
    { value: 'release_date', label: 'Fecha de estreno' },
    { value: 'vote_average', label: 'Valoración' },
    { value: 'title', label: 'Título' }
  ];

  // Skeleton placeholders
  skeletonItems = Array(12).fill(0);

  // Collection copy texts
  collectionCopies: { [key: string]: string } = {
    'trending': 'Descubre lo que está viendo todo el mundo ahora mismo.',
    'new_releases': 'Las películas más nuevas, directas de la gran pantalla.',
    'top_weekly': 'Lo que no te puedes perder esta semana.',
    'recommendations': 'Títulos que encantan a millones de espectadores.',
    'new_seasons': 'Nuevos episodios de las series que te encantan.',
    'movies_today': 'Tu próxima película favorita te está esperando.',
    'series_today': 'Series adictivas para maratonear sin parar.',
    'top_rated': 'Las más aclamadas por críticos y audiencias.',
    'action_adventure': 'Explosiones, persecuciones y héroes en acción.',
    'comedy': 'Risas garantizadas para alegrar tu día.',
    'animation': 'Mundos animados que encantan a grandes y chicos.',
    'documentary': 'Historias reales que cambian tu perspectiva.'
  };

  private intersectionObserver?: IntersectionObserver;

  ngOnInit() {
    this.route.paramMap.subscribe(params => {
      const id = params.get('id') || '';
      this.collectionId.set(id);
      this.resetAndLoad();
    });
  }

  ngOnDestroy() {
    this.intersectionObserver?.disconnect();
  }

  private generateYears(): number[] {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 30 }, (_, i) => currentYear - i);
  }

  async resetAndLoad() {
    this.items.set([]);
    this.page.set(1);
    this.hasMore.set(true);
    this.error.set(null);
    await this.loadItems();
  }

  async loadItems() {
    if (this.loading() && this.page() > 1) return;
    
    this.loading.set(true);
    this.error.set(null);

    try {
      const result = await this.collectionsService.getCollection(
        this.collectionId(),
        this.page(),
        this.activeFilters(),
        this.sortBy()
      );

      if (this.page() === 1) {
        this.items.set(result.items);
      } else {
        this.items.update(current => [...current, ...result.items]);
      }
      
      this.hasMore.set(result.hasMore);
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
      this.loadingMore.set(false);
    }
  }

  async loadMore() {
    if (this.loadingMore() || !this.hasMore()) return;
    
    this.loadingMore.set(true);
    this.page.update(p => p + 1);
    await this.loadItems();
  }

  // Infinite scroll handler
  @HostListener('window:scroll')
  onScroll() {
    if (this.loading() || this.loadingMore() || !this.hasMore()) return;

    const scrollPosition = window.innerHeight + window.scrollY;
    const threshold = document.documentElement.scrollHeight - 500;

    if (scrollPosition >= threshold) {
      this.loadMore();
    }
  }

  @HostListener('window:pirateflix-language-updated')
  onLanguageUpdated() {
    this.resetAndLoad();
  }

  // Filter actions
  setGenreFilter(genreId: number | null) {
    this.activeFilters.update(f => ({
      ...f,
      genre: genreId ?? undefined
    }));
    this.resetAndLoad();
  }

  setYearFilter(year: number | null) {
    this.activeFilters.update(f => ({
      ...f,
      year: year ?? undefined
    }));
    this.resetAndLoad();
  }

  setLanguageFilter(lang: string | null) {
    this.activeFilters.update(f => ({
      ...f,
      language: lang ?? undefined
    }));
    this.resetAndLoad();
  }

  applyPreset(preset: typeof FILTER_PRESETS[0]) {
    this.activeFilters.set(preset.filter);
    this.resetAndLoad();
  }

  clearFilters() {
    this.activeFilters.set({});
    this.resetAndLoad();
  }

  hasActiveFilters(): boolean {
    const f = this.activeFilters();
    return !!(f.genre || f.year || f.language || f.minDuration || f.maxDuration || f.quality);
  }

  setSortBy(option: SortOption) {
    this.sortBy.set(option);
    this.resetAndLoad();
  }

  toggleViewMode() {
    this.viewMode.update(m => m === 'grid' ? 'list' : 'grid');
  }

  // Navigation
  goBack() {
    this.router.navigate(['/']);
  }

  openDetails(item: MediaItem) {
    this.router.navigate(['/details', item.media_type, item.id]);
  }

  // UI helpers
  getTitle(item: MediaItem): string {
    return item.title || item.name || '';
  }

  getYear(item: MediaItem): string {
    const date = item.release_date || item.first_air_date;
    return date ? date.substring(0, 4) : '';
  }

  getPoster(item: MediaItem): string {
    return this.tmdb.posterUrl(item.poster_path) || 'assets/placeholders/placeholder_movie.png';
  }

  getBackdrop(item: MediaItem): string {
    return this.tmdb.backdropUrl(item.backdrop_path) || '';
  }

  getCollectionCopy(): string {
    return this.collectionCopies[this.collectionId()] || '';
  }

  getSortLabel(): string {
    const option = this.sortOptions.find(o => o.value === this.sortBy());
    return option?.label || 'Ordenar';
  }

  getActiveGenreName(): string {
    const genreId = this.activeFilters().genre;
    if (!genreId) return '';
    return MOVIE_GENRES[genreId] || '';
  }
}
