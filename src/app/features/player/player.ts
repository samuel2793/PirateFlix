import { Component, inject, signal, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { AlertController } from '@ionic/angular/standalone';
import { HttpClient } from '@angular/common/http';
import { TmdbService } from '../../core/services/tmdb';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { firstValueFrom } from 'rxjs';

type MediaType = 'movie' | 'tv';

const NO_COMPATIBLE_VIDEO_CODE = 'NO_COMPATIBLE_VIDEO';
const NO_SEEKABLE_CODE = 'NO_SEEKABLE';
const NO_MULTI_AUDIO_CODE = 'NO_MULTI_AUDIO';
const NO_SUBTITLES_CODE = 'NO_SUBTITLES';

function buildNoCompatibleVideoError(): Error {
  const error = new Error(NO_COMPATIBLE_VIDEO_CODE);
  (error as any).code = NO_COMPATIBLE_VIDEO_CODE;
  return error;
}

function buildNoSeekableError(): Error {
  const error = new Error(NO_SEEKABLE_CODE);
  (error as any).code = NO_SEEKABLE_CODE;
  return error;
}

function buildNoMultiAudioError(): Error {
  const error = new Error(NO_MULTI_AUDIO_CODE);
  (error as any).code = NO_MULTI_AUDIO_CODE;
  return error;
}

function buildNoSubtitlesError(): Error {
  const error = new Error(NO_SUBTITLES_CODE);
  (error as any).code = NO_SUBTITLES_CODE;
  return error;
}

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
  provider?: 'torrent' | 'embedded' | 'opensubtitles';
  fileId?: number;
}

interface AudioTrack {
  index: number;
  language: string;
  title: string;
  codec?: string;
  channels?: number | null;
  default?: boolean;
}

interface EmbeddedSubtitle {
  index: number;
  codec: string;
  language: string;
  title: string;
  forced: boolean;
  default: boolean;
}

interface OpenSubtitleResult {
  id: string | null;
  language: string;
  format: string;
  fileId: number;
  fileName: string;
  downloads: number;
  hearingImpaired?: boolean;
  fps?: number | null;
  release?: string;
  uploader?: string;
  season?: number | null;
  episode?: number | null;
}

interface TorrentInfo {
  infoHash: string;
  name: string;
  files: TorrentFile[];
  progress?: number;
  downloadSpeed?: number;
  numPeers?: number;
}

interface LoadMagnetOptions {
  throwOnError?: boolean;
  requireMultiAudio?: boolean;
  requireSeekable?: boolean;
  requireSubtitles?: boolean;
  minAudioTracks?: number;
}

type LoadingLogLevel = 'info' | 'warn' | 'error';

interface LoadingLogEntry {
  id: number;
  level: LoadingLogLevel;
  message: string;
}

@Component({
  selector: 'app-player',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslatePipe],
  templateUrl: './player.html',
  styleUrl: './player.scss',
})
export class PlayerComponent implements OnDestroy {
  private static readonly SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly searchCache = new Map<
    string,
    { ts: number; results: any[]; sawSeeded: boolean }
  >();

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
  loadingLogs = signal<LoadingLogEntry[]>([]);
  errorMessage = signal<string>('');
  videoSrc = signal<string>('');
  subtitleTracks = signal<SubtitleTrack[]>([]);
  audioTracks = signal<AudioTrack[]>([]);
  selectedAudioTrack = signal<'auto' | number>('auto');
  preferMultiAudio = signal<boolean>(false);
  preferSeekable = signal<boolean>(false);
  preferSubtitles = signal<boolean>(false);
  forceYearInSearch = signal<boolean>(false);
  
  // Subtitle customization
  subtitleSize = signal<number>(this.loadSubtitlePref('size', 100));
  subtitleColor = signal<string>(this.loadSubtitlePref('color', '#ffffff'));
  subtitleBackground = signal<string>(this.loadSubtitlePref('background', 'rgba(0,0,0,0.7)'));
  subtitleFont = signal<string>(this.loadSubtitlePref('font', 'sans-serif'));
  showSubtitleSettings = signal<boolean>(false);
  
  // Settings panel
  showSettings = signal<boolean>(false);
  settingsTab = signal<'audio' | 'subtitles' | 'appearance'>('audio');
  selectedSubtitleTrack = signal<number>(-1);
  
  // UI Controls visibility
  showControls = signal<boolean>(true);
  private controlsHideTimer: any = null;
  private readonly CONTROLS_HIDE_DELAY = 3000; // 3 seconds
  openSubtitlesResults = signal<OpenSubtitleResult[]>([]);
  openSubtitlesLoading = signal<boolean>(false);
  openSubtitlesError = signal<string>('');
  openSubtitlesLanguages = signal<string>('es,en');
  openSubtitlesLanguageOrder = signal<string[]>([]);
  openSubtitlesLanguageIndices = signal<Record<string, number>>({});
  openSubtitlesBuckets = signal<Record<string, OpenSubtitleResult[]>>({});

  private readonly API_URL = (() => {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
    return isLocalhost ? 'http://localhost:3001/api' : `http://${hostname}:3001/api`;
  })();
  private readonly maxLoadingLogEntries = 8;
  private currentTorrentHash: string | null = null;
  private currentVideoFileIndex: number | null = null;
  private currentTitle: string | null = null;
  private currentYear: string | null = null;
  private progressInterval: any = null;
  private loadingLogCounter = 0;
  private lastProgressLog = -1;
  private pendingSeekTime: number | null = null;
  private pendingWasPlaying = false;
  private playbackSession = 0;
  private playbackSessionSeed = 0;
  private searchAbortController: AbortController | null = null;

  private startNewPlaybackSession() {
    this.playbackSessionSeed += 1;
    const next = Date.now() * 1000 + this.playbackSessionSeed;
    this.playbackSession = Math.max(this.playbackSession, next);
    return this.playbackSession;
  }

  private isSessionActive(sessionId?: number) {
    return typeof sessionId !== 'number' || sessionId === this.playbackSession;
  }

  private newSearchAbortController() {
    if (this.searchAbortController) {
      try {
        this.searchAbortController.abort();
      } catch {}
    }
    this.searchAbortController = new AbortController();
    return this.searchAbortController;
  }

  private resetLoadingLogs() {
    this.loadingLogCounter = 0;
    this.lastProgressLog = -1;
    this.loadingLogs.set([]);
  }

  private pushLoadingLog(message: string, level: LoadingLogLevel = 'info') {
    const trimmed = String(message || '').trim();
    if (!trimmed) return;

    const current = this.loadingLogs();
    const last = current[current.length - 1];
    if (last && last.message === trimmed && last.level === level) return;

    const entry: LoadingLogEntry = {
      id: ++this.loadingLogCounter,
      level,
      message: trimmed,
    };
    const next = current.concat(entry);
    if (next.length > this.maxLoadingLogEntries) {
      next.splice(0, next.length - this.maxLoadingLogEntries);
    }
    this.loadingLogs.set(next);
  }

  async ngOnInit() {
    const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
    const idStr = this.route.snapshot.paramMap.get('id');
    const seasonStr = this.route.snapshot.paramMap.get('season');
    const episodeStr = this.route.snapshot.paramMap.get('episode');
    const preferMultiAudioParam = this.route.snapshot.queryParamMap.get('multiAudio');
    const preferSeekableParam = this.route.snapshot.queryParamMap.get('seekable');
    const preferSubtitlesParam = this.route.snapshot.queryParamMap.get('subtitles');
    const forceYearParam = this.route.snapshot.queryParamMap.get('forceYear');

    if (type === 'movie' || type === 'tv') this.type.set(type);
    if (idStr) this.id.set(Number(idStr));
    if (seasonStr) this.season.set(Number(seasonStr));
    if (episodeStr) this.episode.set(Number(episodeStr));
    this.preferMultiAudio.set(preferMultiAudioParam === '1' || preferMultiAudioParam === 'true');
    this.preferSeekable.set(preferSeekableParam === '1' || preferSeekableParam === 'true');
    this.preferSubtitles.set(preferSubtitlesParam === '1' || preferSubtitlesParam === 'true');
    this.forceYearInSearch.set(forceYearParam === '1' || forceYearParam === 'true');

    await this.searchAndPlayTorrent();
  }

  private stopPlaybackAndPolling() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    // Clear bound src so Angular does not re-attach the old stream.
    this.videoSrc.set('');
    this.subtitleTracks.set([]);
    this.audioTracks.set([]);
    this.selectedAudioTrack.set('auto');
    this.selectedSubtitleTrack.set(-1);
    this.openSubtitlesResults.set([]);
    this.openSubtitlesError.set('');
    this.openSubtitlesLoading.set(false);
    this.openSubtitlesLanguageOrder.set([]);
    this.openSubtitlesLanguageIndices.set({});
    this.openSubtitlesBuckets.set({});
    this.currentTorrentHash = null;
    this.currentVideoFileIndex = null;

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
    const sessionId = this.startNewPlaybackSession();
    const searchController = this.newSearchAbortController();
    const searchSignal = searchController.signal;

