export type LiveChannelCategory = 'national' | 'news' | 'sports' | 'kids';

export interface LiveStream {
  label: string;
  url?: string;
  language?: string;
  geoRestricted?: boolean;
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
  logoUrl: string;
  websiteUrl: string;
  epgId?: string;
  geoRestricted?: boolean;
  streams: LiveStream[];
}
