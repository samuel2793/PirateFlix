import { inject, Injectable, signal, computed } from '@angular/core';
import { TmdbService } from './tmdb';
import { forkJoin, map, of, catchError } from 'rxjs';

// ============================================
// Types
// ============================================

export interface MediaItem {
  id: number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  genre_ids?: number[];
  original_language?: string;
  popularity?: number;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  icon: string;
  mediaType: 'movie' | 'tv' | 'mixed';
  items: MediaItem[];
  copy?: string;
}

export interface CollectionFilters {
  genre?: number;
  year?: number;
  language?: string;
  minDuration?: number;
  maxDuration?: number;
  quality?: string;
}

export type SortOption = 'popularity' | 'release_date' | 'vote_average' | 'title';

// Genre mappings for TMDB
export const MOVIE_GENRES: { [key: number]: string } = {
  28: 'Acción',
  12: 'Aventura',
  16: 'Animación',
  35: 'Comedia',
  80: 'Crimen',
  99: 'Documental',
  18: 'Drama',
  10751: 'Familiar',
  14: 'Fantasía',
  36: 'Historia',
  27: 'Terror',
  10402: 'Música',
  9648: 'Misterio',
  10749: 'Romance',
  878: 'Ciencia ficción',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'Bélica',
  37: 'Western'
};

export const TV_GENRES: { [key: number]: string } = {
  10759: 'Acción y Aventura',
  16: 'Animación',
  35: 'Comedia',
  80: 'Crimen',
  99: 'Documental',
  18: 'Drama',
  10751: 'Familiar',
  10762: 'Infantil',
  9648: 'Misterio',
  10763: 'Noticias',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasía',
  10766: 'Telenovela',
  10767: 'Talk Show',
  10768: 'Guerra y Política',
  37: 'Western'
};

// Preset filters
export const FILTER_PRESETS = [
  { id: 'under90', label: 'Menos de 90 min', icon: 'schedule', filter: { maxDuration: 90 } },
  { id: 'spanish', label: 'En español', icon: 'language', filter: { language: 'es' } },
  { id: 'action', label: 'Acción', icon: 'local_fire_department', filter: { genre: 28 } },
  { id: 'animation', label: 'Animación', icon: 'animation', filter: { genre: 16 } },
  { id: 'family', label: 'Familiar', icon: 'family_restroom', filter: { genre: 10751 } },
  { id: '4k', label: '4K', icon: 'hd', filter: { quality: '4k' } }
];

// Collection definitions with metadata
export const COLLECTION_DEFINITIONS: {
  id: string;
  nameKey: string;
  descriptionKey: string;
  icon: string;
  mediaType: 'movie' | 'tv' | 'mixed';
  copyKey: string;
}[] = [
  {
    id: 'trending',
    nameKey: 'Tendencias',
    descriptionKey: 'Lo más popular en este momento',
    icon: 'trending_up',
    mediaType: 'mixed',
    copyKey: 'collection_copy_trending'
  },
  {
    id: 'new_releases',
    nameKey: 'Estrenos',
    descriptionKey: 'Recién salidos del horno',
    icon: 'new_releases',
    mediaType: 'movie',
    copyKey: 'collection_copy_new_releases'
  },
  {
    id: 'top_weekly',
    nameKey: 'Top semanal',
    descriptionKey: 'Los más vistos esta semana',
    icon: 'star',
    mediaType: 'mixed',
    copyKey: 'collection_copy_top_weekly'
  },
  {
    id: 'recommendations',
    nameKey: 'Recomendaciones',
    descriptionKey: 'Basado en lo que le gusta a la gente',
    icon: 'recommend',
    mediaType: 'mixed',
    copyKey: 'collection_copy_recommendations'
  },
  {
    id: 'new_seasons',
    nameKey: 'Nuevas temporadas',
    descriptionKey: 'Tus series favoritas tienen nuevos episodios',
    icon: 'playlist_add',
    mediaType: 'tv',
    copyKey: 'collection_copy_new_seasons'
  },
  {
    id: 'movies_today',
    nameKey: 'Películas para hoy',
    descriptionKey: 'Perfectas para una noche de cine',
    icon: 'movie',
    mediaType: 'movie',
    copyKey: 'collection_copy_movies_today'
  },
  {
    id: 'series_today',
    nameKey: 'Series para hoy',
    descriptionKey: 'Ideales para un maratón',
    icon: 'tv',
    mediaType: 'tv',
    copyKey: 'collection_copy_series_today'
  },
  {
    id: 'top_rated',
    nameKey: 'Mejor valoradas',
    descriptionKey: 'Las joyas según las críticas',
    icon: 'workspace_premium',
    mediaType: 'mixed',
    copyKey: 'collection_copy_top_rated'
  },
  {
    id: 'action_adventure',
    nameKey: 'Acción y aventura',
    descriptionKey: 'Adrenalina pura',
    icon: 'local_fire_department',
    mediaType: 'movie',
    copyKey: 'collection_copy_action'
  },
  {
    id: 'comedy',
    nameKey: 'Comedia',
    descriptionKey: 'Para reír sin parar',
    icon: 'sentiment_very_satisfied',
    mediaType: 'mixed',
    copyKey: 'collection_copy_comedy'
  },
  {
    id: 'animation',
    nameKey: 'Animación',
    descriptionKey: 'Para todas las edades',
    icon: 'animation',
    mediaType: 'mixed',
    copyKey: 'collection_copy_animation'
  },
  {
    id: 'documentary',
    nameKey: 'Documentales',
    descriptionKey: 'Historias reales fascinantes',
    icon: 'video_camera_front',
    mediaType: 'mixed',
    copyKey: 'collection_copy_documentary'
  }
];