    this.stopPlaybackAndPolling();
    this.loadingPhase.set('resetting');
    this.loading.set(true);
    this.loadingProgress.set(0);
    this.errorMessage.set('');
    this.showPlayer.set(true);
    this.resetLoadingLogs();
    this.pushLoadingLog('Preparando servidor para la reproducción...');

    const type = this.type();
    const id = this.id();
    const preferMultiAudio = this.preferMultiAudio();
    const preferSeekable = this.preferSeekable();
    const preferSubtitles = this.preferSubtitles();
    const forceYearInSearch = this.forceYearInSearch();

    try {
      // 1. Quick-switch: limpiar streams/ffmpeg anteriores (muy rápido, ~50ms)
      await this.callQuickSwitch(1500);
      if (!this.isSessionActive(sessionId)) return;

      // 2. Obtener información de la película/serie desde TMDB
      console.log(`Obteniendo datos de TMDB: ${type}/${id}`);
      this.pushLoadingLog(`Obteniendo datos de TMDB: ${type}/${id}`);
      const movieData = await firstValueFrom(this.tmdb.details(type, id));
      if (!this.isSessionActive(sessionId)) return;

      const title = movieData.title || movieData.name;
      const year = (movieData.release_date || movieData.first_air_date || '').substring(0, 4);

      if (!title) {
        throw new Error('No se pudo obtener el título de la película');
      }

      this.currentTitle = title;
      this.currentYear = year || null;

      console.log(`Buscando torrent para: ${title} (${year})`);
      this.pushLoadingLog(`Buscando torrent para: ${title} (${year})`);

      // 3. Mostrar fase de búsqueda inmediatamente
      this.loadingPhase.set('searching');
      this.pushLoadingLog('Buscando torrents disponibles...');
      // Intentar queries de más a menos específicas para ampliar resultados
      const normalizeQuery = (value: string) => value.replace(/\s+/g, ' ').trim();
      const normalizedTitle = normalizeQuery(
        title.replace(/['\u2019`\u00b4]/g, '').replace(/[^\w\s]/g, ' ')
      );
      const queryTitle = normalizedTitle || title;
      const season = this.season();
      const episode = this.episode();
      const seasonValue = season ?? NaN;
      const episodeValue = episode ?? NaN;
      const hasEpisodeTarget =
        type === 'tv' && Number.isFinite(seasonValue) && Number.isFinite(episodeValue);
      const episodeLabel = hasEpisodeTarget
        ? `S${String(seasonValue).padStart(2, '0')}E${String(episodeValue).padStart(2, '0')}`
        : '';

      const searchQueries: string[] = [];
      const pushQuery = (...parts: Array<string | null | undefined>) => {
        const q = normalizeQuery(
          parts.filter((part) => part && String(part).trim()).join(' ')
        );
        if (q && !searchQueries.includes(q)) searchQueries.push(q);
      };

      if (hasEpisodeTarget) {
        const seasonTag = String(seasonValue).padStart(2, '0');
        const episodeTag = String(episodeValue).padStart(2, '0');
        const episodeTags = [
          `S${seasonTag}E${episodeTag}`,
          `S${seasonValue}E${episodeValue}`,
          `${seasonValue}x${episodeTag}`,
          `${seasonValue}x${episodeValue}`,
        ];
        const seasonTags = [`S${seasonTag}`, `S${seasonValue}`, `Season ${seasonValue}`];
        const yearToken = forceYearInSearch && year ? year : null;
        const resTokens = ['1080p', '720p'];

        for (const tag of episodeTags) {
          for (const res of resTokens) {
            pushQuery(queryTitle, yearToken, tag, res);
          }
          pushQuery(queryTitle, yearToken, tag);
        }

        for (const tag of seasonTags) {
          pushQuery(queryTitle, yearToken, tag);
        }

        if (!forceYearInSearch && year) {
          for (const tag of episodeTags.slice(0, 2)) {
            pushQuery(queryTitle, year, tag);
          }
        }

        if (!forceYearInSearch) {
          pushQuery(queryTitle);
        }
      } else {
        const baseQueries = [
          normalizeQuery(`${queryTitle} ${year} 1080p`),
          normalizeQuery(`${queryTitle} ${year} 720p`),
          normalizeQuery(`${queryTitle} ${year}`),
        ];
        const rawQueries = forceYearInSearch && year ? baseQueries : baseQueries.concat([queryTitle]);
        for (const q of rawQueries) {
          pushQuery(q);
        }
      }

      const getSeeders = (torrent: any) => Number(torrent?.seeders) || 0;
      const multiAudioHintRegex =
        /\b(dual\s*audio|dual-audio|dualaudio|multi\s*audio|multi-audio|multiaudio|multi\s*lang|multi-lang|multilang)\b/i;
      const hasMultiAudioHint = (name: string) => multiAudioHintRegex.test(name);
      const seekableHintRegex =
        /\b(mp4|x264|h\.?264|web[-\s]?dl|webrip)\b/i;
      const hasSeekableHint = (name: string) => seekableHintRegex.test(name);
      const subtitlesHintRegex =
        /\b(subs?|subtitles?|subtitulado|castellano|spa(nish)?|lat(ino)?|esp|espa[ñn]ol)\b/i;
      const hasSubtitlesHint = (name: string) => subtitlesHintRegex.test(name);

      const categoriesToTry = type === 'tv' ? [208, 205, 0] : [207, 200, 0];
      let anyTimedOut = false;
      let lastCategoryError: any = null;
      let sawNoMultiAudio = false;
      let sawNoSeekable = false;
      let sawNoSubtitles = false;

      const attemptCategory = async (category: number) => {
        const searchStartTime = Date.now();
        const overallTimeoutMs = 35000;
        let timedOut = false;
        let didSearch = false;
        const episodeCacheKey = hasEpisodeTarget ? `:s${seasonValue}:e${episodeValue}` : '';
        const cacheKey = `${type}:${id}${episodeCacheKey}:${category}:${forceYearInSearch ? 'year' : 'any'}`;
        const cachedSearch = PlayerComponent.searchCache.get(cacheKey);
        const cacheFresh =
          cachedSearch && Date.now() - cachedSearch.ts < PlayerComponent.SEARCH_CACHE_TTL_MS;

        const aggregatedResults: any[] = [];
        const seenMagnets = new Set<string>();
        let sawSeeded = false;
        let sawNoMultiAudio = false;
        let sawNoSeekable = false;
        let sawNoSubtitles = false;
        let attempts = 0;
        const maxAttempts = searchQueries.length;

        const mergeResults = (results: any) => {
          for (const torrent of results.results || []) {
            const key = torrent.magnetLink || torrent.name;
            if (key && !seenMagnets.has(key)) {
              seenMagnets.add(key);
              aggregatedResults.push(torrent);
            }
          }
        };

        if (cacheFresh && cachedSearch) {
          console.log('✅ Usando resultados en cache para esta película');
          this.pushLoadingLog('Usando resultados en cache para esta película');
          aggregatedResults.push(...cachedSearch.results);
          sawSeeded = cachedSearch.sawSeeded;
        }

        for (const searchQuery of searchQueries) {
          if (cacheFresh) break;
          if (!this.isSessionActive(sessionId)) return { status: 'aborted' };
          if (Date.now() - searchStartTime > overallTimeoutMs) {
            if (aggregatedResults.length > 0) {
              console.warn('⚠️ Timeout global alcanzado, usando resultados parciales');
              break;
            }
            timedOut = true;
            break;
          }
          if (attempts >= maxAttempts) {
            console.log('⚠️ Alcanzado límite de intentos de búsqueda');
            break;
          }

          attempts++;
          console.log(`Intentando búsqueda ${attempts}/${maxAttempts}: ${searchQuery}`);

          try {
            didSearch = true;
            const searchResponse = await fetch(
              `${this.API_URL}/search-torrent?query=${encodeURIComponent(searchQuery)}&category=${category}`,
              { signal: searchSignal }
            );

            if (!this.isSessionActive(sessionId)) return { status: 'aborted' };
            if (!searchResponse.ok) {
              console.log(`❌ Error HTTP ${searchResponse.status}`);
              if (searchResponse.status === 504) {
                if (aggregatedResults.length > 0) {
                  console.warn('⚠️ Timeout en búsqueda, usando resultados parciales');
                  break;
                }
                timedOut = true;
                break;
              }
              continue;
            }

            const results = await searchResponse.json();
            if (!this.isSessionActive(sessionId)) return { status: 'aborted' };

            if (results.results && results.results.length > 0) {
              mergeResults(results);

              const hasSeeders = results.results.some((t: any) => getSeeders(t) > 0);
              if (hasSeeders) {
                sawSeeded = true;
                console.log(
                  `✓ Encontrados ${results.results.length} torrents con seeders: ${searchQuery}`
                );
              } else {
                console.log(
                  `⚠️ Resultados sin seeders para: ${searchQuery} (probando menos restrictivo)`
                );
              }
            }
          } catch (fetchError: any) {
            if (searchSignal.aborted || fetchError?.name === 'AbortError')
              return { status: 'aborted' };
            console.error(`❌ Error en búsqueda: ${fetchError}`);
            continue;
          }
        }

        if (aggregatedResults.length === 0 && cachedSearch && !cacheFresh) {
          console.warn('⚠️ Usando cache expirado por timeout');
          aggregatedResults.push(...cachedSearch.results);
          sawSeeded = cachedSearch.sawSeeded;
        }

        if (aggregatedResults.length === 0) {
          if (timedOut) {
            return { status: 'timeout' };
          }
          return { status: 'no-results' };
        }

        if (!sawSeeded) {
          console.warn('⚠️ No se encontraron torrents con seeders, usando el mejor disponible');
          this.pushLoadingLog(
            'No se encontraron torrents con seeders, usando el mejor disponible',
            'warn'
          );
        }

        const filterEpisodeResults = (list: any[]) => {
          if (!hasEpisodeTarget) return { results: list, matchType: 'none' };
          const scored = list.map((torrent) => ({
            torrent,
            score: this.getEpisodeMatchScore(
              String(torrent?.name || ''),
              seasonValue,
              episodeValue
            ),
          }));
          const episodeMatches = scored
            .filter((item) => item.score >= 2)
            .map((item) => item.torrent);
          const seasonMatches = scored
            .filter((item) => item.score === 1)
            .map((item) => item.torrent);
          if (episodeMatches.length > 0)
            return {
              results: episodeMatches.concat(seasonMatches),
              matchType: 'episode',
            };
          if (seasonMatches.length > 0) return { results: seasonMatches, matchType: 'season' };
          return { results: [], matchType: 'none' };
        };

        const episodeFiltered = filterEpisodeResults(aggregatedResults);
        if (hasEpisodeTarget && episodeFiltered.matchType === 'none') {
          console.warn('⚠️ Sin coincidencias para episodio/temporada, descartando resultados');
          this.pushLoadingLog(
            `No se encontraron torrents que coincidan con ${episodeLabel}`,
            'warn'
          );
          return { status: 'no-results' };
        }

        if (hasEpisodeTarget && episodeFiltered.matchType !== 'none') {
          if (episodeFiltered.matchType === 'episode') {
            this.pushLoadingLog(`Filtrando por episodio ${episodeLabel}`);
          } else if (episodeFiltered.matchType === 'season') {
            this.pushLoadingLog(
              `Sin episodio exacto, usando temporada S${String(seasonValue).padStart(2, '0')}`,
              'warn'
            );
          }
        }

        // Preferir torrents con formatos compatibles con navegadores
        const torrents = episodeFiltered.results;

        if (didSearch || !cacheFresh) {
          PlayerComponent.searchCache.set(cacheKey, {
            ts: Date.now(),
            results: torrents,
            sawSeeded,
          });
        }

        console.log(`📋 Torrents disponibles (cat ${category}):`);
        this.pushLoadingLog(`Torrents encontrados: ${torrents.length} (cat ${category})`);
        torrents.forEach((t: any, i: number) => {
          console.log(`  ${i + 1}. ${t.name}`);
        });

        const sortBySeeders = (list: any[]) =>
          list
            .slice()
            .sort((a, b) => {
              const matchDiff = hasEpisodeTarget
                ? this.getEpisodeMatchScore(String(b?.name || ''), seasonValue, episodeValue) -
                  this.getEpisodeMatchScore(String(a?.name || ''), seasonValue, episodeValue)
                : 0;
              return (
                matchDiff ||
                getSeeders(b) - getSeeders(a) ||
                (Number(b?.leechers) || 0) - (Number(a?.leechers) || 0)
              );
            });

        const minSeedersPreferred = 2;
        const strongSeededTorrents = torrents.filter(
          (t: any) => getSeeders(t) >= minSeedersPreferred
        );
        const unknownSeededTorrents = torrents.filter((t: any) => getSeeders(t) === 0);

        let candidateTorrents =
          strongSeededTorrents.length > 0 ? strongSeededTorrents : torrents;

        if (strongSeededTorrents.length === 0) {
          if (unknownSeededTorrents.length > 0) {
            console.warn(
              `⚠️ Seeders muy bajos (<${minSeedersPreferred}); probando torrents con seeders desconocidos`
            );
            candidateTorrents = unknownSeededTorrents;
          } else {
            console.warn('⚠️ No hay torrents con seeders suficientes, usando el mejor disponible');
          }
        }

        // Filtros en orden de preferencia:
        // 1. YTS (siempre H.264 MP4 con audio AAC)
        // 2. WEB-DL/WEBRip H.264 de calidad
        // 3. Cualquier H.264 de calidad
        // 4. Lo que sea (probablemente no funcionará)
        const ytsTorrents = sortBySeeders(
          candidateTorrents.filter((t: any) => t.name.toLowerCase().includes('yts'))
        );

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
        const h264Quality = candidateTorrents.filter(
          (t: any) => !incompatibleCodec(t.name) && !lowQuality(t.name)
        );

        // Torrents con audio compatible
        const h264QualityGoodAudio = sortBySeeders(
          h264Quality.filter((t: any) => !incompatibleAudio(t.name))
        );
        const h264QualitySorted = sortBySeeders(h264Quality);

        // Fallback: cualquier H.264 aunque sea baja calidad
        const h264Any = sortBySeeders(
          candidateTorrents.filter((t: any) => !incompatibleCodec(t.name))
        );

        const multiAudioHinted = sortBySeeders(
          candidateTorrents.filter((t: any) => hasMultiAudioHint(String(t?.name || '')))
        );
        const seekableHinted = sortBySeeders(
          candidateTorrents.filter((t: any) => hasSeekableHint(String(t?.name || '')))
        );
        const subtitlesHinted = sortBySeeders(
          candidateTorrents.filter((t: any) => hasSubtitlesHint(String(t?.name || '')))
        );
        const multiAudioSeekableHinted =
          preferMultiAudio && preferSeekable
            ? sortBySeeders(
                candidateTorrents.filter(
                  (t: any) =>
                    hasMultiAudioHint(String(t?.name || '')) &&
                    hasSeekableHint(String(t?.name || ''))
                )
              )
            : [];

        const bestTorrent =
          preferSubtitles && subtitlesHinted.length > 0
            ? subtitlesHinted[0]
            : preferMultiAudio && preferSeekable && multiAudioSeekableHinted.length > 0
            ? multiAudioSeekableHinted[0]
            : preferSeekable && seekableHinted.length > 0
            ? seekableHinted[0]
            : preferMultiAudio && multiAudioHinted.length > 0
            ? multiAudioHinted[0]
            : ytsTorrents.length > 0
            ? ytsTorrents[0]
            : h264QualityGoodAudio.length > 0
            ? h264QualityGoodAudio[0]
            : h264QualitySorted.length > 0
            ? h264QualitySorted[0]
            : h264Any.length > 0
            ? h264Any[0]
            : candidateTorrents[0];

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
        this.pushLoadingLog(`Torrent seleccionado: ${bestTorrent.name}`);

        // Mostrar fase de streaming
        this.loadingPhase.set('streaming');
        this.pushLoadingLog('Conectando al torrent...');
        // Cargar el magnet link (con fallback si no hay video compatible)
        if (!this.isSessionActive(sessionId)) return { status: 'aborted' };

        const orderedCandidates: any[] = [];
        const seenCandidates = new Set<string>();
        const pushUnique = (list: any[]) => {
          for (const torrent of list) {
            const key = torrent?.magnetLink || torrent?.name;
            if (!key || seenCandidates.has(key)) continue;
            seenCandidates.add(key);
            orderedCandidates.push(torrent);
          }
        };

        if (preferSubtitles) {
          pushUnique(subtitlesHinted);
        }
        if (preferMultiAudio && preferSeekable) {
          pushUnique(multiAudioSeekableHinted);
        }
        if (preferSeekable) {
          pushUnique(seekableHinted);
        }
        if (preferMultiAudio) {
          pushUnique(multiAudioHinted);
        }
        pushUnique([bestTorrent]);
        pushUnique(ytsTorrents);
        pushUnique(h264QualityGoodAudio);
        pushUnique(h264QualitySorted);
        pushUnique(h264Any);
        pushUnique(sortBySeeders(candidateTorrents));

        let lastError: any = null;
        let sawNoCompatible = false;
        let loadedAny = false;

        for (let i = 0; i < orderedCandidates.length; i++) {
          const candidate = orderedCandidates[i];
          if (!candidate?.magnetLink) continue;
          if (!this.isSessionActive(sessionId)) return { status: 'aborted' };

          console.log(`🎯 Probando torrent ${i + 1}/${orderedCandidates.length}: ${candidate.name}`);
          try {
            const loaded = await this.loadMagnetLink(candidate.magnetLink, sessionId, {
              throwOnError: true,
              requireMultiAudio: preferMultiAudio,
              requireSeekable: preferSeekable,
              requireSubtitles: preferSubtitles,
            });
            if (loaded) {
              lastError = null;
              loadedAny = true;
              break;
            }
          } catch (error: any) {
            if (!this.isSessionActive(sessionId)) return { status: 'aborted' };
            if (error?.code === NO_COMPATIBLE_VIDEO_CODE) {
              if (!sawNoCompatible) {
                this.pushLoadingLog(
                  'Torrent incompatible (ISO/BDMV), probando otro...',
                  'warn'
                );
              }
              sawNoCompatible = true;
              console.warn('⚠️ Torrent incompatible (ISO/BDMV), probando otro:', candidate.name);
              continue;
            } else {
              if (error?.code === NO_MULTI_AUDIO_CODE) {
                if (!sawNoMultiAudio) {
                  this.pushLoadingLog(
                    'Torrent sin varias pistas de audio, probando otro...',
                    'warn'
                  );
                }
                sawNoMultiAudio = true;
                console.warn(
                  '⚠️ Torrent sin varias pistas de audio, probando otro:',
                  candidate.name
                );
                continue;
              }
              if (error?.code === NO_SUBTITLES_CODE) {
                if (!sawNoSubtitles) {
                  this.pushLoadingLog('Torrent sin subtítulos, probando otro...', 'warn');
                }
                sawNoSubtitles = true;
                console.warn('⚠️ Torrent sin subtítulos, probando otro:', candidate.name);
                continue;
              }
              if (error?.code === NO_SEEKABLE_CODE) {
                if (!sawNoSeekable) {
                  this.pushLoadingLog(
                    'Torrent sin seeking disponible, probando otro...',
                    'warn'
                  );
                }
                sawNoSeekable = true;
                console.warn(
                  '⚠️ Torrent sin seeking disponible, probando otro:',
                  candidate.name
                );
                continue;
              }
              lastError = error;
            }
            console.warn('⚠️ Error al cargar torrent, intentando otro:', error);
          }
        }

        if (!loadedAny) {
          if (lastError) {
            return { status: 'error', error: lastError };
          }
          if (preferMultiAudio && sawNoMultiAudio) {
            return { status: 'no-multi-audio' };
          }
          if (preferSubtitles && sawNoSubtitles) {
            return { status: 'no-subtitles' };
          }
          if (preferSeekable && sawNoSeekable) {
            return { status: 'no-seekable' };
          }
          if (sawNoCompatible) {
            PlayerComponent.searchCache.delete(cacheKey);
            return { status: 'incompatible' };
          }
          return { status: 'no-results' };
        }

        return { status: 'loaded' };
      };

      for (const category of categoriesToTry) {
        if (!this.isSessionActive(sessionId)) return;
        console.log(`🔎 Buscando en categoría ${category}...`);
        this.pushLoadingLog(`Buscando en categoría ${category}...`);
        const result = await attemptCategory(category);
        if (result.status === 'aborted') {
          return;
        }
        if (result.status === 'loaded') {
          return;
        }
        if (result.status === 'no-multi-audio') {
          sawNoMultiAudio = true;
          continue;
        }
        if (result.status === 'no-subtitles') {
          sawNoSubtitles = true;
          continue;
        }
        if (result.status === 'no-seekable') {
          sawNoSeekable = true;
          continue;
        }
        if (result.status === 'error') {
          lastCategoryError = result.error;
          break;
        }
        if (result.status === 'timeout') {
          anyTimedOut = true;
        }
      }

      if (lastCategoryError) {
        throw lastCategoryError;
      }
      if (anyTimedOut) {
        throw new Error('timeout');
      }
      if (preferMultiAudio && sawNoMultiAudio) {
        throw buildNoMultiAudioError();
      }
      if (preferSubtitles && sawNoSubtitles) {
        throw buildNoSubtitlesError();
      }
      if (preferSeekable && sawNoSeekable) {
        throw buildNoSeekableError();
      }
      throw new Error('No se encontraron torrents para esta película');
    } catch (error: any) {
      if (searchSignal.aborted || !this.isSessionActive(sessionId)) return;
      console.error('Error al buscar torrent:', error);

      // Mensaje más claro según el tipo de error
      let errorMsg = 'No se pudo encontrar el torrent automáticamente';
      if (error.message?.includes('No se encontraron torrents')) {
        errorMsg = 'No se encontraron torrents disponibles';
      } else if (error.message?.includes('timeout')) {
        errorMsg = 'La búsqueda tardó demasiado (timeout)';
      } else if (error?.code === NO_MULTI_AUDIO_CODE) {
        errorMsg =
          'No se encontraron torrents con varias pistas de audio. Desactiva el filtro e intenta de nuevo.';
      } else if (error?.code === NO_SUBTITLES_CODE) {
        errorMsg =
          'No se encontraron torrents con subtítulos. Desactiva el filtro e intenta de nuevo.';
      } else if (error?.code === NO_SEEKABLE_CODE) {
        errorMsg =
          'No se encontraron torrents con seeking disponible. Desactiva el filtro e intenta de nuevo.';
      } else if (error?.code === NO_COMPATIBLE_VIDEO_CODE) {
        errorMsg =
          'El torrent encontrado no contiene un archivo de vídeo compatible (ISO/BDMV).';
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
              this.resetLoadingLogs();
              this.pushLoadingLog('Usando magnet link manual...');
              this.loadMagnetLink(data.magnetLink.trim(), this.playbackSession, {
                requireMultiAudio: this.preferMultiAudio(),
                requireSeekable: this.preferSeekable(),
                requireSubtitles: this.preferSubtitles(),
              });
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

  // Quick-switch: endpoint LIGERO para cambiar de película rápido
  // No destruye el cliente WebTorrent, solo limpia streams/ffmpeg
  private async callQuickSwitch(timeoutMs = 1500): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${this.API_URL}/quick-switch`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.playbackSession }),
      });

      clearTimeout(timer);

      if (response.ok) {
        const result = await response.json();
        console.log(`⚡ Quick-switch completado en ${result.time}ms`);
        this.pushLoadingLog(`Servidor preparado en ${result.time}ms`);
        return true;
      }
      this.pushLoadingLog('Quick-switch sin respuesta, continuando...', 'warn');
      return false;
    } catch (err) {
      console.warn('Quick-switch falló, continuando:', err);
      this.pushLoadingLog('Quick-switch falló, continuando...', 'warn');
      return false;
    }
  }

  // Reset completo: solo usar si quick-switch no es suficiente
  private async callResetState(timeoutMs = 2000): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${this.API_URL}/reset-state`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.playbackSession }),
      });

