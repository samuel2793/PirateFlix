import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TmdbService } from '../../core/services/tmdb';
import { firstValueFrom } from 'rxjs';

interface Credit {
  id: number;
  title?: string;
  name?: string;
  media_type: 'movie' | 'tv';
  poster_path: string | null;
  character?: string;
  job?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  popularity: number;
}

@Component({
  selector: 'app-person',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
  ],
  templateUrl: './person.html',
  styleUrl: './person.scss',
})
export class PersonComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly tmdb = inject(TmdbService);

  loading = signal(true);
  error = signal<string | null>(null);
  person = signal<any | null>(null);
  credits = signal<any | null>(null);
  showFullBio = signal(false);

  async ngOnInit() {
    try {
      const idStr = this.route.snapshot.paramMap.get('id');
      const id = idStr ? Number(idStr) : NaN;

      if (!Number.isFinite(id)) {
        this.error.set('ID inválido');
        return;
      }

      const [personData, creditsData] = await Promise.all([
        firstValueFrom(this.tmdb.personDetails(id)),
        firstValueFrom(this.tmdb.personCredits(id)),
      ]);

      this.person.set(personData);
      this.credits.set(creditsData);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loading.set(false);
    }
  }

  // Basic info
  name() {
    return this.person()?.name ?? '—';
  }

  photo() {
    const p = this.person();
    return this.tmdb.profileUrl(p?.profile_path, 'h632') || 'assets/placeholder-person.png';
  }

  biography() {
    return this.person()?.biography || 'No hay biografía disponible.';
  }

  shortBio() {
    const bio = this.biography();
    if (bio.length <= 400) return bio;
    return bio.slice(0, 400).trim() + '...';
  }

  hasBioOverflow() {
    return this.biography().length > 400;
  }

  birthDate() {
    return this.formatDate(this.person()?.birthday);
  }

  deathDate() {
    const d = this.person()?.deathday;
    return d ? this.formatDate(d) : null;
  }

  age() {
    const birth = this.person()?.birthday;
    const death = this.person()?.deathday;
    if (!birth) return null;

    const birthDate = new Date(birth);
    const endDate = death ? new Date(death) : new Date();

    let age = endDate.getFullYear() - birthDate.getFullYear();
    const monthDiff = endDate.getMonth() - birthDate.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && endDate.getDate() < birthDate.getDate())) {
      age--;
    }

    return age;
  }

  birthPlace() {
    return this.person()?.place_of_birth || null;
  }

  knownFor() {
    const dept = this.person()?.known_for_department;
    const translations: Record<string, string> = {
      'Acting': 'Actuación',
      'Directing': 'Dirección',
      'Writing': 'Guión',
      'Production': 'Producción',
      'Crew': 'Equipo técnico',
      'Sound': 'Sonido',
      'Camera': 'Fotografía',
      'Editing': 'Edición',
      'Art': 'Arte',
      'Costume & Make-Up': 'Vestuario y Maquillaje',
      'Visual Effects': 'Efectos visuales',
    };
    return translations[dept] || dept || null;
  }

  // Credits
  actingCredits(): Credit[] {
    const creds = this.credits();
    if (!creds?.cast) return [];

    return [...creds.cast]
      .filter((c: Credit) => c.poster_path) // Only with posters
      .sort((a: Credit, b: Credit) => {
        // Sort by date descending, then by popularity
        const dateA = a.release_date || a.first_air_date || '';
        const dateB = b.release_date || b.first_air_date || '';
        if (dateB !== dateA) return dateB.localeCompare(dateA);
        return b.popularity - a.popularity;
      })
      .slice(0, 30); // Limit to 30 items
  }

  crewCredits(): Credit[] {
    const creds = this.credits();
    if (!creds?.crew) return [];

    // Group by movie/tv to avoid duplicates
    const seen = new Set<string>();
    return [...creds.crew]
      .filter((c: Credit) => {
        const key = `${c.media_type}-${c.id}`;
        if (seen.has(key) || !c.poster_path) return false;
        seen.add(key);
        return true;
      })
      .sort((a: Credit, b: Credit) => {
        const dateA = a.release_date || a.first_air_date || '';
        const dateB = b.release_date || b.first_air_date || '';
        if (dateB !== dateA) return dateB.localeCompare(dateA);
        return b.popularity - a.popularity;
      })
      .slice(0, 20);
  }

  hasCrewCredits() {
    return this.crewCredits().length > 0;
  }

  // Stats
  totalMovies() {
    const creds = this.credits();
    if (!creds?.cast) return 0;
    return creds.cast.filter((c: Credit) => c.media_type === 'movie').length;
  }

  totalTvShows() {
    const creds = this.credits();
    if (!creds?.cast) return 0;
    return creds.cast.filter((c: Credit) => c.media_type === 'tv').length;
  }

  // Helpers
  getPoster(credit: Credit) {
    return this.tmdb.posterUrl(credit.poster_path) || 'assets/placeholders/placeholder_movie.png';
  }

  getTitle(credit: Credit) {
    return credit.title || credit.name || '—';
  }

  getYear(credit: Credit) {
    const date = credit.release_date || credit.first_air_date;
    return date ? date.slice(0, 4) : '';
  }

  getRole(credit: Credit) {
    return credit.character || credit.job || '';
  }

  getMediaType(credit: Credit) {
    return credit.media_type === 'tv' ? 'Serie' : 'Película';
  }

  private formatDate(value: string | null | undefined) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(parsed);
  }

  toggleBio() {
    this.showFullBio.set(!this.showFullBio());
  }
}
