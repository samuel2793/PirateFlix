import { Component, inject, signal, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { AlertController } from '@ionic/angular/standalone';
import { HttpClient } from '@angular/common/http';
import { TmdbService } from '../../core/services/tmdb';
import { firstValueFrom } from 'rxjs';

type MediaType = 'movie' | 'tv';

interface TorrentFile {
  index: number;
  name: string;
  length: number;
  type?: string;
}

interface SubtitleTrack {
  index: number;
  name: string;
  language: string;
  url: string;
  isEmbedded?: boolean;
  streamIndex?: number;
}

interface EmbeddedSubtitle {
  index: number;
  codec: string;
  language: string;
  title: string;
  forced: boolean;
  default: boolean;
}

interface TorrentInfo {
  infoHash: string;
  name: string;
  files: TorrentFile[];
  progress?: number;
  downloadSpeed?: number;
  numPeers?: number;
}

@Component({
  selector: 'app-player',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './player.html',
  styleUrl: './player.scss',
})
export class PlayerComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly alertController = inject(AlertController);
  private readonly http = inject(HttpClient);
  private readonly tmdb = inject(TmdbService);

  @ViewChild('videoPlayer', { static: false }) videoPlayer!: ElementRef<HTMLVideoElement>;

  type = signal<MediaType>('movie');
  id = signal<number>(0);
  season = signal<number | null>(null);
  episode = signal<number | null>(null);

  showPlayer = signal<boolean>(false);
  loading = signal<boolean>(false);
  loadingProgress = signal<number>(0);
  loadingPhase = signal<'idle'|'resetting'|'searching'|'streaming'>('idle');
  errorMessage = signal<string>('');
  videoSrc = signal<string>('');
  subtitleTracks = signal<SubtitleTrack[]>([]);

  private readonly API_URL = 'http://localhost:3001/api';
  private currentTorrentHash: string | null = null;
  private progressInterval: any = null;

  async ngOnInit() {
    const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
    const idStr = this.route.snapshot.paramMap.get('id');
    const seasonStr = this.route.snapshot.paramMap.get('season');
    const episodeStr = this.route.snapshot.paramMap.get('episode');

    if (type === 'movie' || type === 'tv') this.type.set(type);
    if (idStr) this.id.set(Number(idStr));
    if (seasonStr) this.season.set(Number(seasonStr));
    if (episodeStr) this.episode.set(Number(episodeStr));

    await this.searchAndPlayTorrent();
  }

  private stopPlaybackAndPolling() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    // Cierra de verdad la conexión de vídeo y range-requests
    const v = this.videoPlayer?.nativeElement;
    if (v) {
      try {
        v.pause();
      } catch {}
      v.removeAttribute('src');
      v.load();
    }
  }

  async searchAndPlayTorrent() {
    this.stopPlaybackAndPolling();
    this.loadingPhase.set('resetting');
    this.loading.set(true);
    this.loadingProgress.set(0);
    this.errorMessage.set('');
    this.showPlayer.set(true);

    const type = this.type();
    const id = this.id();

    try {
      // Obtener información de la película/serie desde TMDB usando el servicio
      console.log(`Obteniendo datos de TMDB: ${type}/${id}`);
      const movieData = await firstValueFrom(this.tmdb.details(type, id));

      const title = movieData.title || movieData.name;
      const year = (movieData.release_date || movieData.first_air_date || '').substring(0, 4);

      console.log(`Buscando torrent para: ${title} (${year})`);

      // Mostrar fase de reset
      this.loadingPhase.set('resetting');
      // Solicitar al backend que haga un prefetch de la búsqueda durante el reset
      try {
        const prefetchQ = `${title} ${year} 1080p`.trim();
        await this.callResetState(4000, prefetchQ, '207');
        console.log('Reset backend completado (prefetch solicitado)');
      } catch (err) {
        console.warn('Reset/pre-fetch no completado/timeout, continuando con búsqueda');
      }

      if (!title) {
        throw new Error('No se pudo obtener el título de la película');
      }

      // Mostrar fase de búsqueda
      this.loadingPhase.set('searching');
      // Intentar diferentes queries si no se encuentran resultados
      // Simplificar búsquedas para evitar timeouts
      const searchQueries = [`${title} ${year} 1080p`, `${title} ${year}`, title];

      let searchResults: any = null;
      let attempts = 0;
      const maxAttempts = 3; // Limitar intentos para evitar timeouts múltiples

      for (const searchQuery of searchQueries) {
        if (attempts >= maxAttempts) {
          console.log('⚠️ Alcanzado límite de intentos de búsqueda');
          break;
        }

        attempts++;
        console.log(`Intentando búsqueda ${attempts}/${maxAttempts}: ${searchQuery}`);

        try {
          const searchResponse = await fetch(
            `${this.API_URL}/search-torrent?query=${encodeURIComponent(searchQuery)}&category=207`
          );

          if (!searchResponse.ok) {
            console.log(`❌ Error HTTP ${searchResponse.status}`);
            continue;
          }

          const results = await searchResponse.json();

          if (results.results && results.results.length > 0) {
            searchResults = results;
            console.log(
              `✓ Encontrados ${results.results.length} torrents con query: ${searchQuery}`
            );
            break;
          }
        } catch (fetchError) {
          console.error(`❌ Error en búsqueda: ${fetchError}`);
          continue;
        }
      }

      if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
        throw new Error('No se encontraron torrents para esta película');
      }

      // Preferir torrents con formatos compatibles con navegadores
      const torrents = searchResults.results;

      console.log(`📋 Torrents disponibles:`);
      torrents.forEach((t: any, i: number) => {
        console.log(`  ${i + 1}. ${t.name}`);
      });

      // Filtros en orden de preferencia:
      // 1. YTS (siempre H.264 MP4 con audio AAC)
      // 2. WEB-DL/WEBRip H.264 de calidad
      // 3. Cualquier H.264 de calidad
      // 4. Lo que sea (probablemente no funcionará)
      const ytsTorrents = torrents.filter((t: any) => t.name.toLowerCase().includes('yts'));

      const lowQuality = (name: string) => {
        const lower = name.toLowerCase();
        // Formatos de baja calidad (grabaciones de cine, etc)
        return (
          lower.includes('ts ') || // TeleSync
          lower.includes('cam') || // CAMRip
          lower.includes('hdcam') ||
          lower.includes('tc ') || // TeleCine
          lower.includes('hdtc') ||
          lower.includes('r5') ||
          lower.includes('screener')
        );
      };

      const incompatibleCodec = (name: string) => {
        const lower = name.toLowerCase();
        // Video codecs no soportados por navegadores
        return (
          lower.includes('hevc') ||
          lower.includes('x265') ||
          lower.includes('h.265') ||
          lower.includes('h265') ||
          lower.includes('av1')
        );
      };

      const incompatibleAudio = (name: string) => {
        const lower = name.toLowerCase();
        return (
          lower.includes('atmos') ||
          lower.includes('ddp') ||
          lower.includes('dd+') ||
          lower.includes('eac3') ||
          lower.includes('truehd')
        );
      };

      // Torrents con codecs compatibles (H.264/x264) y calidad decente
      const h264Quality = torrents.filter(
        (t: any) => !incompatibleCodec(t.name) && !lowQuality(t.name)
      );

      // Torrents con audio compatible
      const h264QualityGoodAudio = h264Quality.filter((t: any) => !incompatibleAudio(t.name));

      // Fallback: cualquier H.264 aunque sea baja calidad
      const h264Any = torrents.filter((t: any) => !incompatibleCodec(t.name));

      const bestTorrent =
        ytsTorrents.length > 0
          ? ytsTorrents[0]
          : h264QualityGoodAudio.length > 0
          ? h264QualityGoodAudio[0]
          : h264Quality.length > 0
          ? h264Quality[0]
          : h264Any.length > 0
          ? h264Any[0]
          : torrents[0];

      if (ytsTorrents.length > 0) {
        console.log(`✅ Seleccionado torrent YTS (H.264 + AAC - Calidad excelente)`);
      } else if (h264QualityGoodAudio.length > 0 && h264QualityGoodAudio[0] === bestTorrent) {
        console.log(`✅ Seleccionado H.264 de calidad con audio compatible`);
      } else if (h264Quality.length > 0 && h264Quality[0] === bestTorrent) {
        console.log(`⚠️ H.264 de calidad pero con audio avanzado (video OK, audio puede fallar)`);
      } else if (h264Any.length > 0 && h264Any[0] === bestTorrent) {
        console.log(`⚠️ H.264 pero BAJA CALIDAD (TS/CAM)`);
      } else {
        console.log(`❌ ADVERTENCIA: Video HEVC/x265 - NO compatible con navegadores`);
        console.log(`   El video NO se verá. Busca manualmente un torrent con H.264 o x264`);
      }
      console.log(`Torrent seleccionado: ${bestTorrent.name}`);
      console.log(`Seeders: ${bestTorrent.seeders}, Tamaño: ${bestTorrent.size}`);

      // Mostrar fase de streaming
      this.loadingPhase.set('streaming');
      // Cargar el magnet link
      await this.loadMagnetLink(bestTorrent.magnetLink);
    } catch (error: any) {
      console.error('Error al buscar torrent:', error);

      // Mensaje más claro según el tipo de error
      let errorMsg = 'No se pudo encontrar el torrent automáticamente';
      if (error.message?.includes('No se encontraron torrents')) {
        errorMsg = 'No se encontraron torrents disponibles';
      } else if (error.message?.includes('timeout')) {
        errorMsg = 'La búsqueda tardó demasiado (timeout)';
      }

      this.errorMessage.set(errorMsg);
      this.loading.set(false);

      // Fallback: preguntar por magnet link manual
      console.log('🔄 Cambiando a entrada manual de magnet link');
      await this.promptForMagnetLink();
    }
  }
  async promptForMagnetLink() {
    const alert = await this.alertController.create({
      header: 'Búsqueda manual',
      message:
        'No se encontró torrent automáticamente.<br><br><b>Tip:</b> Busca en The Pirate Bay y pega el magnet link aquí.',
      inputs: [
        {
          name: 'magnetLink',
          type: 'url',
          placeholder: 'magnet:?xt=urn:btih:...',
          attributes: {
            required: true,
          },
        },
      ],
      buttons: [
        {
          text: 'Cancelar',
          role: 'cancel',
          handler: () => {
            this.showPlayer.set(false);
          },
        },
        {
          text: 'Reproducir',
          handler: (data) => {
            if (data.magnetLink && data.magnetLink.trim()) {
              this.loadMagnetLink(data.magnetLink.trim());
              return true;
            }
            return false;
          },
        },
      ],
      backdropDismiss: false,
    });

    await alert.present();
  }

  // Llama al endpoint `/api/reset-state` con timeout configurable.
  // Ahora admite un `prefetchQuery` opcional para que el backend haga
  // un prefetch/cache de resultados durante el reset (mejora instant switching).
  private async callResetState(timeoutMs = 4000, prefetchQuery?: string, category?: string) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const body: any = {};
      if (prefetchQuery) body.prefetchQuery = prefetchQuery;
      if (category) body.category = category;

      await fetch(`${this.API_URL}/reset-state`, {
        method: 'POST',
        signal: controller.signal,
        headers: Object.keys(body).length ? { 'Content-Type': 'application/json' } : undefined,
        body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      });

      clearTimeout(timer);
      console.log('Reset backend solicitado correctamente');
    } catch (err) {
      // Propagar para que el caller pueda decidir continuar si timeout
      throw err;
    }
  }

  async loadMagnetLink(magnetUri: string) {
    this.loading.set(true);
    this.errorMessage.set('');
    this.showPlayer.set(true);

    try {
      console.log('Enviando torrent al backend:', magnetUri);

      // Agregar torrent en el backend
      const response = await fetch(`${this.API_URL}/torrent/add`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ magnetUri }),
      });

      if (!response.ok) {
        throw new Error('Error al agregar torrent en el backend');
      }

      const torrentInfo: TorrentInfo = await response.json();
      this.currentTorrentHash = torrentInfo.infoHash;

      console.log('Torrent agregado:', torrentInfo.name);
      console.log('InfoHash:', torrentInfo.infoHash);
      console.log('Archivos:', torrentInfo.files.length);

      // Buscar el archivo de video más grande
      const videoFile =
        torrentInfo.files.find((file) => {
          const ext = file.name.toLowerCase();
          return (
            ext.endsWith('.mp4') ||
            ext.endsWith('.mkv') ||
            ext.endsWith('.avi') ||
            ext.endsWith('.webm') ||
            ext.endsWith('.mov')
          );
        }) ||
        torrentInfo.files.reduce((prev, current) =>
          prev.length > current.length ? prev : current
        );

      if (!videoFile) {
        throw new Error('No se encontró archivo de video en el torrent');
      }

      console.log('Archivo seleccionado:', videoFile.name);

      // ✅ TRANSCODIFICACIÓN AUTOMÁTICA: El backend detecta y transcodifica automáticamente
      // Ya no necesitamos deshabilitar transcodificación, el backend maneja todos los codecs
      const needsTranscode = false; // No se usa, backend decide automáticamente
      const transcodeParam = ''; // No se envía parámetro, backend es inteligente

      if (videoFile.name.toLowerCase().endsWith('.mkv')) {
        console.log('📦 Archivo MKV detectado - backend transcodificará audio automáticamente');
      }

      // Buscar archivos de subtítulos externos
      const subtitleFiles = torrentInfo.files.filter((file) => {
        const ext = file.name.toLowerCase();
        return ext.endsWith('.srt') || ext.endsWith('.vtt') || ext.endsWith('.sub');
      });

      console.log('Subtítulos externos encontrados:', subtitleFiles.length);

      // Procesar subtítulos externos
      const subtitles: SubtitleTrack[] = subtitleFiles.map((file, idx) => {
        const language = this.detectLanguageFromFilename(file.name);
        return {
          index: idx, // Usar índice secuencial único
          name: file.name,
          language: language,
          url: `${this.API_URL}/subtitle/${torrentInfo.infoHash}/${file.index}`,
          isEmbedded: false,
        };
      });

      // Detectar subtítulos embebidos en el video
      try {
        const embeddedResponse = await fetch(
          `${this.API_URL}/embedded-subtitles/${torrentInfo.infoHash}/${videoFile.index}`
        );

        if (embeddedResponse.ok) {
          const embeddedSubs: EmbeddedSubtitle[] = await embeddedResponse.json();
          console.log('Subtítulos embebidos encontrados:', embeddedSubs.length);

          // Agregar subtítulos embebidos a la lista
          embeddedSubs.forEach((sub) => {
            const langName = this.getLanguageName(sub.language);
            subtitles.push({
              index: subtitles.length, // Usar índice secuencial único
              name: sub.title || `Embedded ${langName}`,
              language: langName,
              url: `${this.API_URL}/embedded-subtitle/${torrentInfo.infoHash}/${videoFile.index}/${sub.index}`,
              isEmbedded: true,
              streamIndex: sub.index,
            });
          });
        }
      } catch (error) {
        console.error('Error al detectar subtítulos embebidos:', error);
      }

      this.subtitleTracks.set(subtitles);

      // Construir URL de streaming (con transcodificación si es necesario)
      const streamUrl = `${this.API_URL}/stream/${torrentInfo.infoHash}/${videoFile.index}${transcodeParam}`;
      this.videoSrc.set(streamUrl);

      console.log('URL de streaming:', streamUrl);
      if (subtitles.length > 0) {
        console.log('Total de subtítulos disponibles:', subtitles.length);
        console.log(
          'Subtítulos:',
          subtitles
            .map((s) => `${s.language} (${s.isEmbedded ? 'embebido' : 'externo'})`)
            .join(', ')
        );
      }

      // Iniciar monitoreo de progreso
      this.startProgressMonitoring();

      this.loading.set(false);
    } catch (error: any) {
      console.error('Error al cargar magnet link:', error);
      this.errorMessage.set(`Error: ${error.message || 'Error desconocido'}`);
      this.loading.set(false);
    }
  }

  startProgressMonitoring() {
    // ✅ mata el anterior SIEMPRE
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    if (!this.currentTorrentHash) return;

    // Actualizar progreso cada segundo
    this.progressInterval = setInterval(async () => {
      try {
        const response = await fetch(`${this.API_URL}/torrent/${this.currentTorrentHash}`);
        if (response.ok) {
          const info: TorrentInfo = await response.json();
          const progress = Math.round((info.progress || 0) * 100);
          this.loadingProgress.set(progress);

          if (progress % 10 === 0 && progress > 0) {
            console.log(
              `Progreso: ${progress}% | Peers: ${info.numPeers} | Velocidad: ${Math.round(
                (info.downloadSpeed || 0) / 1024
              )} KB/s`
            );
          }
        }
      } catch (error) {
        console.error('Error al obtener progreso:', error);
      }
    }, 1000);
  }

  getLanguageName(code: string): string {
    const languageMap: { [key: string]: string } = {
      spa: 'Español',
      es: 'Español',
      eng: 'English',
      en: 'English',
      fra: 'Français',
      fre: 'Français',
      fr: 'Français',
      deu: 'Deutsch',
      ger: 'Deutsch',
      de: 'Deutsch',
      ita: 'Italiano',
      it: 'Italiano',
      por: 'Português',
      pt: 'Português',
      jpn: '日本語',
      ja: '日本語',
      kor: '한국어',
      ko: '한국어',
      chi: '中文',
      zh: '中文',
      rus: 'Русский',
      ru: 'Русский',
      ara: 'العربية',
      ar: 'العربية',
      und: 'Desconocido',
    };

    return languageMap[code.toLowerCase()] || code.toUpperCase();
  }

  getLanguageCode(languageNameOrCode: string): string {
    const codeMap: { [key: string]: string } = {
      español: 'es',
      spanish: 'es',
      spa: 'es',
      es: 'es',
      english: 'en',
      inglés: 'en',
      eng: 'en',
      en: 'en',
      français: 'fr',
      french: 'fr',
      francés: 'fr',
      fra: 'fr',
      fre: 'fr',
      fr: 'fr',
      deutsch: 'de',
      german: 'de',
      alemán: 'de',
      deu: 'de',
      ger: 'de',
      de: 'de',
      italiano: 'it',
      italian: 'it',
      ita: 'it',
      it: 'it',
      português: 'pt',
      portuguese: 'pt',
      portugués: 'pt',
      por: 'pt',
      pt: 'pt',
      日本語: 'ja',
      japanese: 'ja',
      japonés: 'ja',
      jpn: 'ja',
      ja: 'ja',
      한국어: 'ko',
      korean: 'ko',
      coreano: 'ko',
      kor: 'ko',
      ko: 'ko',
      中文: 'zh',
      chinese: 'zh',
      chino: 'zh',
      chi: 'zh',
      zh: 'zh',
      русский: 'ru',
      russian: 'ru',
      ruso: 'ru',
      rus: 'ru',
      ru: 'ru',
      العربية: 'ar',
      arabic: 'ar',
      árabe: 'ar',
      ara: 'ar',
      ar: 'ar',
      desconocido: 'und',
      unknown: 'und',
      und: 'und',
    };

    return codeMap[languageNameOrCode.toLowerCase()] || 'und';
  }

  detectLanguageFromFilename(filename: string): string {
    const lower = filename.toLowerCase();

    // Patrones comunes de idiomas en nombres de archivos
    if (
      lower.includes('spanish') ||
      lower.includes('español') ||
      lower.includes('spa') ||
      lower.includes('.es.')
    ) {
      return 'Español';
    }
    if (lower.includes('english') || lower.includes('eng') || lower.includes('.en.')) {
      return 'English';
    }
    if (
      lower.includes('french') ||
      lower.includes('français') ||
      lower.includes('fra') ||
      lower.includes('.fr.')
    ) {
      return 'Français';
    }
    if (
      lower.includes('german') ||
      lower.includes('deutsch') ||
      lower.includes('ger') ||
      lower.includes('.de.')
    ) {
      return 'Deutsch';
    }
    if (
      lower.includes('italian') ||
      lower.includes('italiano') ||
      lower.includes('ita') ||
      lower.includes('.it.')
    ) {
      return 'Italiano';
    }
    if (
      lower.includes('portuguese') ||
      lower.includes('português') ||
      lower.includes('por') ||
      lower.includes('.pt.')
    ) {
      return 'Português';
    }

    // Si no se detecta, usar el nombre del archivo
    return filename.split('.').slice(0, -1).pop() || 'Desconocido';
  }

  ngOnDestroy() {
    // Limpiar interval de progreso
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    // Opcional: eliminar torrent del backend al salir
    if (this.currentTorrentHash) {
      fetch(`${this.API_URL}/torrent/${this.currentTorrentHash}`, {
        method: 'DELETE',
      }).catch((err) => console.error('Error al eliminar torrent:', err));
    }
  }
}
