import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { APP_CONFIG } from '../config/app-config';

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

  posterUrl(path: string | null | undefined) {
    if (!path) return '';
    return `${APP_CONFIG.tmdb.imageBase}${path}`;
  }
}
