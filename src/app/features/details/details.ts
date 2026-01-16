import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TmdbService } from '../../core/services/tmdb';
import { firstValueFrom } from 'rxjs';
import { Router } from '@angular/router';

type MediaType = 'movie' | 'tv';

@Component({
  selector: 'app-details',
  standalone: true,
  imports: [CommonModule, RouterModule, MatCardModule, MatButtonModule, MatIconModule],
  templateUrl: './details.html',
  styleUrl: './details.scss',
})
export class DetailsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly tmdb = inject(TmdbService);
  private readonly router = inject(Router);

  loading = signal(true);
  error = signal<string | null>(null);
  item = signal<any | null>(null);

  async ngOnInit() {
    try {
      const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
      const idStr = this.route.snapshot.paramMap.get('id');
      const id = idStr ? Number(idStr) : NaN;

      if (!type || (type !== 'movie' && type !== 'tv') || !Number.isFinite(id)) {
        this.error.set('Ruta inválida');
        return;
      }

      const data = await firstValueFrom(this.tmdb.details(type, id));
      this.item.set(data);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loading.set(false);
    }
  }

  title() {
    const it = this.item();
    return it?.title ?? it?.name ?? '—';
  }

  poster() {
    const it = this.item();
    return this.tmdb.posterUrl(it?.poster_path);
  }

  backdrop() {
    const it = this.item();
    return this.tmdb.posterUrl(it?.backdrop_path);
  }

  overview() {
    return this.item()?.overview ?? '';
  }

  play() {
    this.router.navigate([
      '/play',
      this.route.snapshot.paramMap.get('type'),
      this.route.snapshot.paramMap.get('id'),
    ]);
  }
}
