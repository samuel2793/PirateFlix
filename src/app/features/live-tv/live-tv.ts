import { CommonModule } from '@angular/common';
import { Capacitor } from '@capacitor/core';
import { NodeJS } from '@choreruiz/capacitor-node-js';
import { Cast, type CastCapabilities, type LoadMediaRequest } from '@strasberry/capacitor-cast';
import {
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import * as dashjs from 'dashjs';
import Hls from 'hls.js';
import { Subject, takeUntil } from 'rxjs';

import { LIVE_CHANNELS } from '../../core/config/live-channels';
import { LiveChannel, LiveChannelCategory, LiveStream } from '../../core/models/live-channel';
import { LiveStreamResolverService } from '../../core/services/live-stream-resolver.service';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';

type PlayerStatus = 'idle' | 'loading' | 'playing' | 'error';
type ActivePlaybackKind = 'dash' | 'hls' | 'native-hls' | 'mpegts' | 'remux' | null;
type CastSupport = 'none' | 'remote-playback' | 'airplay' | 'capacitor-cast';
type LiveCatalogSourceId = 'iptv-org';

interface AirPlayCapableVideoElement extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
}

interface CastNotice {
  message: string;
  tone: 'info' | 'error';
}

interface CastMediaCandidate {
  url: string;
  contentType: string;
  title: string;
  subtitle: string;
  posterUrl?: string;
}

interface LiveCatalogSourceCard {
  id: LiveCatalogSourceId;
  name: string;
  description: string;
  icon: string;
}

interface IptvOrgCatalogResponse {
  ok: boolean;
  source: LiveCatalogSourceId;
  playlistUrl: string;
  fetchedAt: number;
  cached: boolean;
  channels: LiveChannel[];
  error?: string;
}

@Component({
  selector: 'app-live-tv',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, TranslatePipe],
  templateUrl: './live-tv.html',
  styleUrl: './live-tv.scss',
})
export class LiveTvComponent implements OnDestroy {
  private readonly LIVE_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  private readonly IPTV_ORG_VISIBLE_BATCH_SIZE = 120;
  private readonly SETTINGS_STORAGE_KEY = 'pirateflix_settings';
  private readonly isNativePlatform = Capacitor.isNativePlatform();
  private readonly API_URL = (() => {
    if (Capacitor.isNativePlatform()) {
      return 'http://127.0.0.1:3001/api';
    }
    if (typeof window === 'undefined') {
      return 'http://127.0.0.1:3001/api';
    }
    const hostname = window.location.hostname || 'localhost';
    const isLocalhost =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    return isLocalhost ? 'http://localhost:3001/api' : `http://${hostname}:3001/api`;
  })();

  private readonly BACKEND_BASE_URL = this.API_URL.replace(/\/api$/, '');
  private readonly BACKEND_HEALTH_BASE_URLS = (() => {
    const baseUrls = new Set<string>([this.BACKEND_BASE_URL]);
    if (this.isNativePlatform) {
      baseUrls.add('http://127.0.0.1:3001');
      baseUrls.add('http://localhost:3001');
    }
    return Array.from(baseUrls);
  })();
  private backendReadyPromise: Promise<void> | null = null;

  private debugLive(message: string, details?: Record<string, unknown>) {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    console.log(`[LiveTV] ${message}${suffix}`);
  }

  private async ensureBackendReady(): Promise<void> {
    if (this.backendReadyPromise) {
      return this.backendReadyPromise;
    }

    this.backendReadyPromise = this.isNativePlatform
      ? this.startEmbeddedBackend()
      : this.waitForBackendHealth(1500);

    try {
      await this.backendReadyPromise;
    } catch (error) {
      this.backendReadyPromise = null;
      throw error;
    }
  }

