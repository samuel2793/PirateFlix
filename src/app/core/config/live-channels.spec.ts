import { LIVE_CHANNELS } from './live-channels';

describe('LIVE_CHANNELS', () => {
  it('contains the expected M3U8 channel catalog', () => {
    expect(LIVE_CHANNELS).toHaveLength(25);
    expect(LIVE_CHANNELS.reduce((total, channel) => total + channel.streams.length, 0)).toBe(47);
  });

  it('uses unique stable identifiers', () => {
    const ids = LIVE_CHANNELS.map((channel) => channel.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only includes secure M3U8 streams', () => {
    for (const channel of LIVE_CHANNELS) {
      expect(channel.streams.length).toBeGreaterThan(0);
      for (const stream of channel.streams) {
        expect(Boolean(stream.url || stream.resolver)).toBe(true);
        if (stream.url) {
          const url = new URL(stream.url);
          expect(url.protocol).toBe('https:');
          expect(url.pathname.toLowerCase()).toContain('.m3u8');
        }
      }
    }
  });
});
