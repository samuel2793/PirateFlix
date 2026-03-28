import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import pump from 'pump';
import rangeParser from 'range-parser';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';
import path from 'path';
import https from 'https';
import http from 'http';
import axios from 'axios';
import fs from 'fs';
import dns from 'dns';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const app = express();
const PORT = 3001;
const IS_EMBEDDED_RUNTIME = Boolean(process.env.DATADIR);
const HOST = process.env.PIRATEFLIX_BIND_HOST || (IS_EMBEDDED_RUNTIME ? '127.0.0.1' : '0.0.0.0');
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SERVER_DIR, '..');

// =====================
// DNS / IPv4 first (reduce weird long stalls on some hosts)
// =====================
try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
    console.log('🌐 DNS: ipv4first');
  }
} catch (_) {
  // ignore
}

// =====================
// Circuit-breaker / mirror health tracking
// =====================
const mirrorStats = new Map();
const MIRROR_FAILURE_THRESHOLD = parseInt(
  process.env.PIRATEFLIX_MIRROR_FAILURE_THRESHOLD || '3',
  10
);
const MIRROR_COOLDOWN_MS = parseInt(process.env.PIRATEFLIX_MIRROR_COOLDOWN_MS || '60000', 10); // 60s

// Extended timeout (env alias support for backward/forward compatibility)
const EXTENDED_MIRROR_TIMEOUT_MS = parseInt(
  process.env.PIRATEFLIX_MIRROR_EXTENDED_TIMEOUT_MS ||
    process.env.PIRATEFLIX_EXTENDED_MIRROR_TIMEOUT_MS ||
    '45000',
  10
); // 45s por defecto

// Hedged request / tuning
const FAST_PARALLEL_MIRRORS = parseInt(process.env.PIRATEFLIX_FAST_PARALLEL_MIRRORS || '3', 10); // mirrors to probe first
const MIRROR_RETRY_COUNT = parseInt(process.env.PIRATEFLIX_MIRROR_RETRY_COUNT || '0', 10);
const MIRROR_RETRY_DELAY_MS = parseInt(process.env.PIRATEFLIX_MIRROR_RETRY_DELAY_MS || '500', 10);

// 1337x mirrors (excelente para contenido en español/latino y dual audio)
const MIRRORS_1337X = Object.freeze([
  'https://1337x.to',
  'https://1337x.st',
  'https://1337x.ws',
  'https://1337x.is',
  'https://1337x.gd',
]);

// Torrent providers registry.
// Add new providers here and wire their search URL strategy.
function resolveKikassCategory(categoryLike) {
  const category = String(categoryLike || '')
    .trim()
    .toLowerCase();

  const movieCategories = new Set(['200', '201', '202', '203', '204', '207', 'movies', 'movie']);
  const tvCategories = new Set(['205', '208', 'tv', 'television']);

  if (movieCategories.has(category)) return 'movies';
  if (tvCategories.has(category)) return 'tv';
  return null;
}

const TORRENT_PROVIDERS = Object.freeze({
  piratebay: Object.freeze({
    id: 'piratebay',
    label: 'The Pirate Bay',
    mirrors: Object.freeze([
      'https://thepibay.site',
      'https://tpb.party',
      'https://thepiratebay.org',
      'https://thpibay.xyz',
      'https://thpibay.site',
      'https://thepibay.online',
    ]),
    enableYtsFallback: true,
    buildSearchUrl(base, cleanQuery, category) {
      return `${base}/search/${encodeURIComponent(cleanQuery)}/1/99/${category}`;
    },
  }),
  kikass: Object.freeze({
    id: 'kikass',
    label: 'Kikass',
    mirrors: Object.freeze(['https://kikass.to']),
    enableYtsFallback: false,
    buildSearchUrl(base, cleanQuery, category) {
      const slug = resolveKikassCategory(category);
      if (slug) {
        return `${base}/search/${encodeURIComponent(cleanQuery)}/category/${slug}/`;
      }
      return `${base}/search/${encodeURIComponent(cleanQuery)}/`;
    },
  }),
  grantorrent: Object.freeze({
    id: 'grantorrent',
    label: 'GranTorrent',
    mirrors: Object.freeze(['https://www3.grantorrent.lol']),
    enableYtsFallback: false,
    buildSearchUrl(base, cleanQuery) {
      return `${base}/?s=${encodeURIComponent(cleanQuery)}&filtro=`;
    },
  }),
  '1337x': Object.freeze({
    id: '1337x',
    label: '1337x',
    mirrors: MIRRORS_1337X,
    enableYtsFallback: false,
    buildSearchUrl(base, cleanQuery) {
      return `${base}/search/${encodeURIComponent(cleanQuery)}/1/`;
    },
  }),
});

const TORRENT_PROVIDER_IDS = Object.freeze(Object.keys(TORRENT_PROVIDERS));
const DEFAULT_TORRENT_PROVIDER =
  TORRENT_PROVIDERS[
    String(process.env.PIRATEFLIX_DEFAULT_TORRENT_PROVIDER || '').trim().toLowerCase()
  ]?.id || 'piratebay';

function getTorrentProviderDefinition(providerLike) {
  const normalized = String(providerLike || '')
    .trim()
    .toLowerCase();
  return (
    TORRENT_PROVIDERS[normalized] ||
    TORRENT_PROVIDERS[DEFAULT_TORRENT_PROVIDER] ||
    TORRENT_PROVIDERS.piratebay
  );
}

// Warmup tracking
let lastWarmupAt = 0;
const WARMUP_INTERVAL_MS = parseInt(process.env.PIRATEFLIX_WARMUP_INTERVAL_MS || '60000', 10); // 60s

// =====================
// Agentes HTTP/HTTPS globales keep-alive
// =====================
const ALLOW_INSECURE_TLS =
  String(process.env.PIRATEFLIX_ALLOW_WEAK_TLS || 'false').toLowerCase() === 'true';
let httpAgentGlobal = null;
let httpsAgentGlobal = null;

function createAgents() {
  try {
    if (httpAgentGlobal && typeof httpAgentGlobal.destroy === 'function') {
      try {
        httpAgentGlobal.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    if (httpsAgentGlobal && typeof httpsAgentGlobal.destroy === 'function') {
      try {
        httpsAgentGlobal.destroy();
      } catch (e) {
        /* ignore */
      }
    }

    httpAgentGlobal = new http.Agent({ keepAlive: true, maxSockets: 50 });
    httpsAgentGlobal = new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      rejectUnauthorized: !ALLOW_INSECURE_TLS,
    });

    console.log(
      '🔌 Agentes HTTP/HTTPS globales creados (keepAlive) - allowInsecureTLS=',
      ALLOW_INSECURE_TLS
    );
  } catch (err) {
    console.warn('No se pudieron crear agentes globales:', err && err.message ? err.message : err);
  }
}

// Inicializar agentes al inicio
createAgents();

function stripJsComments(source) {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      i += 1;
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inSingle || inDouble || inTemplate) {
      out += ch;
      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i += 1;
        continue;
      }
      if (inSingle && ch === "'") inSingle = false;
      else if (inDouble && ch === '"') inDouble = false;
      else if (inTemplate && ch === '`') inTemplate = false;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '`') {
      inTemplate = true;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function loadAppConfigFromFile() {
  try {
    const configPath =
      process.env.PIRATEFLIX_APP_CONFIG_PATH ||
      path.resolve(APP_ROOT, 'src/app/core/config/app-config-public.ts');
    if (!fs.existsSync(configPath)) {
      if (!IS_EMBEDDED_RUNTIME) {
        console.warn(`No existe app-config-public.ts en ${configPath}`);
      }
      return null;
    }
    const source = fs.readFileSync(configPath, 'utf-8');
    const match = source.match(/export const APP_CONFIG\s*=\s*([\s\S]*?)\s*as const\s*;/);
    if (!match) return null;
    const rawObject = stripJsComments(match[1]);
    return new Function(`"use strict"; return (${rawObject});`)();
  } catch (err) {
    console.warn('No se pudo leer app-config-public.ts:', err?.message || err);
    return null;
  }
}

const appConfig = loadAppConfigFromFile();

// =====================
// OpenSubtitles config
// =====================
const OPENSUBTITLES_BASE_URL = 'https://api.opensubtitles.com/api/v1';
const appConfigTimeout = Number(appConfig?.openSubtitles?.timeoutMs);
const envOpenSubtitlesTimeout = Number(process.env.OPEN_SUBTITLES_TIMEOUT_MS);
const OPENSUBTITLES_TIMEOUT_MS =
  Number.isFinite(envOpenSubtitlesTimeout) && envOpenSubtitlesTimeout > 0
    ? Math.floor(envOpenSubtitlesTimeout)
    : Number.isFinite(appConfigTimeout) && appConfigTimeout > 0
      ? Math.floor(appConfigTimeout)
      : 15000;
const OPENSUBTITLES_SEARCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.OPEN_SUBTITLES_SEARCH_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return Math.max(10000, Math.min(OPENSUBTITLES_TIMEOUT_MS, 20000));
})();
const OPEN_SUBTITLES_RETRY_COUNT = (() => {
  const raw = Number(process.env.OPEN_SUBTITLES_RETRY_COUNT || '1');
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1;
})();
const OPEN_SUBTITLES_RETRY_DELAY_MS = (() => {
  const raw = Number(process.env.OPEN_SUBTITLES_RETRY_DELAY_MS || '600');
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 600;
})();
const OPEN_SUBTITLES_MAX_CONFIGS_PER_REQUEST = (() => {
  const raw = Number(process.env.OPEN_SUBTITLES_MAX_CONFIGS_PER_REQUEST || '4');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
})();
const OPEN_SUBTITLES_TOKEN_TTL_MS = parseInt(
  process.env.OPEN_SUBTITLES_TOKEN_TTL_MS || '43200000',
  10
);
const OPEN_SUBTITLES_DOWNLOAD_CACHE_MS = parseInt(
  process.env.OPEN_SUBTITLES_DOWNLOAD_CACHE_MS || '3600000',
  10
);

function buildOpenSubtitlesConfigs() {
  const envApiKey = process.env.OPEN_SUBTITLES_API_KEY;
  if (envApiKey) {
    return [
      {
        apiKey: String(envApiKey),
        userAgent: String(process.env.OPEN_SUBTITLES_USER_AGENT || 'PirateFlix'),
        username: String(process.env.OPEN_SUBTITLES_USERNAME || ''),
        password: String(process.env.OPEN_SUBTITLES_PASSWORD || ''),
        label: 'env',
      },
    ];
  }

  const openSubtitles = appConfig?.openSubtitles || {};
  const apis = Array.isArray(openSubtitles.apis) ? openSubtitles.apis : [];
  const configs = apis
    .map((entry, idx) => {
      const apiKey = String(entry?.apiKey || '').trim();
      if (!apiKey) return null;
      const userAgent = entry?.userAgent || openSubtitles.userAgent || 'PirateFlix';
      const username = entry?.username || openSubtitles.username || '';
      const password = entry?.password || openSubtitles.password || '';
      return {
        apiKey,
        userAgent: String(userAgent),
        username: String(username),
        password: String(password),
        label: entry?.label ? String(entry.label) : `app-config#${idx + 1}`,
      };
    })
    .filter(Boolean);

  if (configs.length > 0) return configs;

  if (openSubtitles?.apiKey) {
    return [
      {
        apiKey: String(openSubtitles.apiKey),
        userAgent: String(openSubtitles.userAgent || 'PirateFlix'),
        username: String(openSubtitles.username || ''),
        password: String(openSubtitles.password || ''),
        label: 'app-config',
      },
    ];
  }

  return [];
}

const openSubtitlesConfigs = buildOpenSubtitlesConfigs();
const openSubtitlesAuthStates = openSubtitlesConfigs.map(() => ({
  token: null,
  lastLoginAt: 0,
}));
let openSubtitlesActiveIndex = 0;
const openSubtitlesDownloadCache = new Map();

function hasOpenSubtitlesConfig() {
  return openSubtitlesConfigs.length > 0;
}

function getOpenSubtitlesConfig(index) {
  return openSubtitlesConfigs[index];
}

function getOpenSubtitlesAuthState(index) {
  if (!openSubtitlesAuthStates[index]) {
    openSubtitlesAuthStates[index] = { token: null, lastLoginAt: 0 };
  }
  return openSubtitlesAuthStates[index];
}

function getOpenSubtitlesConfigCandidates() {
  const total = openSubtitlesConfigs.length;
  if (total === 0) return [];
  const start = Math.min(Math.max(openSubtitlesActiveIndex, 0), total - 1);
  const indices = [];
  for (let i = 0; i < total; i += 1) {
    indices.push((start + i) % total);
  }
  const limit = Math.max(1, Math.min(indices.length, OPEN_SUBTITLES_MAX_CONFIGS_PER_REQUEST));
  return indices.slice(0, limit);
}

const OPEN_SUBTITLES_RETRIABLE_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
]);

function isRetriableOpenSubtitlesError(error) {
  const status = error?.response?.status;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  const code = String(error?.code || '').toUpperCase();
  if (OPEN_SUBTITLES_RETRIABLE_CODES.has(code)) return true;
  const msg = String(error?.message || '').toLowerCase();
  if (msg.includes('timeout')) return true;
  if (msg.includes('socket hang up')) return true;
  return false;
}

function shouldRetryOpenSubtitlesError(error) {
  return isRetriableOpenSubtitlesError(error);
}

function shouldRotateOpenSubtitlesConfig(error) {
  const status = error?.response?.status;
  if (status === 401 || status === 403 || status === 406 || status === 429) return true;
  return isRetriableOpenSubtitlesError(error);
}

function rotateOpenSubtitlesConfig(index) {
  const total = openSubtitlesConfigs.length;
  if (total <= 1) return index;
  const nextIndex = (index + 1) % total;
  openSubtitlesActiveIndex = nextIndex;
  return nextIndex;
}

function delayMs(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withOpenSubtitlesConfig(action, context) {
  const candidates = getOpenSubtitlesConfigCandidates();
  if (candidates.length === 0) {
    throw new Error('OpenSubtitles API key no configurada');
  }
  let lastError = null;
  for (const index of candidates) {
    try {
      let result = null;
      for (let attempt = 0; attempt <= OPEN_SUBTITLES_RETRY_COUNT; attempt += 1) {
        try {
          result = await action(index, attempt);
          break;
        } catch (innerError) {
          lastError = innerError;
          const isRetriable = shouldRetryOpenSubtitlesError(innerError);
          const hasMoreAttempts = attempt < OPEN_SUBTITLES_RETRY_COUNT;
          if (!isRetriable || !hasMoreAttempts) {
            throw innerError;
          }
          const wait = OPEN_SUBTITLES_RETRY_DELAY_MS * (attempt + 1);
          console.warn('[OpenSubtitles] retry request:', {
            context,
            config: index + 1,
            attempt: attempt + 1,
            waitMs: wait,
            code: innerError?.code || null,
            status: innerError?.response?.status || null,
            message: innerError?.message || String(innerError),
          });
          await delayMs(wait);
        }
      }
      if (result === null) {
        throw lastError || new Error('OpenSubtitles request failed');
      }
      openSubtitlesActiveIndex = index;
      return result;
    } catch (error) {
      lastError = error;
      if (!shouldRotateOpenSubtitlesConfig(error)) throw error;
      const status = error?.response?.status;
      const nextIndex = rotateOpenSubtitlesConfig(index);
      console.warn('[OpenSubtitles] config fallback:', {
        context,
        status,
        from: index + 1,
        to: nextIndex + 1,
      });
    }
  }
  throw lastError;
}

function buildOpenSubtitlesHeaders(configIndex, includeAuth = false) {
  const config = getOpenSubtitlesConfig(configIndex);
  const headers = {
    'Api-Key': config?.apiKey || '',
    'User-Agent': config?.userAgent || 'PirateFlix',
    Accept: 'application/json',
  };
  const authState = getOpenSubtitlesAuthState(configIndex);
  if (includeAuth && authState?.token) {
    headers.Authorization = `Bearer ${authState.token}`;
  }
  return headers;
}

async function loginOpenSubtitles(configIndex) {
  const config = getOpenSubtitlesConfig(configIndex);
  if (!config?.username || !config?.password) return null;
  try {
    console.log('[OpenSubtitles] login start:', {
      index: configIndex + 1,
      user: config.username ? 'set' : 'missing',
      userAgent: config.userAgent,
    });
    const response = await axios.post(
      `${OPENSUBTITLES_BASE_URL}/login`,
      {
        username: config.username,
        password: config.password,
      },
      {
        headers: buildOpenSubtitlesHeaders(configIndex, false),
        timeout: OPENSUBTITLES_TIMEOUT_MS,
        httpAgent: httpAgentGlobal,
        httpsAgent: httpsAgentGlobal,
      }
    );

    const token = response?.data?.token;
    if (token) {
      const authState = getOpenSubtitlesAuthState(configIndex);
      authState.token = token;
      authState.lastLoginAt = Date.now();
      console.log('[OpenSubtitles] login ok');
      return token;
    }
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.warn(
      'OpenSubtitles login falló:',
      status ? `status=${status}` : '',
      err?.message || err
    );
    if (data) {
      console.warn('[OpenSubtitles] login error payload:', data);
    }
  }
  const authState = getOpenSubtitlesAuthState(configIndex);
  authState.token = null;
  return null;
}

async function ensureOpenSubtitlesToken(configIndex) {
  const config = getOpenSubtitlesConfig(configIndex);
  if (!config?.username || !config?.password) return null;
  const authState = getOpenSubtitlesAuthState(configIndex);
  const fresh =
    authState.token && Date.now() - authState.lastLoginAt < OPEN_SUBTITLES_TOKEN_TTL_MS;
  if (fresh) return authState.token;
  return await loginOpenSubtitles(configIndex);
}

function pickOpenSubtitlesFile(files) {
  if (!Array.isArray(files)) return null;
  for (const file of files) {
    const formatRaw = String(file?.format || '').toLowerCase();
    let format = formatRaw;
    if (format === 'webvtt') format = 'vtt';
    if (format === 'srt' || format === 'vtt') {
      return { file, format };
    }

    if (file?.file_name) {
      const lowerName = String(file.file_name).toLowerCase();
      if (lowerName.endsWith('.srt.gz')) return { file, format: 'srt' };
      if (lowerName.endsWith('.vtt.gz')) return { file, format: 'vtt' };

      const ext = lowerName.split('.').pop() || '';
      if (ext === 'webvtt') return { file, format: 'vtt' };
      if (ext === 'srt' || ext === 'vtt') return { file, format: ext };
    }
  }
  for (const file of files) {
    if (file?.file_id) return { file, format: '' };
  }
  return null;
}

function sanitizeFileName(fileName) {
  if (!fileName) return '';
  return String(fileName).split(/[\\/]/).pop() || '';
}

function extractFilenameFromDisposition(disposition) {
  if (!disposition) return '';
  const match =
    /filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?/i.exec(String(disposition)) ||
    /filename\*?=([^;]+)/i.exec(String(disposition));
  if (!match) return '';
  try {
    return sanitizeFileName(decodeURIComponent(match[1]));
  } catch (_) {
    return sanitizeFileName(match[1]);
  }
}

function guessSubtitleExtension(fileName, fallbackUrl, contentType) {
  const base =
    sanitizeFileName(fileName) ||
    sanitizeFileName(fallbackUrl) ||
    '';
  const ext = base.toLowerCase().split('.').pop() || '';
  if (ext) return ext;
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('vtt')) return 'vtt';
  if (ct.includes('srt') || ct.includes('subtitle')) return 'srt';
  if (ct.includes('gzip')) return 'gz';
  if (ct.includes('zip')) return 'zip';
  return '';
}

function getOpenSubtitlesDownloadCacheKey(configIndex, fileId) {
  return `${configIndex}:${fileId}`;
}

function getCachedOpenSubtitlesDownload(configIndex, fileId) {
  const cacheKey = getOpenSubtitlesDownloadCacheKey(configIndex, fileId);
  const cached = openSubtitlesDownloadCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.ts > OPEN_SUBTITLES_DOWNLOAD_CACHE_MS) {
    openSubtitlesDownloadCache.delete(cacheKey);
    return null;
  }
  return cached;
}