  private async startEmbeddedBackend(): Promise<void> {
    this.debugLive('startEmbeddedBackend.begin');
    try {
      const startPromise = NodeJS.start({ nodeDir: 'nodejs-project' });

      await Promise.race([
        startPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (!message.includes('already been started')) {
        console.error('No se pudo iniciar NodeJS embebido desde Live TV:', error);
        throw error;
      }
    }

    await this.waitForBackendHealth();
    this.debugLive('startEmbeddedBackend.ready');
  }

  private async waitForBackendHealth(timeoutMs = 12000): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      for (const baseUrl of this.BACKEND_HEALTH_BASE_URLS) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);

        try {
          const response = await fetch(`${baseUrl}/health`, {
            cache: 'no-store',
            signal: controller.signal,
          });

          if (response.ok) {
            this.debugLive('backend.health.ok', { baseUrl, status: response.status });
            return;
          }
        } catch {
          // Backend aún no disponible.
        } finally {
          clearTimeout(timeout);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error('Backend Node no disponible para Live TV');
  }

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly streamResolver = inject(LiveStreamResolverService);
  private readonly destroy$ = new Subject<void>();
  private readonly builtinChannels = LIVE_CHANNELS;
  private readonly remuxFallbackStreamKeys = new Set<string>();
  private dash: any = null;
  private hls: Hls | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private activeBackendPlaybackId: string | null = null;
  private attachToken = 0;
  private networkRetries = 0;
  private mediaRetries = 0;
  private streamLoadToken = 0;
  private probeToken = 0;
  private routeStateToken = 0;
  private iptvOrgFetchToken = 0;
  private activePlaybackKind: ActivePlaybackKind = null;
  private ignoreNativeVideoErrorsUntil = 0;
  private failedStreamIndices = signal<Set<number>>(new Set());
  private readonly mobileViewport = signal(false);
  private readonly castSupport = signal<CastSupport>('none');
  private castNoticeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly pageHideListener = () => {
    this.stopActiveBackendPlayback(true);
  };
  private castInitialized = false;
  private castListenersRegistered = false;
  private activeCastMedia: CastMediaCandidate | null = null;
  private castCapabilitiesCache: CastCapabilities | null = null;

  readonly sourceCards: readonly LiveCatalogSourceCard[] = [
    {
      id: 'iptv-org',
      name: 'iptv-org',
      description: 'Open the public global IPTV directory maintained by iptv-org.',
      icon: 'travel_explore',
    },
  ];
  readonly categories: { value: 'all' | LiveChannelCategory; label: string; icon: string }[] = [
    { value: 'all', label: 'All channels', icon: 'apps' },
    { value: 'national', label: 'National', icon: 'public' },
    { value: 'news', label: 'News', icon: 'newspaper' },
    { value: 'sports', label: 'Sports', icon: 'sports_soccer' },
    { value: 'kids', label: 'Kids', icon: 'child_care' },
  ];

  query = signal('');
  activeCategory = signal<'all' | LiveChannelCategory>('all');
  activeSource = signal<LiveCatalogSourceId | null>(null);
  iptvOrgChannels = signal<LiveChannel[]>([]);
  catalogLoading = signal(false);
  catalogError = signal('');
  catalogFetchedAt = signal<number | null>(null);
  selectedChannel = signal<LiveChannel | null>(null);
  selectedStreamIndex = signal(0);
  playerStatus = signal<PlayerStatus>('idle');
  playerMessage = signal('');
  qualityLevels = signal<{ index: number; label: string }[]>([]);
  selectedQuality = signal(-1);
  failedLogos = signal<Set<string>>(new Set());
  favoriteIds = signal<Set<string>>(this.loadFavorites());
  castRequestInFlight = signal(false);
  castNotice = signal<CastNotice | null>(null);
  visibleRegularChannelCount = signal(this.IPTV_ORG_VISIBLE_BATCH_SIZE);

  channels = computed(() =>
    this.activeSource() === 'iptv-org' ? this.iptvOrgChannels() : this.builtinChannels
  );

  isSourceMode = computed(() => this.activeSource() !== null);

  heroTitle = computed(() =>
    this.isSourceMode() ? 'iptv-org' : 'Live channels'
  );

  heroDescription = computed(() =>
    this.isSourceMode()
      ? 'Public global IPTV playlist mirrored from the iptv-org project.'
      : 'Free live broadcasts from Spain and other countries.'
  );

  channelGroupTitle = computed(() => {
    if (this.isSourceMode()) return 'iptv-org channels';
    return this.activeCategory() === 'all'
      ? 'All channels'
      : this.categoryLabel(this.activeCategory());
  });

  filteredChannels = computed(() => {
    const query = this.normalize(this.query());
    const category = this.activeCategory();
    return this.channels().filter((channel) => {
      if (!this.isSourceMode() && category !== 'all' && channel.category !== category) return false;
      if (!query) return true;
      return this.normalize(
        `${channel.name} ${channel.countryCode} ${channel.languages.join(' ')} ${channel.epgId ?? ''} ${channel.groupTitle ?? ''} ${channel.sourceLabel ?? ''}`
      ).includes(query);
    });
  });

  favoriteChannels = computed(() => {
    const favorites = this.favoriteIds();
    return this.filteredChannels().filter((channel) => favorites.has(channel.id));
  });

  regularChannels = computed(() => {
    const favorites = this.favoriteIds();
    return this.filteredChannels().filter((channel) => !favorites.has(channel.id));
  });

  displayedRegularChannels = computed(() =>
    this.regularChannels().slice(0, this.visibleRegularChannelCount())
  );

  canLoadMoreRegularChannels = computed(
    () => this.displayedRegularChannels().length < this.regularChannels().length
  );

  orderedSelectedStreams = computed(() => {
    const channel = this.selectedChannel();
    if (!channel) return [];

    const failedIndices = this.failedStreamIndices();
    const ordered = channel.streams.map((stream, index) => ({
      index,
      stream,
      unavailable: failedIndices.has(index),
    }));

    return [
      ...ordered.filter((entry) => !entry.unavailable),
      ...ordered.filter((entry) => entry.unavailable),
    ];
  });

  canShowCastAction = computed(() => {
    if (!this.mobileViewport()) return false;
    if (!this.selectedChannel()) return false;
    return this.activePlaybackKind !== 'mpegts' && this.activePlaybackKind !== 'remux';
  });

  @ViewChild('liveVideo')
  set liveVideo(ref: ElementRef<HTMLVideoElement> | undefined) {
    const nextVideoElement = ref?.nativeElement ?? null;
    const videoElementChanged = this.videoElement !== nextVideoElement;
    this.videoElement = nextVideoElement;
    this.refreshCastSupport();
    if (videoElementChanged && this.videoElement && this.selectedChannel()) {
      const token = ++this.attachToken;
      setTimeout(() => {
        if (token === this.attachToken) void this.loadCurrentStream();
      });
    }
  }

  constructor() {
    this.observeMobileViewport();
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.pageHideListener);
      window.addEventListener('beforeunload', this.pageHideListener);
    }
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      void this.syncRouteState(params.get('sourceId'), params.get('channelId'));
    });
  }

  openChannel(channel: LiveChannel) {
    void this.router.navigate(this.channelRoute(channel.id));
  }

  openSourceCatalog(sourceId: LiveCatalogSourceId) {
    void this.router.navigate(['/live/source', sourceId]);
  }

  closePlayer() {
    this.destroyPlayer();
    void this.router.navigate(this.baseRoute());
  }

  async reloadSourceCatalog() {
    if (this.activeSource() !== 'iptv-org') return;
    await this.fetchIptvOrgCatalog(true);
  }

  castButtonLabel() {
    if (this.castSupport() === 'airplay') return 'AirPlay';
    if (this.castSupport() === 'capacitor-cast') return 'Chromecast';
    return 'Cast to TV';
  }

  setCategory(category: 'all' | LiveChannelCategory) {
    this.activeCategory.set(category);
    this.resetVisibleChannels();
  }

  updateQuery(value: string) {
    this.query.set(value);
    this.resetVisibleChannels();
  }

  sourceCardChannelCount(sourceId: LiveCatalogSourceId) {
    if (sourceId !== 'iptv-org') return 0;
    return this.iptvOrgChannels().length;
  }

  loadMoreChannels() {
    this.visibleRegularChannelCount.update((current) => current + this.IPTV_ORG_VISIBLE_BATCH_SIZE);
  }

  channelMetaLabel(channel: LiveChannel) {
    return channel.groupTitle || this.categoryLabel(channel.category);
  }

  channelOriginLabel(channel: LiveChannel, stream?: LiveStream | null) {
    const streamOriginLabel = String(stream?.originLabel || '').trim();
    if (streamOriginLabel) {
      return streamOriginLabel;
    }

    const channelOriginLabel = String(channel.originLabel || '').trim();
    if (channelOriginLabel) {
      return channelOriginLabel;
    }

    if (channel.sourceId !== 'iptv-org') {
      return channel.countryCode;
    }

    const countryCode = String(channel.countryCode || '').trim().toUpperCase();
    if (countryCode && countryCode !== 'INT' && countryCode !== 'UND') {
      try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) || countryCode;
      } catch {
        return countryCode;
      }
    }

    const languageCode = String(channel.languages[0] || '').trim().toLowerCase();
    if (languageCode && languageCode !== 'und') {
      try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(languageCode) || languageCode;
      } catch {
        return languageCode;
      }
    }

    return 'International';
  }

  switchStream(index: number) {
    if (this.isStreamUnavailable(index)) return;
    if (index === this.selectedStreamIndex() && this.playerStatus() !== 'error') return;
    this.selectedStreamIndex.set(index);
    void this.loadCurrentStream();
  }

  retry() {
    this.probeToken += 1;
    this.clearFailedStreams();
    const stream = this.selectedChannel()?.streams[this.selectedStreamIndex()];
    if (stream) {
      this.streamResolver.invalidate(stream);
      this.remuxFallbackStreamKeys.delete(this.streamPlaybackKey(stream, this.selectedChannel()?.id));
    }
    const channel = this.selectedChannel();
    if (channel) void this.probeStreamsInBackground(channel);
    void this.loadCurrentStream();
  }

  setQuality(index: number) {
    this.selectedQuality.set(index);
    if (this.hls) this.hls.currentLevel = index;
    if (this.dash && index >= 0 && typeof this.dash.setQualityFor === 'function') {
      this.dash.setQualityFor('video', index);
    }
  }

  toggleFavorite(channel: LiveChannel, event?: Event) {
    event?.stopPropagation();
    const favorites = new Set(this.favoriteIds());
    if (favorites.has(channel.id)) favorites.delete(channel.id);
    else favorites.add(channel.id);
    this.favoriteIds.set(favorites);
    try {
      localStorage.setItem('pirateflix_live_favorites', JSON.stringify([...favorites]));
    } catch {}
  }

  isFavorite(channel: LiveChannel) {
    return this.favoriteIds().has(channel.id);
  }

  markLogoFailed(channel: LiveChannel) {
    const failed = new Set(this.failedLogos());
    failed.add(channel.id);
    this.failedLogos.set(failed);
  }

  categoryLabel(category: 'all' | LiveChannelCategory) {
    return this.categories.find((item) => item.value === category)?.label ?? category;
  }

  isStreamUnavailable(index: number) {
    return this.failedStreamIndices().has(index);
  }

  onVideoPlaying() {
    this.playerStatus.set('playing');
    this.playerMessage.set('');
  }

  onVideoWaiting() {
    if (this.playerStatus() !== 'error') this.playerStatus.set('loading');
  }

  onNativeVideoError() {
    const mediaError = this.videoElement?.error;
    this.debugLive('nativeVideo.error', {
      code: mediaError?.code ?? null,
      message: mediaError?.message ?? null,
      activePlaybackKind: this.activePlaybackKind,
    });
    if (Date.now() < this.ignoreNativeVideoErrorsUntil) return;
    if (this.activePlaybackKind === 'mpegts') return;
    if (!this.hls) this.tryNextStream('This broadcast could not be played.');
  }

  private async syncRouteState(sourceIdParam: string | null, channelId: string | null) {
    const routeToken = ++this.routeStateToken;
    const sourceId = sourceIdParam === 'iptv-org' ? sourceIdParam : null;

    if (sourceIdParam && !sourceId) {
      void this.router.navigate(['/live'], { replaceUrl: true });
      return;
    }

    this.activeSource.set(sourceId);
    this.resetVisibleChannels();
    if (sourceId) {
      this.activeCategory.set('all');
      const loaded = await this.fetchIptvOrgCatalog(false);
      if (routeToken !== this.routeStateToken) return;
      if (!loaded) {
        this.applyRouteSelection(null);
        return;
      }
    } else {
      this.catalogError.set('');
      this.catalogLoading.set(false);
    }

    const channel = channelId
      ? this.channels().find((candidate) => candidate.id === channelId) ?? null
      : null;

    if (channelId && !channel) {
      void this.router.navigate(this.baseRoute(sourceId), { replaceUrl: true });
      return;
    }

    this.applyRouteSelection(channel);
  }

  private async fetchIptvOrgCatalog(forceRefresh: boolean) {
    if (!forceRefresh && this.iptvOrgChannels().length > 0) {
      this.catalogError.set('');
      return true;
    }

    const fetchToken = ++this.iptvOrgFetchToken;
    this.catalogLoading.set(true);
    this.catalogError.set('');

    try {
      await this.ensureBackendReady();
      const response = await fetch(
        `${this.API_URL}/live/iptv-org/channels${forceRefresh ? '?refresh=true' : ''}`,
        { cache: 'no-store' }
      );
      const payload = (await response.json().catch(() => null)) as IptvOrgCatalogResponse | null;
      if (!response.ok || !payload?.ok || !Array.isArray(payload.channels)) {
        throw new Error(payload?.error || 'Could not load the IPTV-org catalog.');
      }
      if (fetchToken !== this.iptvOrgFetchToken) return false;

      this.iptvOrgChannels.set(payload.channels);
      this.catalogFetchedAt.set(Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : Date.now());
      this.resetVisibleChannels();
      return true;
    } catch (error) {
      console.error('Could not load IPTV-org catalog.', error);
      if (fetchToken === this.iptvOrgFetchToken) {
        this.catalogError.set('Could not load the IPTV-org catalog.');
      }
      return false;
    } finally {
      if (fetchToken === this.iptvOrgFetchToken) {
        this.catalogLoading.set(false);
      }
    }
  }

  private applyRouteSelection(channel: LiveChannel | null) {
    if (this.selectedChannel()?.id === channel?.id) return;
    this.destroyPlayer();
    this.probeToken += 1;
    this.remuxFallbackStreamKeys.clear();
    this.clearFailedStreams();
    this.selectedStreamIndex.set(0);
    this.selectedChannel.set(channel);
    this.playerStatus.set(channel ? 'loading' : 'idle');
    this.playerMessage.set('');
    if (channel) void this.probeStreamsInBackground(channel);
  }

  private baseRoute(sourceId = this.activeSource()) {
    return sourceId ? ['/live/source', sourceId] : ['/live'];
  }

  private channelRoute(channelId: string, sourceId = this.activeSource()) {
    return sourceId ? ['/live/source', sourceId, channelId] : ['/live', channelId];
  }

  private resetVisibleChannels() {
    if (this.activeSource() !== 'iptv-org') {
      this.visibleRegularChannelCount.set(this.builtinChannels.length);
      return;
    }

    this.visibleRegularChannelCount.set(this.IPTV_ORG_VISIBLE_BATCH_SIZE);
  }

  private async startNativeCastSession() {
    const castMedia = this.activeCastMedia;
    if (!castMedia) {
      this.showCastNotice('This broadcast cannot be cast from the current mobile player.', 'error', 4200);
      return;
    }

    await this.ensureNativeCastReady();

    const capabilities = this.castCapabilitiesCache ?? (await Cast.getCapabilities());
    this.castCapabilitiesCache = capabilities;

    if (!capabilities.isSupported || !capabilities.canShowDevicePicker) {
      this.showCastNotice('Chromecast is not available on this device.', 'error', 4200);
      return;
    }

    this.showCastNotice('Opening cast menu...', 'info', 2400);
    const session = await Cast.getSession();
    if (!session.session) {
      await Cast.showDevicePicker();
    }

    const request: LoadMediaRequest = {
      url: castMedia.url,
      contentType: castMedia.contentType,
      title: castMedia.title,
      subtitle: castMedia.subtitle,
      posterUrl: castMedia.posterUrl,
      autoplay: true,
      streamType: 'LIVE',
    };
    await Cast.loadMedia(request);
    this.showCastNotice('Casting started on your TV.', 'info', 4200);
  }

  async openCastPicker() {
    if (!this.canShowCastAction() || this.castRequestInFlight()) return;
    const video = this.videoElement as AirPlayCapableVideoElement | null;

    this.castRequestInFlight.set(true);
    try {
      if (this.castSupport() === 'capacitor-cast') {
        await this.startNativeCastSession();
        return;
      }

      if (!video) {
        this.showCastNotice('Could not start casting.', 'error', 4200);
        return;
      }

      this.showCastNotice('Opening cast menu...', 'info', 2200);

      if (this.castSupport() === 'airplay' && typeof video.webkitShowPlaybackTargetPicker === 'function') {
        video.webkitShowPlaybackTargetPicker();
        return;
      }

      if (
        this.castSupport() === 'remote-playback' &&
        'remote' in video &&
        typeof video.remote?.prompt === 'function'
      ) {
        await video.remote.prompt();
        this.showCastNotice('Choose a device to continue casting.', 'info', 3200);
        return;
      }

      this.showCastNotice(
        'Casting is not available on this mobile device.',
        'error',
        4200
      );
    } catch (error) {
      console.warn('Could not open cast picker.', error);
      this.showCastNotice('Could not start casting.', 'error', 4200);
    } finally {
      this.castRequestInFlight.set(false);
    }
  }

  private async loadCurrentStream() {
    const channel = this.selectedChannel();
    const video = this.videoElement;
    const stream = channel?.streams[this.selectedStreamIndex()];
    if (!channel || !video || !stream) return;
    const loadToken = ++this.streamLoadToken;

    this.stopActiveBackendPlayback();
    this.destroyHlsOnly();
    this.networkRetries = 0;
    this.mediaRetries = 0;
    this.playerStatus.set('loading');
    this.playerMessage.set('Connecting to live broadcast...');
    this.qualityLevels.set([]);
    this.selectedQuality.set(-1);
    this.activePlaybackKind = null;
    this.ignoreNativeVideoErrorsUntil = Date.now() + 1200;
    this.activeCastMedia = null;
    this.refreshCastSupport();

    video.pause();
    video.removeAttribute('src');
    video.load();

    let streamUrl: string;
    try {
      streamUrl = await this.streamResolver.resolve(stream);
      this.debugLive('stream.resolved', { channelId: channel.id, index: this.selectedStreamIndex(), streamUrl });
    } catch (error) {
      console.error('Could not resolve live stream URL.', error);
      if (loadToken === this.streamLoadToken) {
        this.tryNextStream('Could not obtain a current broadcast URL.');
      }
      return;
    }
    if (
      loadToken !== this.streamLoadToken ||
      video !== this.videoElement ||
      channel.id !== this.selectedChannel()?.id
    ) {
      return;
    }

    const streamKind = this.detectStreamKind(stream, streamUrl);
    this.debugLive('stream.kind', {
      channelId: channel.id,
      index: this.selectedStreamIndex(),
      streamKind,
      format: stream.format ?? null,
    });

    if (this.shouldPreflightPlayback(channel, streamKind)) {
      this.playerMessage.set('Checking broadcast status...');
      const isAvailable = await this.probeStreamAvailability(channel, stream, streamUrl, streamKind);
      if (
        loadToken !== this.streamLoadToken ||
        video !== this.videoElement ||
        channel.id !== this.selectedChannel()?.id
      ) {
        return;
      }
      if (!isAvailable) {
        this.tryNextStream('The broadcast is unavailable or blocked by its provider.');
        return;
      }
      this.playerMessage.set('Connecting to live broadcast...');
    }

    if (streamKind === 'dash') {
      this.activePlaybackKind = 'dash';
      this.updateActiveCastMedia(streamUrl, this.activePlaybackKind, stream);
      this.refreshCastSupport();
      if (typeof (dashjs.MediaPlayer as any).isSupported === 'function' && !(dashjs.MediaPlayer as any).isSupported()) {
        this.playerStatus.set('error');
        this.playerMessage.set('DASH playback is not supported on this device.');
        return;
      }

      const player = dashjs.MediaPlayer().create() as any;
      this.dash = player;
      if (typeof player.updateSettings === 'function') {
        player.updateSettings({
          streaming: {
            text: {
              defaultEnabled: false,
            },
          },
        });
      }
      const drmConfig = this.getDrmConfig(stream);
      if (drmConfig && typeof player.setProtectionData === 'function') {
        player.setProtectionData(drmConfig);
      }
      player.initialize(video, streamUrl, true);
      player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        if (loadToken !== this.streamLoadToken || this.dash !== player) return;
        const tracks: Array<{ height?: number; bitrate?: number }> =
          (typeof player.getBitrateInfoListFor === 'function'
            ? (player.getBitrateInfoListFor('video') as Array<{ height?: number; bitrate?: number }> | undefined)
            : undefined) ??
          [];
        this.qualityLevels.set(
          tracks.map((track: { height?: number; bitrate?: number }, index: number) => ({
            index,
            label: track.height ? `${track.height}p` : `${Math.round((track.bitrate || 0) / 1000)} kbps`,
          }))
        );
        this.playerMessage.set('');
      });
      const handleDashError = (event: unknown) => {
        if (loadToken !== this.streamLoadToken || this.dash !== player) return;
        const serialized = this.stringifyDashError(event);
        console.error('DASH playback error.', event);

        if (this.isTransientDashError(serialized)) {
          return;
        }
        if (this.isDrmDashError(serialized)) {
          this.tryNextStream('This broadcast is DRM-protected and cannot be played without a license.');
          return;
        }
        this.tryNextStream('The broadcast is unavailable or blocked by its provider.');
      };
      player.on(dashjs.MediaPlayer.events.ERROR, handleDashError);
      player.on(dashjs.MediaPlayer.events.PLAYBACK_ERROR, handleDashError);
      void video.play().catch(() => {
        this.playerMessage.set('Press play to start the broadcast.');
      });
      return;
    }

    if (streamKind === 'mpegts') {
      await this.ensureBackendReady();
      if (
        loadToken !== this.streamLoadToken ||
        video !== this.videoElement ||
        channel.id !== this.selectedChannel()?.id
      ) {
        this.debugLive('mpegts.cancelled.afterBackendReady', { channelId: channel.id, index: this.selectedStreamIndex() });
        return;
      }
      this.activePlaybackKind = 'mpegts';
      this.updateActiveCastMedia(null, this.activePlaybackKind, stream);
      this.refreshCastSupport();
      this.ignoreNativeVideoErrorsUntil = Date.now() + 2500;
      const playbackId = this.createBackendPlaybackId(channel, stream);
      const playbackUrl = this.buildPlaybackUrl(channel, stream, streamUrl, false, playbackId);
      this.debugLive('mpegts.playbackUrl', { playbackUrl });
      if (this.isNativePlatform) {
        this.debugLive('mpegts.head.begin', { playbackUrl });
        const isReachable = await this.verifyNativeRemuxUrl(playbackUrl);
        if (
          loadToken !== this.streamLoadToken ||
          video !== this.videoElement ||
          channel.id !== this.selectedChannel()?.id
        ) {
          this.debugLive('mpegts.cancelled.afterHead', { channelId: channel.id, index: this.selectedStreamIndex() });
          return;
        }
        if (!isReachable) {
          this.debugLive('mpegts.head.unreachable', { playbackUrl });
          this.tryNextStream('The local playback bridge is unavailable on this device.');
          return;
        }
      }
      this.activeBackendPlaybackId = playbackId;
      this.debugLive('mpegts.assignVideoSrc', { playbackUrl });
      video.src = playbackUrl;
      video.load();
      void video.play().catch(() => {
        this.playerMessage.set('Press play to start the broadcast.');
      });
      return;
    }

    const canUseNativeHls = this.shouldUseNativeHls(video, channel);
    if (
      streamKind === 'hls' &&
      this.shouldUseServerRemux(channel, canUseNativeHls, stream)
    ) {
      await this.ensureBackendReady();
      if (
        loadToken !== this.streamLoadToken ||
        video !== this.videoElement ||
        channel.id !== this.selectedChannel()?.id
      ) {
        return;
      }

      this.activePlaybackKind = 'remux';
      this.updateActiveCastMedia(null, this.activePlaybackKind, stream);
      this.refreshCastSupport();
      this.ignoreNativeVideoErrorsUntil = Date.now() + 2500;
      const playbackId = this.createBackendPlaybackId(channel, stream);
      const playbackUrl = this.buildPlaybackUrl(channel, stream, streamUrl, true, playbackId);
      this.activeBackendPlaybackId = playbackId;
      this.debugLive('remux.assignVideoSrc', {
        playbackUrl,
        fallback: this.shouldUseRemuxFallback(channel, stream),
      });
      video.src = playbackUrl;
      video.load();
      void video.play().catch(() => {
        this.playerMessage.set('Press play to start the broadcast.');
      });
      return;
    }
    if (canUseNativeHls) {
      this.activePlaybackKind = 'native-hls';
      this.updateActiveCastMedia(streamUrl, this.activePlaybackKind, stream);
      this.refreshCastSupport();
      this.ignoreNativeVideoErrorsUntil = Date.now() + 1500;
      this.debugLive('nativeHls.assignVideoSrc', { streamUrl });
      video.src = streamUrl;
      video.load();
      void video.play().catch(() => {
        this.playerMessage.set('Press play to start the broadcast.');
      });
      return;
    }

    if (!Hls.isSupported()) {
      this.playerStatus.set('error');
      this.playerMessage.set('HLS playback is not supported on this device.');
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      backBufferLength: 30,
    });
    this.activePlaybackKind = 'hls';
    this.updateActiveCastMedia(streamUrl, this.activePlaybackKind, stream);
    this.refreshCastSupport();
    this.hls = hls;
    this.debugLive('hls.attachMedia', { streamUrl });
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(this.buildPlaybackUrl(channel, stream, streamUrl)));
    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      const levels = data.levels.map((level, index) => ({
        index,
        label: level.height ? `${level.height}p` : `${Math.round((level.bitrate || 0) / 1000)} kbps`,
      }));
      this.qualityLevels.set(levels);
      this.playerMessage.set('');
      void video.play().catch(() => {
        this.playerMessage.set('Press play to start the broadcast.');
      });
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      this.debugLive('hls.error', {
        channelId: channel.id,
        fatal: data.fatal,
        type: data.type,
        details: data.details,
        error: data.error instanceof Error ? data.error.message : String(data.error ?? ''),
      });
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.networkRetries < 2) {
        this.networkRetries += 1;
        this.playerMessage.set('Reconnecting to the broadcast...');
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.mediaRetries < 1) {
        this.mediaRetries += 1;
        this.playerMessage.set('Recovering video playback...');
        hls.recoverMediaError();
        return;
      }
      if (this.tryBackendRemuxFallback(channel, stream, data)) {
        return;
      }
      this.tryNextStream('The broadcast is unavailable or blocked by its provider.');
    });
  }

  private tryNextStream(reason: string) {
    const channel = this.selectedChannel();
    if (!channel) return;
    this.markStreamUnavailable(this.selectedStreamIndex());
    const nextIndex = channel.streams.findIndex((_, index) => !this.failedStreamIndices().has(index));
    if (nextIndex >= 0) {
      this.selectedStreamIndex.set(nextIndex);
      this.playerMessage.set('Trying an alternative broadcast...');
      void this.loadCurrentStream();
      return;
    }
    this.destroyHlsOnly();
    this.playerStatus.set('error');
    this.playerMessage.set(reason);
  }

  private destroyHlsOnly() {
    // On stream switches we only detach the current player; full teardown happens
    // in destroyPlayer() to avoid closing EME sessions while a new load is starting.
    this.dash = null;
    this.activePlaybackKind = null;
    this.refreshCastSupport();
    this.hls?.destroy();
    this.hls = null;
  }

  private destroyPlayer() {
    this.attachToken += 1;
    this.streamLoadToken += 1;
    this.probeToken += 1;
    this.stopActiveBackendPlayback();
    try {
      this.dash?.destroy();
    } catch (error) {
      console.warn('Could not destroy DASH player cleanly.', error);
    }
    this.destroyHlsOnly();
    if (this.videoElement) {
      this.ignoreNativeVideoErrorsUntil = Date.now() + 1200;
      this.videoElement.pause();
      (this.videoElement as HTMLVideoElement & { srcObject?: unknown }).srcObject = null;
      this.videoElement.src = '';
      this.videoElement.removeAttribute('src');
      this.videoElement.load();
    }
    this.qualityLevels.set([]);
    this.castRequestInFlight.set(false);
    this.activeCastMedia = null;
    this.clearCastNotice();
    this.refreshCastSupport();
  }

  private async ensureNativeCastReady() {
    if (!this.isNativePlatform) return;

    if (!this.castInitialized) {
      await Cast.initialize();
      this.castInitialized = true;
    }

    if (!this.castListenersRegistered) {
      await Cast.addListener('castError', (event) => {
        this.showCastNotice(event.message || 'Could not start casting.', 'error', 4200);
      });
      this.castListenersRegistered = true;
    }
  }

  private showCastNotice(message: string, tone: 'info' | 'error', durationMs = 3200) {
    this.castNotice.set({ message, tone });
    if (this.castNoticeTimeoutId) clearTimeout(this.castNoticeTimeoutId);
    this.castNoticeTimeoutId = setTimeout(() => {
      this.castNotice.set(null);
      this.castNoticeTimeoutId = null;
    }, durationMs);
  }

  private clearCastNotice() {
    if (this.castNoticeTimeoutId) {
      clearTimeout(this.castNoticeTimeoutId);
      this.castNoticeTimeoutId = null;
    }
    this.castNotice.set(null);
  }

  private observeMobileViewport() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(max-width: 900px), (pointer: coarse)');
    const syncViewport = () => {
      this.mobileViewport.set(mediaQuery.matches);
      this.refreshCastSupport();
    };

    syncViewport();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncViewport);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(syncViewport);
    }
  }

  private refreshCastSupport() {
    const video = this.videoElement as AirPlayCapableVideoElement | null;
    if (
      !this.mobileViewport() ||
      this.activePlaybackKind === 'mpegts' ||
      this.activePlaybackKind === 'remux'
    ) {
      this.castSupport.set('none');
      return;
    }

    if (this.isNativePlatform) {
      this.castSupport.set('capacitor-cast');
      return;
    }

    if (!video) {
      this.castSupport.set('none');
      return;
    }

    if (typeof video.webkitShowPlaybackTargetPicker === 'function') {
      this.castSupport.set('airplay');
      return;
    }

    if ('remote' in video && typeof video.remote?.prompt === 'function') {
      this.castSupport.set('remote-playback');
      return;
    }

    this.castSupport.set('none');
  }

  private updateActiveCastMedia(streamUrl: string | null, streamKind: ActivePlaybackKind, stream?: LiveStream | null) {
    const channel = this.selectedChannel();
    if (!channel || !streamUrl || !stream) {
      this.activeCastMedia = null;
      return;
    }

    const contentType = this.getCastContentType(streamKind, streamUrl);
    if (!contentType) {
      this.activeCastMedia = null;
      return;
    }

    this.activeCastMedia = {
      url: streamUrl,
      contentType,
      title: channel.name,
      subtitle: `${this.categoryLabel(channel.category)} · ${this.channelOriginLabel(channel, stream)}`,
      posterUrl: channel.logoUrl,
    };
  }

  private getCastContentType(streamKind: ActivePlaybackKind, streamUrl: string) {
    if (streamKind === 'dash') return 'application/dash+xml';
    if (streamKind === 'hls' || streamKind === 'native-hls') return 'application/x-mpegURL';
    if (/\.mp4($|\?)/i.test(streamUrl)) return 'video/mp4';
    return null;
  }

  private shouldUseRemuxFallback(channel: LiveChannel, stream: LiveStream) {
    return this.remuxFallbackStreamKeys.has(this.streamPlaybackKey(stream, channel.id));
  }

  private shouldUseServerRemux(
    channel: LiveChannel,
    canUseNativeHls: boolean,
    stream: LiveStream
  ) {
    if (this.shouldUseRemuxFallback(channel, stream)) return true;
    return channel.sourceId === 'iptv-org' && !canUseNativeHls;
  }

  private tryBackendRemuxFallback(channel: LiveChannel, stream: LiveStream, errorData?: unknown) {
    if (channel.sourceId !== 'iptv-org') return false;
    const key = this.streamPlaybackKey(stream, channel.id);
    if (this.remuxFallbackStreamKeys.has(key)) return false;

    this.remuxFallbackStreamKeys.add(key);
    this.playerMessage.set('Trying compatibility mode for this broadcast...');
    this.debugLive('remuxFallback.enabled', {
      channelId: channel.id,
      streamLabel: stream.label,
      errorData,
    });
    void this.loadCurrentStream();
    return true;
  }

  private streamPlaybackKey(stream: LiveStream, channelId?: string | null) {
    return `${channelId ?? this.selectedChannel()?.id ?? 'unknown'}::${stream.label}::${stream.url ?? stream.resolver?.pagePath ?? 'resolver'}`;
  }

  private shouldUseNativeHls(video: HTMLVideoElement, channel: LiveChannel) {
    if (!video.canPlayType('application/vnd.apple.mpegurl')) return false;

    if (channel.sourceId !== 'iptv-org') {
      return true;
    }

    if (typeof navigator === 'undefined') return true;
    const userAgent = navigator.userAgent;
    const isAppleDevice = /iPad|iPhone|iPod|Macintosh/i.test(userAgent);
    const isSafari =
      /Safari/i.test(userAgent) &&
      !/Chrome|Chromium|Android|CriOS|Edg|OPR|Firefox|FxiOS/i.test(userAgent);
    return isAppleDevice || isSafari;
  }

  private shouldPreflightPlayback(channel: LiveChannel, streamKind: ActivePlaybackKind) {
    if (!streamKind) return false;
    if (channel.sourceId !== 'iptv-org') return false;
    if (streamKind === 'dash') return true;
    if (streamKind === 'native-hls') return true;
    return false;
  }

  private detectStreamKind(stream: LiveStream, streamUrl: string) {
    if (stream.format) return stream.format;
    const normalized = streamUrl.toLowerCase();
    if (normalized.endsWith('.mpd')) return 'dash';
    if (normalized.endsWith('.m3u8')) return 'hls';
    try {
      const url = new URL(streamUrl);
      if (url.searchParams.get('extension')?.toLowerCase() === 'ts') return 'mpegts';
      if (url.pathname.toLowerCase().endsWith('.ts')) return 'mpegts';
    } catch {}
    return 'hls';
  }

  private createBackendPlaybackId(channel: LiveChannel, stream: LiveStream) {
    return [
      'live',
      channel.id,
      this.selectedStreamIndex(),
      Date.now().toString(36),
      Math.random().toString(36).slice(2, 10),
      stream.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    ].join('-');
  }

  private stopActiveBackendPlayback(preferBeacon = false) {
    const playbackId = this.activeBackendPlaybackId;
    if (!playbackId) return;

    this.activeBackendPlaybackId = null;
    const stopUrl = `${this.API_URL}/live/remux/stop?playbackId=${encodeURIComponent(playbackId)}`;

    if (preferBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        navigator.sendBeacon(stopUrl);
        return;
      } catch {
        // Fall back to fetch when sendBeacon is unavailable for this URL.
      }
    }

    void fetch(stopUrl, {
      method: 'POST',
      cache: 'no-store',
      keepalive: preferBeacon,
    }).catch(() => {
      // Best-effort cleanup only.
    });
  }

  private buildPlaybackUrl(
    channel: LiveChannel,
    stream: LiveStream,
    streamUrl: string,
    forceRemux = false,
    playbackId?: string
  ) {
    if (!forceRemux && this.detectStreamKind(stream, streamUrl) !== 'mpegts') return streamUrl;

    const params = new URLSearchParams();
    params.set('url', streamUrl);
    params.set('userAgent', this.LIVE_USER_AGENT);
    if (stream.format) {
      params.set('format', stream.format);
    } else if (forceRemux) {
      params.set('format', this.detectStreamKind(stream, streamUrl));
    }
    if (playbackId) {
      params.set('playbackId', playbackId);
    }

    if (channel.websiteUrl) {
      try {
        const websiteUrl = new URL(channel.websiteUrl);
        params.set('referer', channel.websiteUrl);
        params.set('origin', websiteUrl.origin);
      } catch {}
    }

    for (const [key, value] of Object.entries(stream.requestHeaders ?? {})) {
      params.append(`header_${key}`, value);
    }

    return `${this.API_URL}/live/remux?${params.toString()}`;
  }

  private async verifyNativeRemuxUrl(playbackUrl: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch(playbackUrl, {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller.signal,
      });
      this.debugLive('mpegts.head.result', { playbackUrl, status: response.status });
      return response.ok;
    } catch (error) {
      console.error(
        `[LiveTV] mpegts.head.failed ${JSON.stringify({
          playbackUrl,
          error: error instanceof Error ? error.message : String(error),
        })}`
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async probeStreamsInBackground(channel: LiveChannel) {
    if (!this.isBackgroundLiveProbeEnabled()) {
      return;
    }

    const token = ++this.probeToken;
    for (const [index, stream] of channel.streams.entries()) {
      if (token !== this.probeToken || this.selectedChannel()?.id !== channel.id) return;
      if (index === this.selectedStreamIndex() || this.failedStreamIndices().has(index)) continue;
      const isAvailable = await this.probeStreamAvailability(channel, stream);
      if (token !== this.probeToken || this.selectedChannel()?.id !== channel.id) return;
      if (!isAvailable) {
        this.markStreamUnavailable(index);
      }
    }
  }

  private clearFailedStreams() {
    this.failedStreamIndices.set(new Set());
  }

  private markStreamUnavailable(index: number) {
    const failed = new Set(this.failedStreamIndices());
    failed.add(index);
    this.failedStreamIndices.set(failed);
  }

  private async probeStreamAvailability(
    channel: LiveChannel,
    stream: LiveStream,
    resolvedStreamUrl?: string,
    streamKindOverride?: ActivePlaybackKind
  ) {
    try {
      const streamUrl = resolvedStreamUrl ?? (await this.streamResolver.resolve(stream));
      const probeUrl = new URL(`${this.API_URL}/live/probe`);
      probeUrl.searchParams.set('url', streamUrl);
      probeUrl.searchParams.set(
        'format',
        streamKindOverride ?? this.detectStreamKind(stream, streamUrl)
      );
      probeUrl.searchParams.set('userAgent', this.LIVE_USER_AGENT);

      if (channel.websiteUrl) {
        try {
          const websiteUrl = new URL(channel.websiteUrl);
          probeUrl.searchParams.set('referer', channel.websiteUrl);
          probeUrl.searchParams.set('origin', websiteUrl.origin);
        } catch {}
      }

      for (const [key, value] of Object.entries(stream.requestHeaders ?? {})) {
        probeUrl.searchParams.append(`header_${key}`, value);
      }

      const response = await fetch(probeUrl.toString());
      return response.ok;
    } catch (error) {
      console.warn('Background live probe failed.', error);
      return false;
    }
  }

  private getDrmConfig(stream: LiveStream) {
    const drm = stream.drm;
    if (!drm) return null;
    if (drm.keySystem === 'org.w3.clearkey' && (!drm.clearKeys || Object.keys(drm.clearKeys).length === 0)) {
      return null;
    }

    const protectionData: Record<string, any> = {};
    const keySystem = drm.keySystem ?? (drm.clearKeys ? 'org.w3.clearkey' : 'com.widevine.alpha');

    if (drm.clearKeys && Object.keys(drm.clearKeys).length > 0) {
      // dash.js expects ClearKey material as base64, while several channel configs
      // are stored as hex strings because that matches the provider metadata.
      protectionData['clearkeys'] = this.normalizeClearKeys(drm.clearKeys);
    }
    if (drm.licenseServerUrl) {
      protectionData['laURL'] = drm.licenseServerUrl;
    }
    if (drm.audioRobustness) {
      protectionData['audioRobustness'] = drm.audioRobustness;
    }
    if (drm.videoRobustness) {
      protectionData['videoRobustness'] = drm.videoRobustness;
    }
    if (drm.serverCertificate) {
      protectionData['serverCertificate'] = drm.serverCertificate;
    }
    if (drm.headers) {
      protectionData['httpRequestHeaders'] = drm.headers;
    }
    if (drm.withCredentials !== undefined) {
      protectionData['withCredentials'] = drm.withCredentials;
    }

    return Object.keys(protectionData).length > 0 ? { [keySystem]: protectionData } : null;
  }

  private stringifyDashError(event: unknown) {
    if (event == null) return '';
    if (typeof event === 'string') return event;
    const parts: string[] = [];
    const stack: unknown[] = [event];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || typeof current !== 'object') continue;
      for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
        if (typeof value === 'string') parts.push(value);
        else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
        else if (value && typeof value === 'object') stack.push(value);
        if (key === 'message' || key === 'code' || key === 'name' || key === 'event' || key === 'error') {
          if (typeof value === 'string') parts.push(value);
        }
      }
    }
    return parts.join(' ').toLowerCase();
  }

  private isTransientDashError(serialized: string) {
    return [
      'aborterror',
      'play() request was interrupted',
      'new load request',
      'sourcebuffer has been removed',
      'operation is not allowed',
      'session is not callable',
      'generating key request',
    ].some((pattern) => serialized.includes(pattern));
  }

  private isDrmDashError(serialized: string) {
    return [
      'license',
      'drm',
      'keysystem',
      'clearkey',
      'widevine',
      'key request',
      'update() message',
      'media keyerr',
    ].some((pattern) => serialized.includes(pattern));
  }

  private normalizeClearKeys(clearKeys: Record<string, string>) {
    const normalized: Record<string, string> = {};
    for (const [keyId, key] of Object.entries(clearKeys)) {
      normalized[this.normalizeClearKeyValue(keyId)] = this.normalizeClearKeyValue(key);
    }
    return normalized;
  }

  private normalizeClearKeyValue(value: string) {
    const trimmed = value.trim();
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      const bytes = new Uint8Array(trimmed.length / 2);
      for (let index = 0; index < trimmed.length; index += 2) {
        bytes[index / 2] = Number.parseInt(trimmed.slice(index, index + 2), 16);
      }
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return this.toBase64Url(btoa(binary));
    }
    return this.toBase64Url(trimmed);
  }

  private toBase64Url(value: string) {
    return value.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  }

  private loadFavorites() {
    try {
      const parsed = JSON.parse(localStorage.getItem('pirateflix_live_favorites') ?? '[]');
      return new Set<string>(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set<string>();
    }
  }

  private isBackgroundLiveProbeEnabled() {
    try {
      const raw = localStorage.getItem(this.SETTINGS_STORAGE_KEY);
      if (!raw) return false;
      const settings = JSON.parse(raw) as { backgroundLiveProbe?: boolean };
      return settings.backgroundLiveProbe === true;
    } catch {
      return false;
    }
  }

  private normalize(value: string) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  ngOnDestroy() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pageHideListener);
      window.removeEventListener('beforeunload', this.pageHideListener);
    }
    this.stopActiveBackendPlayback(true);
    this.clearCastNotice();
    this.destroy$.next();
    this.destroy$.complete();
    this.destroyPlayer();
  }
}