      clearTimeout(timer);

      if (response.ok) {
        const result = await response.json();
        console.log(`🔁 Reset completo en ${result.time}ms`);
        return true;
      }
      return false;
    } catch (err) {
      console.warn('Reset falló:', err);
      return false;
    }
  }

  async loadMagnetLink(
    magnetUri: string,
    sessionId: number = this.playbackSession,
    options: LoadMagnetOptions = {}
  ): Promise<boolean> {
    const throwOnError = options.throwOnError === true;
    const requireSeekable = options.requireSeekable === true;
    const requireSubtitles = options.requireSubtitles === true;
    const minAudioTracks = Math.max(
      0,
      options.minAudioTracks ?? (options.requireMultiAudio ? 2 : 0)
    );
    if (!this.isSessionActive(sessionId)) return false;
    this.loading.set(true);
    this.loadingPhase.set('streaming');
    this.errorMessage.set('');
    this.showPlayer.set(true);
    this.subtitleTracks.set([]);
    this.audioTracks.set([]);
    this.selectedAudioTrack.set('auto');
    this.selectedSubtitleTrack.set(-1);
    this.openSubtitlesResults.set([]);
    this.openSubtitlesError.set('');
    this.openSubtitlesLanguageOrder.set([]);
    this.openSubtitlesLanguageIndices.set({});
    this.openSubtitlesBuckets.set({});
    this.pushLoadingLog('Conectando al torrent...');

    try {
      console.log('Enviando torrent al backend:', magnetUri);
      this.pushLoadingLog('Enviando torrent al backend...');

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
      if (!this.isSessionActive(sessionId)) return false;
      this.currentTorrentHash = torrentInfo.infoHash;

      console.log('Torrent agregado:', torrentInfo.name);
      console.log('InfoHash:', torrentInfo.infoHash);
      console.log('Archivos:', torrentInfo.files.length);
      this.pushLoadingLog(`Torrent agregado: ${torrentInfo.name}`);

      const isVideoFile = (file: TorrentFile) => {
        if (file.type === 'video') return true;
        const ext = file.name.toLowerCase();
        return (
          ext.endsWith('.mp4') ||
          ext.endsWith('.mkv') ||
          ext.endsWith('.avi') ||
          ext.endsWith('.webm') ||
          ext.endsWith('.mov')
        );
      };

      const isDiscImage = (name: string) => {
        const ext = name.toLowerCase().split('.').pop();
        return ['iso', 'img', 'bin', 'mdf', 'mds', 'cue'].includes(ext || '');
      };

      const isLikelySample = (name: string) => {
        const lower = name.toLowerCase();
        return (
          lower.includes('sample') ||
          lower.includes('trailer') ||
          lower.includes('preview') ||
          lower.includes('extras') ||
          lower.includes('bonus') ||
          lower.includes('featurette') ||
          lower.includes('bts')
        );
      };

      const videoCandidates = torrentInfo.files.filter(
        (file) => isVideoFile(file) && !isDiscImage(file.name)
      );
      const filteredVideos = videoCandidates.filter((file) => !isLikelySample(file.name));
      const pickFrom = filteredVideos.length > 0 ? filteredVideos : videoCandidates;

      if (pickFrom.length === 0) {
        const hasDiscImage = torrentInfo.files.some((file) => isDiscImage(file.name));
        if (hasDiscImage) {
          console.warn('⚠️ Torrent contiene imagen de disco (ISO/IMG), no compatible con el navegador');
        }
        throw buildNoCompatibleVideoError();
      }

      const targetSeason = this.season();
      const targetEpisode = this.episode();
      const hasEpisodeTarget =
        this.type() === 'tv' &&
        targetSeason !== null &&
        targetEpisode !== null &&
        Number.isFinite(targetSeason) &&
        Number.isFinite(targetEpisode);
      let videoFile: TorrentFile | null = null;
      let selectedByEpisode = false;

      if (hasEpisodeTarget) {
        const episodeMatches = pickFrom.filter(
          (file) => this.getEpisodeMatchScore(file.name, targetSeason!, targetEpisode!) >= 2
        );
        if (episodeMatches.length > 0) {
          videoFile = episodeMatches.slice().sort((a, b) => b.length - a.length)[0];
          selectedByEpisode = true;
        }
      }

      if (!videoFile) {
        videoFile = pickFrom.slice().sort((a, b) => b.length - a.length)[0];
      }

      if (!videoFile) {
        throw new Error('No se encontró archivo de video en el torrent');
      }

      console.log('Archivo seleccionado:', videoFile.name);
      if (hasEpisodeTarget && !selectedByEpisode) {
        const seasonTag = String(targetSeason).padStart(2, '0');
        const episodeTag = String(targetEpisode).padStart(2, '0');
        this.pushLoadingLog(
          `No se identificó el episodio S${seasonTag}E${episodeTag} en los archivos; usando el más grande`,
          'warn'
        );
      }
      if (selectedByEpisode && hasEpisodeTarget) {
        const seasonTag = String(targetSeason).padStart(2, '0');
        const episodeTag = String(targetEpisode).padStart(2, '0');
        this.pushLoadingLog(
          `Archivo seleccionado (S${seasonTag}E${episodeTag}): ${videoFile.name}`
        );
      } else {
        this.pushLoadingLog(`Archivo seleccionado: ${videoFile.name}`);
      }
      this.currentVideoFileIndex = videoFile.index;

      // ✅ TRANSCODIFICACIÓN AUTOMÁTICA: el backend detecta y decide si transcodificar

      if (requireSeekable) {
        const seekableInfo = await this.fetchSeekableInfo(
          torrentInfo.infoHash,
          videoFile.index
        );
        if (!this.isSessionActive(sessionId)) return false;
        if (!seekableInfo.seekable) {
          console.warn('⚠️ Archivo sin seeking disponible:', seekableInfo.reason || 'desconocido');
          throw buildNoSeekableError();
        }
      }

      let preloadedAudioTracks: AudioTrack[] | null = null;
      if (minAudioTracks > 1) {
        preloadedAudioTracks = await this.fetchAudioTracks(
          torrentInfo.infoHash,
          videoFile.index
        );
        if (!this.isSessionActive(sessionId)) return false;
        if (preloadedAudioTracks.length < minAudioTracks) {
          throw buildNoMultiAudioError();
        }
        this.audioTracks.set(preloadedAudioTracks);
      }

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
          provider: 'torrent',
        };
      });

      // Detectar subtítulos embebidos en el video
      try {
      const embeddedResponse = await fetch(
        `${this.API_URL}/embedded-subtitles/${torrentInfo.infoHash}/${videoFile.index}`
      );

      if (embeddedResponse.ok) {
        const embeddedSubs: EmbeddedSubtitle[] = await embeddedResponse.json();
        if (!this.isSessionActive(sessionId)) return false;
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
              provider: 'embedded',
            });
          });
        }
      } catch (error) {
        console.error('Error al detectar subtítulos embebidos:', error);
      }

      if (requireSubtitles && subtitles.length === 0) {
        throw buildNoSubtitlesError();
      }

      this.subtitleTracks.set(subtitles);
      this.pushLoadingLog(`Total de subtítulos disponibles: ${subtitles.length}`);

      // Construir URL de streaming (con transcodificación si es necesario)
      const streamUrl = this.buildStreamUrl('auto');
      this.videoSrc.set(streamUrl);

      console.log('URL de streaming:', streamUrl);
      this.pushLoadingLog('Iniciando streaming...');
      if (subtitles.length > 0) {
        console.log('Total de subtítulos disponibles:', subtitles.length);
        console.log(
          'Subtítulos:',
          subtitles
            .map((s) => `${s.language} (${s.isEmbedded ? 'embebido' : 'externo'})`)
            .join(', ')
        );
      }

      // Cargar pistas de audio sin bloquear el inicio del video
      if (minAudioTracks <= 1) {
        void this.loadAudioTracks(torrentInfo.infoHash, videoFile.index);
      }

      // Iniciar monitoreo de progreso
      this.startProgressMonitoring();

      if (!this.isSessionActive(sessionId)) return false;
      this.loading.set(false);
      return true;
    } catch (error: any) {
      if (!this.isSessionActive(sessionId)) return false;
      const infoHash = this.currentTorrentHash;
      this.currentTorrentHash = null;
      this.currentVideoFileIndex = null;
      if (infoHash) {
        fetch(`${this.API_URL}/torrent/${infoHash}`, { method: 'DELETE' }).catch(() => {});
      }
      if (throwOnError) {
        throw error;
      }
      console.error('Error al cargar magnet link:', error);
      if (error?.code === NO_MULTI_AUDIO_CODE) {
        this.errorMessage.set(
          'El torrent no tiene varias pistas de audio. Desactiva el filtro e intenta de nuevo.'
        );
      } else if (error?.code === NO_SUBTITLES_CODE) {
        this.errorMessage.set(
          'El torrent no tiene subtítulos. Desactiva el filtro e intenta de nuevo.'
        );
      } else if (error?.code === NO_SEEKABLE_CODE) {
        this.errorMessage.set(
          'El torrent no permite seeking. Desactiva el filtro e intenta de nuevo.'
        );
      } else if (error?.code === NO_COMPATIBLE_VIDEO_CODE) {
        this.errorMessage.set(
          'El torrent no contiene un archivo de vídeo compatible (ISO/BDMV).'
        );
      } else {
        this.errorMessage.set(`Error: ${error.message || 'Error desconocido'}`);
      }
      this.loading.set(false);
      return false;
    }
  }

  private buildStreamUrl(selection: 'auto' | number, cacheBust = false): string {
    if (!this.currentTorrentHash || this.currentVideoFileIndex === null) return '';
    const base = `${this.API_URL}/stream/${this.currentTorrentHash}/${this.currentVideoFileIndex}`;
    const params = new URLSearchParams();

    if (selection !== 'auto') {
      params.set('audioStream', String(selection));
    }
    if (cacheBust) {
      params.set('t', String(Date.now()));
    }

    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }

  private async fetchSeekableInfo(
    infoHash: string,
    fileIndex: number
  ): Promise<{ seekable: boolean; reason?: string }> {
    try {
      const response = await fetch(`${this.API_URL}/seekable/${infoHash}/${fileIndex}`);
      if (!response.ok) {
        return { seekable: false, reason: `http-${response.status}` };
      }

      const data = await response.json();
      return {
        seekable: Boolean(data?.seekable),
        reason: typeof data?.reason === 'string' ? data.reason : '',
      };
    } catch (error) {
      console.error('Error al validar seeking:', error);
      return { seekable: false, reason: 'request-failed' };
    }
  }

  private async fetchAudioTracks(infoHash: string, fileIndex: number): Promise<AudioTrack[]> {
    try {
      const response = await fetch(`${this.API_URL}/audio-tracks/${infoHash}/${fileIndex}`);
      if (!response.ok) {
        return [];
      }

      const tracks: AudioTrack[] = await response.json();
      const normalized = tracks.map((track, idx) => {
        const rawLanguage = track.language || 'und';
        const language =
          rawLanguage.length <= 3 ? this.getLanguageName(rawLanguage) : rawLanguage;

        return {
          ...track,
          language,
          title: track.title || `Audio ${idx + 1}`,
        };
      });

      return normalized;
    } catch (error) {
      console.error('Error al detectar pistas de audio:', error);
      return [];
    }
  }

  private async loadAudioTracks(infoHash: string, fileIndex: number) {
    try {
      const normalized = await this.fetchAudioTracks(infoHash, fileIndex);
      if (this.currentTorrentHash !== infoHash || this.currentVideoFileIndex !== fileIndex) {
        return;
      }

      this.audioTracks.set(normalized);
    } catch (error) {
      console.error('Error al detectar pistas de audio:', error);
      this.audioTracks.set([]);
    }
  }

  onAudioTrackChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'auto') {
      this.selectedAudioTrack.set('auto');
    } else {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return;
      this.selectedAudioTrack.set(parsed);
    }

    const v = this.videoPlayer?.nativeElement;
    if (v) {
      this.pendingSeekTime = v.currentTime || 0;
      this.pendingWasPlaying = !v.paused;
    }

    const nextUrl = this.buildStreamUrl(this.selectedAudioTrack(), true);
    this.videoSrc.set(nextUrl);
  }

  onVideoLoadedMetadata() {
    // Apply subtitle styles
    this.applySubtitleStyles();
    
    // Iniciar temporizador para ocultar controles
    this.resetControlsHideTimer();
    
    if (this.pendingSeekTime === null) return;

    const v = this.videoPlayer?.nativeElement;
    if (!v) return;

    const target = this.pendingSeekTime;
    const shouldPlay = this.pendingWasPlaying;
    this.pendingSeekTime = null;
    this.pendingWasPlaying = false;

    try {
      if (Number.isFinite(target) && target > 0) {
        v.currentTime = Math.min(target, v.duration || target);
      }
    } catch {}

    if (shouldPlay) {
      v.play().catch(() => {});
    }
  }

  formatAudioTrackLabel(track: AudioTrack): string {
    const pieces: string[] = [];
    if (track.language) pieces.push(track.language);
    if (track.title && track.title !== track.language) pieces.push(track.title);
    if (track.channels) pieces.push(`${track.channels}ch`);
    if (track.codec) pieces.push(track.codec.toUpperCase());
    if (track.default) pieces.push('predeterminado');
    return pieces.filter(Boolean).join(' - ');
  }

  private getEpisodeMatchFlags(
    name: string,
    season: number,
    episode: number
  ): { episode: boolean; season: boolean; explicitEpisodeFound: boolean } {
    const text = String(name || '').toLowerCase();
    const seasonNum = Number(season);
    const episodeNum = Number(episode);
    if (!text || !Number.isFinite(seasonNum) || !Number.isFinite(episodeNum)) {
      return { episode: false, season: false, explicitEpisodeFound: false };
    }

    const normalized = text.replace(/[\s._\/\\-]+/g, ' ');
    const explicitSource = text.replace(/[\s._\/\\]+/g, ' ');
    const inRange = (value: number, start: number, end?: number) => {
      if (!Number.isFinite(start)) return false;
      if (!Number.isFinite(end)) return value === start;
      const endValue = Number.isFinite(end) ? (end as number) : start;
      const min = Math.min(start, endValue);
      const max = Math.max(start, endValue);
      return value >= min && value <= max;
    };

    let seasonMatch = false;
    let episodeMatch = false;
    let explicitEpisodeFound = false;

    const checkEpisode = (s: number, e1: number, e2?: number) => {
      explicitEpisodeFound = true;
      if (s !== seasonNum) return false;
      seasonMatch = true;
      if (inRange(episodeNum, e1, e2)) {
        episodeMatch = true;
        return true;
      }
      return false;
    };

    const seRegex =
      /\bs(?:eason)?\s*0?(\d{1,3})\s*[.\-_ ]*e(?:p(?:isode)?)?\s*0?(\d{1,3})(?:\s*(?:-|to|e)\s*0?(\d{1,3}))?/gi;
    let match;
    while ((match = seRegex.exec(explicitSource)) !== null) {
      const s = Number(match[1]);
      const e1 = Number(match[2]);
      const e2 = match[3] ? Number(match[3]) : undefined;
      if (checkEpisode(s, e1, e2)) break;
    }

    if (!episodeMatch) {
      const hasCodecX = /\bx26[45]\b/.test(normalized);
      const xRegex =
        /\b(\d{1,3})\s*x\s*0?(\d{1,3})\b(?:\s*(?:-|to|x)\s*0?(\d{1,3}))?/gi;
      while ((match = xRegex.exec(explicitSource)) !== null) {
        const s = Number(match[1]);
        const e1 = Number(match[2]);
        const e2 = match[3] ? Number(match[3]) : undefined;
        if (hasCodecX && (e1 === 264 || e1 === 265)) {
          continue;
        }
        if (checkEpisode(s, e1, e2)) break;
      }
    }

    if (explicitEpisodeFound) {
      return { episode: episodeMatch, season: seasonMatch, explicitEpisodeFound: true };
    }

    let seasonMarkersFound = false;
    const seasonRangeRegex =
      /\bs(?:eason)?\s*0?(\d{1,3})\s*(?:-|to)\s*s?(?:eason)?\s*0?(\d{1,3})\b/gi;
    while ((match = seasonRangeRegex.exec(text)) !== null) {
      seasonMarkersFound = true;
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (inRange(seasonNum, start, end)) {
        seasonMatch = true;
      }
    }

    const seasonWordRegex = /\bseason\s*0?(\d{1,3})\b/gi;
    while ((match = seasonWordRegex.exec(normalized)) !== null) {
      seasonMarkersFound = true;
      if (Number(match[1]) === seasonNum) {
        seasonMatch = true;
      }
    }

    const seasonShortRegex = /\bs\s*0?(\d{1,3})\b/gi;
    while ((match = seasonShortRegex.exec(normalized)) !== null) {
      seasonMarkersFound = true;
      if (Number(match[1]) === seasonNum) {
        seasonMatch = true;
      }
    }

    if (seasonMarkersFound && !seasonMatch) {
      return { episode: false, season: false, explicitEpisodeFound: false };
    }

    const allowEpisodeOnly = seasonMatch || !seasonMarkersFound;
    if (allowEpisodeOnly) {
      const epRegex = /\b(?:episode|ep|e)\s*0?(\d{1,3})\b/gi;
      let episodeMarkerFound = false;
      while ((match = epRegex.exec(normalized)) !== null) {
        episodeMarkerFound = true;
        const e1 = Number(match[1]);
        if (inRange(episodeNum, e1)) {
          episodeMatch = true;
          break;
        }
      }
      if (episodeMarkerFound && !episodeMatch) {
        return { episode: false, season: seasonMatch, explicitEpisodeFound: true };
      }
    }

    if (seasonMatch && !episodeMatch) {
      const fileSegment = text.split(/[\\/]/).pop() || text;
      const scrubbed = fileSegment
        .replace(/\.[a-z0-9]{2,4}$/i, ' ')
        .replace(/\d+\.\d+/g, ' ')
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/\b(480|576|720|1080|2160|4320)p?\b/g, ' ')
        .replace(/\b(4k|8k|10bit|12bit)\b/g, ' ')
        .replace(/\d+ch/gi, ' ')
        .replace(/\bseason\s*\d+\b/gi, ' ')
        .replace(/\bs\s*\d+\b/gi, ' ')
        .replace(/\b(x264|x265|h264|h265|hevc|av1|aac|ac3|eac3|ddp|dd|truehd|atmos)\b/g, ' ');
      const episodeOnlyRegex = /(?:^|[\s._-])0?(\d{1,3})(?:$|[\s._-])/g;
      while ((match = episodeOnlyRegex.exec(scrubbed)) !== null) {
        const value = Number(match[1]);
        if (value === episodeNum) {
          episodeMatch = true;
          break;
        }
      }
    }

    if (episodeMatch) seasonMatch = true;
    return { episode: episodeMatch, season: seasonMatch, explicitEpisodeFound };
  }

  private getEpisodeMatchScore(name: string, season: number, episode: number): number {
    const match = this.getEpisodeMatchFlags(name, season, episode);
    if (match.episode) return 2;
    if (match.season && !match.explicitEpisodeFound) return 1;
    return 0;
  }

  private getOpenSubtitleMatchScore(
    result: OpenSubtitleResult,
    season: number,
    episode: number
  ): number {
    const seasonValue = typeof result?.season === 'number' ? result.season : NaN;
    const episodeValue = typeof result?.episode === 'number' ? result.episode : NaN;
    if (
      Number.isFinite(seasonValue) &&
      seasonValue > 0 &&
      Number.isFinite(episodeValue) &&
      episodeValue > 0
    ) {
      if (seasonValue === season && episodeValue === episode) return 3;
      if (seasonValue === season) return 1;
      return 0;
    }
    const releaseScore = this.getEpisodeMatchScore(result.release || '', season, episode);
    const fileScore = this.getEpisodeMatchScore(result.fileName || '', season, episode);
    return Math.max(releaseScore, fileScore);
  }

  canSearchOpenSubtitles(): boolean {
    return Boolean(this.currentTitle);
  }

  currentOpenSubtitleResult(languageKey: string): OpenSubtitleResult | null {
    const buckets = this.openSubtitlesBuckets();
    const list = buckets[languageKey] || [];
    const indices = this.openSubtitlesLanguageIndices();
    const idx = indices[languageKey] ?? 0;
    if (!list.length || idx < 0 || idx >= list.length) return null;
    return list[idx];
  }

  hasNextOpenSubtitle(languageKey: string): boolean {
    const buckets = this.openSubtitlesBuckets();
    const list = buckets[languageKey] || [];
    const indices = this.openSubtitlesLanguageIndices();
    const idx = indices[languageKey] ?? 0;
    return idx + 1 < list.length;
  }

  pickNextOpenSubtitle(languageKey: string) {
    const buckets = this.openSubtitlesBuckets();
    const list = buckets[languageKey] || [];
    const indices = { ...this.openSubtitlesLanguageIndices() };
    const idx = indices[languageKey] ?? 0;
    if (idx + 1 >= list.length) {
      const label =
        languageKey === 'all'
          ? 'todos los idiomas'
          : this.getLanguageName(languageKey);
      this.openSubtitlesError.set(`No hay más subtítulos para ${label}.`);
      return;
    }
    indices[languageKey] = idx + 1;
    this.openSubtitlesLanguageIndices.set(indices);
    this.openSubtitlesError.set('');
  }

  setOpenSubtitlesLanguages(value: string) {
    this.openSubtitlesLanguages.set(value);
  }

  private parseOpenSubtitlesLanguages(value: string) {
    const parts = String(value || '')
      .split(',')
      .map((lang) => this.normalizeOpenSubtitlesLanguage(lang))
      .filter(Boolean);
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const lang of parts) {
      if (seen.has(lang)) continue;
      seen.add(lang);
      unique.push(lang);
    }
    return unique;
  }

  private normalizeOpenSubtitlesLanguage(value: string) {
    return String(value || '').trim().toLowerCase().replace(/_/g, '-');
  }

  private matchesOpenSubtitlesLanguage(resultLang: string, queryLang: string) {
    const normalizedResult = this.normalizeOpenSubtitlesLanguage(resultLang);
    const normalizedQuery = this.normalizeOpenSubtitlesLanguage(queryLang);
    if (!normalizedResult || !normalizedQuery) return false;
    if (normalizedResult === normalizedQuery) return true;
    const resultBase = normalizedResult.split('-')[0];
    const queryBase = normalizedQuery.split('-')[0];
    return (
      resultBase === normalizedQuery ||
      normalizedResult === queryBase ||
      resultBase === queryBase
    );
  }

  private buildOpenSubtitlesBuckets(
    results: OpenSubtitleResult[],
    languages: string[]
  ): { buckets: Record<string, OpenSubtitleResult[]>; order: string[] } {
    const sorted = results.slice().sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    if (!languages.length) {
      if (!sorted.length) return { buckets: {}, order: [] };
      return { buckets: { all: sorted }, order: ['all'] };
    }

    const buckets: Record<string, OpenSubtitleResult[]> = {};
    for (const lang of languages) {
      buckets[lang] = [];
    }

    for (const result of sorted) {
      const match = languages.find((lang) =>
        this.matchesOpenSubtitlesLanguage(result.language, lang)
      );
      if (match) buckets[match].push(result);
    }

    const order = languages.filter((lang) => buckets[lang] && buckets[lang].length > 0);
    return { buckets, order };
  }

  private buildOpenSubtitlesQuery(includeYear = true) {
    const title = this.currentTitle || '';
    if (!title) return '';

    if (this.type() === 'tv') {
      const season = this.season();
      const episode = this.episode();
      if (season !== null && episode !== null) {
        const seasonTag = String(season).padStart(2, '0');
        const episodeTag = String(episode).padStart(2, '0');
        return `${title} S${seasonTag}E${episodeTag}`;
      }
    }

    if (this.currentYear && includeYear) return `${title} ${this.currentYear}`;
    return title;
  }

  private async fetchOpenSubtitles(params: URLSearchParams): Promise<OpenSubtitleResult[]> {
    const response = await fetch(`${this.API_URL}/opensubtitles/search?${params.toString()}`);
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const errorData = await response.json();
        message = errorData?.message || errorData?.error || message;
      } catch {}
      throw new Error(message);
    }

    const data = await response.json();
    return Array.isArray(data?.results) ? data.results : [];
  }

  async searchOpenSubtitles() {
    if (this.openSubtitlesLoading()) return;

    const query = this.buildOpenSubtitlesQuery(true);
    const tmdbId = this.id();
    if (!query && !tmdbId) {
      this.openSubtitlesError.set('No hay información suficiente para buscar subtítulos.');
      return;
    }

    this.openSubtitlesLoading.set(true);
    this.openSubtitlesError.set('');

    try {
      const params = new URLSearchParams();
      if (query) params.set('query', query);
      if (tmdbId) params.set('tmdbId', String(tmdbId));
      params.set('type', this.type());

      const season = this.season();
      const episode = this.episode();
      if (season !== null) params.set('season', String(season));
      if (episode !== null) params.set('episode', String(episode));

      const languageList = this.parseOpenSubtitlesLanguages(this.openSubtitlesLanguages());
      const languages = languageList.join(',');
      let usedLanguagesFilter = false;
      if (languages) {
        params.set('languages', languages);
        usedLanguagesFilter = true;
      }

      console.log('[OpenSubtitles] search start:', {
        query: params.get('query'),
        tmdbId: params.get('tmdbId'),
        type: params.get('type'),
        season: params.get('season'),
        episode: params.get('episode'),
        languages: params.get('languages'),
      });
      let results = await this.fetchOpenSubtitles(params);
      console.log('[OpenSubtitles] initial results:', results.length);

      if (results.length === 0) {
        const fallbackParams = new URLSearchParams(params);
        let fallbackUsedLanguages = usedLanguagesFilter;
        if (fallbackParams.has('tmdbId')) {
          fallbackParams.delete('tmdbId');
          console.log('[OpenSubtitles] retry without tmdbId:', {
            query: fallbackParams.get('query'),
            type: fallbackParams.get('type'),
            season: fallbackParams.get('season'),
            episode: fallbackParams.get('episode'),
            languages: fallbackParams.get('languages'),
          });
          results = await this.fetchOpenSubtitles(fallbackParams);
          fallbackUsedLanguages = fallbackParams.has('languages');
          console.log('[OpenSubtitles] results without tmdbId:', results.length);
        }

        if (results.length === 0) {
          const fallbackQuery = this.buildOpenSubtitlesQuery(false);
          if (fallbackQuery && fallbackQuery !== query) {
            fallbackParams.set('query', fallbackQuery);
            console.log('[OpenSubtitles] retry without year:', fallbackQuery);
            results = await this.fetchOpenSubtitles(fallbackParams);
            fallbackUsedLanguages = fallbackParams.has('languages');
            console.log('[OpenSubtitles] results without year:', results.length);
          }
        }

        if (results.length === 0 && fallbackParams.has('languages')) {
          fallbackParams.delete('languages');
          console.log('[OpenSubtitles] retry without languages:', fallbackParams.get('query'));
          results = await this.fetchOpenSubtitles(fallbackParams);
          fallbackUsedLanguages = fallbackParams.has('languages');
          console.log('[OpenSubtitles] results without languages:', results.length);
        }
        usedLanguagesFilter = fallbackUsedLanguages;
      }

      const seasonValue = this.season() ?? NaN;
      const episodeValue = this.episode() ?? NaN;
      const hasEpisodeTarget =
        this.type() === 'tv' &&
        Number.isFinite(seasonValue) &&
        Number.isFinite(episodeValue);
      let episodeFilterFailed = false;

      if (hasEpisodeTarget && results.length > 0) {
        const scored = results.map((result) => ({
          result,
          score: this.getOpenSubtitleMatchScore(result, seasonValue!, episodeValue!),
        }));
        const episodeMatches = scored
          .filter((item) => item.score >= 2)
          .map((item) => item.result);
        if (episodeMatches.length > 0) {
          results = episodeMatches;
        } else {
          results = [];
          episodeFilterFailed = true;
        }
      }

      const groupingLanguages = usedLanguagesFilter ? languageList : [];
      const grouped = this.buildOpenSubtitlesBuckets(results, groupingLanguages);
      const nextIndices: Record<string, number> = {};
      for (const key of grouped.order) {
        nextIndices[key] = 0;
      }
      this.openSubtitlesResults.set(results);
      this.openSubtitlesBuckets.set(grouped.buckets);
      this.openSubtitlesLanguageOrder.set(grouped.order);
      this.openSubtitlesLanguageIndices.set(nextIndices);

      if (grouped.order.length === 0) {
        if (episodeFilterFailed && hasEpisodeTarget) {
          const seasonTag = String(seasonValue).padStart(2, '0');
          const episodeTag = String(episodeValue).padStart(2, '0');
          this.openSubtitlesError.set(
            `No se encontraron subtítulos del episodio S${seasonTag}E${episodeTag}.`
          );
        } else {
          this.openSubtitlesError.set('No se encontraron subtítulos en OpenSubtitles.');
        }
      }
    } catch (error: any) {
      console.error('Error al buscar subtítulos externos:', error);
      this.openSubtitlesError.set(
        error?.message || 'No se pudo consultar OpenSubtitles en este momento.'
      );
      this.openSubtitlesResults.set([]);
      this.openSubtitlesBuckets.set({});
      this.openSubtitlesLanguageOrder.set([]);
      this.openSubtitlesLanguageIndices.set({});
    } finally {
      this.openSubtitlesLoading.set(false);
    }
  }

  downloadOpenSubtitle(result: OpenSubtitleResult) {
    if (!result?.fileId) return;
    const seasonValue = this.season() ?? NaN;
    const episodeValue = this.episode() ?? NaN;
    const hasEpisodeTarget =
      this.type() === 'tv' &&
      Number.isFinite(seasonValue) &&
      Number.isFinite(episodeValue);
    if (hasEpisodeTarget) {
      const score = this.getOpenSubtitleMatchScore(result, seasonValue!, episodeValue!);
      if (score < 2) {
        const seasonTag = String(seasonValue).padStart(2, '0');
        const episodeTag = String(episodeValue).padStart(2, '0');
        this.openSubtitlesError.set(
          `El subtítulo seleccionado no coincide con el episodio S${seasonTag}E${episodeTag}.`
        );
        return;
      }
    }

    const params = new URLSearchParams();
    if (result.format) params.set('format', result.format);
    if (result.fps) params.set('fps', String(result.fps));
    const query = params.toString();
    const url = `${this.API_URL}/opensubtitles/subtitle/${result.fileId}${query ? `?${query}` : ''}`;
    const existing = this.subtitleTracks();
    const existingIndex = existing.findIndex((track) => track.url === url);
    if (existingIndex >= 0) {
      this.selectSubtitleTrack(existingIndex);
      return;
    }

    const language = this.getLanguageName(result.language || 'und');
    const titleBits = [language];
    if (result.release) titleBits.push(result.release);

    const nextTrack: SubtitleTrack = {
      index: existing.length,
      name: `OpenSubtitles - ${titleBits.join(' - ')}`,
      language,
      url,
      isEmbedded: false,
      provider: 'opensubtitles',
      fileId: result.fileId,
    };

    const nextTracks = existing.concat(nextTrack);
    const newIndex = nextTracks.length - 1;
    this.subtitleTracks.set(nextTracks);
    this.openSubtitlesError.set('');
    setTimeout(() => this.selectSubtitleTrack(newIndex), 0);
  }

  formatOpenSubtitleTitle(result: OpenSubtitleResult) {
    const language = this.getLanguageName(result.language || 'und');
    const label = result.release || result.fileName || '';
    return [language, label].filter(Boolean).join(' - ');
  }

  formatOpenSubtitleMeta(result: OpenSubtitleResult) {
    const meta: string[] = [];
    if (result.format) meta.push(result.format.toUpperCase());
    if (result.downloads) meta.push(`${result.downloads} descargas`);
    if (result.hearingImpaired) meta.push('SDH');
    if (result.fps) meta.push(`${result.fps}fps`);
    return meta.join(' • ');
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

          if (progress % 10 === 0 && progress > 0 && progress !== this.lastProgressLog) {
            this.lastProgressLog = progress;
            this.pushLoadingLog(
              `Progreso ${progress}% | Peers ${info.numPeers || 0} | Velocidad ${Math.round(
                (info.downloadSpeed || 0) / 1024
              )} KB/s`
            );
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

  // Subtitle customization helpers
  private loadSubtitlePref<T>(key: string, defaultValue: T): T {
    try {
      const stored = localStorage.getItem(`pirateflix_subtitle_${key}`);
      if (stored === null) return defaultValue;
      if (typeof defaultValue === 'number') return Number(stored) as T;
      return stored as T;
    } catch {
      return defaultValue;
    }
  }

  private saveSubtitlePref(key: string, value: string | number) {
    try {
      localStorage.setItem(`pirateflix_subtitle_${key}`, String(value));
    } catch {}
  }

  setSubtitleSize(size: number) {
    this.subtitleSize.set(size);
    this.saveSubtitlePref('size', size);
    this.applySubtitleStyles();
  }

  setSubtitleColor(color: string) {
    this.subtitleColor.set(color);
    this.saveSubtitlePref('color', color);
    this.applySubtitleStyles();
  }

  setSubtitleBackground(bg: string) {
    this.subtitleBackground.set(bg);
    this.saveSubtitlePref('background', bg);
    this.applySubtitleStyles();
  }

  setSubtitleFont(font: string) {
    this.subtitleFont.set(font);
    this.saveSubtitlePref('font', font);
    this.applySubtitleStyles();
  }

  toggleSubtitleSettings() {
    this.showSubtitleSettings.set(!this.showSubtitleSettings());
  }

  toggleSettings() {
    const newValue = !this.showSettings();
    this.showSettings.set(newValue);
    
    if (newValue) {
      // Si se abre settings, mostrar controles y cancelar ocultamiento
      this.showControls.set(true);
      this.clearControlsHideTimer();
      
      // Auto-select appropriate tab
      if (this.audioTracks().length > 1) {
        this.settingsTab.set('audio');
      } else if (this.subtitleTracks().length > 0 || this.canSearchOpenSubtitles()) {
        this.settingsTab.set('subtitles');
      }
    } else {
      // Si se cierra settings, reiniciar el temporizador
      this.resetControlsHideTimer();
    }
  }

  setSettingsTab(tab: 'audio' | 'subtitles' | 'appearance') {
    this.settingsTab.set(tab);
  }

  selectAudioTrack(track: 'auto' | number) {
    this.selectedAudioTrack.set(track);
    // Trigger audio track change
    const event = { target: { value: track.toString() } } as unknown as Event;
    this.onAudioTrackChange(event);
  }

  selectSubtitleTrack(index: number) {
    this.selectedSubtitleTrack.set(index);
    const video = this.videoPlayer?.nativeElement;
    if (!video) return;
    
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = (i === index) ? 'showing' : 'hidden';
    }
  }

  adjustSubtitleSize(delta: number) {
    const newSize = Math.max(50, Math.min(200, this.subtitleSize() + delta));
    this.setSubtitleSize(newSize);
  }

  private subtitleStyleElement: HTMLStyleElement | null = null;

  applySubtitleStyles() {
    // Create or update a dynamic style element for ::cue styling
    // ::cue doesn't support CSS variables, so we need to inject actual values
    if (!this.subtitleStyleElement) {
      this.subtitleStyleElement = document.createElement('style');
      this.subtitleStyleElement.id = 'subtitle-custom-styles';
      document.head.appendChild(this.subtitleStyleElement);
    }

    const size = this.subtitleSize();
    const color = this.subtitleColor();
    const bg = this.subtitleBackground();
    const font = this.subtitleFont();

    // Calculate font size (base is roughly 1.5em for default video subtitles)
    const fontSize = (size / 100) * 1.5;

    this.subtitleStyleElement.textContent = `
      video::cue {
        font-size: ${fontSize}em !important;
        color: ${color} !important;
        background-color: ${bg} !important;
        font-family: ${font} !important;
        padding: 4px 8px;
        border-radius: 4px;
        text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
      }
    `;
  }

  private cleanupSubtitleStyles() {
    if (this.subtitleStyleElement) {
      this.subtitleStyleElement.remove();
      this.subtitleStyleElement = null;
    }
  }

  // Mostrar controles y reiniciar el temporizador de ocultamiento
  onUserActivity() {
    this.showControls.set(true);
    this.resetControlsHideTimer();
  }

  // Reiniciar el temporizador para ocultar controles
  private resetControlsHideTimer() {
    if (this.controlsHideTimer) {
      clearTimeout(this.controlsHideTimer);
    }
    
    // No ocultar si el panel de settings está abierto
    if (this.showSettings()) {
      return;
    }
    
    this.controlsHideTimer = setTimeout(() => {
      // Solo ocultar si no hay errores y el video está cargado
      if (!this.errorMessage() && this.videoSrc() && !this.showSettings()) {
        this.showControls.set(false);
      }
    }, this.CONTROLS_HIDE_DELAY);
  }

  // Limpiar el temporizador de controles
  private clearControlsHideTimer() {
    if (this.controlsHideTimer) {
      clearTimeout(this.controlsHideTimer);
      this.controlsHideTimer = null;
    }
  }

  ngOnDestroy() {
    // Limpiar interval de progreso
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    // Limpiar temporizador de controles
    this.clearControlsHideTimer();

    // Limpiar estilos de subtítulos
    this.cleanupSubtitleStyles();

    // Parar el video completamente
    this.stopPlaybackAndPolling();

    if (this.searchAbortController) {
      try {
        this.searchAbortController.abort();
      } catch {}
      this.searchAbortController = null;
    }

    // Quick-switch para limpiar recursos en el backend (no esperar)
    fetch(`${this.API_URL}/quick-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.playbackSession }),
    })
      .catch(() => {}); // Ignorar errores, el usuario ya se fue
  }
}
