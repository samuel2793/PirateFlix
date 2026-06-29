import { CommonModule } from '@angular/common';
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

@Component({
  selector: 'app-live-tv',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, TranslatePipe],
  templateUrl: './live-tv.html',
  styleUrl: './live-tv.scss',
})
export class LiveTvComponent implements OnDestroy {
  private readonly API_URL = (() => {
    if (typeof window === 'undefined') {
      return 'http://127.0.0.1:3001/api';
    }
    const hostname = window.location.hostname || 'localhost';
    const isLocalhost =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    return isLocalhost ? 'http://localhost:3001/api' : `http://${hostname}:3001/api`;
  })();
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly streamResolver = inject(LiveStreamResolverService);
  private readonly destroy$ = new Subject<void>();
  private dash: any = null;
  private hls: Hls | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private attachToken = 0;
  private networkRetries = 0;
  private mediaRetries = 0;
  private streamLoadToken = 0;
  private failedStreamIndices = new Set<number>();

  readonly channels = LIVE_CHANNELS;
  readonly categories: { value: 'all' | LiveChannelCategory; label: string; icon: string }[] = [
    { value: 'all', label: 'All channels', icon: 'apps' },
    { value: 'national', label: 'National', icon: 'public' },
    { value: 'news', label: 'News', icon: 'newspaper' },
    { value: 'sports', label: 'Sports', icon: 'sports_soccer' },
    { value: 'kids', label: 'Kids', icon: 'child_care' },
  ];

  query = signal('');
  activeCategory = signal<'all' | LiveChannelCategory>('all');
  selectedChannel = signal<LiveChannel | null>(null);
  selectedStreamIndex = signal(0);
  playerStatus = signal<PlayerStatus>('idle');
  playerMessage = signal('');
  qualityLevels = signal<{ index: number; label: string }[]>([]);
  selectedQuality = signal(-1);
  failedLogos = signal<Set<string>>(new Set());
  favoriteIds = signal<Set<string>>(this.loadFavorites());

  filteredChannels = computed(() => {
    const query = this.normalize(this.query());
    const category = this.activeCategory();
    return this.channels.filter((channel) => {
      if (category !== 'all' && channel.category !== category) return false;
      if (!query) return true;
      return this.normalize(
        `${channel.name} ${channel.countryCode} ${channel.languages.join(' ')} ${channel.epgId ?? ''}`
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

  @ViewChild('liveVideo')
  set liveVideo(ref: ElementRef<HTMLVideoElement> | undefined) {
    this.videoElement = ref?.nativeElement ?? null;
    if (this.videoElement && this.selectedChannel()) {
      const token = ++this.attachToken;
      setTimeout(() => {
        if (token === this.attachToken) void this.loadCurrentStream();
      });
    }
  }

  constructor() {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((params) => {
      const channelId = params.get('channelId');
      const channel = channelId
        ? this.channels.find((candidate) => candidate.id === channelId) ?? null
        : null;

      if (channelId && !channel) {
        void this.router.navigate(['/live'], { replaceUrl: true });
        return;
      }

      if (this.selectedChannel()?.id !== channel?.id) {
        this.destroyPlayer();
        this.failedStreamIndices.clear();
        this.selectedStreamIndex.set(0);
        this.selectedChannel.set(channel);
        this.playerStatus.set(channel ? 'loading' : 'idle');
        this.playerMessage.set('');
      }
    });
  }

  openChannel(channel: LiveChannel) {
    void this.router.navigate(['/live', channel.id]);
  }

  closePlayer() {
    void this.router.navigate(['/live']);
  }

  setCategory(category: 'all' | LiveChannelCategory) {
    this.activeCategory.set(category);
  }

  switchStream(index: number) {
    if (index === this.selectedStreamIndex() && this.playerStatus() !== 'error') return;
    this.failedStreamIndices.clear();
    this.selectedStreamIndex.set(index);
    void this.loadCurrentStream();
  }

  retry() {
    this.failedStreamIndices.clear();
    const stream = this.selectedChannel()?.streams[this.selectedStreamIndex()];
    if (stream) this.streamResolver.invalidate(stream);
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

  onVideoPlaying() {
    this.playerStatus.set('playing');
    this.playerMessage.set('');
  }

  onVideoWaiting() {
    if (this.playerStatus() !== 'error') this.playerStatus.set('loading');
  }

  onNativeVideoError() {
    if (!this.hls) this.tryNextStream('This broadcast could not be played.');
  }

  private async loadCurrentStream() {
    const channel = this.selectedChannel();
    const video = this.videoElement;
    const stream = channel?.streams[this.selectedStreamIndex()];
    if (!channel || !video || !stream) return;
    const loadToken = ++this.streamLoadToken;

    this.destroyHlsOnly();
    this.networkRetries = 0;
    this.mediaRetries = 0;
    this.playerStatus.set('loading');
    this.playerMessage.set('Connecting to live broadcast...');
    this.qualityLevels.set([]);
    this.selectedQuality.set(-1);

    video.pause();
    video.removeAttribute('src');
    video.load();

    let streamUrl: string;
    try {
      streamUrl = await this.streamResolver.resolve(stream);
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

    if (streamKind === 'dash') {
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
      video.src = this.buildPlaybackUrl(channel, stream, streamUrl);
      video.load();
      void video.play().catch(() => {
        this.playerMessage.set('Press play to start the broadcast.');
      });
      return;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
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
    this.hls = hls;
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
      this.tryNextStream('The broadcast is unavailable or blocked by its provider.');
    });
  }

  private tryNextStream(reason: string) {
    const channel = this.selectedChannel();
    if (!channel) return;
    this.failedStreamIndices.add(this.selectedStreamIndex());
    const nextIndex = channel.streams.findIndex((_, index) => !this.failedStreamIndices.has(index));
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
    this.hls?.destroy();
    this.hls = null;
  }

  private destroyPlayer() {
    this.attachToken += 1;
    this.streamLoadToken += 1;
    try {
      this.dash?.destroy();
    } catch (error) {
      console.warn('Could not destroy DASH player cleanly.', error);
    }
    this.destroyHlsOnly();
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.removeAttribute('src');
      this.videoElement.load();
    }
    this.qualityLevels.set([]);
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

  private buildPlaybackUrl(channel: LiveChannel, stream: LiveStream, streamUrl: string) {
    if (this.detectStreamKind(stream, streamUrl) !== 'mpegts') return streamUrl;

    const params = new URLSearchParams();
    params.set('url', streamUrl);
    params.set(
      'userAgent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
    );

    try {
      const websiteUrl = new URL(channel.websiteUrl);
      params.set('referer', channel.websiteUrl);
      params.set('origin', websiteUrl.origin);
    } catch {}

    for (const [key, value] of Object.entries(stream.requestHeaders ?? {})) {
      params.append(`header_${key}`, value);
    }

    return `${this.API_URL}/live/remux?${params.toString()}`;
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

  private normalize(value: string) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.destroyPlayer();
  }
}