@Injectable({ providedIn: 'root' })
export class CollectionsService {
  private readonly tmdb = inject(TmdbService);

  // Track used items to avoid duplicates across collections
  private usedItemIds = new Set<string>();
  
  // Cache for collections
  private collectionsCache = new Map<string, { data: Collection; timestamp: number }>();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  // Loading state
  loading = signal(false);
  error = signal<string | null>(null);

  // All collections
  collections = signal<Collection[]>([]);

  /**
   * Reset duplicate tracking (call when refreshing all collections)
   */
  resetDuplicateTracking() {
    this.usedItemIds.clear();
  }

  /**
   * Mark an item as used to prevent duplicates
   */
  private markAsUsed(item: MediaItem): void {
    this.usedItemIds.add(`${item.media_type}-${item.id}`);
  }

  /**
   * Check if an item is already used
   */
  private isUsed(item: MediaItem): boolean {
    return this.usedItemIds.has(`${item.media_type}-${item.id}`);
  }

  /**
   * Filter out duplicates and limit appearances to max 2 collections
   */
  private filterDuplicates(items: MediaItem[], maxAppearances = 2): MediaItem[] {
    const itemCounts = new Map<string, number>();
    
    return items.filter(item => {
      const key = `${item.media_type}-${item.id}`;
      const count = itemCounts.get(key) || 0;
      
      if (count >= maxAppearances) {
        return false;
      }
      
      itemCounts.set(key, count + 1);
      return true;
    });
  }

  /**
   * Remove items that appear in more than 2 collections globally
   */
  private removeDuplicatesFromCollection(items: MediaItem[]): MediaItem[] {
    return items.filter(item => {
      const key = `${item.media_type}-${item.id}`;
      if (this.usedItemIds.has(key)) {
        // Check if item has appeared too many times
        return false;
      }
      this.usedItemIds.add(key);
      return true;
    });
  }