async function resolveOpenSubtitlesDownload(
  configIndex,
  fileId,
  subFormat = '',
  inFps = null,
  outFps = null
) {
  const cached = getCachedOpenSubtitlesDownload(configIndex, fileId);
  if (cached) return cached;

  const config = getOpenSubtitlesConfig(configIndex);
  const authState = getOpenSubtitlesAuthState(configIndex);
  await ensureOpenSubtitlesToken(configIndex);
  let response = null;
  const payload = {
    file_id: fileId,
    ...(subFormat ? { sub_format: subFormat } : {}),
    ...(Number.isFinite(inFps) ? { in_fps: inFps } : {}),
    ...(Number.isFinite(outFps) ? { out_fps: outFps } : {}),
  };
  try {
    console.log('[OpenSubtitles] download request:', payload);
    response = await axios.post(
      `${OPENSUBTITLES_BASE_URL}/download`,
      payload,
      {
        headers: buildOpenSubtitlesHeaders(configIndex, true),
        timeout: OPENSUBTITLES_TIMEOUT_MS,
        httpAgent: httpAgentGlobal,
        httpsAgent: httpsAgentGlobal,
      }
    );
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 && config?.username && config?.password) {
      authState.token = null;
      await loginOpenSubtitles(configIndex);
      response = await axios.post(
        `${OPENSUBTITLES_BASE_URL}/download`,
        payload,
        {
          headers: buildOpenSubtitlesHeaders(configIndex, true),
          timeout: OPENSUBTITLES_TIMEOUT_MS,
          httpAgent: httpAgentGlobal,
          httpsAgent: httpsAgentGlobal,
        }
      );
    } else {
      const data = err?.response?.data;
      console.warn(
        '[OpenSubtitles] download error:',
        status ? `status=${status}` : '',
        err?.message || err
      );
      if (data) {
        console.warn('[OpenSubtitles] download error payload:', data);
      }
      throw err;
    }
  }

  const link = response?.data?.link;
  const fileName = sanitizeFileName(response?.data?.file_name || '');
  if (!link) {
    throw new Error('OpenSubtitles no devolvió un link de descarga');
  }

  const cacheKey = getOpenSubtitlesDownloadCacheKey(configIndex, fileId);
  const info = { link, fileName, ts: Date.now() };
  openSubtitlesDownloadCache.set(cacheKey, info);
  return info;
}

// Track active search AbortControllers so we can abort searches on-demand
const activeSearchControllers = new Set();
let latestQuickSwitchSession = 0;

// Configurar CORS
app.use(cors());
app.use(express.json());

// =====================
// Tracker list (must be before WebTorrent client creation)
// =====================
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://9.rarbg.me:2780/announce',
  'udp://tracker.pirateparty.gr:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.fastcast.nz',
];

const ADD_TORRENT_TIMEOUT_MS = parseInt(
  process.env.PIRATEFLIX_ADD_TORRENT_TIMEOUT_MS || '30000',
  10
);
const DOWNLOAD_TORRENT_TIMEOUT_MS = parseInt(
  process.env.PIRATEFLIX_DOWNLOAD_TORRENT_TIMEOUT_MS || '15000',
  10
);
const DOWNLOAD_TORRENT_RETRIES = parseInt(
  process.env.PIRATEFLIX_DOWNLOAD_TORRENT_RETRIES || '1',
  10
);

// =====================
// WebTorrent client RECREABLE (esto es clave para "reset" real)
// =====================
let client = null;

function wireClientEvents(c) {
  // Un solo handler global (NO dentro de /api/torrent/add)
  c.on('error', (err) => {
    console.error('WebTorrent client error:', err && err.message ? err.message : err);
  });
}

function createWebTorrentClient() {
  const c = new WebTorrent({
    maxConns: 100,
    tracker: {
      announce: DEFAULT_TRACKERS,
    },
  });
  wireClientEvents(c);
  return c;
}

client = createWebTorrentClient();

// =====================
// Estado / caches
// =====================
const activeTorrents = new Map();
const embeddedSubtitlesCache = new Map();
const embeddedAudioTracksCache = new Map();

const STORAGE_ROOT = process.env.PIRATEFLIX_STORAGE_DIR || path.join(SERVER_DIR, 'storage');
const TORRENT_DIR = process.env.PIRATEFLIX_TORRENT_DIR || path.join(STORAGE_ROOT, 'webtorrent');
const CACHE_DIR =
  process.env.PIRATEFLIX_TRANSCODE_DIR || path.join(STORAGE_ROOT, 'transcoded');
const STORAGE_MAX_BYTES = (() => {
  const bytes = Number(process.env.PIRATEFLIX_STORAGE_MAX_BYTES);
  if (Number.isFinite(bytes) && bytes > 0) return Math.floor(bytes);
  const gb = Number(process.env.PIRATEFLIX_STORAGE_MAX_GB || '20');
  if (Number.isFinite(gb) && gb > 0) return Math.floor(gb * 1024 * 1024 * 1024);
  return 0;
})();
const STORAGE_RETENTION_MS = (() => {
  const value = Number(process.env.PIRATEFLIX_STORAGE_RETENTION_MS || String(7 * 24 * 60 * 60 * 1000));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
})();
const STORAGE_PARTIAL_RETENTION_MS = (() => {
  const value = Number(process.env.PIRATEFLIX_STORAGE_PARTIAL_RETENTION_MS || String(2 * 60 * 60 * 1000));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
})();
const STORAGE_SWEEP_INTERVAL_MS = (() => {
  const value = Number(process.env.PIRATEFLIX_STORAGE_SWEEP_INTERVAL_MS || String(10 * 60 * 1000));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
})();
const STORAGE_PRUNE_ON_START =
  String(process.env.PIRATEFLIX_STORAGE_PRUNE_ON_START || 'true').toLowerCase() !== 'false';
const STORAGE_DELETE_ON_TORRENT_DESTROY =
  String(process.env.PIRATEFLIX_STORAGE_DELETE_ON_TORRENT_DESTROY || 'true').toLowerCase() !==
  'false';
const transcodedCache = new Map();

const activeFFmpegProcesses = new Map();
const transcodeJobs = new Map();
const transcodeStatusByKey = new Map();
let storagePruneInProgress = false;
let storageSweepTimer = null;
let lastStoragePruneReport = null;

const MP4_LIKE_EXT_RE = /\.(mp4|mov|m4v)$/i;
const INCOMPATIBLE_VIDEO_HINT_RE = /\b(hevc|x265|h265|av1)\b/i;
const H264_HINT_RE = /\b(x264|h\.?264|avc|web[-\s]?dl|web[-\s]?rip|hdtv)\b/i;
const INCOMPATIBLE_AUDIO_HINT_RE =
  /\b(atmos|truehd|ddp|dd\+|eac3|ac-?3|dts|dd5\.?1|dd5\+1|dd\s*5\.?1|dolby)\b/i;
const COMPATIBLE_AUDIO_HINT_RE = /\b(aac|mp3)\b/i;

// --- NUEVO: tracking de streams activos por torrent ---
// Esto evita destruir torrents mientras el navegador todavía hace Range requests,
// que te estaba generando ERR_CONTENT_LENGTH_MISMATCH/404 al cambiar rápido.
const activeStreamsByInfoHash = new Map(); // infoHash -> count
const pendingDestroy = new Set(); // infoHash marcado para destruir cuando streams=0
// Map para llevar las respuestas HTTP activas por torrent: infoHash -> Set(res)
const activeResponsesByInfoHash = new Map();

function incStream(infoHash) {
  activeStreamsByInfoHash.set(infoHash, (activeStreamsByInfoHash.get(infoHash) || 0) + 1);
}

function decStream(infoHash) {
  const n = (activeStreamsByInfoHash.get(infoHash) || 0) - 1;
  if (n <= 0) activeStreamsByInfoHash.delete(infoHash);
  else activeStreamsByInfoHash.set(infoHash, n);
}

function hasFfmpegForInfoHash(infoHash) {
  for (const key of activeFFmpegProcesses.keys()) {
    if (String(key).startsWith(`${infoHash}_`) || String(key).startsWith(infoHash)) return true;
  }
  return false;
}

function canDestroyNow(infoHash) {
  const streams = activeStreamsByInfoHash.get(infoHash) || 0;
  const ff = hasFfmpegForInfoHash(infoHash);
  return streams === 0 && !ff;
}

function clearEmbeddedCacheForInfoHash(infoHash) {
  for (const k of Array.from(embeddedSubtitlesCache.keys())) {
    if (String(k).startsWith(`${infoHash}-`)) embeddedSubtitlesCache.delete(k);
  }
  for (const k of Array.from(embeddedAudioTracksCache.keys())) {
    if (String(k).startsWith(`${infoHash}-`)) embeddedAudioTracksCache.delete(k);
  }
}

function isPathInside(basePath, targetPath) {
  const base = path.resolve(basePath);
  const target = path.resolve(targetPath);
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isStorageManagedPath(targetPath) {
  return (
    isPathInside(STORAGE_ROOT, targetPath) ||
    isPathInside(TORRENT_DIR, targetPath) ||
    isPathInside(CACHE_DIR, targetPath)
  );
}

function getDirectorySizeBytes(targetPath) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch (_) {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        total += getDirectorySizeBytes(fullPath);
      } else {
        total += Number(fs.statSync(fullPath).size || 0);
      }
    } catch (_) {}
  }
  return total;
}

function listManagedStorageEntries(baseDir, category) {
  let names = [];
  try {
    names = fs.readdirSync(baseDir);
  } catch (_) {
    return [];
  }

  const entries = [];
  for (const name of names) {
    const fullPath = path.join(baseDir, name);
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      entries.push({
        category,
        name,
        fullPath,
        mtimeMs: Number(stat.mtimeMs) || 0,
        sizeBytes: stat.isDirectory() ? getDirectorySizeBytes(fullPath) : Number(stat.size || 0),
      });
    } catch (_) {}
  }
  return entries;
}

function removePathSafe(targetPath) {
  if (!targetPath || !isStorageManagedPath(targetPath)) return false;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn('No se pudo eliminar ruta de almacenamiento:', targetPath, err?.message || err);
    return false;
  }
}

function removeEmptyDirs(baseDir, keepRoot = true) {
  if (!fs.existsSync(baseDir)) return 0;
  let removed = 0;

  const walk = (dirPath, isRoot) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      walk(path.join(dirPath, entry.name), false);
    }

    if (isRoot && keepRoot) return;
    try {
      if (fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
        removed += 1;
      }
    } catch (_) {}
  };

  walk(baseDir, true);
  return removed;
}

function getTorrentDataPaths(torrent) {
  const targets = new Set();
  if (!torrent || !torrent.path || !Array.isArray(torrent.files)) return [];
  const torrentBase = path.resolve(torrent.path);

  for (const file of torrent.files) {
    const relRaw = String(file?.path || '').trim();
    if (!relRaw) continue;
    const rel = relRaw.replace(/\\/g, '/');
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const targetRel = parts.length > 1 ? parts[0] : rel;
    const candidate = path.resolve(torrentBase, targetRel);
    if (isPathInside(torrentBase, candidate) && isStorageManagedPath(candidate)) {
      targets.add(candidate);
    }
  }

  return Array.from(targets);
}

function collectStorageSummary() {
  const torrentEntries = listManagedStorageEntries(TORRENT_DIR, 'torrent');
  const transcodeEntries = listManagedStorageEntries(CACHE_DIR, 'transcoded');
  const allEntries = [...torrentEntries, ...transcodeEntries];
  const totalBytes = allEntries.reduce((acc, item) => acc + Number(item.sizeBytes || 0), 0);
  return {
    roots: {
      storage: STORAGE_ROOT,
      torrents: TORRENT_DIR,
      transcoded: CACHE_DIR,
    },
    policy: {
      maxBytes: STORAGE_MAX_BYTES,
      retentionMs: STORAGE_RETENTION_MS,
      partialRetentionMs: STORAGE_PARTIAL_RETENTION_MS,
      sweepIntervalMs: STORAGE_SWEEP_INTERVAL_MS,
      pruneOnStart: STORAGE_PRUNE_ON_START,
      deleteOnTorrentDestroy: STORAGE_DELETE_ON_TORRENT_DESTROY,
    },
    usage: {
      totalBytes,
      torrentsBytes: torrentEntries.reduce((acc, item) => acc + Number(item.sizeBytes || 0), 0),
      transcodedBytes: transcodeEntries.reduce((acc, item) => acc + Number(item.sizeBytes || 0), 0),
      torrentItems: torrentEntries.length,
      transcodedItems: transcodeEntries.length,
    },
    entries: allEntries,
  };
}

function pruneStorage(reason = 'manual') {
  if (storagePruneInProgress) {
    return {
      success: false,
      skipped: true,
      reason,
      message: 'prune-in-progress',
      ts: Date.now(),
    };
  }

  storagePruneInProgress = true;
  const startedAt = Date.now();
  const removed = [];

  try {
    const before = collectStorageSummary();
    let candidates = [...before.entries];
    const now = Date.now();
    const staleCutoff = STORAGE_RETENTION_MS > 0 ? now - STORAGE_RETENTION_MS : 0;
    const partialCutoff =
      STORAGE_PARTIAL_RETENTION_MS > 0 ? now - STORAGE_PARTIAL_RETENTION_MS : 0;

    const deleteCandidate = (entry, why) => {
      if (!entry) return false;
      if (!fs.existsSync(entry.fullPath)) return false;
      if (!removePathSafe(entry.fullPath)) return false;
      removed.push({
        path: entry.fullPath,
        category: entry.category,
        sizeBytes: Number(entry.sizeBytes || 0),
        mtimeMs: Number(entry.mtimeMs || 0),
        reason: why,
      });
      return true;
    };

    if (partialCutoff > 0) {
      const partials = candidates
        .filter(
          (entry) =>
            entry.category === 'transcoded' &&
            String(entry.name || '').endsWith('.partial') &&
            Number(entry.mtimeMs || 0) > 0 &&
            Number(entry.mtimeMs || 0) < partialCutoff
        )
        .sort((a, b) => Number(a.mtimeMs || 0) - Number(b.mtimeMs || 0));

      for (const entry of partials) {
        deleteCandidate(entry, 'stale-partial');
      }
    }

    if (staleCutoff > 0) {
      candidates = [
        ...listManagedStorageEntries(TORRENT_DIR, 'torrent'),
        ...listManagedStorageEntries(CACHE_DIR, 'transcoded'),
      ];

      const stale = candidates
        .filter(
          (entry) =>
            Number(entry.mtimeMs || 0) > 0 &&
            Number(entry.mtimeMs || 0) < staleCutoff &&
            !String(entry.name || '').endsWith('.partial')
        )
        .sort((a, b) => Number(a.mtimeMs || 0) - Number(b.mtimeMs || 0));

      for (const entry of stale) {
        deleteCandidate(entry, 'retention');
      }
    }

    candidates = [
      ...listManagedStorageEntries(TORRENT_DIR, 'torrent'),
      ...listManagedStorageEntries(CACHE_DIR, 'transcoded'),
    ];
    let totalBytes = candidates.reduce((acc, item) => acc + Number(item.sizeBytes || 0), 0);

    if (STORAGE_MAX_BYTES > 0 && totalBytes > STORAGE_MAX_BYTES) {
      const quotaCandidates = candidates
        .slice()
        .sort((a, b) => Number(a.mtimeMs || 0) - Number(b.mtimeMs || 0));

      for (const entry of quotaCandidates) {
        if (totalBytes <= STORAGE_MAX_BYTES) break;
        if (deleteCandidate(entry, 'quota')) {
          totalBytes -= Number(entry.sizeBytes || 0);
        }
      }
    }

    const emptyTorrentDirs = removeEmptyDirs(TORRENT_DIR, true);
    const emptyTranscodedDirs = removeEmptyDirs(CACHE_DIR, true);
    const after = collectStorageSummary();
    const report = {
      success: true,
      skipped: false,
      reason,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      policy: after.policy,
      removedCount: removed.length,
      removedBytes: removed.reduce((acc, item) => acc + Number(item.sizeBytes || 0), 0),
      removed,
      emptyDirsRemoved: {
        torrents: emptyTorrentDirs,
        transcoded: emptyTranscodedDirs,
      },
      before: before.usage,
      after: after.usage,
    };

    lastStoragePruneReport = report;
    return report;
  } finally {
    storagePruneInProgress = false;
  }
}

function selectOnlyFile(torrent, fileIndex) {
  if (!torrent || !Array.isArray(torrent.files)) return;
  torrent.files.forEach((f, idx) => {
    try {
      if (idx === fileIndex) {
        f.select();
      } else {
        f.deselect();
      }
    } catch (_) {}
  });
}

function destroyTorrentNow(infoHash) {
  const torrent = client?.get(infoHash);
  if (!torrent) return false;
  const torrentDataPaths = getTorrentDataPaths(torrent);

  try {
    torrent.destroy(() => {
      activeTorrents.delete(infoHash);
      clearEmbeddedCacheForInfoHash(infoHash);
      pendingDestroy.delete(infoHash);
      if (STORAGE_DELETE_ON_TORRENT_DESTROY && torrentDataPaths.length > 0) {
        for (const targetPath of torrentDataPaths) {
          removePathSafe(targetPath);
        }
        removeEmptyDirs(TORRENT_DIR, true);
      }
      console.log('Torrent eliminado:', infoHash);
    });
    return true;
  } catch (e) {
    console.warn('Error destruyendo torrent:', infoHash, e && e.message ? e.message : e);
    return false;
  }
}

function maybeDestroyPending(infoHash) {
  if (pendingDestroy.has(infoHash) && canDestroyNow(infoHash)) {
    destroyTorrentNow(infoHash);
  }
}

function attachStreamLifecycle(infoHash, res) {
  incStream(infoHash);
  // Registrar la respuesta activa
  try {
    let s = activeResponsesByInfoHash.get(infoHash);
    if (!s) {
      s = new Set();
      activeResponsesByInfoHash.set(infoHash, s);
    }
    s.add(res);
  } catch (e) {
    /* ignore */
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;

    decStream(infoHash);

    // Quitar la respuesta del tracking
    try {
      const s = activeResponsesByInfoHash.get(infoHash);
      if (s) {
        s.delete(res);
        if (s.size === 0) activeResponsesByInfoHash.delete(infoHash);
      }
    } catch (e) {
      /* ignore */
    }

    // Si estaba pendiente de destruirse y ya no quedan streams/ffmpeg, destruye
    if (pendingDestroy.has(infoHash) && canDestroyNow(infoHash)) {
      destroyTorrentNow(infoHash);
    }
  };

  res.on('close', release);
  res.on('finish', release);
}

const ensureDir = (dirPath, label) => {
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
  console.log(`📁 Directorio ${label} creado:`, dirPath);
};

ensureDir(TORRENT_DIR, 'de torrents');
ensureDir(CACHE_DIR, 'de transcodificacion');
console.log(
  '🗄️ Storage policy:',
  JSON.stringify(
    {
      root: STORAGE_ROOT,
      torrentDir: TORRENT_DIR,
      transcodeDir: CACHE_DIR,
      maxBytes: STORAGE_MAX_BYTES,
      retentionMs: STORAGE_RETENTION_MS,
      partialRetentionMs: STORAGE_PARTIAL_RETENTION_MS,
      sweepIntervalMs: STORAGE_SWEEP_INTERVAL_MS,
      pruneOnStart: STORAGE_PRUNE_ON_START,
      deleteOnTorrentDestroy: STORAGE_DELETE_ON_TORRENT_DESTROY,
    },
    null,
    2
  )
);
if (STORAGE_PRUNE_ON_START) {
  setTimeout(() => {
    try {
      const report = pruneStorage('startup');
      if (!report?.skipped) {
        console.log(
          `🧹 Storage prune startup: removed=${report.removedCount}, freed=${report.removedBytes} bytes`
        );
      }
    } catch (err) {
      console.warn('Storage prune startup falló:', err?.message || err);
    }
  }, 500);
}
if (STORAGE_SWEEP_INTERVAL_MS > 0) {
  storageSweepTimer = setInterval(() => {
    try {
      const report = pruneStorage('scheduled');
      if (!report?.skipped && report?.removedCount > 0) {
        console.log(
          `🧹 Storage prune scheduled: removed=${report.removedCount}, freed=${report.removedBytes} bytes`
        );
      }
    } catch (err) {
      console.warn('Storage prune scheduled falló:', err?.message || err);
    }
  }, STORAGE_SWEEP_INTERVAL_MS);
  if (storageSweepTimer && typeof storageSweepTimer.unref === 'function') {
    storageSweepTimer.unref();
  }
}

