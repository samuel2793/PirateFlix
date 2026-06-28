import { Injectable } from '@angular/core';

import { LiveStream } from '../models/live-channel';

interface CachedStream {
  url: string;
  validUntil: number;
}

interface AtresRouteResponse {
  href?: string;
}

interface AtresPageResponse {
  urlVideo?: string;
}

interface AtresPlayerSource {
  src?: string;
  type?: string;
}

interface AtresPlayerResponse {
  sourcesLive?: AtresPlayerSource[];
}

@Injectable({ providedIn: 'root' })
export class LiveStreamResolverService {
  private readonly cache = new Map<string, CachedStream>();
  private readonly requestTimeoutMs = 10_000;

  async resolve(stream: LiveStream): Promise<string> {
    if (!stream.resolver) {
      if (stream.url) return stream.url;
      throw new Error('Live stream has neither a URL nor a resolver');
    }

    const cacheKey = this.cacheKey(stream);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.validUntil > Date.now() + 60_000) return cached.url;

    try {
      const url = await this.resolveAtresplayer(stream.resolver.pagePath);
      this.cache.set(cacheKey, { url, validUntil: this.readAtresExpiry(url) });
      return url;
    } catch (error) {
      if (stream.url) {
        console.warn('Could not refresh live stream URL; using configured fallback.', error);
        return stream.url;
      }
      throw error;
    }
  }

  invalidate(stream: LiveStream) {
    if (stream.resolver) this.cache.delete(this.cacheKey(stream));
  }

  private async resolveAtresplayer(pagePath: string): Promise<string> {
    if (!/^\/directos\/[a-z0-9-]+\/$/i.test(pagePath)) {
      throw new Error('Invalid Atresplayer page path');
    }

    const routeUrl = new URL('https://api.atresplayer.com/client/v1/url');
    routeUrl.searchParams.set('href', pagePath);
    const route = await this.fetchJson<AtresRouteResponse>(routeUrl.toString());
    const pageUrl = this.validateAtresApiUrl(route.href, '/client/v1/page/');

    const page = await this.fetchJson<AtresPageResponse>(pageUrl);
    const playerUrl = new URL(this.validateAtresApiUrl(page.urlVideo, '/player/v1/'));
    playerUrl.searchParams.set('NODRM', 'true');
    playerUrl.searchParams.set('usp', 'true');
    playerUrl.searchParams.set('device', 'webDesktop');

    const player = await this.fetchJson<AtresPlayerResponse>(playerUrl.toString());
    const source = player.sourcesLive?.find(
      (candidate) =>
        candidate.type === 'application/vnd.apple.mpegurl' && Boolean(candidate.src)
    );
    if (!source?.src) throw new Error('Atresplayer returned no HLS source');

    const streamUrl = new URL(source.src);
    if (
      streamUrl.protocol !== 'https:' ||
      !['atresmedia.com', 'atres-live.atresmedia.com'].some(
        (host) => streamUrl.hostname === host || streamUrl.hostname.endsWith(`.${host}`)
      ) ||
      !streamUrl.pathname.toLowerCase().endsWith('.m3u8')
    ) {
      throw new Error('Atresplayer returned an unexpected stream URL');
    }
    return streamUrl.toString();
  }

  private validateAtresApiUrl(value: string | undefined, pathPrefix: string) {
    if (!value) throw new Error('Atresplayer response is incomplete');
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.atresplayer.com' ||
      !url.pathname.startsWith(pathPrefix)
    ) {
      throw new Error('Atresplayer returned an unexpected API URL');
    }
    return url.toString();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Atresplayer API responded with ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private cacheKey(stream: LiveStream) {
    return `${stream.resolver?.provider}:${stream.resolver?.pagePath}`;
  }

  private readAtresExpiry(url: string) {
    const expiresAtSeconds = Number(new URL(url).pathname.match(/_ES_\d+_(\d+)\//)?.[1]);
    return Number.isFinite(expiresAtSeconds)
      ? expiresAtSeconds * 1000
      : Date.now() + 10 * 60_000;
  }
}
