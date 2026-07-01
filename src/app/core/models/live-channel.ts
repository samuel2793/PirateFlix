export type LiveChannelCategory = 'national' | 'news' | 'sports' | 'kids';

export interface LiveStream {
  label: string;
  url?: string;
  format?: 'hls' | 'dash' | 'mpegts';
  requestHeaders?: Record<string, string>;
  language?: string;
  originLabel?: string;
  geoRestricted?: boolean;
  drm?: {
    keySystem?: 'org.w3.clearkey' | 'com.widevine.alpha';
    clearKeys?: Record<string, string>;
    licenseServerUrl?: string;
    audioRobustness?: string;
    videoRobustness?: string;
    serverCertificate?: string;
    headers?: Record<string, string>;
    withCredentials?: boolean;
  };
  resolver?: {
    provider: 'atresplayer';
    pagePath: string;
  };
}

export interface LiveChannel {
  id: string;
  name: string;
  category: LiveChannelCategory;
  countryCode: string;
  languages: string[];
  originLabel?: string;
  logoUrl: string;
  websiteUrl?: string;
  epgId?: string;
  groupTitle?: string;
  sourceId?: 'iptv-org';
  sourceLabel?: string;
  geoRestricted?: boolean;
  streams: LiveStream[];
}