function buildTorrentFilePathCandidates(torrent, file) {
  const candidates = [];
  const pushCandidate = (value) => {
    if (!value) return;
    const normalized = path.normalize(String(value));
    if (!normalized) return;
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  const filePath = String(file?.path || '').trim();
  const fileName = String(file?.name || '').trim();
  const torrentName = String(torrent?.name || '').trim();
  const torrentPath = String(torrent?.path || TORRENT_DIR).trim();

  if (path.isAbsolute(filePath)) {
    pushCandidate(filePath);
  } else {
    pushCandidate(path.join(torrentPath, filePath));
    pushCandidate(path.join(TORRENT_DIR, filePath));
  }
  if (fileName) {
    pushCandidate(path.join(torrentPath, fileName));
    pushCandidate(path.join(TORRENT_DIR, fileName));
  }
  if (fileName && torrentName) {
    pushCandidate(path.join(torrentPath, torrentName, fileName));
    pushCandidate(path.join(TORRENT_DIR, torrentName, fileName));
  }

  return candidates;
}

function resolveExistingTorrentFilePath(torrent, file) {
  const candidates = buildTorrentFilePathCandidates(torrent, file);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return candidates[0] || null;
}

// Helper: esperar hasta que el archivo exista en disco y tenga al menos `minBytes` bytes
async function waitForFileOnDisk(file, filePathOrCandidates, minBytes = 1024, timeoutMs = 15000) {
  const start = Date.now();
  const candidates = (Array.isArray(filePathOrCandidates)
    ? filePathOrCandidates
    : [filePathOrCandidates]
  )
    .filter(Boolean)
    .map((item) => path.normalize(String(item)));
  const requiredBytes = Math.min(minBytes, Number(file?.length || minBytes));

  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        try {
          file.select(0, Math.min(requiredBytes, Number(file?.length || requiredBytes)));
        } catch (e) {
          // ignore
        }

        for (const candidate of candidates) {
          if (!candidate) continue;
          if (fs.existsSync(candidate)) {
            const stat = fs.statSync(candidate);
            if (stat.size >= requiredBytes || Number(file?.downloaded || 0) > 0) {
              return resolve(candidate);
            }
          }
        }

        if (Date.now() - start > timeoutMs) {
          return reject(new Error('Timeout waiting for file on disk'));
        }
      } catch (err) {
        return reject(err);
      }
      setTimeout(check, 150);
    };
    check();
  });
}

// Helper: ejecutar ffprobe con argumentos mejorados para archivos en descargan
async function ffprobeWithRetry(filePath, retries = 2) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-probesize', '50000000',
      '-analyzeduration', '30000000',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];
    
    const attemptProbe = (attempt) => {
      execFile('ffprobe', args, (err, stdout, stderr) => {
        if (err) {
          if (attempt < retries) {
            // Si falla y tenemos reintentos, esperar progresivamente más
            const delay = 1000 * (attempt + 1);
            setTimeout(() => attemptProbe(attempt + 1), delay);
            return;
          }
          console.error(`ffprobe falló después de ${retries} intentos:`, stderr || err.message);
          reject(err);
          return;
        }
        
        try {
          const metadata = JSON.parse(stdout);
          resolve(metadata);
        } catch (parseErr) {
          reject(new Error('No se pudo analizar resultado de ffprobe: ' + parseErr.message));
        }
      });
    };
    
    attemptProbe(0);
  });
}

const MP4_FASTSTART_SCAN_BYTES = 1024 * 1024;
const MP4_FASTSTART_MIN_BYTES = 64 * 1024;
const MP4_ATOM_MOOV = Buffer.from('moov');
const MP4_ATOM_MDAT = Buffer.from('mdat');

async function isLikelyFaststartMp4(file, filePath) {
  try {
    await waitForFileOnDisk(file, filePath, Math.min(256 * 1024, file.length), 3000);
  } catch (_) {
    return false;
  }

  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return false;
  }

  const readBytes = Math.min(stat.size, MP4_FASTSTART_SCAN_BYTES);
  if (readBytes < MP4_FASTSTART_MIN_BYTES) return false;

  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, 0);

    const moovIndex = buf.indexOf(MP4_ATOM_MOOV);
    if (moovIndex === -1) return false;
    const mdatIndex = buf.indexOf(MP4_ATOM_MDAT);
    if (mdatIndex === -1) return true;
    return moovIndex < mdatIndex;
  } catch (_) {
    return false;
  } finally {
    if (fd) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

function isMp4LikeName(name) {
  return MP4_LIKE_EXT_RE.test(String(name || '').toLowerCase());
}

function hasIncompatibleVideoHint(name) {
  return INCOMPATIBLE_VIDEO_HINT_RE.test(String(name || '').toLowerCase());
}

function hasH264Hint(name) {
  return H264_HINT_RE.test(String(name || '').toLowerCase());
}

function hasIncompatibleAudioHint(name) {
  return INCOMPATIBLE_AUDIO_HINT_RE.test(String(name || '').toLowerCase());
}

function hasCompatibleAudioHint(name) {
  return COMPATIBLE_AUDIO_HINT_RE.test(String(name || '').toLowerCase());
}

function getTranscodeKey(infoHash, fileIndex, audioStreamIndex) {
  const audioSuffix = Number.isFinite(audioStreamIndex) ? `_a${audioStreamIndex}` : '';
  return `${infoHash}_${fileIndex}${audioSuffix}`;
}

function timemarkToSeconds(timemark) {
  if (!timemark || typeof timemark !== 'string') return null;
  const parts = timemark.trim().split(':');
  if (parts.length < 2) return null;
  const secondsPart = parts.pop();
  const minutesPart = parts.pop();
  const hoursPart = parts.pop();
  const seconds = Number(secondsPart);
  const minutes = Number(minutesPart);
  const hours = hoursPart ? Number(hoursPart) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function upsertTranscodeStatus(cacheKey, patch) {
  const current = transcodeStatusByKey.get(cacheKey) || {};
  const next = { ...current, ...patch, updatedAt: Date.now() };
  transcodeStatusByKey.set(cacheKey, next);
  return next;
}

function clearTranscodeStatus(cacheKey, patch) {
  if (!transcodeStatusByKey.has(cacheKey)) return;
  if (patch) {
    upsertTranscodeStatus(cacheKey, patch);
    return;
  }
  transcodeStatusByKey.delete(cacheKey);
}

function getTranscodedCachePath(cacheKey) {
  return path.join(CACHE_DIR, `${cacheKey}.mp4`);
}

function removeTranscodedFiles(cacheKey) {
  const finalPath = getTranscodedCachePath(cacheKey);
  const partialPath = `${finalPath}.partial`;
  try {
    fs.unlinkSync(finalPath);
  } catch (_) {}
  try {
    fs.unlinkSync(partialPath);
  } catch (_) {}
}

function abortTranscodeJob(cacheKey, reason) {
  const job = transcodeJobs.get(cacheKey);
  if (!job) return;
  transcodeJobs.delete(cacheKey);
  try {
    job.reject(new Error(reason || 'Transcode aborted'));
  } catch (_) {}
}

function abortAllTranscodeJobs(reason) {
  for (const key of Array.from(transcodeJobs.keys())) {
    abortTranscodeJob(key, reason);
  }
}

function clearTranscodeEntry(cacheKey, reason) {
  const proc = activeFFmpegProcesses.get(cacheKey);
  if (proc) {
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
    activeFFmpegProcesses.delete(cacheKey);
  }
  abortTranscodeJob(cacheKey, reason);
  removeTranscodedFiles(cacheKey);
  transcodedCache.delete(cacheKey);
  clearTranscodeStatus(cacheKey, { status: 'aborted', error: reason || 'aborted' });
}

function clearAllTranscodeEntries(reason) {
  const keys = new Set([
    ...Array.from(transcodedCache.keys()),
    ...Array.from(transcodeJobs.keys()),
    ...Array.from(activeFFmpegProcesses.keys()),
  ]);
  for (const key of keys) {
    clearTranscodeEntry(key, reason);
  }
}

async function determineTranscodeMode(file, filePath, audioStreamIndex) {
  const name = String(file?.name || '').toLowerCase();
  const isMp4Like = isMp4LikeName(name);
  const hasIncompatibleVideo = hasIncompatibleVideoHint(name);
  const hasH264Video = hasH264Hint(name);
  const hasIncompatibleAudio = hasIncompatibleAudioHint(name);
  const hasCompatibleAudio = hasCompatibleAudioHint(name);
  let faststart = false;

  if (isMp4Like && !hasIncompatibleVideo) {
    try {
      faststart = await isLikelyFaststartMp4(file, filePath);
    } catch (_) {
      faststart = false;
    }
  }

  if (Number.isFinite(audioStreamIndex)) {
    return {
      mode: isMp4Like && !hasIncompatibleVideo ? 'audio' : hasH264Video ? 'audio' : 'full',
      isMp4Like,
      hasIncompatibleVideo,
      faststart,
    };
  }

  if (!isMp4Like || hasIncompatibleVideo) {
    if (!hasIncompatibleVideo && hasH264Video) {
      return {
        mode: hasCompatibleAudio && !hasIncompatibleAudio ? 'remux' : 'audio',
        isMp4Like,
        hasIncompatibleVideo,
        faststart,
      };
    }
    return { mode: 'full', isMp4Like, hasIncompatibleVideo, faststart };
  }

  if (hasIncompatibleAudio) {
    return { mode: 'audio', isMp4Like, hasIncompatibleVideo, faststart };
  }

  if (!faststart) {
    return { mode: 'remux', isMp4Like, hasIncompatibleVideo, faststart };
  }

  return { mode: 'none', isMp4Like, hasIncompatibleVideo, faststart };
}

async function ensureTranscodedFile({
  cacheKey,
  infoHash,
  fileIndex,
  file,
  filePath,
  filePathCandidates = [],
  mode,
  audioStreamIndex,
}) {
  const cachedPath = getTranscodedCachePath(cacheKey);

  if (transcodedCache.get(cacheKey) === 'ready' && fs.existsSync(cachedPath)) {
    upsertTranscodeStatus(cacheKey, { status: 'ready', percent: 100 });
    return cachedPath;
  }

  if (fs.existsSync(cachedPath)) {
    transcodedCache.set(cacheKey, 'ready');
    upsertTranscodeStatus(cacheKey, { status: 'ready', percent: 100 });
    return cachedPath;
  }

  const existingJob = transcodeJobs.get(cacheKey);
  if (existingJob) {
    return existingJob.promise;
  }

  upsertTranscodeStatus(cacheKey, {
    status: 'queued',
    mode,
    infoHash,
    fileIndex,
    audioStreamIndex: Number.isFinite(audioStreamIndex) ? audioStreamIndex : null,
    startedAt: Date.now(),
    percent: 0,
  });

  let resolveJob = null;
  let rejectJob = null;
  const jobPromise = new Promise((resolve, reject) => {
    resolveJob = resolve;
    rejectJob = reject;
  });

  transcodeJobs.set(cacheKey, { promise: jobPromise, reject: rejectJob });
  transcodedCache.set(cacheKey, 'transcoding');

  const existing = activeFFmpegProcesses.get(cacheKey);
  if (existing) {
    try {
      existing.kill('SIGKILL');
    } catch (_) {}
    activeFFmpegProcesses.delete(cacheKey);
  }

  // --- Resume support: detect partial progress for logging ---
  const partialPath = `${cachedPath}.partial`;
  if (fs.existsSync(partialPath)) {
    try {
      const stat = fs.statSync(partialPath);
      if (stat.size > 256 * 1024) {
        console.log(`🔄 Previous partial file found (${(stat.size / 1024 / 1024).toFixed(1)} MB). Restarting transcode...`);
      }
    } catch (_) {}
    removeTranscodedFiles(cacheKey);
  }

  const useTorrentStream = Number(file?.downloaded || 0) < Number(file?.length || 0);
  let inputStream = null;
  if (useTorrentStream) {
    inputStream = file.createReadStream();
  } else {
    try {
      await waitForFileOnDisk(
        file,
        filePathCandidates.length > 0 ? filePathCandidates : filePath,
        Math.min(64 * 1024, file.length),
        15000
      );
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló antes de transcodificar:', err.message);
    }
  }

  const inputSource = useTorrentStream ? inputStream : filePath;

  // Get duration for progress tracking - retry with delay if file is still downloading
  const probeDuration = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const metadata = await ffprobeWithRetry(filePath, 1);
        const duration = metadata?.format?.duration;
        if (Number.isFinite(duration) && duration > 0) {
          upsertTranscodeStatus(cacheKey, { durationSec: duration });
          console.log(`📏 Duración detectada: ${Math.round(duration)}s`);
          return;
        }
      } catch (_) {}
      // Wait for more data to download before retrying
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
    console.warn('ffprobe: no se pudo determinar duración para progreso');
  };
  probeDuration();

  const mapOptions = [];
  if (Number.isFinite(audioStreamIndex)) {
    mapOptions.push('-map', '0:v:0', '-map', `0:${audioStreamIndex}?`);
  }

  const outputOptions = [
    ...mapOptions,
    '-movflags +faststart',
    '-max_muxing_queue_size 1024',
  ];

  const ffmpegCommand = ffmpeg(inputSource)
    .format('mp4')
    .outputOptions(outputOptions)
    .on('start', (cmdLine) => {
      console.log('🔄 FFmpeg preparando MP4 seekable:', cacheKey, `(mode=${mode})`);
      console.log('📋 FFmpeg cmd:', cmdLine);
      upsertTranscodeStatus(cacheKey, { status: 'running' });
    })
    .on('progress', (progress) => {
      const current = transcodeStatusByKey.get(cacheKey) || {};
      const rawPercent = Number(progress?.percent);
      let percent = Number.isFinite(rawPercent) ? rawPercent : null;
      if (percent === null) {
        const durationSec = Number(current?.durationSec);
        const markSec = timemarkToSeconds(progress?.timemark);
        if (
          Number.isFinite(durationSec) &&
          Number.isFinite(markSec) &&
          durationSec > 0
        ) {
          percent = (markSec / durationSec) * 100;
        }
      }

      const next = upsertTranscodeStatus(cacheKey, {
        status: 'running',
        percent: percent !== null ? Math.max(0, Math.min(100, percent)) : null,
        timemark: progress?.timemark || '',
        outputBytes: Number.isFinite(progress?.targetSize)
          ? Math.max(0, Math.round(progress.targetSize * 1024))
          : null,
      });

      const percentInt =
        Number.isFinite(next.percent) && next.percent !== null
          ? Math.floor(next.percent)
          : null;
      const lastLoggedPercent = Number(next?.lastLoggedPercent) || 0;
      const lastLoggedAt = Number(next?.lastLoggedAt) || 0;
      const now = Date.now();

      if (percentInt !== null) {
        const bucket = Math.floor(percentInt / 5) * 5;
        if (bucket >= lastLoggedPercent + 5) {
          console.log(`⏳ Transcodificando ${cacheKey}: ${bucket}%`);
          upsertTranscodeStatus(cacheKey, { lastLoggedPercent: bucket });
        }
      } else if (now - lastLoggedAt > 30000) {
        const mark = next.timemark ? ` (${next.timemark})` : '';
        console.log(`⏳ Transcodificando ${cacheKey}: en progreso${mark}`);
        upsertTranscodeStatus(cacheKey, { lastLoggedAt: now });
      }
    })
    .on('error', (err) => {
      if (!String(err.message || '').includes('SIGKILL')) {
        console.error('❌ Error FFmpeg:', err.message);
      }
      if (inputStream) {
        try {
          inputStream.destroy();
        } catch (_) {}
      }
      activeFFmpegProcesses.delete(cacheKey);
      transcodedCache.delete(cacheKey);
      removeTranscodedFiles(cacheKey);
      transcodeJobs.delete(cacheKey);
      clearTranscodeStatus(cacheKey, { status: 'error', error: err.message || 'ffmpeg-error' });
      if (infoHash) {
        maybeDestroyPending(infoHash);
      }
      try {
        rejectJob(err);
      } catch (_) {}
    })
    .on('end', async () => {
      if (inputStream) {
        try {
          inputStream.destroy();
        } catch (_) {}
      }
      activeFFmpegProcesses.delete(cacheKey);
      if (infoHash) {
        maybeDestroyPending(infoHash);
      }
      try {
        fs.renameSync(partialPath, cachedPath);
      } catch (err) {
        console.error('Error moviendo archivo transcodificado:', err.message);
        transcodedCache.delete(cacheKey);
        removeTranscodedFiles(cacheKey);
        transcodeJobs.delete(cacheKey);
        if (infoHash) {
          maybeDestroyPending(infoHash);
        }
        try {
          rejectJob(err);
        } catch (_) {}
        return;
      }

      // Validate transcoded file with ffprobe
      try {
        const meta = await ffprobeWithRetry(cachedPath, 1);
        const vStream = (meta?.streams || []).find(s => s.codec_type === 'video');
        if (!vStream) throw new Error('No video stream in transcoded file');
        const duration = Number(meta?.format?.duration);
        if (!Number.isFinite(duration) || duration < 1) {
          throw new Error(`Invalid duration: ${duration}`);
        }
        const fileStat = fs.statSync(cachedPath);
        console.log(`✅ Validación OK: ${vStream.codec_name} ${vStream.width}x${vStream.height}, ${Math.round(duration)}s, ${(fileStat.size / 1024 / 1024).toFixed(1)} MB`);
      } catch (valErr) {
        console.error('❌ Archivo transcodificado inválido:', valErr.message);
        transcodedCache.delete(cacheKey);
        removeTranscodedFiles(cacheKey);
        transcodeJobs.delete(cacheKey);
        try {
          rejectJob(new Error('Transcoded file validation failed: ' + valErr.message));
        } catch (_) {}
        return;
      }

      transcodedCache.set(cacheKey, 'ready');
      transcodeJobs.delete(cacheKey);
      upsertTranscodeStatus(cacheKey, { status: 'ready', percent: 100, completedAt: Date.now() });
      try {
        resolveJob(cachedPath);
      } catch (_) {}
    });

  if (mode === 'full') {
    ffmpegCommand
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('192k')
      .videoFilter('scale=-2:720')
      .outputOptions([
        '-preset ultrafast',
        '-crf 28',
        '-threads 0',
        '-g 30',
        '-bf 0',
        '-refs 1',
        '-rc-lookahead 0',
      ]);
  } else if (mode === 'audio') {
    ffmpegCommand
      .videoCodec('copy')
      .audioCodec('aac')
      .audioBitrate('192k')
      .outputOptions(['-threads 0']);
  } else if (mode === 'remux') {
    ffmpegCommand
      .videoCodec('copy')
      .audioCodec('copy')
      .outputOptions(['-threads 0']);
  }

  activeFFmpegProcesses.set(cacheKey, ffmpegCommand);
  ffmpegCommand.save(partialPath);

  return jobPromise;
}

