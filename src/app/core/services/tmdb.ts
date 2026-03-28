import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { APP_CONFIG } from '../config/app-config-public';

type MediaType = 'movie' | 'tv';

@Injectable({ providedIn: 'root' })
export class TmdbService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = APP_CONFIG.tmdb.baseUrl;
  private readonly key = APP_CONFIG.tmdb.apiKey;
  private readonly lang = APP_CONFIG.tmdb.language;
  private readonly region = APP_CONFIG.tmdb.region;

  trending(type: MediaType, timeWindow: 'day' | 'week' = 'day') {
    return this.http.get<any>(`${this.baseUrl}/trending/${type}/${timeWindow}`, {
      params: {
        api_key: this.key,
        language: this.lang,
        region: this.region,
      },
    });
  }

  // Popular movies or TV shows
  popular(type: MediaType, page = 1) {
    return this.http.get<any>(`${this.baseUrl}/${type}/popular`, {
      params: {
        api_key: this.key,
        language: this.lang,
        region: this.region,
        page: String(page),
      },
    });
  }

  // Top rated movies or TV shows
  topRated(type: MediaType, page = 1) {
    return this.http.get<any>(`${this.baseUrl}/${type}/top_rated`, {
      params: {
        api_key: this.key,
        language: this.lang,
        region: this.region,
        page: String(page),
      },
    });
  }

  // Now playing movies (in theaters)
  nowPlaying(page = 1) {
    return this.http.get<any>(`${this.baseUrl}/movie/now_playing`, {
      params: {
        api_key: this.key,
        language: this.lang,
        region: this.region,
        page: String(page),
      },
    });
  }

  // Upcoming movies
  upcoming(page = 1) {
    return this.http.get<any>(`${this.baseUrl}/movie/upcoming`, {
      params: {
        api_key: this.key,
        language: this.lang,
        region: this.region,
        page: String(page),
      },
    });
  }

  // TV shows currently on the air
  onTheAir(page = 1) {
    return this.http.get<any>(`${this.baseUrl}/tv/on_the_air`, {
      params: {
        api_key: this.key,
        language: this.lang,
        page: String(page),
      },
    });
  }

  // TV shows airing today
  airingToday(page = 1) {
    return this.http.get<any>(`${this.baseUrl}/tv/airing_today`, {
      params: {
        api_key: this.key,
        language: this.lang,
        page: String(page),
      },
    });
  }

  // Discover by genre
  discoverByGenre(type: MediaType, genreId: number, page = 1) {
    return this.http.get<any>(`${this.baseUrl}/discover/${type}`, {
      params: {
        api_key: this.key,
        language: this.lang,
        region: this.region,
        page: String(page),
        with_genres: String(genreId),
        sort_by: 'popularity.desc',
      },
    });
  }

  // Discover with multiple filters
  discover(type: MediaType, options: {
    page?: number;
    genreId?: number;
    year?: number;
    language?: string;
    sortBy?: string;
    voteAverageGte?: number;
  } = {}) {
    const params: any = {
      api_key: this.key,
      language: this.lang,
      page: String(options.page || 1),
      sort_by: options.sortBy || 'popularity.desc',
    };

    if (options.genreId) params.with_genres = String(options.genreId);
    if (options.year) {
      if (type === 'movie') {
        params.primary_release_year = String(options.year);
      } else {
        params.first_air_date_year = String(options.year);
      }
    }
    if (options.language) params.with_original_language = options.language;
    if (options.voteAverageGte) params['vote_average.gte'] = String(options.voteAverageGte);

    return this.http.get<any>(`${this.baseUrl}/discover/${type}`, { params });
  }

  // Get genre list
  getGenres(type: MediaType) {
    return this.http.get<any>(`${this.baseUrl}/genre/${type}/list`, {
      params: {
        api_key: this.key,
        language: this.lang,
      },
    });
  }

  details(type: MediaType, id: number) {
    return this.http.get<any>(`${this.baseUrl}/${type}/${id}`, {
      params: {
        api_key: this.key,
        language: this.lang,
      },
    });
  }

  credits(type: MediaType, id: number) {
    return this.http.get<any>(`${this.baseUrl}/${type}/${id}/credits`, {
      params: {
        api_key: this.key,
        language: this.lang,
      },
    });
  }

  videos(type: MediaType, id: number) {
    return this.http.get<any>(`${this.baseUrl}/${type}/${id}/videos`, {
      params: {
        api_key: this.key,
        language: this.lang,
      },
    });
  }

  tvSeason(id: number, season: number) {
    return this.http.get<any>(`${this.baseUrl}/tv/${id}/season/${season}`, {
      params: {
        api_key: this.key,
        language: this.lang,
      },
    });
  }

  searchMulti(query: string, page = 1) {
    return this.http.get<any>(`${this.baseUrl}/search/multi`, {
      params: {
        api_key: this.key,
        language: this.lang,
        query,
        page,
        include_adult: 'false',
        region: this.region,
      },
    });
  }

  // Person endpoints
  personDetails(id: number) {
    return this.http.get<any>(`${this.baseUrl}/person/${id}`, {
      params: {
        api_key: this.key,
        language: this.lang,
      },
    });
  }

  personCredits(id: number) {
    return this.http.get<any>(`${this.baseUrl}/person/${id}/combined_credits`, {
      params: {
        api_key: this.key,
        language: this.lang,
      },
    });
  }

  personImages(id: number) {
    return this.http.get<any>(`${this.baseUrl}/person/${id}/images`, {
      params: {
        api_key: this.key,
      },
    });
  }

  profileUrl(path: string | null | undefined, size: 'w185' | 'w300' | 'h632' | 'original' = 'w300') {
    if (!path) return '';
    return `https://image.tmdb.org/t/p/${size}${path}`;
  }

  posterUrl(path: string | null | undefined) {
    if (!path) return '';
    return `${APP_CONFIG.tmdb.imageBase}${path}`;
  }

  backdropUrl(path: string | null | undefined) {
    if (!path) return '';
    return `https://image.tmdb.org/t/p/original${path}`;
  }
}
