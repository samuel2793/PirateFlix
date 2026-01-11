import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';

type MediaType = 'movie' | 'tv';

@Component({
  selector: 'app-player',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './player.html',
  styleUrl: './player.scss',
})
export class PlayerComponent {
  private readonly route = inject(ActivatedRoute);

  type = signal<MediaType>('movie');
  id = signal<number>(0);
  season = signal<number | null>(null);
  episode = signal<number | null>(null);

  // Fuente demo LEGAL: cambia esto por un provider real luego
  // (pon un MP4/HLS legal que sepas que carga en navegador)
  src = signal<string>('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');
  // Si usas mp4 directo: 'https://.../video.mp4'

  ngOnInit() {
    const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
    const idStr = this.route.snapshot.paramMap.get('id');
    const seasonStr = this.route.snapshot.paramMap.get('season');
    const episodeStr = this.route.snapshot.paramMap.get('episode');

    if (type === 'movie' || type === 'tv') this.type.set(type);
    if (idStr) this.id.set(Number(idStr));
    if (seasonStr) this.season.set(Number(seasonStr));
    if (episodeStr) this.episode.set(Number(episodeStr));
  }
}
