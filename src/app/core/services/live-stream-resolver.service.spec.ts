import { LiveStream } from '../models/live-channel';
import { LiveStreamResolverService } from './live-stream-resolver.service';

describe('LiveStreamResolverService', () => {
  const fallbackUrl = 'https://atres-live.atresmedia.com/fallback/playlist.m3u8';
  const stream: LiveStream = {
    label: 'Principal',
    url: fallbackUrl,
    resolver: { provider: 'atresplayer', pagePath: '/directos/antena3/' },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('follows the public Atresplayer API flow and caches the signed HLS URL', async () => {
    const signedUrl =
      'https://atres-live.atresmedia.com/token_ES_2000000000_9999999999/hlsts/live/antena3/playlist.m3u8';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            href: 'https://api.atresplayer.com/client/v1/page/live/channel-id',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            urlVideo: 'https://api.atresplayer.com/player/v1/live/channel-id',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sourcesLive: [
              { src: 'https://example.com/video.mpd', type: 'application/dash+xml' },
              { src: signedUrl, type: 'application/vnd.apple.mpegurl' },
            ],
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const service = new LiveStreamResolverService();
    expect(await service.resolve(stream)).toBe(signedUrl);
    expect(await service.resolve(stream)).toBe(signedUrl);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects unexpected API domains and uses the configured fallback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ href: 'https://example.com/client/v1/page/live/id' }), {
          status: 200,
        })
      )
    );

    const service = new LiveStreamResolverService();
    expect(await service.resolve(stream)).toBe(fallbackUrl);
  });
});
