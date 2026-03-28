export type TorrentProviderId = 'piratebay' | 'kikass' | 'grantorrent' | '1337x';

export interface TorrentProviderOption {
  value: TorrentProviderId;
  label: string;
  description: string;
  logoPath: string;
}

export const DEFAULT_TORRENT_PROVIDER: TorrentProviderId = 'piratebay';

// Add new providers here as they become available.
export const TORRENT_PROVIDER_OPTIONS: ReadonlyArray<TorrentProviderOption> = Object.freeze([
  {
    value: 'piratebay',
    label: 'The Pirate Bay',
    description: 'Proveedor recomendado y compatible por defecto con la app.',
    logoPath: 'assets/providers/piratebay.svg',
  },
  {
    value: '1337x',
    label: '1337x',
    description: 'Proveedor dedicado para mirrors 1337x.',
    logoPath: 'assets/providers/1337x.svg',
  },
  {
    value: 'kikass',
    label: 'Kikass',
    description: 'Proveedor alternativo basado en el buscador de kikass.to.',
    logoPath: 'assets/providers/kikass.svg',
  },
  {
    value: 'grantorrent',
    label: 'GranTorrent',
    description: 'Proveedor en español con enlaces directos .torrent.',
    logoPath: 'assets/providers/grantorrent.svg',
  },
]);

const SUPPORTED_TORRENT_PROVIDER_SET = new Set(
  TORRENT_PROVIDER_OPTIONS.map((provider) => provider.value)
);

export function normalizeTorrentProvider(
  value: unknown,
  fallback: TorrentProviderId = DEFAULT_TORRENT_PROVIDER
): TorrentProviderId {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (SUPPORTED_TORRENT_PROVIDER_SET.has(normalized as TorrentProviderId)) {
    return normalized as TorrentProviderId;
  }

  return fallback;
}

export function resolveTorrentProviderForPlayback(
  selectedProvider: unknown,
  isAuthenticated: boolean
): TorrentProviderId {
  if (!isAuthenticated) {
    return DEFAULT_TORRENT_PROVIDER;
  }

  return normalizeTorrentProvider(selectedProvider);
}
