export type TorrentProviderId = 'piratebay' | 'kikass';

export interface TorrentProviderOption {
  value: TorrentProviderId;
  label: string;
  description: string;
}

export const DEFAULT_TORRENT_PROVIDER: TorrentProviderId = 'piratebay';

// Add new providers here as they become available.
export const TORRENT_PROVIDER_OPTIONS: ReadonlyArray<TorrentProviderOption> = Object.freeze([
  {
    value: 'piratebay',
    label: 'The Pirate Bay',
    description: 'Provider por defecto compatible con la app actualmente.',
  },
  {
    value: 'kikass',
    label: 'Kikass',
    description: 'Provider alternativo basado en el buscador de kikass.to.',
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
