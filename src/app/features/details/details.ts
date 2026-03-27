import { Component, inject, signal, computed, ElementRef } from '@angular/core';
import { CommonModule, DOCUMENT, LowerCasePipe } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TmdbService } from '../../core/services/tmdb';
import { UserDataService } from '../../core/services/user-data.service';
import { FirebaseAuthService } from '../../core/services/firebase-auth';
import { SafeUrlPipe } from '../../core/pipes/safe-url.pipe';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { TranslationService } from '../../shared/services/translation.service';
import { LanguageService } from '../../shared/services/language.service';
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
    TranslatePipe,
    LowerCasePipe,
  ],
  templateUrl: './details.html',
  styleUrl: './details.scss',
})
export class DetailsComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly tmdb = inject(TmdbService);
  private readonly router = inject(Router);
  private readonly translation = inject(TranslationService);
  private readonly language = inject(LanguageService);
  private readonly document = inject(DOCUMENT);
  private readonly elementRef = inject(ElementRef);
  private readonly userData = inject(UserDataService);
  private readonly auth = inject(FirebaseAuthService);
  
  // Exponer para la vista
  isChangingLanguage = this.language.isChangingLanguage;

  loading = signal(true);
  error = signal<string | null>(null);
  item = signal<any | null>(null);
  credits = signal<any | null>(null);
  videos = signal<any[]>([]);
  showTrailer = signal(false);
  selectedSeason = signal<number | null>(null);
  selectedEpisode = signal<number | null>(null);
  seasonEpisodes = signal<any[]>([]);
  seasonEpisodesLoading = signal(false);

  private seasonEpisodesCache = new Map<number, any[]>();
  private seasonEpisodesRequestId = 0;

  // Preferences with localStorage persistence
  preferMultiAudio = signal(this.loadPref('preferMultiAudio'));
  preferSeekable = signal(this.loadPref('preferSeekable', true));
  preferSubtitles = signal(this.loadPref('preferSubtitles'));
  preferYearInSearch = signal(this.loadPref('preferYearInSearch'));
  showInfo = signal(false);
  
  // My List integration with Firestore
  inMyList = computed(() => {
    const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
    const idStr = this.route.snapshot.paramMap.get('id');
    const id = idStr ? Number(idStr) : NaN;
    
    if (!type || !Number.isFinite(id)) return false;
    return this.userData.isInMyList(type, id);
  });

  // Load preference from localStorage
  private loadPref(key: string, defaultValue = false): boolean {
    try {
      const value = localStorage.getItem(`pirateflix_${key}`);
      if (value === null) return defaultValue;
      return value === 'true';
    } catch {
      return defaultValue;
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

  toggleYearInSearch(value: boolean) {
    this.preferYearInSearch.set(value);
    this.savePref('preferYearInSearch', value);
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
      this.initializeSeriesSelection(data);
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
    return this.tmdb.posterUrl(it?.poster_path) || 'assets/placeholders/placeholder_movie.png';
  }

  backdrop() {
    const it = this.item();
    return (
      this.tmdb.backdropUrl(it?.backdrop_path) ||
      this.tmdb.posterUrl(it?.poster_path) ||
      'assets/placeholders/placeholder_movie.png'
    );
  }

  overview() {
    return this.item()?.overview ?? '';
  }

  mediaLabel() {
    const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
    if (type === 'tv') return 'TV';
    if (type === 'movie') return 'Movie';
    return 'Title';
  }

  isTv() {
    return this.route.snapshot.paramMap.get('type') === 'tv';
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

  seasons() {
    const it = this.item();
    if (!Array.isArray(it?.seasons)) return [];
    return it.seasons
      .filter((season: any) => Number.isFinite(season?.season_number))
      .slice()
      .sort((a: any, b: any) => (a.season_number ?? 0) - (b.season_number ?? 0));
  }

  episodeOptions() {
    const episodes = this.seasonEpisodes()
      .filter((ep: any) => Number.isFinite(Number(ep?.episode_number)))
      .slice()
      .sort((a: any, b: any) => (a.episode_number ?? 0) - (b.episode_number ?? 0));
    if (episodes.length) return episodes;

    const season = this.selectedSeasonData();
    const count = Number(season?.episode_count);
    if (!Number.isFinite(count) || count <= 0) return [];
    return Array.from({ length: count }, (_, index) => ({
      episode_number: index + 1,
      name: '',
    }));
  }

  // Estado de transición del grid de episodios
  seasonTransitioning = signal(false);

  setSeason(value: number | string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    if (this.selectedSeason() === parsed) return;

    // Transición natural y simple con reset de episodio
    this.smoothSeasonChange(() => {
      this.selectedSeason.set(parsed);
      this.seasonEpisodes.set([]);
      
      // Cada temporada es independiente - resetear selección de episodio
      this.selectedEpisode.set(null);

      this.loadSeasonEpisodes(parsed);
    });
  }

  /**
   * Transición de temporada fluida y sin saltos
   * - Fade suave sin movimiento vertical
   * - Mantiene scroll 100% estable
   * - Cambio instantáneo sin sensación de recarga
   */
  private smoothSeasonChange(changeCallback: () => void): void {
    // Respetar prefers-reduced-motion: swap instantáneo
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      changeCallback();
      return;
    }

    const rowWrapper = this.elementRef.nativeElement.querySelector('.netflix-episode-row-wrapper') as HTMLElement;
    const gridEl = this.elementRef.nativeElement.querySelector('.netflix-episode-row') as HTMLElement;
    
    if (!gridEl) {
      changeCallback();
      return;
    }

    // Marcar como transitioning (bloquea interacciones)
    this.seasonTransitioning.set(true);
    
    // Fijar altura del wrapper para evitar saltos de layout
    if (rowWrapper) {
      const currentHeight = rowWrapper.offsetHeight;
      rowWrapper.style.minHeight = `${currentHeight}px`;
    }
    
    // Fade out suave sin desplazamiento
    gridEl.style.transition = 'opacity 200ms ease-out';
    gridEl.style.opacity = '0';
    gridEl.style.pointerEvents = 'none';

    // Ejecutar el cambio de datos después del fade out
    setTimeout(() => {
      changeCallback();

      // Después del render, hacer el fade-in
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Fade in suave
          gridEl.style.transition = 'opacity 280ms ease-in';
          gridEl.style.opacity = '1';

          // Cleanup después de la transición
          setTimeout(() => {
            gridEl.style.transition = '';
            gridEl.style.opacity = '';
            gridEl.style.pointerEvents = '';
            if (rowWrapper) {
              rowWrapper.style.minHeight = '';
            }
            this.seasonTransitioning.set(false);
          }, 300);
        });
      });
    }, 210);
  }

  setEpisode(value: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    this.selectedEpisode.set(parsed);
  }

  selectEpisode(episodeNumber: number) {
    if (!Number.isFinite(episodeNumber) || episodeNumber < 0) return;
    this.selectedEpisode.set(episodeNumber);
  }

  /**
   * Reproduce un episodio específico.
   * Detiene propagación para no disparar selectEpisode de la card padre.
   */
  playEpisode(episode: any, event: Event) {
    event.stopPropagation();
    
    // Asegurar que el episodio esté seleccionado
    const episodeNumber = episode?.episode_number;
    if (Number.isFinite(episodeNumber) && episodeNumber >= 0) {
      this.selectedEpisode.set(episodeNumber);
    }
    
    // Reproducir
    this.play();
  }

  // Retorna info de la temporada para mostrar en el template
  getSeasonInfo(season: any): { customName: string; number: number; isSpecial: boolean } | null {
    const name = String(season?.name || '').trim();
    const number = Number(season?.season_number);
    
    if (!Number.isFinite(number)) return null;
    
    // Si tiene nombre personalizado (no es "Season X", "Temporada X" o "Specials")
    const isCustomName = name && 
      !name.startsWith('Season') && 
      !name.startsWith('Temporada') && 
      name !== 'Specials' &&
      name !== 'Especiales';
    
    return {
      customName: isCustomName ? name : '',
      number: number,
      isSpecial: number === 0
    };
  }

  formatEpisodeLabel(episode: any) {
    const number = Number(episode?.episode_number);
    const name = String(episode?.name || '').trim();
    if (!Number.isFinite(number)) return name || 'Episode';

    const numberTag = String(number).padStart(2, '0');
    if (!name) return `Episode ${number}`;
    return `E${numberTag} - ${name}`;
  }

  episodeTitle(episode: any) {
    const name = String(episode?.name || '').trim();
    if (name) return name;
    const number = Number(episode?.episode_number);
    if (!Number.isFinite(number)) return 'Episode';
    if (number === 0) return 'Specials';
    return `Episode ${number}`;
  }

  episodeCode(episode: any) {
    const number = Number(episode?.episode_number);
    if (!Number.isFinite(number)) return '';
    if (number === 0) return 'SP';
    return `E${String(number).padStart(2, '0')}`;
  }

  episodeMeta(episode: any) {
    const parts: string[] = [];
    const airDate = this.formatDate(episode?.air_date);
    if (airDate && airDate !== '—') parts.push(airDate);
    return parts.join(' • ');
  }

  episodeRuntime(episode: any) {
    const runtime = Number(episode?.runtime);
    if (!Number.isFinite(runtime) || runtime <= 0) return '';
    return `${runtime}m`;
  }

  episodeRatingLabel(episode: any) {
    const rating = Number(episode?.vote_average);
    if (!Number.isFinite(rating) || rating <= 0) return '';
    const votes = Number(episode?.vote_count);
    if (Number.isFinite(votes) && votes <= 0) return '';
    return rating.toFixed(1);
  }

  episodeOverview(episode: any) {
    return String(episode?.overview || '').trim();
  }

  episodeStill(episode: any) {
    return this.tmdb.posterUrl(episode?.still_path) || 'assets/placeholders/placeholder_movie.png';
  }

  seriesBadge() {
    const season = this.selectedSeason();
    const episode = this.selectedEpisode();
    if (season === null || episode === null) return '';
    const seasonTag = String(season).padStart(2, '0');
    const episodeTag = String(episode).padStart(2, '0');
    return `S${seasonTag}E${episodeTag}`;
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

  directors(): { id: number; name: string }[] {
    const c = this.credits();
    if (!Array.isArray(c?.crew)) return [];
    return c.crew
      .filter((p: any) => p.job === 'Director')
      .map((p: any) => ({ id: p.id, name: p.name }));
  }

  directorsDisplay() {
    return this.directors().map(d => d.name).join(', ');
  }

  writers(): { id: number; name: string }[] {
    const c = this.credits();
    if (!Array.isArray(c?.crew)) return [];
    return c.crew
      .filter((p: any) => p.job === 'Screenplay' || p.job === 'Writer')
      .slice(0, 3)
      .map((p: any) => ({ id: p.id, name: p.name }));
  }

  writersDisplay() {
    return this.writers().map(w => w.name).join(', ');
  }

  creators(): { id: number; name: string }[] {
    const it = this.item();
    if (!Array.isArray(it?.created_by)) return [];
    return it.created_by.map((p: any) => ({ id: p.id, name: p.name }));
  }

  creatorsDisplay() {
    return this.creators().map(c => c.name).join(', ');
  }

  play() {
    const queryParams: Record<string, string> = {};
    if (this.preferMultiAudio()) queryParams['multiAudio'] = '1';
    if (this.preferSeekable()) queryParams['seekable'] = '1';
    if (this.preferSubtitles()) queryParams['subtitles'] = '1';
    if (this.preferYearInSearch()) queryParams['forceYear'] = '1';
    const type = this.route.snapshot.paramMap.get('type');
    const id = this.route.snapshot.paramMap.get('id');
    const route = ['/play', type, id];

    if (type === 'tv') {
      const season = this.selectedSeason();
      const episode = this.selectedEpisode();
      if (season !== null && episode !== null) {
        route.push(String(season), String(episode));
      }
    }

    this.router.navigate(route, { queryParams });
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
  async toggleMyList() {
    const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
    const idStr = this.route.snapshot.paramMap.get('id');
    const id = idStr ? Number(idStr) : NaN;
    const it = this.item();

    if (!type || !Number.isFinite(id) || !it) return;
    
    // Check authentication
    if (!this.auth.isAuthenticated()) {
      console.log('User not authenticated, cannot modify list');
      return;
    }

    try {
      if (this.inMyList()) {
        // Remove from list
        const itemId = `${type}_${id}`;
        await this.userData.removeFromMyList(itemId);
      } else {
        // Add to list
        await this.userData.addToMyList({
          mediaType: type,
          tmdbId: id,
          title: this.title(),
          poster: it.poster_path,
          backdrop: it.backdrop_path,
          rating: it.vote_average,
          year: this.year(),
        });
      }
    } catch (error) {
      console.error('Error toggling My List:', error);
    }
  }

  // My List methods removed - now using UserDataService with Firestore

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

  private initializeSeriesSelection(data: any) {
    if (!this.isTv()) return;
    const seasons = Array.isArray(data?.seasons) ? data.seasons : [];
    if (!seasons.length) return;

    const sorted = seasons
      .filter((season: any) => Number.isFinite(season?.season_number))
      .slice()
      .sort((a: any, b: any) => (a.season_number ?? 0) - (b.season_number ?? 0));
    const primary = sorted.find((season: any) => season.season_number > 0) ?? sorted[0];
    const seasonNumber = Number(primary?.season_number);
    if (!Number.isFinite(seasonNumber)) return;

    this.selectedSeason.set(seasonNumber);
    const episodeCount = Number(primary?.episode_count);
    if (Number.isFinite(episodeCount) && episodeCount > 0) {
      this.selectedEpisode.set(1);
    } else {
      this.selectedEpisode.set(null);
    }

    this.loadSeasonEpisodes(seasonNumber);
  }

  private selectedSeasonData() {
    const seasonNumber = this.selectedSeason();
    if (!Number.isFinite(seasonNumber)) return null;
    return this.seasons().find((season: any) => season.season_number === seasonNumber) ?? null;
  }

  private getEpisodeCount(seasonNumber: number) {
    const season = this.seasons().find((s: any) => s.season_number === seasonNumber);
    return Number(season?.episode_count);
  }

  private async loadSeasonEpisodes(seasonNumber: number) {
    if (!this.isTv() || !Number.isFinite(seasonNumber)) return;

    const requestId = ++this.seasonEpisodesRequestId;
    const cached = this.seasonEpisodesCache.get(seasonNumber);
    if (cached) {
      this.seasonEpisodes.set(cached);
      this.seasonEpisodesLoading.set(false);
      this.ensureEpisodeSelection(cached);
      return;
    }

    this.seasonEpisodesLoading.set(true);
    const idStr = this.route.snapshot.paramMap.get('id');
    const id = idStr ? Number(idStr) : NaN;
    if (!Number.isFinite(id)) {
      this.seasonEpisodesLoading.set(false);
      return;
    }

    try {
      const data = await firstValueFrom(this.tmdb.tvSeason(id, seasonNumber));
      if (requestId !== this.seasonEpisodesRequestId) return;

      const episodes = Array.isArray(data?.episodes) ? data.episodes : [];
      this.seasonEpisodesCache.set(seasonNumber, episodes);
      this.seasonEpisodes.set(episodes);
      this.ensureEpisodeSelection(episodes);
    } catch {
      if (requestId !== this.seasonEpisodesRequestId) return;
      this.seasonEpisodes.set([]);
    } finally {
      if (requestId === this.seasonEpisodesRequestId) {
        this.seasonEpisodesLoading.set(false);
      }
    }
  }

  private ensureEpisodeSelection(episodes: any[]) {
    if (!episodes.length) return;
    const current = this.selectedEpisode();
    if (current !== null && episodes.some((ep: any) => Number(ep?.episode_number) === current)) {
      return;
    }

    const firstEpisode = episodes.find((ep: any) =>
      Number.isFinite(Number(ep?.episode_number))
    );
    if (!firstEpisode) return;
    this.selectedEpisode.set(Number(firstEpisode.episode_number));
  }
}