  /**
   * Load all collections for the home page
   */
  async loadAllCollections(): Promise<Collection[]> {
    this.loading.set(true);
    this.error.set(null);
    this.resetDuplicateTracking();

    try {
      const collections = await Promise.all([
        this.getTrendingCollection(),
        this.getNewReleasesCollection(),
        this.getTopWeeklyCollection(),
        this.getRecommendationsCollection(),
        this.getNewSeasonsCollection(),
        this.getMoviesTodayCollection(),
        this.getSeriesTodayCollection(),
        this.getTopRatedCollection(),
        this.getActionCollection(),
        this.getComedyCollection(),
        this.getAnimationCollection(),
        this.getDocumentaryCollection()
      ]);

      this.collections.set(collections);
      return collections;
    } catch (e) {
      this.error.set(String(e));
      return [];
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Get a single collection by ID with pagination
   */
  async getCollection(id: string, page = 1, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    switch (id) {
      case 'trending':
        return this.getTrendingPaginated(page, filters, sort);
      case 'new_releases':
        return this.getNewReleasesPaginated(page, filters, sort);
      case 'top_weekly':
        return this.getTopWeeklyPaginated(page, filters, sort);
      case 'recommendations':
        return this.getRecommendationsPaginated(page, filters, sort);
      case 'new_seasons':
        return this.getNewSeasonsPaginated(page, filters, sort);
      case 'movies_today':
        return this.getMoviesTodayPaginated(page, filters, sort);
      case 'series_today':
        return this.getSeriesTodayPaginated(page, filters, sort);
      case 'top_rated':
        return this.getTopRatedPaginated(page, filters, sort);
      case 'action_adventure':
        return this.getActionPaginated(page, filters, sort);
      case 'comedy':
        return this.getComedyPaginated(page, filters, sort);
      case 'animation':
        return this.getAnimationPaginated(page, filters, sort);
      case 'documentary':
        return this.getDocumentaryPaginated(page, filters, sort);
      default:
        return { items: [], hasMore: false };
    }
  }

  /**
   * Get collection metadata by ID
   */
  getCollectionMeta(id: string) {
    return COLLECTION_DEFINITIONS.find(c => c.id === id);
  }

  // ==========================================
  // Individual Collection Loaders
  // ==========================================

  private async getTrendingCollection(): Promise<Collection> {
    try {
      const [movies, tv] = await Promise.all([
        this.tmdb.trending('movie', 'day').toPromise(),
        this.tmdb.trending('tv', 'day').toPromise()
      ]);

      const items = this.mergeAndSort([
        ...(movies?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })),
        ...(tv?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const }))
      ], 'popularity').slice(0, 20);

