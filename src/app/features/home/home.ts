import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TmdbService } from '../../core/services/tmdb';
import { Router } from '@angular/router';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule],
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

  openDetails(type: 'movie' | 'tv', id: number) {
    this.router.navigate(['/details', type, id]);
  }
}
