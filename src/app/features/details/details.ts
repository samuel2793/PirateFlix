import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TmdbService } from '../../core/services/tmdb';
import { SafeUrlPipe } from '../../core/pipes/safe-url.pipe';
import { firstValueFrom } from 'rxjs';
import { Router } from '@angular/router';

type MediaType = 'movie' | 'tv';

@Component({
  selector: 'app-details',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatButtonToggleModule,
    MatTooltipModule,
    SafeUrlPipe,
  ],
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
  credits = signal<any | null>(null);
  videos = signal<any[]>([]);
  showTrailer = signal(false);
  
  // Preferences with localStorage persistence
  preferMultiAudio = signal(this.loadPref('preferMultiAudio'));
  preferSeekable = signal(this.loadPref('preferSeekable'));
  preferSubtitles = signal(this.loadPref('preferSubtitles'));
  showInfo = signal(false);
  inMyList = signal(false);

  // Load preference from localStorage
  private loadPref(key: string): boolean {
    try {
      return localStorage.getItem(`pirateflix_${key}`) === 'true';
    } catch {
      return false;
    }
  }

  // Save preference to localStorage
  savePref(key: string, value: boolean) {
    try {
      localStorage.setItem(`pirateflix_${key}`, value ? 'true' : 'false');
    } catch {
      // Ignore storage errors
    }
  }

  // Toggle handlers that persist
  toggleMultiAudio(value: boolean) {
    this.preferMultiAudio.set(value);
    this.savePref('preferMultiAudio', value);
  }

  toggleSeekable(value: boolean) {
    this.preferSeekable.set(value);
    this.savePref('preferSeekable', value);
  }

  toggleSubtitles(value: boolean) {
    this.preferSubtitles.set(value);
    this.savePref('preferSubtitles', value);
  }

  async ngOnInit() {
    try {
      const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
      const idStr = this.route.snapshot.paramMap.get('id');
      const id = idStr ? Number(idStr) : NaN;

      if (!type || (type !== 'movie' && type !== 'tv') || !Number.isFinite(id)) {
        this.error.set('Ruta inválida');
        return;
      }

      const [data, creditsData, videosData] = await Promise.all([
        firstValueFrom(this.tmdb.details(type, id)),
        firstValueFrom(this.tmdb.credits(type, id)),
        firstValueFrom(this.tmdb.videos(type, id)),
      ]);
      this.item.set(data);
      this.credits.set(creditsData);
      this.videos.set(videosData?.results || []);
      
      // Check if item is in My List
      this.inMyList.set(this.isInMyList());
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
    return this.tmdb.posterUrl(it?.poster_path) || 'assets/placeholder.png';
  }

  backdrop() {
    const it = this.item();
    return (
      this.tmdb.backdropUrl(it?.backdrop_path) ||
      this.tmdb.posterUrl(it?.poster_path) ||
      'assets/placeholder.png'
    );
  }

  overview() {
    return this.item()?.overview ?? '';
  }

  mediaLabel() {
    const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
    if (type === 'tv') return 'Serie';
    if (type === 'movie') return 'Película';
    return 'Título';
  }

  year() {
    const it = this.item();
    const date = it?.release_date ?? it?.first_air_date;
    return typeof date === 'string' && date.length >= 4 ? date.slice(0, 4) : '';
  }

  rating() {
    const v = this.item()?.vote_average;
    return typeof v === 'number' && v > 0 ? v.toFixed(1) : '';
  }

  votesLabel() {
    const v = this.item()?.vote_count;
    if (typeof v !== 'number' || v <= 0) return '';
    return new Intl.NumberFormat('es-ES').format(v);
  }

  runtimeLabel() {
    const it = this.item();
    let runtime: number | null = null;

    if (typeof it?.runtime === 'number') {
      runtime = it.runtime;
    } else if (Array.isArray(it?.episode_run_time)) {
      runtime = it.episode_run_time.find((n: any) => typeof n === 'number' && n > 0) ?? null;
    }

    if (!runtime) return '';
    const hours = Math.floor(runtime / 60);
    const minutes = runtime % 60;
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  genres() {
    const it = this.item();
    if (!Array.isArray(it?.genres)) return [];
    return it.genres.map((g: any) => g?.name).filter(Boolean);
  }

  releaseDateLabel() {
    const it = this.item();
    return this.formatDate(it?.release_date ?? it?.first_air_date);
  }

  statusLabel() {
    return this.item()?.status ?? '—';
  }

  languageLabel() {
    const code = this.item()?.original_language;
    return code ? String(code).toUpperCase() : '—';
  }

  seasonsLabel() {
    const n = this.item()?.number_of_seasons;
    return Number.isFinite(n) ? String(n) : '';
  }

  episodesLabel() {
    const n = this.item()?.number_of_episodes;
    return Number.isFinite(n) ? String(n) : '';
  }

  countriesLabel() {
    const it = this.item();
    const countries = Array.isArray(it?.production_countries)
      ? it.production_countries.map((c: any) => c?.name).filter(Boolean)
      : [];
    const origin = Array.isArray(it?.origin_country)
      ? it.origin_country.map((c: any) => c).filter(Boolean)
      : [];
    const list = countries.length ? countries : origin;
    return list.length ? list.join(', ') : '—';
  }

  companiesLabel() {
    const it = this.item();
    const companies = Array.isArray(it?.production_companies)
      ? it.production_companies.map((c: any) => c?.name).filter(Boolean)
      : [];
    return companies.length ? companies.slice(0, 4).join(', ') : '—';
  }

  budgetLabel() {
    return this.formatCurrency(this.item()?.budget);
  }

  revenueLabel() {
    return this.formatCurrency(this.item()?.revenue);
  }

  homepageLabel() {
    return this.item()?.homepage ?? '';
  }

  cast() {
    const c = this.credits();
    if (!Array.isArray(c?.cast)) return [];
    return c.cast.slice(0, 12).map((p: any) => ({
      id: p.id,
      name: p.name,
      character: p.character,
      profile: this.tmdb.posterUrl(p.profile_path),
    }));
  }

  directors() {
    const c = this.credits();
    if (!Array.isArray(c?.crew)) return [];
    return c.crew
      .filter((p: any) => p.job === 'Director')
      .map((p: any) => p.name);
  }

  writers() {
    const c = this.credits();
    if (!Array.isArray(c?.crew)) return [];
    return c.crew
      .filter((p: any) => p.job === 'Screenplay' || p.job === 'Writer')
      .slice(0, 3)
      .map((p: any) => p.name);
  }

  creators() {
    const it = this.item();
    if (!Array.isArray(it?.created_by)) return [];
    return it.created_by.map((p: any) => p.name);
  }

  play() {
    const queryParams: Record<string, string> = {};
    if (this.preferMultiAudio()) queryParams['multiAudio'] = '1';
    if (this.preferSeekable()) queryParams['seekable'] = '1';
    if (this.preferSubtitles()) queryParams['subtitles'] = '1';
    this.router.navigate(
      [
        '/play',
        this.route.snapshot.paramMap.get('type'),
        this.route.snapshot.paramMap.get('id'),
      ],
      { queryParams }
    );
  }

  // Trailer methods
  mainTrailer() {
    const vids = this.videos();
    if (!vids.length) return null;
    
    // Prioritize: Official Trailer > Trailer > Teaser > any YouTube video
    const priorities = ['Trailer', 'Official Trailer', 'Teaser', 'Clip'];
    
    for (const priority of priorities) {
      const found = vids.find(
        (v: any) => v.site === 'YouTube' && v.type === priority
      );
      if (found) return found;
    }
    
    // Fallback to any YouTube video
    return vids.find((v: any) => v.site === 'YouTube') || null;
  }

  trailerUrl() {
    const trailer = this.mainTrailer();
    if (!trailer) return '';
    return `https://www.youtube.com/embed/${trailer.key}?autoplay=1&rel=0`;
  }

  hasTrailer() {
    return !!this.mainTrailer();
  }

  openTrailer() {
    if (this.hasTrailer()) {
      this.showTrailer.set(true);
    }
  }

  closeTrailer() {
    this.showTrailer.set(false);
  }

  // My List functionality
  toggleMyList() {
    const type = this.route.snapshot.paramMap.get('type');
    const id = this.route.snapshot.paramMap.get('id');
    const it = this.item();
    
    if (!type || !id || !it) return;

    const myList = this.getMyList();
    const itemKey = `${type}_${id}`;
    
    if (this.inMyList()) {
      // Remove from list
      delete myList[itemKey];
      this.inMyList.set(false);
    } else {
      // Add to list
      myList[itemKey] = {
        id: Number(id),
        type,
        title: this.title(),
        poster: it.poster_path,
        backdrop: it.backdrop_path,
        rating: it.vote_average,
        year: this.year(),
        addedAt: new Date().toISOString(),
      };
      this.inMyList.set(true);
    }

    this.saveMyList(myList);
  }

  private isInMyList(): boolean {
    const type = this.route.snapshot.paramMap.get('type');
    const id = this.route.snapshot.paramMap.get('id');
    
    if (!type || !id) return false;
    
    const myList = this.getMyList();
    return `${type}_${id}` in myList;
  }

  private getMyList(): Record<string, any> {
    try {
      const data = localStorage.getItem('pirateflix_myList');
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  }

  private saveMyList(list: Record<string, any>) {
    try {
      localStorage.setItem('pirateflix_myList', JSON.stringify(list));
    } catch {
      // Ignore storage errors
    }
  }

  private formatDate(value: string | null | undefined) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(parsed);
  }

  private formatCurrency(value: number | null | undefined) {
    if (typeof value !== 'number' || value <= 0) return '—';
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(value);
  }
}