async function streamTranscodedFile({
  cacheKey,
  infoHash,
  fileIndex,
  file,
  filePath,
  filePathCandidates = [],
  mode,
  audioStreamIndex,
  res,
}) {
  const existing = activeFFmpegProcesses.get(cacheKey);
  if (existing) {
    try {
      existing.kill('SIGKILL');
    } catch (_) {}
    activeFFmpegProcesses.delete(cacheKey);
  }

  upsertTranscodeStatus(cacheKey, {
    status: 'running',
    mode,
    infoHash,
    fileIndex,
    audioStreamIndex: Number.isFinite(audioStreamIndex) ? audioStreamIndex : null,
    startedAt: Date.now(),
    percent: null,
  });

  const useTorrentStream = Number(file?.downloaded || 0) < Number(file?.length || 0);
  let inputStream = null;
  if (useTorrentStream) {
    inputStream = file.createReadStream();
  } else {
    try {
      await waitForFileOnDisk(
        file,
        filePathCandidates.length > 0 ? filePathCandidates : filePath,
        Math.min(64 * 1024, file.length),
        15000
      );
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló antes de streaming:', err.message);
    }
  }

  const inputSource = useTorrentStream ? inputStream : filePath;

  const mapOptions = [];
  if (Number.isFinite(audioStreamIndex)) {
    mapOptions.push('-map', '0:v:0', '-map', `0:${audioStreamIndex}?`);
  }

  const outputOptions = [
    ...mapOptions,
    '-movflags +frag_keyframe+empty_moov+default_base_moof',
    '-max_muxing_queue_size 1024',
  ];

  let closed = false;
  let finished = false;
  let ffmpegCommand = null;

  const cleanup = () => {
    if (inputStream) {
      try {
        inputStream.destroy();
      } catch (_) {}
    }
    activeFFmpegProcesses.delete(cacheKey);
    if (infoHash) {
      maybeDestroyPending(infoHash);
    }
  };

  res.on('close', () => {
    closed = true;
    try {
      if (ffmpegCommand) ffmpegCommand.kill('SIGKILL');
    } catch (_) {}
    if (!finished) {
      cleanup();
      clearTranscodeStatus(cacheKey, {
        status: 'aborted',
        error: 'client-disconnected',
      });
    }
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'none',
  });

  ffmpegCommand = ffmpeg(inputSource)
    .format('mp4')
    .outputOptions(outputOptions)
    .on('start', () => {
      console.log('🔄 FFmpeg streaming MP4:', cacheKey, `(mode=${mode})`);
      upsertTranscodeStatus(cacheKey, { status: 'running' });
    })
    .on('progress', (progress) => {
      const current = transcodeStatusByKey.get(cacheKey) || {};
      const rawPercent = Number(progress?.percent);
      let percent = Number.isFinite(rawPercent) ? rawPercent : null;
      if (percent === null) {
        const durationSec = Number(current?.durationSec);
        const markSec = timemarkToSeconds(progress?.timemark);
        if (
          Number.isFinite(durationSec) &&
          Number.isFinite(markSec) &&
          durationSec > 0
        ) {
          percent = (markSec / durationSec) * 100;
        }
      }

      const next = upsertTranscodeStatus(cacheKey, {
        status: 'running',
        percent: percent !== null ? Math.max(0, Math.min(100, percent)) : null,
        timemark: progress?.timemark || '',
        outputBytes: Number.isFinite(progress?.targetSize)
          ? Math.max(0, Math.round(progress.targetSize * 1024))
          : null,
      });

      const percentInt =
        Number.isFinite(next.percent) && next.percent !== null
          ? Math.floor(next.percent)
          : null;
      const lastLoggedPercent = Number(next?.lastLoggedPercent) || 0;
      const lastLoggedAt = Number(next?.lastLoggedAt) || 0;
      const now = Date.now();

      if (percentInt !== null) {
        const bucket = Math.floor(percentInt / 5) * 5;
        if (bucket >= lastLoggedPercent + 5) {
          console.log(`⏳ Transcodificando ${cacheKey}: ${bucket}%`);
          upsertTranscodeStatus(cacheKey, { lastLoggedPercent: bucket });
        }
      } else if (now - lastLoggedAt > 30000) {
        const mark = next.timemark ? ` (${next.timemark})` : '';
        console.log(`⏳ Transcodificando ${cacheKey}: en progreso${mark}`);
        upsertTranscodeStatus(cacheKey, { lastLoggedAt: now });
      }
    })
    .on('error', (err) => {
      if (closed) return;
      if (!String(err.message || '').includes('SIGKILL')) {
        console.error('❌ Error FFmpeg (stream):', err.message);
      }
      finished = true;
      cleanup();
      clearTranscodeStatus(cacheKey, { status: 'error', error: err.message || 'ffmpeg-error' });
      if (!res.headersSent) {
        res.status(500).send('Error al preparar video');
      }
    })
    .on('end', () => {
      finished = true;
      cleanup();
      upsertTranscodeStatus(cacheKey, { status: 'ready', percent: 100, completedAt: Date.now() });
    });

  if (mode === 'full') {
    ffmpegCommand
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('192k')
      .videoFilter('scale=-2:720')
      .outputOptions([
        '-preset ultrafast',
        '-crf 28',
        '-threads 0',
        '-g 30',
        '-bf 0',
      ]);
  } else if (mode === 'audio') {
    ffmpegCommand
      .videoCodec('copy')
      .audioCodec('aac')
      .audioBitrate('192k')
      .outputOptions(['-threads 0']);
  } else if (mode === 'remux') {
    ffmpegCommand
      .videoCodec('copy')
      .audioCodec('copy')
      .outputOptions(['-threads 0']);
  }

  activeFFmpegProcesses.set(cacheKey, ffmpegCommand);
  ffmpegCommand.pipe(res, { end: true });
}

// =====================
// Seek por tiempo - Stream instantáneo desde cualquier posición
// =====================
async function streamSeekFromTime({
  infoHash,
  fileIndex,
  file,
  filePath,
  filePathCandidates = [],
  seekTime,
  mode,
  audioStreamIndex,
  res,
}) {
  const cacheKey = `seek_${infoHash}_${fileIndex}_${Math.floor(seekTime)}`;
  
  const existing = activeFFmpegProcesses.get(cacheKey);
  if (existing) {
    try {
      existing.kill('SIGKILL');
    } catch (_) {}
    activeFFmpegProcesses.delete(cacheKey);
  }

  const useTorrentStream = Number(file?.downloaded || 0) < Number(file?.length || 0);
  let inputStream = null;
  
  // Para seek, preferimos el archivo en disco si está disponible
  if (!useTorrentStream) {
    try {
      await waitForFileOnDisk(
        file,
        filePathCandidates.length > 0 ? filePathCandidates : filePath,
        Math.min(64 * 1024, file.length),
        15000
      );
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló antes de seek:', err.message);
    }
  } else {
    inputStream = file.createReadStream();
  }

  const inputSource = useTorrentStream ? inputStream : filePath;

  const mapOptions = [];
  if (Number.isFinite(audioStreamIndex)) {
    mapOptions.push('-map', '0:v:0', '-map', `0:${audioStreamIndex}?`);
  }

  const outputOptions = [
    ...mapOptions,
    '-movflags +frag_keyframe+empty_moov+default_base_moof',
    '-max_muxing_queue_size 1024',
  ];

  let closed = false;
  let finished = false;
  let ffmpegCommand = null;

  const cleanup = () => {
    if (inputStream) {
      try {
        inputStream.destroy();
      } catch (_) {}
    }
    activeFFmpegProcesses.delete(cacheKey);
    if (infoHash) {
      maybeDestroyPending(infoHash);
    }
  };

  res.on('close', () => {
    closed = true;
    try {
      if (ffmpegCommand) ffmpegCommand.kill('SIGKILL');
    } catch (_) {}
    if (!finished) {
      cleanup();
    }
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'none',
  });

  // Crear comando ffmpeg con -ss ANTES del input para seek rápido a keyframe
  ffmpegCommand = ffmpeg()
    .input(inputSource)
    .inputOptions([`-ss ${seekTime}`]) // Seek rápido antes del input
    .format('mp4')
    .outputOptions(outputOptions)
    .on('start', (cmd) => {
      console.log(`🔄 FFmpeg seek streaming desde ${seekTime}s:`, file.name);
    })
    .on('error', (err) => {
      if (closed) return;
      if (!String(err.message || '').includes('SIGKILL')) {
        console.error('❌ Error FFmpeg (seek stream):', err.message);
      }
      finished = true;
      cleanup();
    })
    .on('end', () => {
      finished = true;
      cleanup();
    });

  if (mode === 'full') {
    ffmpegCommand
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('192k')
      .videoFilter('scale=-2:720')
      .outputOptions([
        '-preset ultrafast',
        '-crf 28',
        '-threads 0',
        '-g 30',
        '-bf 0',
      ]);
  } else if (mode === 'audio') {
    ffmpegCommand
      .videoCodec('copy')
      .audioCodec('aac')
      .audioBitrate('192k');
  } else {
    // remux o default - solo copiar
    ffmpegCommand.videoCodec('copy').audioCodec('copy');
  }

  activeFFmpegProcesses.set(cacheKey, ffmpegCommand);
  ffmpegCommand.pipe(res, { end: true });
}

// Warmup: hacer peticiones HEAD/GET rápidas a mirrors
async function warmupMirrors(timeoutPer = 3000) {
  try {
    console.log('🔧 Ejecutando warmup de mirrors...');
    const mirrors = getTorrentProviderDefinition(DEFAULT_TORRENT_PROVIDER).mirrors || [];
    const tasks = mirrors.map(async (base) => {
      try {
        try {
          const resp = await axios.head(base, {
            timeout: timeoutPer,
            httpAgent: httpAgentGlobal,
            httpsAgent: httpsAgentGlobal,
          });
          console.log(`🔧 Warmup OK: ${base} ${resp && resp.status ? resp.status : 'unknown'}`);
          return;
        } catch (e) {
          // fallback GET
        }

        const resp2 = await axios.get(base, {
          timeout: timeoutPer,
          httpAgent: httpAgentGlobal,
          httpsAgent: httpsAgentGlobal,
        });
        console.log(`🔧 Warmup OK: ${base} ${resp2 && resp2.status ? resp2.status : 'unknown'}`);
      } catch (err) {
        console.warn(`🔧 Warmup fallo: ${base} -> ${err && err.message ? err.message : err}`);
      }
    });

    await Promise.allSettled(tasks);
    lastWarmupAt = Date.now();
    console.log('🔧 Warmup completado');
  } catch (err) {
    console.warn('🔧 Warmup inesperado fallo:', err && err.message ? err.message : err);
  }
}

// =====================
// 1337x search provider (gran cobertura de contenido en español, latino, dual audio)
// =====================
async function search1337x(query, parentSignal) {
  const USE_1337X = String(process.env.PIRATEFLIX_USE_1337X || 'true').toLowerCase() === 'true';
  if (!USE_1337X) return [];

  const timeout1337x = parseInt(process.env.PIRATEFLIX_1337X_TIMEOUT_MS || '10000', 10);
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    Referer: 'https://www.google.com/',
  };

  const decodeHtml = (value) =>
    String(value)
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

  // Step 1: Search listing page
  for (const base of MIRRORS_1337X) {
    if (parentSignal && parentSignal.aborted) break;
    const searchUrl = `${base}/search/${encodeURIComponent(query)}/1/`;
    let controller = null;
    try {
      controller = new AbortController();
      if (parentSignal) {
        parentSignal.addEventListener('abort', () => { try { controller.abort(); } catch (_) {} }, { once: true });
      }

      console.log(`🔍 1337x buscando: ${searchUrl} (timeout ${timeout1337x}ms)`);
      const resp = await axios.get(searchUrl, {
        headers,
        timeout: timeout1337x,
        maxRedirects: 5,
        responseType: 'text',
        httpsAgent: httpsAgentGlobal,
        httpAgent: httpAgentGlobal,
        signal: controller.signal,
      });

      if (!resp?.data || resp.data.length < 200) continue;

      // Parse search results to extract detail page URLs and basic info
      const html = resp.data;
      const rowRegex = /<td\s+class="coll-1 name"[^>]*>[\s\S]*?<\/td>/gi;
      const seedRegex = /<td\s+class="coll-2 seeds"[^>]*>\s*(\d+)\s*<\/td>/gi;
      const leechRegex = /<td\s+class="coll-3 leeches"[^>]*>\s*(\d+)\s*<\/td>/gi;
      const sizeRegex = /<td\s+class="coll-4 size[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;

      // Extract all rows more reliably
      const tableRowRegex = /<tr>[\s\S]*?<\/tr>/gi;
      const rows = [];
      let rowMatch;
      while ((rowMatch = tableRowRegex.exec(html)) !== null) {
        const row = rowMatch[0];
        // Only rows that have the torrent link pattern
        if (row.includes('coll-1 name') || row.includes('/torrent/')) {
          rows.push(row);
        }
      }

      if (rows.length === 0) {
        console.log(`1337x: no rows found from ${base}`);
        continue;
      }

      // Extract detail links + metadata from rows
      const results = [];
      for (const row of rows.slice(0, 10)) {
        // Extract link to detail page
        const linkMatch = row.match(/<a\s+href="(\/torrent\/[^"]+)"[^>]*>([^<]+)<\/a>/i);
        if (!linkMatch) continue;
        const detailPath = linkMatch[1];
        const name = decodeHtml(linkMatch[2]).trim();

        // Extract seeders
        const seedMatch = row.match(/<td\s+class="coll-2 seeds"[^>]*>\s*(\d+)\s*<\/td>/i);
        const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;

        // Extract leechers
        const leechMatch = row.match(/<td\s+class="coll-3 leeches"[^>]*>\s*(\d+)\s*<\/td>/i);
        const leechers = leechMatch ? parseInt(leechMatch[1], 10) : 0;

        // Extract size
        const sizeMatch = row.match(/<td\s+class="coll-4 size[^"]*"[^>]*>([\s\S]*?)<span/i);
        const size = sizeMatch ? decodeHtml(sizeMatch[1]).trim() : 'Unknown';

        results.push({ name, detailPath, seeders, leechers, size, base });
      }

      if (results.length === 0) continue;

      console.log(`🔍 1337x: ${results.length} resultados de ${base}`);

      // Step 2: Fetch detail pages in parallel (limit 5) to get magnet links
      const detailLimit = Math.min(results.length, 5);
      const detailPromises = results.slice(0, detailLimit).map(async (item) => {
        if (parentSignal && parentSignal.aborted) return null;
        const detailUrl = `${item.base}${item.detailPath}`;
        let ctrl = null;
        try {
          ctrl = new AbortController();
          if (parentSignal) {
            parentSignal.addEventListener('abort', () => { try { ctrl.abort(); } catch (_) {} }, { once: true });
          }
          const detailResp = await axios.get(detailUrl, {
            headers,
            timeout: timeout1337x,
            maxRedirects: 5,
            responseType: 'text',
            httpsAgent: httpsAgentGlobal,
            httpAgent: httpAgentGlobal,
            signal: ctrl.signal,
          });
          if (!detailResp?.data) return null;
          const detailHtml = detailResp.data;
          const magnetMatch = detailHtml.match(/magnet:\?xt=urn:btih:[^'"\s<>]+/i);
          if (!magnetMatch) {
            // Try to build from info hash
            const hashMatch = detailHtml.match(/infohash[^a-z0-9]{0,10}([a-f0-9]{40})/i)
              || detailHtml.match(/btih[:=]([a-f0-9]{40})/i);
            if (hashMatch) {
              const dn = item.name ? `&dn=${encodeURIComponent(item.name)}` : '';
              const trackers = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
              return {
                name: item.name,
                magnetLink: `magnet:?xt=urn:btih:${hashMatch[1]}${dn}${trackers}`,
                size: item.size,
                seeders: item.seeders,
                leechers: item.leechers,
                score: item.seeders * 2 + item.leechers,
                source: '1337x',
              };
            }
            return null;
          }
          return {
            name: item.name,
            magnetLink: magnetMatch[0],
            size: item.size,
            seeders: item.seeders,
            leechers: item.leechers,
            score: item.seeders * 2 + item.leechers,
            source: '1337x',
          };
        } catch (err) {
          if (err?.code === 'ERR_CANCELED' || err?.name === 'AbortError') return null;
          console.warn(`1337x detail falló (${detailUrl}):`, err?.message || err);
          return null;
        }
      });

      const detailResults = (await Promise.allSettled(detailPromises))
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => r.value);

      if (detailResults.length > 0) {
        console.log(`✅ 1337x: ${detailResults.length} torrents con magnet obtenidos`);
        return detailResults;
      }
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'AbortError') break;
      console.warn(`1337x mirror falló (${base}):`, err?.message || err);
    }
  }
  return [];
}

// =====================
// Endpoint para buscar torrents
// =====================
app.get('/api/torrent/providers', (_req, res) => {
  const providers = TORRENT_PROVIDER_IDS.map((id) => ({
    id,
    label: TORRENT_PROVIDERS[id].label,
  }));
  res.json({
    defaultProvider: DEFAULT_TORRENT_PROVIDER,
    providers,
  });
});

