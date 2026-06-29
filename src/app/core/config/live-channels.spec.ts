import { LIVE_CHANNELS } from './live-channels';

describe('LIVE_CHANNELS', () => {
  it('contains the expected live channel catalog', () => {
    expect(LIVE_CHANNELS).toHaveLength(26);
    expect(LIVE_CHANNELS.reduce((total, channel) => total + channel.streams.length, 0)).toBe(48);
  });

  it('uses unique stable identifiers', () => {
    const ids = LIVE_CHANNELS.map((channel) => channel.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only includes supported live stream definitions', () => {
    for (const channel of LIVE_CHANNELS) {
      expect(channel.streams.length).toBeGreaterThan(0);
      for (const stream of channel.streams) {
        expect(Boolean(stream.url || stream.resolver)).toBe(true);
        if (stream.url) {
          const url = new URL(stream.url);
          if (stream.format === 'mpegts') {
            expect(['http:', 'https:']).toContain(url.protocol);
            expect(
              url.pathname.toLowerCase().endsWith('.ts') || url.searchParams.get('extension') === 'ts'
            ).toBe(true);
            continue;
          }
          expect(url.protocol).toBe('https:');
          expect(
            stream.format === 'dash'
              ? url.pathname.toLowerCase().includes('.mpd')
              : url.pathname.toLowerCase().includes('.m3u8')
          ).toBe(true);
        }
      }
    }
  });
});
