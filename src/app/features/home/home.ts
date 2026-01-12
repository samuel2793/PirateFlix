import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TmdbService } from '../../core/services/tmdb';
import { Router } from '@angular/router';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomeComponent {
  private readonly tmdb = inject(TmdbService);
  private readonly router = inject(Router);

  movies = signal<any[]>([]);
  tv = signal<any[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  // Buscador
  query = signal<string>('');
  searchResults = signal<any[]>([]);
  searchLoading = signal(false);
  searchError = signal<string | null>(null);

  constructor() {
    // Carga paralela simple (sin RxJS avanzado)
    Promise.all([
      this.tmdb.trending('movie', 'day').toPromise(),
      this.tmdb.trending('tv', 'day').toPromise(),
    ])
      .then(([m, t]) => {
        this.movies.set(m?.results ?? []);
        this.tv.set(t?.results ?? []);
      })
      .catch((e) => this.error.set(String(e)))
      .finally(() => this.loading.set(false));
  }

  poster(path: string | null | undefined) {
    return this.tmdb.posterUrl(path);
  }

  title(item: any) {
    return item?.title ?? item?.name ?? '—';
  }

  hasSearch() {
    return this.query().trim().length > 0;
  }

  onInput() {
    // Cuando el usuario borra la query, limpiar resultados
    if (!this.hasSearch()) {
      this.searchResults.set([]);
      this.searchError.set(null);
    }
  }

  async doSearch() {
    const q = this.query().trim();
    if (!q) return;
    this.searchLoading.set(true);
    this.searchError.set(null);
    try {
      const resp: any = await this.tmdb.searchMulti(q).toPromise();
      // Filtrar solo movie/tv
      const results = (resp?.results ?? []).filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv' || r.media_type === 'person');
      this.searchResults.set(results);
    } catch (e) {
      this.searchError.set(String(e));
    } finally {
      this.searchLoading.set(false);
    }
  }

  openDetailsForResult(item: any) {
    if (item.media_type === 'movie') {
      this.openDetails('movie', item.id);
    } else if (item.media_type === 'tv') {
      this.openDetails('tv', item.id);
    } else if (item.media_type === 'person' && item.known_for && item.known_for.length) {
      // si es persona, intentar abrir el primer known_for que sea movie/tv
      const known = item.known_for.find((k: any) => k.media_type === 'movie' || k.media_type === 'tv');
      if (known) {
        this.openDetails(known.media_type, known.id);
      }
    }
  }

  openDetails(type: 'movie' | 'tv', id: number) {
    this.router.navigate(['/details', type, id]);
  }
}