app.get('/api/search-torrent', async (req, res) => {
  const { query, category = '207', provider: requestedProvider = '' } = req.query; // 207 = HD Movies
  if (!query) return res.status(400).json({ error: 'query es requerido' });
  const providerDefinition = getTorrentProviderDefinition(requestedProvider);
  const provider = providerDefinition.id;

  const decodeHtmlEntities = (value) =>
    String(value)
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

  const normalizeHtmlForScan = (value) => decodeHtmlEntities(value).toLowerCase();

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9',
    Referer: 'https://www.google.com/',
  };

  const perMirrorTimeoutMs = parseInt(process.env.PIRATEFLIX_MIRROR_TIMEOUT_MS || '20000', 10);
  const stage2TimeoutMs = Math.max(
    Math.floor(perMirrorTimeoutMs * 1.3),
    Math.floor(perMirrorTimeoutMs + 3000)
  );
  const baseTimeoutMs = parseInt(process.env.PIRATEFLIX_SEARCH_TIMEOUT_MS || '30000', 10);
  const timeoutMs = Math.max(baseTimeoutMs, stage2TimeoutMs + 2000);
  const requestAbortController = new AbortController();
  const requestAbortSignal = requestAbortController.signal;
  activeSearchControllers.add(requestAbortController);
  const requestTimeout = setTimeout(() => {
    try {
      requestAbortController.abort();
    } catch (_) {}
  }, timeoutMs);

  const onClientClose = () => {
    try {
      if (!requestAbortSignal.aborted) requestAbortController.abort();
    } catch (_) {}
  };
  req.on('close', onClientClose);
  req.on('aborted', onClientClose);

  const cleanupSearch = () => {
    clearTimeout(requestTimeout);
    activeSearchControllers.delete(requestAbortController);
    try {
      req.removeListener('close', onClientClose);
      req.removeListener('aborted', onClientClose);
    } catch (_) {}
  };

  const isAbortLikeError = (err) => {
    if (!err) return false;
    const code = err.code || err.name;
    const msg = String(err.message || '').toLowerCase();
    return (
      code === 'ERR_CANCELED' ||
      code === 'AbortError' ||
      msg.includes('canceled') ||
      msg.includes('aborted')
    );
  };

  try {
    let cleanQuery = query
      .replace(/'/g, '')
      .replace(/:/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`Buscando torrent [provider=${provider}]: ${query}`);
    if (cleanQuery !== query) console.log(`Query limpio: ${cleanQuery}`);

    if (provider === '1337x') {
      const results1337x = await search1337x(cleanQuery, requestAbortSignal);
      results1337x.sort(
        (a, b) =>
          (Number(b?.seeders) || 0) - (Number(a?.seeders) || 0) ||
          (Number(b?.leechers) || 0) - (Number(a?.leechers) || 0)
      );
      console.log(`1337x provider: torrents parseados=${results1337x.length}`);
      return res.json({
        query,
        provider,
        requestedProvider: String(requestedProvider || '').trim().toLowerCase() || provider,
        results: results1337x,
        count: results1337x.length,
      });
    }

    const httpAgent = httpAgentGlobal;
    const httpsAgentShared = httpsAgentGlobal;
    const mirrors = (providerDefinition.mirrors || []).slice();
    if (mirrors.length === 0) {
      throw new Error(`Provider ${provider} has no mirrors configured`);
    }

    const searchStart = Date.now();
    console.log(`Intentando mirrors: ${mirrors.join(', ')}`);
    console.log(`Busqueda iniciada: ${new Date(searchStart).toISOString()}`);

    try {
      const handles =
        typeof process._getActiveHandles === 'function'
          ? process._getActiveHandles().length
          : 'unknown';
      const requests =
        typeof process._getActiveRequests === 'function'
          ? process._getActiveRequests().length
          : 'unknown';
      console.log(
        `Diagnostics: torrents=${client.torrents.length}, activeFFmpeg=${activeFFmpegProcesses.size}, transcodedCache=${transcodedCache.size}, handles=${handles}, requests=${requests}`
      );
    } catch (e) {
      console.warn('No se pudieron obtener diagnostics internos:', e.message);
    }

    async function fetchSearchHtml(cleanQuery, category, parentSignal) {
      const looksLikeBlockedHtml = (html) => {
        const lower = normalizeHtmlForScan(html);
        return (
          lower.includes('ddos-guard') ||
          lower.includes('cloudflare') ||
          lower.includes('checking your browser') ||
          lower.includes('attention required') ||
          lower.includes('access denied') ||
          lower.includes('enable javascript') ||
          lower.includes('captcha') ||
          lower.includes('sucuri') ||
          lower.includes('just a moment')
        );
      };

      const looksLikeSearchHtml = (html) => {
        const lower = normalizeHtmlForScan(html);
        return (
          lower.includes('magnet:?xt=urn:btih:') ||
          lower.includes('searchresult') ||
          lower.includes('detlink') ||
          lower.includes('detname') ||
          lower.includes('cellmainlink') ||
          lower.includes('class="grantorrent"') ||
          lower.includes('busqueda:') ||
          lower.includes('movie-list') ||
          lower.includes('linktorrent') ||
          lower.includes('torrentname') ||
          lower.includes('frontpagewidget') ||
          lower.includes('no hits') ||
          lower.includes('no results') ||
          lower.includes('nothing found')
        );
      };

      const cacheKey = `${provider}::${cleanQuery}::${category}`;
      const cacheTtl = parseInt(process.env.PIRATEFLIX_SEARCH_CACHE_MS || '30000', 10);
      if (!global.__pirateflix_search_cache) global.__pirateflix_search_cache = new Map();
      const searchCache = global.__pirateflix_search_cache;
      const cached = searchCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < cacheTtl) {
        console.log('✅ Sirviendo búsqueda desde cache:', cacheKey);
        if (typeof cached === 'string') return { html: cached, base: null };
        return { html: cached.html, base: cached.base || null };
      }

      const perMirrorTimeout = perMirrorTimeoutMs;
      const controllers = new Set();
      const overallSignal = parentSignal;

      const makeAbortError = () => {
        const err = new Error('Search aborted');
        err.code = 'ERR_CANCELED';
        return err;
      };

      const isAbortError = (err) => {
        if (!err) return false;
        const code = err.code || err.name;
        const msg = String(err.message || '').toLowerCase();
        return (
          code === 'ERR_CANCELED' ||
          code === 'AbortError' ||
          msg.includes('canceled') ||
          msg.includes('aborted')
        );
      };

      const isAggregateAbort = (err) => {
        const errs = err && err.errors;
        return Array.isArray(errs) && errs.length > 0 && errs.every((e) => isAbortError(e));
      };

      const ensureNotAborted = () => {
        if (overallSignal && overallSignal.aborted) throw makeAbortError();
      };

      const trackController = (controller) => {
        if (!controllers.has(controller)) controllers.add(controller);
        activeSearchControllers.add(controller);
        if (overallSignal && overallSignal.aborted) {
          try {
            controller.abort();
          } catch (_) {}
        } else if (overallSignal) {
          overallSignal.addEventListener(
            'abort',
            () => {
              try {
                controller.abort();
              } catch (_) {}
            },
            { once: true }
          );
        }
        return controller;
      };

      const tryYtsFallback = async (q) => {
        if (
          !providerDefinition.enableYtsFallback ||
          String(process.env.PIRATEFLIX_USE_EXTERNAL_API || 'true').toLowerCase() !== 'true'
        )
          return null;
        ensureNotAborted();
        let controller = null;
        try {
          const apiUrl = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(
            q
          )}&limit=5`;
          const ytsTimeout = parseInt(process.env.PIRATEFLIX_YTS_TIMEOUT_MS || '7000', 10);
          console.log(
            'Intentando fallback externo rápido (YTS):',
            apiUrl,
            `(timeout ${ytsTimeout}ms)`
          );
          controller = trackController(new AbortController());
          const resp = await axios.get(apiUrl, {
            timeout: ytsTimeout,
            responseType: 'json',
            httpsAgent: httpsAgentShared,
            httpAgent,
            signal: controller.signal,
          });
          try {
            activeSearchControllers.delete(controller);
          } catch (e) {
            /* ignore */
          }
          const movies = resp?.data?.data?.movies;
          if (!movies || movies.length === 0) return null;

          const magnets = [];
          for (const m of movies) {
            if (!m.torrents) continue;
            for (const t of m.torrents) {
              if (!t.hash) continue;
              const dn = encodeURIComponent(`${m.title} ${m.year} ${t.quality}`);
              magnets.push(`magnet:?xt=urn:btih:${t.hash}&dn=${dn}`);
            }
          }

          if (magnets.length === 0) return null;
          return magnets.map((m) => `<a href="${m}">download</a>`).join('\n');
        } catch (err) {
          if (controller) {
            try {
              activeSearchControllers.delete(controller);
            } catch (e) {
              /* ignore */
            }
          }
          if (isAbortError(err) || (overallSignal && overallSignal.aborted)) throw makeAbortError();
          console.warn('Fallback YTS falló:', err && err.message ? err.message : err);
          return null;
        }
      };

      // try {
      //   if (Date.now() - lastWarmupAt > WARMUP_INTERVAL_MS) {
      //     console.log(
      //       '🔧 Warmup previo detectado como antiguo. Ejecutando warmup corto antes de buscar...'
      //     );
      //     await warmupMirrors(3000);
      //   }
      // } catch (e) {
      //   console.warn('Warmup corto falló antes de buscar:', e && e.message ? e.message : e);
      // }

      const healthyMirrors = mirrors.filter((base) => {
        const s = mirrorStats.get(base);
        if (!s) return true;
        if (s.openUntil && s.openUntil > Date.now()) return false;
        return true;
      });

      const prioritized = (healthyMirrors.length > 0 ? healthyMirrors : mirrors).slice();
      prioritized.sort((a, b) => {
        const sa = mirrorStats.get(a) || {};
        const sb = mirrorStats.get(b) || {};
        const ta = sa.lastSuccess || 0;
        const tb = sb.lastSuccess || 0;
        if (ta !== tb) return tb - ta;
        const fa = sa.fails || 0;
        const fb = sb.fails || 0;
        return fa - fb;
      });

      if (healthyMirrors.length === 0)
        console.log(
          '⚠️ Todos los mirrors en cooldown; se utilizarán todos los mirrors temporalmente'
        );

      const makeRequestFor = (base, timeoutMs, signalController) => {
        const url = providerDefinition.buildSearchUrl(base, cleanQuery, category);
        const controller = signalController || new AbortController();
        trackController(controller);

        console.log(`Lanzando petición a: ${url} (timeout ${timeoutMs}ms)`);

        return axios
          .get(url, {
            headers,
            timeout: timeoutMs,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: (s) => s >= 200 && s < 400,
            httpsAgent: httpsAgentShared,
            httpAgent,
            signal: controller.signal,
          })
          .then((resp) => {
            if (resp && resp.data && resp.data.length > 0) {
              if (!looksLikeSearchHtml(resp.data)) {
                const blocked = looksLikeBlockedHtml(resp.data);
                console.warn(
                  `HTML inesperado desde ${base} (${blocked ? 'bloqueado' : 'no-search'})`
                );
                throw new Error(`Invalid search HTML from ${base}`);
              }

              console.log(`HTML recibido desde ${base}: ${resp.data.length} bytes`);
              mirrorStats.set(base, { fails: 0, lastSuccess: Date.now(), openUntil: null });
              try {
                activeSearchControllers.delete(controller);
              } catch (e) {
                /* ignore */
              }
              return { base, html: resp.data };
            }
            throw new Error(`Empty response from ${base}`);
          })
          .catch((err) => {
            if (
              isAbortError(err) ||
              controller.signal.aborted ||
              (overallSignal && overallSignal.aborted)
            ) {
              try {
                activeSearchControllers.delete(controller);
              } catch (e) {
                /* ignore */
              }
              throw makeAbortError();
            }

            const msg = err && err.message ? String(err.message).toLowerCase() : '';
            if (
              msg.includes('certificate key too weak') ||
              (msg.includes('certificate') && msg.includes('weak'))
            ) {
              console.warn(`Advertencia: certificado débil en mirror ${base}`);
            }

            const prev = mirrorStats.get(base) || { fails: 0 };
            prev.fails = (prev.fails || 0) + 1;
            prev.lastFail = Date.now();
            if (prev.fails >= MIRROR_FAILURE_THRESHOLD) {
              prev.openUntil = Date.now() + MIRROR_COOLDOWN_MS;
              console.warn(
                `⛔ Mirror ${base} abierto por circuit-breaker hasta ${new Date(
                  prev.openUntil
                ).toISOString()} (fails=${prev.fails})`
              );
            }
            mirrorStats.set(base, prev);

            try {
              activeSearchControllers.delete(controller);
            } catch (e) {
              /* ignore */
            }
            throw err;
          });
      };

      let result = null;
      try {
        ensureNotAborted();
        const topN = Math.max(1, Math.min(prioritized.length, FAST_PARALLEL_MIRRORS));
        const topList = prioritized.slice(0, topN);
        try {
          console.log(`Stage1: probando top ${topList.length} mirrors en paralelo`);
          const requests = topList.map((m) => makeRequestFor(m, perMirrorTimeout));
          const winner = await Promise.any(requests);
          result = winner;
        } catch (stage1Err) {
          if (
            (overallSignal && overallSignal.aborted) ||
            isAbortError(stage1Err) ||
            isAggregateAbort(stage1Err)
          )
            throw makeAbortError();
          console.warn(
            'Stage1 falló:',
            stage1Err && stage1Err.errors
              ? stage1Err.errors.map((e) => e && e.message).join(' | ')
              : (stage1Err && stage1Err.message) || stage1Err
          );

          for (const controller of controllers) {
            try {
              controller.abort();
            } catch (e) {
              /* ignore */
            }
            try {
              activeSearchControllers.delete(controller);
            } catch (e) {
              /* ignore */
            }
          }

          ensureNotAborted();
          const wideTimeout = Math.max(perMirrorTimeout * 2, Math.floor(perMirrorTimeout + 7000));
          const controllersStage2 = [];
          console.log(`Stage2: probando todos los mirrors en paralelo (timeout ${wideTimeout}ms)`);
          try {
            const requests2 = prioritized.map((m) => {
              const controller = new AbortController();
              controllersStage2.push({ controller, base: m });
              return makeRequestFor(m, wideTimeout, controller);
            });
            const winner2 = await Promise.any(requests2);
            for (const { controller } of controllersStage2) {
              try {
                controller.abort();
              } catch (e) {}
              try {
                activeSearchControllers.delete(controller);
              } catch (e) {}
            }

            result = winner2;
          } catch (stage2Err) {
            if (
              (overallSignal && overallSignal.aborted) ||
              isAbortError(stage2Err) ||
              isAggregateAbort(stage2Err)
            )
              throw makeAbortError();
            console.warn(
              'Stage2 falló:',
              stage2Err && stage2Err.errors
                ? stage2Err.errors.map((e) => e && e.message).join(' | ')
                : (stage2Err && stage2Err.message) || stage2Err
            );

            for (const { controller } of controllersStage2) {
              try {
                controller.abort();
              } catch (e) {
                /* ignore */
              }
              try {
                activeSearchControllers.delete(controller);
              } catch (e) {
                /* ignore */
              }
            }

            try {
              const ytsHtml = await tryYtsFallback(cleanQuery);
              if (ytsHtml) {
                console.log('✅ Fallback externo (YTS) exitoso — usando resultados rápidos');
                result = { html: ytsHtml, base: null };
              }
            } catch (e) {
              console.warn('Error en fallback externo rápido:', e && e.message ? e.message : e);
            }

            ensureNotAborted();
            if (!result) console.log('Intentando reintentos secuenciales con timeout extendido...');
            for (const base of mirrors) {
              ensureNotAborted();
              const url = providerDefinition.buildSearchUrl(base, cleanQuery, category);
              console.log(
                `Intentando secuencial a: ${url} (timeout ${EXTENDED_MIRROR_TIMEOUT_MS}ms)`
              );
              let controller = null;
              try {
                controller = trackController(new AbortController());
                const resp = await axios.get(url, {
                  headers,
                  timeout: EXTENDED_MIRROR_TIMEOUT_MS,
                  maxRedirects: 5,
                  responseType: 'text',
                  validateStatus: (s) => s >= 200 && s < 400,
                  httpsAgent: httpsAgentShared,
                  httpAgent,
                  signal: controller.signal,
                });
                if (controller) {
                  try {
                    activeSearchControllers.delete(controller);
                  } catch (e) {
                    /* ignore */
                  }
                }

                if (resp && resp.data && resp.data.length > 0) {
                  if (!looksLikeSearchHtml(resp.data)) {
                    const blocked = looksLikeBlockedHtml(resp.data);
                    console.warn(
                      `HTML inesperado (secuencial) desde ${base} (${blocked ? 'bloqueado' : 'no-search'})`
                    );
                  } else {
                    console.log(
                      `HTML recibido (secuencial) desde ${base}: ${resp.data.length} bytes`
                    );
                    mirrorStats.set(base, { fails: 0, lastSuccess: Date.now(), openUntil: null });
                    result = { base, html: resp.data };
                    break;
                  }
                }
              } catch (err) {
                if (controller) {
                  try {
                    activeSearchControllers.delete(controller);
                  } catch (e) {
                    /* ignore */
                  }
                }
                if (isAbortError(err) || (overallSignal && overallSignal.aborted))
                  throw makeAbortError();
                const prev = mirrorStats.get(base) || { fails: 0 };
                prev.fails = (prev.fails || 0) + 1;
                prev.lastFail = Date.now();
                if (prev.fails >= MIRROR_FAILURE_THRESHOLD) {
                  prev.openUntil = Date.now() + MIRROR_COOLDOWN_MS;
                  console.warn(
                    `⛔ Mirror ${base} abierto por circuit-breaker hasta ${new Date(
                      prev.openUntil
                    ).toISOString()} (fails=${prev.fails})`
                  );
                }
                mirrorStats.set(base, prev);
                console.warn(
                  `Secuencial falló para ${base}:`,
                  err && err.message ? err.message : err
                );
              }

              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }
      } finally {
        for (const controller of controllers) {
          try {
            controller.abort();
          } catch (e) {
            /* ignore */
          }
          try {
            activeSearchControllers.delete(controller);
          } catch (e) {
            /* ignore */
          }
        }
      }

      if (!result) throw new Error('All mirrors failed');

      if (typeof result === 'string') {
        result = { html: result, base: null };
      }

      searchCache.set(cacheKey, { html: result.html, base: result.base || null, ts: Date.now() });
      return result;
    }

    let html = null;
    let htmlBase = null;

    // 1337x ahora es provider dedicado; no mezclar resultados con otros providers
    const promise1337x = Promise.resolve([]);

    try {
      const searchResult = await fetchSearchHtml(cleanQuery, category, requestAbortSignal);
      html = searchResult?.html || searchResult;
      htmlBase = searchResult?.base || null;
      console.log(`Busqueda finalizada en ${Date.now() - searchStart} ms`);
    } catch (initialErr) {
      if (isAbortLikeError(initialErr) || requestAbortSignal.aborted) throw initialErr;
      console.warn('Búsqueda inicial falló, intentando fallbacks de query:', initialErr.message);

      const fallbacks = [];
      const withoutRes = cleanQuery
        .replace(
          /\b(1080p|720p|2160p|4k|4k?p|bdrip|bluray|brip|brrip|webrip|web-dl|dvdrip|hdrip)\b/gi,
          ''
        )
        .replace(/\s+/g, ' ')
        .trim();
      if (withoutRes && withoutRes !== cleanQuery) fallbacks.push(withoutRes);

      const withoutYear = cleanQuery
        .replace(/\b(19|20)\d{2}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (withoutYear && withoutYear !== cleanQuery && !fallbacks.includes(withoutYear))
        fallbacks.push(withoutYear);

      const noResNoYear = withoutRes
        .replace(/\b(19|20)\d{2}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (noResNoYear && !fallbacks.includes(noResNoYear) && noResNoYear !== cleanQuery)
        fallbacks.push(noResNoYear);

      for (const fq of fallbacks) {
        try {
          console.log(`Intentando fallback: '${fq}'`);
          const searchResult = await fetchSearchHtml(fq, category, requestAbortSignal);
          html = searchResult?.html || searchResult;
          htmlBase = searchResult?.base || null;
          console.log(`Fallback exitoso con query: '${fq}'`);
          break;
        } catch (fbErr) {
          console.warn(
            `Fallback falló para '${fq}':`,
            fbErr && fbErr.message ? fbErr.message : fbErr
          );
        }
      }

      if (!html) throw initialErr;
      console.log(`Busqueda (fallback) finalizada en ${Date.now() - searchStart} ms`);
    }

    const torrents = [];

    const extractPeersFromRow = (rowHtml) => {
      const numbersFrom = (regex) => {
        const nums = [];
        let match;
        while ((match = regex.exec(rowHtml)) !== null) {
          nums.push(parseInt(match[1], 10));
        }
        return nums;
      };

      const rightTdRegex =
        /<td[^>]*(?:align="right"|class="[^"]*(?:right|text-right)[^"]*")[^>]*>\s*(\d+)\s*<\/td>/gi;
      const anyTdRegex = /<td[^>]*>\s*(\d+)\s*<\/td>/gi;

      let nums = numbersFrom(rightTdRegex);
      if (nums.length < 2) nums = numbersFrom(anyTdRegex);

      const seeders = nums.length >= 2 ? nums[nums.length - 2] : 0;
      const leechers = nums.length >= 2 ? nums[nums.length - 1] : 0;
      return { seeders, leechers };
    };

    const extractName = (magnetLink, rowHtml) => {
      const nameMatch = magnetLink.match(/&dn=([^&]+)/);
      if (nameMatch) return decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));

      const detLinkMatch = rowHtml.match(/class="detLink"[^>]*>([^<]+)</i);
      if (detLinkMatch) return decodeHtmlEntities(detLinkMatch[1]).trim();

      const detNameMatch = rowHtml.match(/class="detName"[^>]*>([^<]+)</i);
      if (detNameMatch) return decodeHtmlEntities(detNameMatch[1]).trim();

      const cellMainLinkMatch = rowHtml.match(/class=['"][^'"]*cellMainLink[^'"]*['"][^>]*>([\s\S]*?)<\/a>/i);
      if (cellMainLinkMatch) {
        return decodeHtmlEntities(cellMainLinkMatch[1].replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .trim();
      }

      const titleMatch = rowHtml.match(/title=["']Details\s+for\s+([^"']+)["']/i);
      if (titleMatch) return decodeHtmlEntities(titleMatch[1]).trim();

      return 'Unknown';
    };

    const extractSize = (rowHtml) => {
      const sizeMatch = rowHtml.match(/Size\s+([^,<]+)\s*,/i);
      if (sizeMatch && sizeMatch[1]) return sizeMatch[1].trim();

      const tdMatches = [...rowHtml.matchAll(/<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi)];
      if (tdMatches.length >= 2) {
        const raw = decodeHtmlEntities(String(tdMatches[1][1] || ''))
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (/\d/.test(raw) && /(kb|mb|gb|tb|kib|mib|gib|tib)\b/i.test(raw)) {
          return raw;
        }
      }

      return 'Unknown';
    };

    const buildMagnetFromHash = (hash, name) => {
      const safeHash = String(hash || '').trim();
      if (!safeHash) return null;
      const dn = name && name !== 'Unknown' ? `&dn=${encodeURIComponent(name)}` : '';
      const trackers = DEFAULT_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
      return `magnet:?xt=urn:btih:${safeHash}${dn}${trackers}`;
    };

    const extractInfoHash = (value) => {
      const scan = normalizeHtmlForScan(value);
      const patterns = [
        /data-infohash=['"]?([a-f0-9]{40}|[a-z2-7]{32})/i,
        /infohash[^a-z0-9]{0,10}([a-f0-9]{40}|[a-z2-7]{32})/i,
        /info_hash[^a-z0-9]{0,10}([a-f0-9]{40}|[a-z2-7]{32})/i,
        /btih[:=]([a-f0-9]{40}|[a-z2-7]{32})/i,
      ];
      for (const pattern of patterns) {
        const match = scan.match(pattern);
        if (match && match[1]) return match[1];
      }
      return null;
    };

    const extractDetailUrls = (value, base) => {
      if (!base) return [];
      const urls = [];
      const seen = new Set();
      const addUrl = (href) => {
        if (!href) return;
        if (href.startsWith('magnet:')) return;
        if (href.startsWith('#') || href.startsWith('javascript:')) return;
        let resolved = href;
        if (href.startsWith('//')) {
          resolved = `https:${href}`;
        } else if (href.startsWith('/')) {
          resolved = `${base}${href}`;
        } else if (!/^https?:\/\//i.test(href)) {
          resolved = `${base}/${href.replace(/^\.?\//, '')}`;
        }
        if (/\/download\//i.test(resolved)) return;
        if (!seen.has(resolved)) {
          seen.add(resolved);
          urls.push(resolved);
        }
      };

      const patterns = [
        /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"][^'"]*detLink[^'"]*['"]/gi,
        /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"][^'"]*cellMainLink[^'"]*['"]/gi,
        /<a[^>]+href=['"]([^'"]*\/torrent\/[^'"]+)['"][^>]*>/gi,
        /<a[^>]+href=['"]([^'"]*\/desc\/[^'"]+)['"][^>]*>/gi,
        /<a[^>]+href=['"]([^'"]*?-t\d+\.html)['"][^>]*>/gi,
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(value)) !== null) {
          addUrl(match[1]);
        }
      }
      return urls;
    };

    const resolveAbsoluteUrl = (href, base) => {
      const raw = String(href || '').trim();
      if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return null;
      try {
        if (/^https?:\/\//i.test(raw)) return raw;
        if (raw.startsWith('//')) return `https:${raw}`;
        if (!base) return null;
        return new URL(raw, `${base}/`).toString();
      } catch (_) {
        return null;
      }
    };

    const extractGrantorrentDetailEntries = (searchHtml, base) => {
      const entries = [];
      const seen = new Set();
      const anchorRegex = /<a[^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = anchorRegex.exec(searchHtml)) !== null) {
        const resolved = resolveAbsoluteUrl(match[1], base);
        if (!resolved) continue;
        let parsed = null;
        try {
          parsed = new URL(resolved);
        } catch (_) {
          continue;
        }
        const host = String(parsed.hostname || '').toLowerCase();
        if (!host.includes('grantorrent')) continue;
        const pathName = String(parsed.pathname || '');
        if (!/^\/[^/?#]+\/?$/.test(pathName)) continue;
        if (
          pathName === '/' ||
          /^\/(peliculas|series_p|contacto|ayuda|categoria|search|tag|author)\//i.test(pathName)
        ) {
          continue;
        }

        const inner = decodeHtmlEntities(match[2] || '');
        const altMatch = inner.match(/\balt=['"]([^'"]+)['"]/i);
        const pMatch = inner.match(/<p[^>]*>([^<]+)<\/p>/i);
        const rawName = altMatch?.[1] || pMatch?.[1] || '';
        const name = decodeHtmlEntities(String(rawName || ''))
          .replace(/\s+/g, ' ')
          .trim();
        const key = resolved.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ url: resolved, name: name || 'Unknown' });
      }
      return entries;
    };

    const decodeGrantorrentDataSrc = (value) => {
      const raw = decodeHtmlEntities(String(value || '')).trim();
      if (!raw) return null;
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
        if (!decoded) return null;
        if (/^(https?:\/\/|magnet:\?)/i.test(decoded)) return decoded;
      } catch (_) {}
      return null;
    };

    const scoreGrantorrentName = (name) => {
      const normalizedName = decodeHtmlEntities(String(name || ''))
        .toLowerCase()
        .replace(/['`´]/g, '')
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const normalizedQuery = String(cleanQuery || '')
        .toLowerCase()
        .replace(/['`´]/g, '')
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const queryTokens = normalizedQuery
        .split(' ')
        .map((t) => t.trim())
        .filter(
          (t) =>
            t.length >= 3 &&
            !/^(720p|1080p|2160p|4k|hdrip|bdrip|bluray|webrip|web|dl|dual|audio)$/.test(t)
        );

      let score = 0;
      if (!normalizedName) return score;
      if (normalizedName === normalizedQuery) score += 300;
      if (normalizedName.startsWith(normalizedQuery) && normalizedQuery) score += 220;
      if (normalizedQuery && normalizedName.includes(normalizedQuery)) score += 120;
      if (queryTokens.length > 0) {
        const matched = queryTokens.filter((token) => normalizedName.includes(token)).length;
        score += matched * 40;
        if (matched === queryTokens.length) score += 100;
      }
      const yearMatch = normalizedQuery.match(/\b(19|20)\d{2}\b/);
      if (yearMatch && normalizedName.includes(yearMatch[0])) score += 60;
      if (/\b(microhd|bdremux|1080p|720p|hdrip)\b/.test(normalizedName)) score += 8;
      return score;
    };

    const fetchGrantorrentTorrentsFromDetails = async (entries) => {
      const results = [];
      const seen = new Set();
      const limit = Math.min(entries.length, 12);
      for (let i = 0; i < limit; i += 1) {
        if (requestAbortSignal && requestAbortSignal.aborted) break;
        const entry = entries[i];
        if (!entry?.url) continue;
        try {
          const resp = await axios.get(entry.url, {
            headers,
            timeout: Math.min(15000, perMirrorTimeoutMs),
            maxRedirects: 5,
            responseType: 'text',
            httpsAgent: httpsAgentShared,
            httpAgent,
            signal: requestAbortSignal,
          });
          if (!resp?.data) continue;
          const detailHtml = String(resp.data);
          const linkRegexes = [
            /<a[^>]*class=['"][^'"]*linktorrent[^'"]*['"][^>]*data-src=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi,
            /<a[^>]*data-src=['"]([^'"]+)['"][^>]*class=['"][^'"]*linktorrent[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi,
          ];

          for (const regex of linkRegexes) {
            let match;
            while ((match = regex.exec(detailHtml)) !== null) {
              const torrentUrl = decodeGrantorrentDataSrc(match[1]);
              if (!torrentUrl || seen.has(torrentUrl)) continue;
              seen.add(torrentUrl);

              const anchorInner = decodeHtmlEntities(String(match[2] || ''))
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
              const qualityText = anchorInner
                .replace(/^(descargar|download)\s*/i, '')
                .trim();
              const fallbackNameRaw = decodeURIComponent(
                String(torrentUrl.split('/').pop() || '')
              ).replace(/\.torrent$/i, '');
              const fallbackName = fallbackNameRaw.replace(/[_+.]+/g, ' ').trim();
              const entryName = String(entry.name || '').trim();
              const composedName =
                entryName && qualityText && !entryName.toLowerCase().includes(qualityText.toLowerCase())
                  ? `${entryName} - ${qualityText}`
                  : entryName &&
                      fallbackName &&
                      !entryName.toLowerCase().includes(fallbackName.toLowerCase())
                    ? `${entryName} - ${fallbackName}`
                    : entryName || qualityText || fallbackName || 'Unknown';

              const score = scoreGrantorrentName(composedName);
              results.push({
                name: composedName,
                magnetLink: torrentUrl,
                size: 'Unknown',
                seeders: 0,
                leechers: 0,
                score,
              });
            }
          }
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          console.warn('Detalle Grantorrent falló:', entry.url, msg);
        }
      }
      return results;
    };

    const fetchMagnetsFromDetails = async (entries) => {
      const results = [];
      const seen = new Set();
      const limit = Math.min(entries.length, 10);
      for (let i = 0; i < limit; i++) {
        if (requestAbortSignal && requestAbortSignal.aborted) break;
        const entry = entries[i];
        const url = typeof entry === 'string' ? entry : entry?.url;
        if (!url) continue;
        try {
          const resp = await axios.get(url, {
            headers,
            timeout: Math.min(15000, perMirrorTimeoutMs),
            maxRedirects: 5,
            responseType: 'text',
            httpsAgent: httpsAgentShared,
            httpAgent,
            signal: requestAbortSignal,
          });
          if (!resp?.data) continue;
          const detailHtml = decodeHtmlEntities(resp.data);
          const magnetMatch = detailHtml.match(/magnet:\?xt=urn:btih:[^'"\s<>]+/i);
          let magnetLink = magnetMatch ? magnetMatch[0] : null;
          if (!magnetLink) {
            const hash = extractInfoHash(detailHtml);
            if (hash) {
              const titleMatch = detailHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
              const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : 'Unknown';
              magnetLink = buildMagnetFromHash(hash, title);
            }
          }
          if (!magnetLink || seen.has(magnetLink)) continue;
          seen.add(magnetLink);
          const detailName = extractName(magnetLink, detailHtml);
          const rowName =
            typeof entry === 'string' ? '' : String(entry?.name || '').trim();
          const name = rowName && rowName !== 'Unknown' ? rowName : detailName;
          const rowSeeders = typeof entry === 'string' ? 0 : Number(entry?.seeders) || 0;
          const rowLeechers = typeof entry === 'string' ? 0 : Number(entry?.leechers) || 0;
          const rowSize =
            typeof entry === 'string'
              ? 'Unknown'
              : String(entry?.size || '').trim() || 'Unknown';
          results.push({
            name,
            magnetLink,
            size: rowSize,
            seeders: rowSeeders,
            leechers: rowLeechers,
            score: rowSeeders * 2 + rowLeechers,
          });
        } catch (err) {
          const msg = err && err.message ? err.message : err;
          console.warn('Detalle falló para magnet:', url, msg);
        }
      }
      return results;
    };

    const seenMagnets = new Set();
    const pendingDetailRows = [];
    const seenPendingDetailUrls = new Set();

    if (provider === 'grantorrent') {
      const directLinkRegexes = [
        /<a[^>]*data-src=['"]([^'"]+)['"][^>]*class=['"][^'"]*linktorrent[^'"]*['"][^>]*>/gi,
        /<a[^>]*class=['"][^'"]*linktorrent[^'"]*['"][^>]*data-src=['"]([^'"]+)['"][^>]*>/gi,
      ];
      for (const directLinkRegex of directLinkRegexes) {
        let directMatch;
        while ((directMatch = directLinkRegex.exec(html)) !== null) {
          const torrentUrl = decodeGrantorrentDataSrc(directMatch[1]);
          if (!torrentUrl || seenMagnets.has(torrentUrl)) continue;
          const fallbackName = decodeURIComponent(String(torrentUrl.split('/').pop() || ''))
            .replace(/\.torrent$/i, '')
            .replace(/[_+.]+/g, ' ')
            .trim();
          const displayName = fallbackName || 'Grantorrent result';
          seenMagnets.add(torrentUrl);
          torrents.push({
            name: displayName,
            magnetLink: torrentUrl,
            size: 'Unknown',
            seeders: 0,
            leechers: 0,
            score: scoreGrantorrentName(displayName),
          });
        }
      }

      const detailEntries = extractGrantorrentDetailEntries(html, htmlBase || mirrors[0]);
      if (detailEntries.length > 0) {
        console.log(`Grantorrent: resolviendo detalles (${detailEntries.length})...`);
        const detailTorrents = await fetchGrantorrentTorrentsFromDetails(detailEntries);
        for (const torrent of detailTorrents) {
          if (torrents.length >= 25) break;
          if (seenMagnets.has(torrent.magnetLink)) continue;
          seenMagnets.add(torrent.magnetLink);
          torrents.push(torrent);
        }
      }
      torrents.sort((a, b) => b.score - a.score);
    }

    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      if (torrents.length >= 15) break;

      const rowHtml = rowMatch[0];
      const decodedRow = decodeHtmlEntities(rowHtml);
      const name = extractName('', decodedRow);
      const size = extractSize(decodedRow);
      const { seeders, leechers } = extractPeersFromRow(decodedRow);
      const magnetMatch = decodedRow.match(/magnet:\?xt=urn:btih:[^'"\s<>]+/i);
      let magnetLink = magnetMatch ? magnetMatch[0] : null;
      if (!magnetLink) {
        const hash = extractInfoHash(decodedRow);
        if (hash) {
          magnetLink = buildMagnetFromHash(hash, name);
        }
      }

      if (!magnetLink) {
        if (htmlBase) {
          const rowDetailUrls = extractDetailUrls(decodedRow, htmlBase);
          if (rowDetailUrls.length > 0) {
            const detailUrl = rowDetailUrls[0];
            if (!seenPendingDetailUrls.has(detailUrl)) {
              seenPendingDetailUrls.add(detailUrl);
              pendingDetailRows.push({
                url: detailUrl,
                name,
                size,
                seeders,
                leechers,
              });
            }
          }
        }
        continue;
      }

      if (seenMagnets.has(magnetLink)) continue;
      seenMagnets.add(magnetLink);

      const resolvedName = extractName(magnetLink, decodedRow);

      torrents.push({
        name: resolvedName,
        magnetLink,
        size,
        seeders,
        leechers,
        score: seeders * 2 + leechers,
      });
    }

    if (torrents.length === 0) {
      const normalizedHtml = decodeHtmlEntities(html);
      const magnetRegex = /magnet:\?xt=urn:btih:[^'"\s<>]+/gi;
      const magnets = [];
      let magnetMatch;

      while ((magnetMatch = magnetRegex.exec(normalizedHtml)) !== null) {
        magnets.push(magnetMatch[0]);
      }

      console.log(`Magnet links encontrados (fallback): ${magnets.length}`);

      for (const magnetLink of magnets) {
        if (torrents.length >= 15) break;
        if (seenMagnets.has(magnetLink)) continue;
        seenMagnets.add(magnetLink);

        const name = extractName(magnetLink, normalizedHtml);

        torrents.push({
          name,
          magnetLink,
          size: 'Unknown',
          seeders: 0,
          leechers: 0,
          score: 0,
        });
      }
    }

    const shouldResolveDetails =
      provider !== 'grantorrent' &&
      htmlBase &&
      torrents.length < 10 &&
      (pendingDetailRows.length > 0 || torrents.length === 0);

    if (shouldResolveDetails) {
      const detailEntries =
        pendingDetailRows.length > 0
          ? pendingDetailRows
          : extractDetailUrls(html, htmlBase).map((url) => ({ url }));
      if (detailEntries.length > 0) {
        console.log(`Intentando detalles para ${detailEntries.length} resultados...`);
        const detailTorrents = await fetchMagnetsFromDetails(detailEntries);
        for (const torrent of detailTorrents) {
          if (torrents.length >= 15) break;
          if (seenMagnets.has(torrent.magnetLink)) continue;
          seenMagnets.add(torrent.magnetLink);
          torrents.push(torrent);
        }
      }
    } else {
      console.log(`Magnet links encontrados (TPB): ${torrents.length}`);
    }

    // Merge resultados de 1337x (corrió en paralelo)
    try {
      const results1337x = await promise1337x;
      if (results1337x && results1337x.length > 0) {
        const extractHash = (magnet) => {
          const m = String(magnet || '').match(/btih:([a-f0-9]{40})/i);
          return m ? m[1].toLowerCase() : null;
        };
        const existingHashes = new Set(
          torrents.map((t) => extractHash(t.magnetLink)).filter(Boolean)
        );
        let added = 0;
        for (const t of results1337x) {
          const hash = extractHash(t.magnetLink);
          if (hash && existingHashes.has(hash)) continue;
          if (seenMagnets.has(t.magnetLink)) continue;
          seenMagnets.add(t.magnetLink);
          if (hash) existingHashes.add(hash);
          torrents.push(t);
          added++;
        }
        if (added > 0) console.log(`✅ 1337x aportó ${added} torrents adicionales`);
      }
    } catch (mergeErr) {
      console.warn('Error merging 1337x:', mergeErr?.message || mergeErr);
    }

    torrents.sort((a, b) => b.score - a.score);

    console.log(`Torrents parseados: ${torrents.length}`);
    if (torrents.length > 0) {
      console.log(
        `Mejor resultado: ${torrents[0].name} (${torrents[0].seeders}S/${torrents[0].leechers}L)`
      );
    } else {
      console.log('No se pudieron parsear torrents del HTML');
    }

    res.json({
      query,
      provider,
      requestedProvider: String(requestedProvider || '').trim().toLowerCase() || provider,
      results: torrents,
      count: torrents.length,
    });
  } catch (error) {
    console.error(
      `Error al buscar torrent [provider=${provider}]:`,
      error && error.message ? error.message : error
    );

    const msg = error && error.message ? String(error.message).toLowerCase() : '';
    if (
      msg.includes('timeout') ||
      error?.code === 'ECONNABORTED' ||
      error?.code === 'ERR_CANCELED' ||
      error?.name === 'AbortError' ||
      msg.includes('canceled') ||
      msg.includes('aborted') ||
      msg.includes('all mirrors failed') ||
      msg.includes('empty response') ||
      msg.includes('certificate key too weak') ||
      (msg.includes('certificate') && msg.includes('weak')) ||
      msg.includes('request failed with status code 5') ||
      (error && error.response && error.response.status >= 500 && error.response.status < 600)
    ) {
      return res.status(504).json({
        error: 'Timeout en búsqueda',
        message: 'La búsqueda tardó demasiado o los mirrors no respondieron',
      });
    }

    res.status(500).json({
      error: 'Error al buscar torrent',
      message: (error && error.message) || String(error),
    });
  } finally {
    cleanupSearch();
  }
});

// =====================
// OpenSubtitles
// =====================
app.get('/api/opensubtitles/search', async (req, res) => {
  if (!hasOpenSubtitlesConfig()) {
    return res.status(500).json({ error: 'OpenSubtitles API key no configurada' });
  }

  const { query, tmdbId, type, season, episode, languages } = req.query;
  if (!query && !tmdbId) {
    return res.status(400).json({ error: 'query o tmdbId es requerido' });
  }

  const params = {
    query: query ? String(query) : undefined,
    tmdb_id: tmdbId ? String(tmdbId) : undefined,
    languages: languages ? String(languages) : undefined,
    season_number: season ? String(season) : undefined,
    episode_number: episode ? String(episode) : undefined,
    order_by: 'download_count',
    order_direction: 'desc',
    limit: 50,
  };

  if (type === 'tv') {
    params.type = 'episode';
  } else if (type === 'movie') {
    params.type = 'movie';
  }

  const searchParamVariants = [params];
  if (params.query && params.tmdb_id) {
    searchParamVariants.push({
      ...params,
      query: undefined,
    });
    searchParamVariants.push({
      ...params,
      tmdb_id: undefined,
    });
  }

  try {
    console.log('[OpenSubtitles] search params:', {
      query: params.query,
      tmdb_id: params.tmdb_id,
      type: params.type,
      season_number: params.season_number,
      episode_number: params.episode_number,
      languages: params.languages,
    });
    let response = null;
    let lastSearchError = null;
    for (let variantIndex = 0; variantIndex < searchParamVariants.length; variantIndex += 1) {
      const variant = searchParamVariants[variantIndex];
      try {
        response = await withOpenSubtitlesConfig(
          (configIndex) =>
            axios.get(`${OPENSUBTITLES_BASE_URL}/subtitles`, {
              params: variant,
              headers: buildOpenSubtitlesHeaders(configIndex, false),
              timeout: OPENSUBTITLES_SEARCH_TIMEOUT_MS,
              httpAgent: httpAgentGlobal,
              httpsAgent: httpsAgentGlobal,
            }),
          `search#${variantIndex + 1}`
        );
        if (variantIndex > 0) {
          console.warn('[OpenSubtitles] search fallback OK:', {
            variant: variantIndex + 1,
            usedQuery: Boolean(variant.query),
            usedTmdb: Boolean(variant.tmdb_id),
            usedLanguages: Boolean(variant.languages),
          });
        }
        break;
      } catch (searchErr) {
        lastSearchError = searchErr;
        if (!isRetriableOpenSubtitlesError(searchErr) || variantIndex >= searchParamVariants.length - 1) {
          throw searchErr;
        }
        console.warn('[OpenSubtitles] search fallback trigger:', {
          variant: variantIndex + 1,
          code: searchErr?.code || null,
          status: searchErr?.response?.status || null,
          message: searchErr?.message || String(searchErr),
        });
      }
    }
    if (!response) throw lastSearchError || new Error('OpenSubtitles search failed');

    const items = Array.isArray(response?.data?.data) ? response.data.data : [];
    const results = [];
    const sampleFiles = Array.isArray(items?.[0]?.attributes?.files)
      ? items[0].attributes.files.slice(0, 3)
      : [];
    console.log(
      '[OpenSubtitles] response:',
      `status=${response.status}`,
      `total=${response?.data?.total_count || 0}`,
      `items=${items.length}`,
      `sampleFiles=${sampleFiles.length}`
    );
    if (sampleFiles.length > 0) {
      console.log('[OpenSubtitles] sample files:', sampleFiles);
    }

    for (const item of items) {
      const attrs = item?.attributes || {};
      const picked = pickOpenSubtitlesFile(attrs.files);
      if (!picked?.file?.file_id) continue;
      const featureDetails = attrs.feature_details || attrs.featureDetails || {};
      const seasonRaw =
        featureDetails.season_number ??
        featureDetails.seasonNumber ??
        attrs.season_number ??
        attrs.seasonNumber;
      const episodeRaw =
        featureDetails.episode_number ??
        featureDetails.episodeNumber ??
        attrs.episode_number ??
        attrs.episodeNumber;
      const seasonNumber = Number(seasonRaw);
      const episodeNumber = Number(episodeRaw);

      results.push({
        id: item?.id || null,
        language: attrs.language || 'und',
        format: picked.format,
        fileId: picked.file.file_id,
        fileName: sanitizeFileName(picked.file.file_name || ''),
        downloads: Number(attrs.download_count) || 0,
        hearingImpaired: Boolean(attrs.hearing_impaired),
        fps: attrs.fps || null,
        release: attrs.release || '',
        uploader: attrs.uploader?.name || '',
        season: Number.isFinite(seasonNumber) ? seasonNumber : undefined,
        episode: Number.isFinite(episodeNumber) ? episodeNumber : undefined,
      });
    }

    console.log('[OpenSubtitles] results:', results.slice(0, 3));
    res.json({
      results,
      total: response?.data?.total_count || results.length,
    });
  } catch (error) {
    if (error?.code === 'OPENSUBTITLES_AUTH_REQUIRED') {
      return res.status(403).send(error.message);
    }
    const status = error?.response?.status;
    const data = error?.response?.data;
    console.error(
      'Error al buscar en OpenSubtitles:',
      status ? `status=${status}` : '',
      error?.message || error
    );
    if (data) {
      console.error('[OpenSubtitles] error payload:', data);
    }
    res.status(502).json({
      error: 'Error al consultar OpenSubtitles',
      message: error?.message || String(error),
    });
  }
});

app.get('/api/opensubtitles/subtitle/:fileId', async (req, res) => {
  if (!hasOpenSubtitlesConfig()) {
    return res.status(500).send('OpenSubtitles API key no configurada');
  }

  const fileId = Number(req.params.fileId);
  const requestedFormat = String(req.query.format || '').toLowerCase();
  const subFormat = requestedFormat === 'vtt' ? 'vtt' : requestedFormat === 'srt' ? 'srt' : '';
  const fpsRaw = Number(req.query.fps);
  const fps = Number.isFinite(fpsRaw) ? fpsRaw : null;
  if (!Number.isFinite(fileId)) {
    return res.status(400).send('fileId inválido');
  }

  try {
    const { subtitleResponse, downloadInfo } = await withOpenSubtitlesConfig(
      async (configIndex) => {
        const config = getOpenSubtitlesConfig(configIndex);
        const authState = getOpenSubtitlesAuthState(configIndex);

        const fetchSubtitle = async (link) =>
          axios.get(link, {
            responseType: 'arraybuffer',
            timeout: OPENSUBTITLES_TIMEOUT_MS,
            httpAgent: httpAgentGlobal,
            httpsAgent: httpsAgentGlobal,
            maxRedirects: 5,
            headers: {
              'User-Agent': config?.userAgent || 'PirateFlix',
              'Api-Key': config?.apiKey || '',
              Accept: '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              ...(authState?.token ? { Authorization: `Bearer ${authState.token}` } : {}),
            },
          });

        const fetchSubtitleWithRetry = async (link) => {
          try {
            return await fetchSubtitle(link);
          } catch (err) {
            const status = err?.response?.status;
            if (status !== 503) throw err;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return await fetchSubtitle(link);
          }
        };

        let downloadInfo = await resolveOpenSubtitlesDownload(
          configIndex,
          fileId,
          subFormat,
          fps,
          fps
        );
        let subtitleResponse = null;

        try {
          subtitleResponse = await fetchSubtitleWithRetry(downloadInfo.link);
        } catch (err) {
          const status = err?.response?.status;
          if (status === 401 || status === 403 || status === 503) {
            if (!config?.username || !config?.password) {
              const authError = new Error(
                'OpenSubtitles requiere usuario y contraseña para descargar'
              );
              authError.code = 'OPENSUBTITLES_AUTH_REQUIRED';
              authError.response = { status: 403 };
              throw authError;
            }

            const cacheKey = getOpenSubtitlesDownloadCacheKey(configIndex, fileId);
            openSubtitlesDownloadCache.delete(cacheKey);
            authState.token = null;
            await ensureOpenSubtitlesToken(configIndex);
            downloadInfo = await resolveOpenSubtitlesDownload(
              configIndex,
              fileId,
              subFormat,
              fps,
              fps
            );
            subtitleResponse = await fetchSubtitleWithRetry(downloadInfo.link);
          } else {
            throw err;
          }
        }

        return { subtitleResponse, downloadInfo };
      },
      'download'
    );

    let buffer = Buffer.from(subtitleResponse.data);
    let fileName =
      downloadInfo.fileName ||
      extractFilenameFromDisposition(subtitleResponse.headers?.['content-disposition']);
    let ext = guessSubtitleExtension(
      fileName,
      downloadInfo.link,
      subtitleResponse.headers?.['content-type']
    );

    if (ext === 'gz') {
      try {
        buffer = zlib.gunzipSync(buffer);
        fileName = String(fileName).replace(/\.gz$/i, '');
        ext = guessSubtitleExtension(
          fileName,
          downloadInfo.link,
          subtitleResponse.headers?.['content-type']
        );
      } catch (err) {
        console.error('Error al descomprimir subtítulo:', err?.message || err);
        return res.status(500).send('Error al descomprimir subtítulo');
      }
    }

    if (ext === 'zip') {
      return res.status(415).send('Formato ZIP no soportado');
    }

    const content = buffer.toString('utf-8');
    let vttData = '';

    if (ext === 'vtt' || content.startsWith('WEBVTT')) {
      vttData = content;
    } else if (ext === 'srt' || /\d{2}:\d{2}:\d{2},\d{3}/.test(content)) {
      vttData = convertSrtToVtt(content);
    } else {
      return res.status(415).send('Formato de subtítulo no soportado');
    }

    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(vttData);
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    console.error(
      'Error al descargar subtítulo OpenSubtitles:',
      status ? `status=${status}` : '',
      error?.message || error
    );
    if (data) {
      console.error('[OpenSubtitles] download fetch payload:', data);
    }
    res.status(502).send('Error al descargar subtítulo');
  }
});

// =====================
// Endpoint para agregar un torrent
// =====================
function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

async function downloadTorrentBufferWithRetry(url) {
  const attempts = Math.max(1, DOWNLOAD_TORRENT_RETRIES + 1);
  let lastError = null;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await axios.get(url, {
        timeout: DOWNLOAD_TORRENT_TIMEOUT_MS,
        responseType: 'arraybuffer',
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/x-bittorrent,*/*',
        },
        httpAgent: httpAgentGlobal,
        httpsAgent: httpsAgentGlobal,
      });
      const data = response?.data;
      if (!data) throw new Error('Respuesta vacía al descargar .torrent');
      const buffer = Buffer.from(data);
      if (!buffer.length) throw new Error('Archivo .torrent vacío');
      return buffer;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        const delayMs = 500 * (i + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError || new Error('No se pudo descargar el archivo .torrent');
}

app.post('/api/torrent/add', async (req, res) => {
  const { magnetUri } = req.body;
  if (!magnetUri) return res.status(400).json({ error: 'magnetUri es requerido' });

  const sourceInput = String(magnetUri).trim();
  if (!sourceInput) return res.status(400).json({ error: 'magnetUri es requerido' });

  console.log('Agregando torrent:', sourceInput);

  const existingTorrent = client.get(sourceInput);
  if (existingTorrent) {
    console.log('Torrent ya existe');
    return res.json({
      infoHash: existingTorrent.infoHash,
      name: existingTorrent.name || 'Esperando metadata...',
      files: existingTorrent.files.map((f, i) => ({
        index: i,
        name: f.name,
        length: f.length,
        type: getFileType(f.name),
      })),
    });
  }

  let sourceForClient = sourceInput;
  if (isHttpUrl(sourceInput)) {
    try {
      sourceForClient = await downloadTorrentBufferWithRetry(sourceInput);
    } catch (err) {
      const msg = String(err?.message || err || '').toLowerCase();
      const isTimeout =
        msg.includes('timeout') ||
        err?.code === 'ECONNABORTED' ||
        err?.code === 'ERR_CANCELED' ||
        err?.name === 'AbortError';
      return res.status(isTimeout ? 504 : 502).json({
        error: 'Error descargando .torrent',
        message: err?.message || String(err),
      });
    }
  }

  let settled = false;
  const finish = (statusCode, payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(addTimeout);
    res.status(statusCode).json(payload);
  };

  const addTimeout = setTimeout(() => {
    finish(504, {
      error: 'Timeout agregando torrent',
      message: 'WebTorrent tardó demasiado en añadir el torrent',
    });
  }, ADD_TORRENT_TIMEOUT_MS);

  try {
    client.add(sourceForClient, { path: TORRENT_DIR, announce: DEFAULT_TRACKERS }, (torrent) => {
      if (!torrent) {
        finish(500, { error: 'No se pudo agregar torrent', message: 'Respuesta vacía de WebTorrent' });
        return;
      }

      console.log('Torrent agregado:', torrent.name);
      console.log('InfoHash:', torrent.infoHash);
      console.log('Archivos:', torrent.files.length);

      activeTorrents.set(torrent.infoHash, torrent);

      torrent.files.forEach((file) => {
        try {
          file.deselect();
        } catch (_) {}
      });

      finish(200, {
        infoHash: torrent.infoHash,
        name: torrent.name,
        files: torrent.files.map((f, i) => ({
          index: i,
          name: f.name,
          length: f.length,
          type: getFileType(f.name),
        })),
      });
    });
  } catch (err) {
    finish(500, {
      error: 'Error al agregar torrent',
      message: err?.message || String(err),
    });
  }
});

// Función helper para determinar el tipo de archivo
function getFileType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['mp4', 'mkv', 'avi', 'webm', 'mov', 'flv', 'wmv'].includes(ext)) return 'video';
  if (['srt', 'vtt', 'sub', 'ass', 'ssa', 'sbv'].includes(ext)) return 'subtitle';
  return 'other';
}

// Endpoint para obtener información de un torrent
app.get('/api/torrent/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent no encontrado' });

  res.json({
    infoHash: torrent.infoHash,
    name: torrent.name,
    progress: torrent.progress,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    numPeers: torrent.numPeers,
    files: torrent.files.map((f, i) => ({
      index: i,
      name: f.name,
      length: f.length,
      type: getFileType(f.name),
    })),
  });
});

// Endpoint para detectar subtítulos embebidos
app.get('/api/embedded-subtitles/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const cacheKey = `${infoHash}-${fileIndex}`;

  if (embeddedSubtitlesCache.has(cacheKey)) return res.json(embeddedSubtitlesCache.get(cacheKey));

  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent no encontrado' });

  const file = torrent.files[parseInt(fileIndex, 10)];
  if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });
  selectOnlyFile(torrent, parseInt(fileIndex, 10));

  try {
    const filePath = resolveExistingTorrentFilePath(torrent, file);
    console.log('Analizando subtítulos embebidos en:', filePath);

    try {
      await waitForFileOnDisk(
        file,
        buildTorrentFilePathCandidates(torrent, file),
        Math.min(10 * 1024 * 1024, file.length),
        20000
      );
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló:', err.message);
    }

    if (!filePath || !fs.existsSync(filePath)) {
      console.warn('Subtítulos embebidos: archivo aún no disponible en disco');
      return res.json([]);
    }

    const subtitles = await new Promise((resolve) => {
      ffprobeWithRetry(filePath)
        .then((metadata) => {
          const subtitleTracks = [];
          if (metadata.streams) {
            metadata.streams.forEach((stream, index) => {
              if (stream.codec_type === 'subtitle') {
                subtitleTracks.push({
                  index: stream.index,
                  codec: stream.codec_name,
                  language: stream.tags?.language || 'und',
                  title: stream.tags?.title || `Subtitle ${index}`,
                  forced: stream.disposition?.forced === 1,
                  default: stream.disposition?.default === 1,
                });
              }
            });
          }
          resolve(subtitleTracks);
        })
        .catch((err) => {
          console.error('Error al analizar archivo:', err.message);
          resolve([]);
        });
    });

    embeddedSubtitlesCache.set(cacheKey, subtitles);
    res.json(subtitles);
  } catch (error) {
    console.error('Error al detectar subtítulos embebidos:', error);
    res.json([]);
  }
});

// Endpoint para detectar pistas de audio embebidas
app.get('/api/audio-tracks/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const cacheKey = `${infoHash}-${fileIndex}`;

  if (embeddedAudioTracksCache.has(cacheKey)) {
    return res.json(embeddedAudioTracksCache.get(cacheKey));
  }

  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent no encontrado' });

  const file = torrent.files[parseInt(fileIndex, 10)];
  if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });
  selectOnlyFile(torrent, parseInt(fileIndex, 10));

  try {
    const filePath = resolveExistingTorrentFilePath(torrent, file);
    console.log('Analizando pistas de audio embebidas en:', filePath);

    // Esperar bytes mínimos (2MB) con timeout generoso (30s) para que haya datos suficientes
    try {
      await waitForFileOnDisk(
        file,
        buildTorrentFilePathCandidates(torrent, file),
        Math.min(2 * 1024 * 1024, file.length),
        30000
      );
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló:', err.message);
    }

    if (!filePath || !fs.existsSync(filePath)) {
      console.warn('Pistas de audio embebidas: archivo aún no disponible en disco');
      return res.json([]);
    }

    // Progressive ffprobe: retry with increasing delays to allow more data to download
    const audioTracks = await new Promise((resolve) => {
      const maxProbeAttempts = 4;
      const probeDelays = [0, 2000, 4000, 6000]; // ms between attempts

      const attemptProbe = (attempt) => {
        ffprobeWithRetry(filePath, 2)
          .then((metadata) => {
            const tracks = [];
            if (metadata.streams) {
              metadata.streams.forEach((stream, index) => {
                if (stream.codec_type === 'audio') {
                  tracks.push({
                    index: stream.index,
                    codec: stream.codec_name,
                    language: stream.tags?.language || 'und',
                    title: stream.tags?.title || `Audio ${index}`,
                    channels: stream.channels || null,
                    default: stream.disposition?.default === 1,
                  });
                }
              });
            }
            if (tracks.length === 0 && attempt + 1 < maxProbeAttempts) {
              console.log(`ffprobe audio: intento ${attempt + 1}/${maxProbeAttempts} sin pistas, reintentando en ${probeDelays[attempt + 1]}ms...`);
              setTimeout(() => attemptProbe(attempt + 1), probeDelays[attempt + 1]);
            } else {
              resolve(tracks);
            }
          })
          .catch((err) => {
            if (attempt + 1 < maxProbeAttempts) {
              console.log(`ffprobe audio: intento ${attempt + 1}/${maxProbeAttempts} falló (${err.message}), reintentando en ${probeDelays[attempt + 1]}ms...`);
              setTimeout(() => attemptProbe(attempt + 1), probeDelays[attempt + 1]);
            } else {
              console.error('Error al analizar archivo (todos los intentos fallaron):', err.message);
              resolve([]);
            }
          });
      };

      attemptProbe(0);
    });

    embeddedAudioTracksCache.set(cacheKey, audioTracks);
    res.json(audioTracks);
  } catch (error) {
    console.error('Error al detectar pistas de audio embebidas:', error);
    res.json([]);
  }
});

// Endpoint para validar si el archivo permite seeking (duracion al inicio)
app.get('/api/seekable/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).json({ seekable: false, error: 'Torrent no encontrado' });

  const file = torrent.files[parseInt(fileIndex, 10)];
  if (!file) return res.status(404).json({ seekable: false, error: 'Archivo no encontrado' });
  selectOnlyFile(torrent, parseInt(fileIndex, 10));

  const filePath = resolveExistingTorrentFilePath(torrent, file);

  const fileLength = Number(file.length || 0);
  const fileDownloaded = Number(file.downloaded || 0);
  const fullyDownloaded = fileLength > 0 && fileDownloaded >= fileLength;
  const decision = await determineTranscodeMode(file, filePath, null);
  const needsTranscode = decision.mode !== 'none';
  let seekable = false;
  let reason = '';

  if (needsTranscode) {
    seekable = true;
    reason = decision.mode === 'remux' ? 'remux-faststart' : 'transcode';
  } else if (fullyDownloaded) {
    seekable = true;
    reason = 'fully-downloaded';
  } else if (decision.isMp4Like && decision.faststart) {
    seekable = true;
    reason = 'faststart';
  } else if (decision.isMp4Like) {
    reason = 'no-faststart';
  } else {
    reason = 'unsupported-container';
  }

  res.json({
    seekable,
    reason,
    faststart: decision.faststart,
    fullyDownloaded,
    needsTranscode,
  });
});

// Endpoint para ver estado/progreso de transcodificacion
app.get('/api/transcode-status/:infoHash/:fileIndex', (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const audioStreamParam = req.query.audioStream;
  const audioStreamIndex =
    typeof audioStreamParam === 'string' && audioStreamParam.trim() !== ''
      ? Number(audioStreamParam)
      : null;
  const cacheKey = getTranscodeKey(infoHash, fileIndex, audioStreamIndex);
  const status = transcodeStatusByKey.get(cacheKey);

  const torrent = client.get(infoHash);
  let fileLength = null;
  let downloadedBytes = null;
  let downloadPercent = null;
  if (torrent) {
    const file = torrent.files[parseInt(fileIndex)];
    if (file) {
      fileLength = Number(file.length || 0);
      downloadedBytes = Number(file.downloaded || 0);
      if (fileLength > 0) {
        downloadPercent = Math.max(0, Math.min(100, (downloadedBytes / fileLength) * 100));
      }
    }
  }

  if (!status) {
    const cachedPath = getTranscodedCachePath(cacheKey);
    const ready = transcodedCache.get(cacheKey) === 'ready' && fs.existsSync(cachedPath);
    return res.json({
      status: ready ? 'ready' : 'idle',
      percent: ready ? 100 : null,
      downloadPercent,
      fileLength,
      downloadedBytes,
    });
  }

  res.json({
    ...status,
    downloadPercent,
    fileLength,
    downloadedBytes,
  });
});

// =====================
// Seek por tiempo - Stream instantáneo desde cualquier posición
// =====================
app.get('/api/stream-seek/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const timeParam = req.query.time || req.query.t;
  const audioStreamParam = req.query.audioStream;
  
  const seekTime = parseFloat(timeParam) || 0;
  const audioStreamIndex =
    typeof audioStreamParam === 'string' && audioStreamParam.trim() !== ''
      ? Number(audioStreamParam)
      : null;
  
  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).send('Torrent no encontrado');

  const file = torrent.files[parseInt(fileIndex, 10)];
  if (!file) return res.status(404).send('Archivo no encontrado');
  selectOnlyFile(torrent, parseInt(fileIndex, 10));

  attachStreamLifecycle(infoHash, res);

  const filePathCandidates = buildTorrentFilePathCandidates(torrent, file);
  const filePath = resolveExistingTorrentFilePath(torrent, file);
  const transcodeDecision = await determineTranscodeMode(
    file,
    filePath,
    Number.isFinite(audioStreamIndex) ? audioStreamIndex : null
  );

  console.log(
    `🎯 Seek streaming desde ${seekTime}s:`,
    file.name,
    `(mode=${transcodeDecision.mode})`
  );

  try {
    await streamSeekFromTime({
      infoHash,
      fileIndex,
      file,
      filePath,
      filePathCandidates,
      seekTime,
      mode: transcodeDecision.mode,
      audioStreamIndex,
      res,
    });
  } catch (err) {
    console.error('Error en seek streaming:', err?.message || err);
    if (!res.headersSent) {
      res.status(500).send('Error al hacer seek en video');
    }
  }
});

// =====================
// Streaming
// =====================
app.get('/api/stream/:infoHash/:fileIndex', async (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const audioStreamParam = req.query.audioStream;
  const seekableParam = req.query.seekable;
  const requireSeekable =
    typeof seekableParam === 'string' &&
    (seekableParam === '1' || seekableParam.toLowerCase() === 'true');
  const audioStreamIndex =
    typeof audioStreamParam === 'string' && audioStreamParam.trim() !== ''
      ? Number(audioStreamParam)
      : null;
  const forceTranscode = Number.isFinite(audioStreamIndex);
  const torrent = client.get(infoHash);
  if (!torrent) return res.status(404).send('Torrent no encontrado');

  const file = torrent.files[parseInt(fileIndex, 10)];
  if (!file) return res.status(404).send('Archivo no encontrado');
  selectOnlyFile(torrent, parseInt(fileIndex, 10));

  // NUEVO: contabilizar stream activo de este torrent
  attachStreamLifecycle(infoHash, res);

  const filePathCandidates = buildTorrentFilePathCandidates(torrent, file);
  const filePath = resolveExistingTorrentFilePath(torrent, file);
  const transcodeDecision = await determineTranscodeMode(
    file,
    filePath,
    Number.isFinite(audioStreamIndex) ? audioStreamIndex : null
  );
  const needsTranscode = transcodeDecision.mode !== 'none';

  console.log(
    'Streaming archivo:',
    file.name,
    needsTranscode ? `(preparando MP4 seekable: ${transcodeDecision.mode})` : '',
    forceTranscode ? `(audio stream ${audioStreamIndex})` : ''
  );

  if (needsTranscode) {
    if (
      !requireSeekable &&
      !forceTranscode &&
      transcodeDecision.mode === 'remux' &&
      transcodeDecision.isMp4Like
    ) {
      console.log('✅ Sirviendo MP4 sin faststart (no seekable requerido):', file.name);
      return serveVideoFile(filePath, req, res, file);
    }

    const cacheKey = getTranscodeKey(
      infoHash,
      fileIndex,
      forceTranscode ? audioStreamIndex : null
    );
    const cachedPath = getTranscodedCachePath(cacheKey);
    if (!requireSeekable && fs.existsSync(cachedPath)) {
      console.log('✅ Sirviendo MP4 seekable en cache:', file.name);
      return serveVideoFile(cachedPath, req, res);
    }
    try {
      if (!requireSeekable) {
        await streamTranscodedFile({
          cacheKey,
          infoHash,
          fileIndex,
          file,
          filePath,
          filePathCandidates,
          mode: transcodeDecision.mode,
          audioStreamIndex: forceTranscode ? audioStreamIndex : null,
          res,
        });
        return;
      }

      const ensuredPath = await ensureTranscodedFile({
        cacheKey,
        infoHash,
        fileIndex,
        file,
        filePath,
        filePathCandidates,
        mode: transcodeDecision.mode,
        audioStreamIndex: forceTranscode ? audioStreamIndex : null,
      });
      if (res.destroyed) return;
      console.log('✅ Sirviendo MP4 seekable:', file.name);
      return serveVideoFile(ensuredPath, req, res);
    } catch (err) {
      console.error('Error preparando MP4 seekable:', err?.message || err);
      if (!res.headersSent) {
        res.status(500).send('Error al preparar video');
      }
      return;
    }
  }

  // Streaming normal compatible: PASAMOS el file de WebTorrent para que sirva con createReadStream
  serveVideoFile(filePath, req, res, file);
});

// Función auxiliar para servir archivos de video con soporte de Range
function serveVideoFile(filePath, req, res, webTorrentFile = null) {
  // Si es archivo del sistema (transcodificado)
  if (!webTorrentFile) {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = rangeParser(fileSize, range);
      if (parts === -1 || parts === -2 || parts.type !== 'bytes' || parts.length === 0) {
        res.status(416).send('Rango no satisfactorio');
        return;
      }

      const [{ start, end }] = parts;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });

      const fileStream = fs.createReadStream(filePath, { start, end });
      pump(fileStream, res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      });

      const fileStream = fs.createReadStream(filePath);
      pump(fileStream, res);
    }
    return;
  }

  // Si es archivo de WebTorrent
  const fileSize = webTorrentFile.length;
  const range = req.headers.range;

  if (range) {
    const parts = rangeParser(fileSize, range);

    if (parts === -1 || parts === -2 || parts.type !== 'bytes' || parts.length === 0) {
      res.status(416).send('Rango no satisfactorio');
      return;
    }

    const [{ start, end }] = parts;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    const stream = webTorrentFile.createReadStream({ start, end });
    pump(stream, res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });

    const stream = webTorrentFile.createReadStream();
    pump(stream, res);
  }
}

// Endpoint para extraer subtítulos embebidos
app.get('/api/embedded-subtitle/:infoHash/:fileIndex/:streamIndex', async (req, res) => {
  const { infoHash, fileIndex, streamIndex } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) return res.status(404).send('Torrent no encontrado');

  const file = torrent.files[parseInt(fileIndex, 10)];
  if (!file) return res.status(404).send('Archivo no encontrado');
  selectOnlyFile(torrent, parseInt(fileIndex, 10));

  try {
    console.log(`Extrayendo subtítulo stream ${streamIndex} de:`, file.name);

    const filePath = resolveExistingTorrentFilePath(torrent, file);

    let clientDisconnected = false;
    let ffmpegCommand = null;

    res.on('close', () => {
      clientDisconnected = true;
      console.log('Cliente desconectado durante extracción de subtítulo');
      try {
        if (ffmpegCommand) ffmpegCommand.kill('SIGKILL');
      } catch (_) {}
    });

    try {
      await waitForFileOnDisk(
        file,
        buildTorrentFilePathCandidates(torrent, file),
        Math.min(64 * 1024, file.length),
        15000
      );
    } catch (err) {
      console.warn('Advertencia: waitForFileOnDisk falló antes de extraer subtítulo:', err.message);
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(503).send('Archivo aún no disponible en disco');
    }

    res.writeHead(200, {
      'Content-Type': 'text/vtt',
      'Access-Control-Allow-Origin': '*',
    });

    ffmpegCommand = ffmpeg(filePath)
      .outputOptions([`-map 0:${streamIndex}`, '-f webvtt'])
      .on('error', (err) => {
        if (!clientDisconnected && err.code !== 'EPIPE') {
          console.error('Error extrayendo subtítulo:', err.message);
          if (!res.headersSent) res.status(500).send('Error al extraer subtítulo');
        }
      })
      .on('end', () => {
        if (!clientDisconnected) console.log('Subtítulo extraído exitosamente');
      });

    ffmpegCommand.pipe(res, { end: true });
  } catch (error) {
    console.error('Error al extraer subtítulo embebido:', error.message);
    if (!res.headersSent) res.status(500).send('Error al procesar subtítulo');
  }
});

// Endpoint para obtener subtítulos
app.get('/api/subtitle/:infoHash/:fileIndex', (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) return res.status(404).send('Torrent no encontrado');

  const file = torrent.files[parseInt(fileIndex)];
  if (!file) return res.status(404).send('Archivo no encontrado');

  console.log('Sirviendo subtítulo:', file.name);

  const ext = file.name.toLowerCase().split('.').pop();

  res.writeHead(200, {
    'Content-Type': 'text/vtt',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=31536000',
  });

  const stream = file.createReadStream();

  if (ext === 'srt') {
    let srtData = '';
    stream.on('data', (chunk) => {
      srtData += chunk.toString('utf-8');
    });
    stream.on('end', () => {
      try {
        const vttData = convertSrtToVtt(srtData);
        res.end(vttData);
      } catch (error) {
        console.error('Error al convertir SRT a VTT:', error);
        res.status(500).send('Error al convertir subtítulo');
      }
    });
    stream.on('error', (err) => {
      console.error('Error al leer subtítulo:', err);
      if (!res.headersSent) res.status(500).send('Error al leer subtítulo');
    });
  } else {
    pump(stream, res);
  }
});

function convertSrtToVtt(srtContent) {
  let vtt = 'WEBVTT\n\n';
  vtt += srtContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
}

// =====================
// Endpoint para eliminar un torrent (DEFERRED si hay streams activos)
// =====================
app.delete('/api/torrent/:infoHash', (req, res) => {
  const { infoHash } = req.params;
  const torrent = client.get(infoHash);

  if (!torrent) return res.status(404).json({ error: 'Torrent no encontrado' });

  // Marcar para destruir (aunque no se pueda ahora)
  pendingDestroy.add(infoHash);

  // Matar FFmpeg si existe (si hay transcode activo, igual prefieres dejarlo terminar;
  // pero para cambio de peli es mejor cortarlo)
  for (const [cacheKey] of activeFFmpegProcesses.entries()) {
    if (String(cacheKey).startsWith(infoHash)) {
      console.log('🧹 Deteniendo FFmpeg para torrent:', cacheKey);
      clearTranscodeEntry(cacheKey, 'torrent-deleted');
    }
  }

  for (const cacheKey of Array.from(transcodedCache.keys())) {
    if (String(cacheKey).startsWith(infoHash)) {
      clearTranscodeEntry(cacheKey, 'torrent-deleted');
    }
  }

  // Si no hay streams ni ffmpeg, destruye ya
  if (canDestroyNow(infoHash)) {
    destroyTorrentNow(infoHash);
    return res.json({ success: true, destroyed: true });
  }

  // Si hay streams activos, responde OK pero el destroy será cuando acaben
  const streams = activeStreamsByInfoHash.get(infoHash) || 0;
  return res.json({ success: true, destroyed: false, pending: true, activeStreams: streams });
});

// Health
app.get('/health', (req, res) => {
  const storageSummary = collectStorageSummary();
  res.json({
    status: 'ok',
    torrents: client?.torrents?.length ?? 0,
    uploadSpeed: client?.uploadSpeed ?? 0,
    downloadSpeed: client?.downloadSpeed ?? 0,
    activeStreamsTracked: activeStreamsByInfoHash.size,
    pendingDestroy: pendingDestroy.size,
    storage: {
      totalBytes: storageSummary.usage.totalBytes,
      torrentsBytes: storageSummary.usage.torrentsBytes,
      transcodedBytes: storageSummary.usage.transcodedBytes,
      maxBytes: storageSummary.policy.maxBytes,
      lastPruneAt: lastStoragePruneReport?.finishedAt || null,
    },
  });
});

app.get('/api/storage/stats', (req, res) => {
  try {
    const summary = collectStorageSummary();
    res.json({
      ...summary,
      pruneInProgress: storagePruneInProgress,
      lastPrune: lastStoragePruneReport,
    });
  } catch (err) {
    console.error('Error obteniendo storage stats:', err);
    res.status(500).json({ error: 'failed to get storage stats' });
  }
});

app.post('/api/storage/prune', (req, res) => {
  try {
    const reasonRaw = String(req?.body?.reason || '').trim();
    const reason = reasonRaw ? `manual:${reasonRaw}` : 'manual';
    const report = pruneStorage(reason);
    res.json(report);
  } catch (err) {
    console.error('Error en storage prune:', err);
    res.status(500).json({ error: 'failed to prune storage' });
  }
});

// TheIntroDB Proxy - Get skip times for credits/intros
// API Docs: https://theintrodb.org/docs
app.get('/api/theintrodb/media', async (req, res) => {
  const { tmdb_id, season, episode } = req.query;
  
  if (!tmdb_id) {
    return res.status(400).json({ error: 'tmdb_id is required' });
  }
  
  try {
    // Build query params
    const params = new URLSearchParams();
    params.set('tmdb_id', tmdb_id);
    if (season) params.set('season', season);
    if (episode) params.set('episode', episode);
    
    const url = `https://api.theintrodb.org/v1/media?${params.toString()}`;
    console.log(`[TheIntroDB] Fetching: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
      },
      httpAgent: httpAgentGlobal,
      httpsAgent: httpsAgentGlobal,
      timeout: 10000,
    });
    
    console.log(`[TheIntroDB] Response:`, JSON.stringify(response.data));
    res.json(response.data);
  } catch (err) {
    const status = err?.response?.status || 500;
    console.warn(`[TheIntroDB] Error fetching tmdb_id=${tmdb_id}:`, err?.message || err);
    
    // Return empty data for 404 (not found in database)
    if (status === 404) {
      return res.json({
        tmdb_id: parseInt(tmdb_id),
        type: season ? 'tv' : 'movie',
        intro: null,
        recap: null,
        credits: null,
      });
    }
    
    res.status(status).json({
      error: 'Failed to fetch from TheIntroDB',
      message: err?.message || 'Unknown error',
    });
  }
});

// Mirror stats
app.get('/api/mirror-stats', (req, res) => {
  try {
    const arr = Array.from(mirrorStats.entries()).map(([base, s]) => ({
      base,
      fails: s.fails || 0,
      lastFail: s.lastFail ? new Date(s.lastFail).toISOString() : null,
      lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
      openUntil: s.openUntil ? new Date(s.openUntil).toISOString() : null,
    }));

    const cacheInfo = {
      searchCacheSize: global.__pirateflix_search_cache ? global.__pirateflix_search_cache.size : 0,
      transcodedCacheSize: transcodedCache.size,
    };

    res.json({ mirrors: arr, cache: cacheInfo });
  } catch (err) {
    console.error('Error obteniendo mirror-stats:', err);
    res.status(500).json({ error: 'failed to get mirror stats' });
  }
});

// =====================
// Quick-switch: Endpoint LIGERO para cambiar de película rápido
// Solo mata FFmpeg y streams activos, NO destruye el cliente WebTorrent
// =====================
app.post('/api/quick-switch', async (req, res) => {
  const startTime = Date.now();
  console.log('⚡ Quick-switch solicitado');

  try {
    const rawSession = req?.body?.sessionId;
    const sessionId = Number(rawSession);
    if (Number.isFinite(sessionId)) {
      if (sessionId < latestQuickSwitchSession) {
        console.log(
          '⚠️ Quick-switch ignorado por sesión antigua:',
          sessionId,
          '(latest=',
          latestQuickSwitchSession,
          ')'
        );
        return res.json({
          success: true,
          skipped: true,
          time: Date.now() - startTime,
          reason: 'stale-session',
        });
      }
      latestQuickSwitchSession = sessionId;
    }

    // 1. Abortar búsquedas activas inmediatamente
    for (const ctrl of Array.from(activeSearchControllers)) {
      try {
        ctrl.abort();
      } catch (_) {}
      activeSearchControllers.delete(ctrl);
    }

    // 2. Matar FFmpeg y limpiar transcodes activos
    clearAllTranscodeEntries('quick-switch');
    transcodeStatusByKey.clear();

    // 3. Cerrar streams HTTP activos (sin esperar)
    for (const [infoHash, resSet] of Array.from(activeResponsesByInfoHash.entries())) {
      for (const r of Array.from(resSet)) {
        try {
          r.destroy && r.destroy();
        } catch (_) {}
      }
    }
    activeResponsesByInfoHash.clear();
    activeStreamsByInfoHash.clear();

    // 4. Destruir torrents activos en background (no esperar)
    const torrentsToDestroy = client?.torrents?.slice() || [];
    for (const t of torrentsToDestroy) {
      try {
        const ih = t.infoHash;
        const torrentDataPaths = getTorrentDataPaths(t);
        activeTorrents.delete(ih);
        clearEmbeddedCacheForInfoHash(ih);
        t.destroy(() => {
          if (STORAGE_DELETE_ON_TORRENT_DESTROY && torrentDataPaths.length > 0) {
            for (const targetPath of torrentDataPaths) {
              removePathSafe(targetPath);
            }
            removeEmptyDirs(TORRENT_DIR, true);
          }
        });
      } catch (_) {}
    }

    // 5. Limpiar caches de subtítulos
    embeddedSubtitlesCache.clear();
    embeddedAudioTracksCache.clear();
    pendingDestroy.clear();
    setTimeout(() => {
      try {
        pruneStorage('quick-switch');
      } catch (_) {}
    }, 0);

    console.log(`⚡ Quick-switch completado en ${Date.now() - startTime}ms`);
    res.json({ success: true, time: Date.now() - startTime });
  } catch (err) {
    console.error('Error en quick-switch:', err);
    res.json({ success: true, time: Date.now() - startTime }); // No fallar, seguir
  }
});

// =====================
// Reset-state COMPLETO: Solo usar si quick-switch no funciona
// =====================
app.post('/api/reset-state', async (req, res) => {
  const startTime = Date.now();
  console.log('🔁 Reset completo solicitado');

  try {
    const rawSession = req?.body?.sessionId;
    const sessionId = Number(rawSession);
    if (Number.isFinite(sessionId)) {
      if (sessionId < latestQuickSwitchSession) {
        console.log(
          '⚠️ Reset ignorado por sesión antigua:',
          sessionId,
          '(latest=',
          latestQuickSwitchSession,
          ')'
        );
        return res.json({
          success: true,
          skipped: true,
          time: Date.now() - startTime,
          reason: 'stale-session',
        });
      }
      latestQuickSwitchSession = sessionId;
    }

    // 1. Abortar búsquedas
    for (const ctrl of Array.from(activeSearchControllers)) {
      try {
        ctrl.abort();
      } catch (_) {}
      activeSearchControllers.delete(ctrl);
    }

    // 2. Matar FFmpeg y limpiar transcodes activos
    clearAllTranscodeEntries('reset-state');
    transcodeStatusByKey.clear();

    // 3. Cerrar streams
    for (const [, resSet] of Array.from(activeResponsesByInfoHash.entries())) {
      for (const r of Array.from(resSet)) {
        try {
          r.destroy && r.destroy();
        } catch (_) {}
      }
    }
    activeResponsesByInfoHash.clear();
    activeStreamsByInfoHash.clear();
    pendingDestroy.clear();

    // 4. Destruir cliente WebTorrent y recrearlo
    const allTorrentDataPaths = new Set();
    for (const t of client?.torrents?.slice() || []) {
      for (const p of getTorrentDataPaths(t)) allTorrentDataPaths.add(p);
    }
    if (client) {
      try {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 2000); // Max 2s
          client.destroy(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch (_) {}
    }
    if (STORAGE_DELETE_ON_TORRENT_DESTROY) {
      for (const targetPath of Array.from(allTorrentDataPaths)) {
        removePathSafe(targetPath);
      }
      removeEmptyDirs(TORRENT_DIR, true);
    }

    client = createWebTorrentClient();

    // 5. Limpiar caches
    activeTorrents.clear();
    embeddedSubtitlesCache.clear();
    embeddedAudioTracksCache.clear();
    transcodedCache.clear();
    pruneStorage('reset-state');

    console.log(`✅ Reset completo en ${Date.now() - startTime}ms`);
    res.json({ success: true, time: Date.now() - startTime });
  } catch (err) {
    console.error('Error en reset:', err);
    // Recrear cliente de todas formas
    try {
      client = createWebTorrentClient();
    } catch (_) {}
    res.json({ success: true, time: Date.now() - startTime });
  }
});

// Iniciar servidor
app.listen(PORT, HOST, () => {
  console.log(`🚀 Servidor de torrents escuchando en http://${HOST}:${PORT}`);
  console.log(`📊 Health check: http://${HOST}:${PORT}/health`);

  (async () => {
    try {
      await warmupMirrors(3000);
    } catch (err) {
      console.warn('🔧 Warmup inesperado fallo:', err && err.message ? err.message : err);
    }
  })();
});

// Limpiar al cerrar
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  if (storageSweepTimer) {
    try {
      clearInterval(storageSweepTimer);
    } catch (_) {}
    storageSweepTimer = null;
  }
  const c = client;
  if (!c) return process.exit(0);

  c.destroy(() => {
    console.log('✅ Cliente WebTorrent cerrado');
    process.exit(0);
  });
});

// Manejar errores no capturados
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') {
    console.log('Cliente desconectado (EPIPE) - ignorado');
  } else {
    console.error('Error no capturado:', err);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Promesa rechazada no manejada:', reason);
});
