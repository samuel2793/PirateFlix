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