      return {
        id: 'trending',
        name: 'Tendencias',
        description: 'Lo más popular en este momento',
        icon: 'trending_up',
        mediaType: 'mixed',
        items,
        copy: 'Descubre lo que está viendo todo el mundo ahora mismo.'
      };
    } catch {
      return this.emptyCollection('trending');
    }
  }

  private async getNewReleasesCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.nowPlaying(1).toPromise();
      const items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })).slice(0, 20);

      return {
        id: 'new_releases',
        name: 'Estrenos',
        description: 'Recién salidos del horno',
        icon: 'new_releases',
        mediaType: 'movie',
        items,
        copy: 'Las películas más nuevas, directas de la gran pantalla.'
      };
    } catch {
      return this.emptyCollection('new_releases');
    }
  }

  private async getTopWeeklyCollection(): Promise<Collection> {
    try {
      const [movies, tv] = await Promise.all([
        this.tmdb.trending('movie', 'week').toPromise(),
        this.tmdb.trending('tv', 'week').toPromise()
      ]);

      const items = this.mergeAndSort([
        ...(movies?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })),
        ...(tv?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const }))
      ], 'popularity').slice(0, 20);

      return {
        id: 'top_weekly',
        name: 'Top semanal',
        description: 'Los más vistos esta semana',
        icon: 'star',
        mediaType: 'mixed',
        items,
        copy: 'Lo que no te puedes perder esta semana.'
      };
    } catch {
      return this.emptyCollection('top_weekly');
    }
  }

  private async getRecommendationsCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.popular('movie', 1).toPromise();
      const items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })).slice(0, 20);

      return {
        id: 'recommendations',
        name: 'Recomendaciones',
        description: 'Basado en lo que le gusta a la gente',
        icon: 'recommend',
        mediaType: 'mixed',
        items,
        copy: 'Títulos que encantan a millones de espectadores.'
      };
    } catch {
      return this.emptyCollection('recommendations');
    }
  }

  private async getNewSeasonsCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.onTheAir(1).toPromise();
      const items = (response?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const })).slice(0, 20);

      return {
        id: 'new_seasons',
        name: 'Nuevas temporadas',
        description: 'Tus series favoritas tienen nuevos episodios',
        icon: 'playlist_add',
        mediaType: 'tv',
        items,
        copy: 'Nuevos episodios de las series que te encantan.'
      };
    } catch {
      return this.emptyCollection('new_seasons');
    }
  }

  private async getMoviesTodayCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.popular('movie', 1).toPromise();
      // Shuffle for variety
      const shuffled = this.shuffleArray([...(response?.results || [])]);
      const items = shuffled.map((m: any) => ({ ...m, media_type: 'movie' as const })).slice(0, 20);

      return {
        id: 'movies_today',
        name: 'Películas para hoy',
        description: 'Perfectas para una noche de cine',
        icon: 'movie',
        mediaType: 'movie',
        items,
        copy: 'Tu próxima película favorita te está esperando.'
      };
    } catch {
      return this.emptyCollection('movies_today');
    }
  }

  private async getSeriesTodayCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.popular('tv', 1).toPromise();
      const shuffled = this.shuffleArray([...(response?.results || [])]);
      const items = shuffled.map((t: any) => ({ ...t, media_type: 'tv' as const })).slice(0, 20);

      return {
        id: 'series_today',
        name: 'Series para hoy',
        description: 'Ideales para un maratón',
        icon: 'tv',
        mediaType: 'tv',
        items,
        copy: 'Series adictivas para maratonear sin parar.'
      };
    } catch {
      return this.emptyCollection('series_today');
    }
  }

  private async getTopRatedCollection(): Promise<Collection> {
    try {
      const [movies, tv] = await Promise.all([
        this.tmdb.topRated('movie', 1).toPromise(),
        this.tmdb.topRated('tv', 1).toPromise()
      ]);

      const items = this.mergeAndSort([
        ...(movies?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })),
        ...(tv?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const }))
      ], 'vote_average').slice(0, 20);

      return {
        id: 'top_rated',
        name: 'Mejor valoradas',
        description: 'Las joyas según las críticas',
        icon: 'workspace_premium',
        mediaType: 'mixed',
        items,
        copy: 'Las más aclamadas por críticos y audiencias.'
      };
    } catch {
      return this.emptyCollection('top_rated');
    }
  }

  private async getActionCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.discoverByGenre('movie', 28, 1).toPromise();
      const items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })).slice(0, 20);

      return {
        id: 'action_adventure',
        name: 'Acción y aventura',
        description: 'Adrenalina pura',
        icon: 'local_fire_department',
        mediaType: 'movie',
        items,
        copy: 'Explosiones, persecuciones y héroes en acción.'
      };
    } catch {
      return this.emptyCollection('action_adventure');
    }
  }

  private async getComedyCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.discoverByGenre('movie', 35, 1).toPromise();
      const items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })).slice(0, 20);

      return {
        id: 'comedy',
        name: 'Comedia',
        description: 'Para reír sin parar',
        icon: 'sentiment_very_satisfied',
        mediaType: 'mixed',
        items,
        copy: 'Risas garantizadas para alegrar tu día.'
      };
    } catch {
      return this.emptyCollection('comedy');
    }
  }

  private async getAnimationCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.discoverByGenre('movie', 16, 1).toPromise();
      const items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })).slice(0, 20);

      return {
        id: 'animation',
        name: 'Animación',
        description: 'Para todas las edades',
        icon: 'animation',
        mediaType: 'mixed',
        items,
        copy: 'Mundos animados que encantan a grandes y chicos.'
      };
    } catch {
      return this.emptyCollection('animation');
    }
  }

  private async getDocumentaryCollection(): Promise<Collection> {
    try {
      const response = await this.tmdb.discoverByGenre('movie', 99, 1).toPromise();
      const items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })).slice(0, 20);

      return {
        id: 'documentary',
        name: 'Documentales',
        description: 'Historias reales fascinantes',
        icon: 'video_camera_front',
        mediaType: 'mixed',
        items,
        copy: 'Historias reales que cambian tu perspectiva.'
      };
    } catch {
      return this.emptyCollection('documentary');
    }
  }

  // ==========================================
  // Paginated Collection Loaders
  // ==========================================

  private async getTrendingPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const [movies, tv] = await Promise.all([
        this.tmdb.trending('movie', 'day').toPromise(),
        this.tmdb.trending('tv', 'day').toPromise()
      ]);

      let items = this.mergeAndSort([
        ...(movies?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })),
        ...(tv?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const }))
      ], sort || 'popularity');

      items = this.applyFilters(items, filters);

      return { items, hasMore: false };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getNewReleasesPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.nowPlaying(page).toPromise();
      let items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getTopWeeklyPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const [movies, tv] = await Promise.all([
        this.tmdb.trending('movie', 'week').toPromise(),
        this.tmdb.trending('tv', 'week').toPromise()
      ]);

      let items = this.mergeAndSort([
        ...(movies?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })),
        ...(tv?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const }))
      ], sort || 'popularity');

      items = this.applyFilters(items, filters);
      return { items, hasMore: false };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getRecommendationsPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.popular('movie', page).toPromise();
      let items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getNewSeasonsPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.onTheAir(page).toPromise();
      let items = (response?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getMoviesTodayPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.popular('movie', page).toPromise();
      let items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getSeriesTodayPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.popular('tv', page).toPromise();
      let items = (response?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getTopRatedPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const [movies, tv] = await Promise.all([
        this.tmdb.topRated('movie', page).toPromise(),
        this.tmdb.topRated('tv', page).toPromise()
      ]);

      let items = this.mergeAndSort([
        ...(movies?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const })),
        ...(tv?.results || []).map((t: any) => ({ ...t, media_type: 'tv' as const }))
      ], sort || 'vote_average');

      items = this.applyFilters(items, filters);
      return { items, hasMore: page < Math.max(movies?.total_pages || 1, tv?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getActionPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.discoverByGenre('movie', 28, page).toPromise();
      let items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getComedyPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.discoverByGenre('movie', 35, page).toPromise();
      let items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getAnimationPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.discoverByGenre('movie', 16, page).toPromise();
      let items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  private async getDocumentaryPaginated(page: number, filters?: CollectionFilters, sort?: SortOption): Promise<{ items: MediaItem[]; hasMore: boolean }> {
    try {
      const response = await this.tmdb.discoverByGenre('movie', 99, page).toPromise();
      let items = (response?.results || []).map((m: any) => ({ ...m, media_type: 'movie' as const }));
      items = this.applyFilters(items, filters);
      if (sort) items = this.sortItems(items, sort);
      return { items, hasMore: page < (response?.total_pages || 1) };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  private emptyCollection(id: string): Collection {
    const def = COLLECTION_DEFINITIONS.find(c => c.id === id);
    return {
      id,
      name: def?.nameKey || id,
      description: def?.descriptionKey || '',
      icon: def?.icon || 'collections',
      mediaType: def?.mediaType || 'mixed',
      items: []
    };
  }

  private mergeAndSort(items: MediaItem[], sortBy: SortOption | string): MediaItem[] {
    return this.sortItems(items, sortBy as SortOption);
  }

  private sortItems(items: MediaItem[], sortBy: SortOption): MediaItem[] {
    return [...items].sort((a, b) => {
      switch (sortBy) {
        case 'popularity':
          return (b.popularity || 0) - (a.popularity || 0);
        case 'vote_average':
          return (b.vote_average || 0) - (a.vote_average || 0);
        case 'release_date':
          const dateA = a.release_date || a.first_air_date || '';
          const dateB = b.release_date || b.first_air_date || '';
          return dateB.localeCompare(dateA);
        case 'title':
          const titleA = a.title || a.name || '';
          const titleB = b.title || b.name || '';
          return titleA.localeCompare(titleB);
        default:
          return 0;
      }
    });
  }

  private applyFilters(items: MediaItem[], filters?: CollectionFilters): MediaItem[] {
    if (!filters) return items;

    return items.filter(item => {
      // Genre filter
      if (filters.genre && item.genre_ids && !item.genre_ids.includes(filters.genre)) {
        return false;
      }

      // Year filter
      if (filters.year) {
        const date = item.release_date || item.first_air_date;
        if (!date || !date.startsWith(String(filters.year))) {
          return false;
        }
      }

      // Language filter
      if (filters.language && item.original_language !== filters.language) {
        return false;
      }

      return true;
    });
  }

  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}
