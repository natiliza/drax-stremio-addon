
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 7000);
const EMBY_BASE_URL = (process.env.EMBY_BASE_URL || '').replace(/\/$/, '');
const EMBY_USER_ID = process.env.EMBY_USER_ID || '';
const EMBY_TOKEN = process.env.EMBY_TOKEN || '';
const DEBUG = String(process.env.DEBUG_DRAX || '').toLowerCase() === '1' || String(process.env.DEBUG_DRAX || '').toLowerCase() === 'true';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);
const metaCache = new Map();
const episodesCache = new Map();
const subtitleListCache = new Map();
const subtitleSourceCache = new Map();
const translationJobs = new Map();
const translationJobsByQueueId = new Map();

const TRANSLATE_SERVER_URL = (process.env.TRANSLATE_SERVER_URL || '').replace(/\/$/, '');
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || '';
const TRANSLATION_KEEP_MS = Number(process.env.TRANSLATION_KEEP_MS || 10 * 60 * 1000);
const SUBTITLE_REQUEST_TIMEOUT_MS = Number(process.env.SUBTITLE_REQUEST_TIMEOUT_MS || 45000);
const OPENSUBTITLES_MANIFEST_URL = process.env.OPENSUBTITLES_MANIFEST_URL || 'https://opensubtitles-v3.strem.io/manifest.json';
const KTUVIT_MANIFEST_URL = process.env.KTUVIT_MANIFEST_URL || 'https://4b139a4b7f94-ktuvit-stremio.baby-beamup.club/manifest.json';
const WIZDOM_MANIFEST_URL = process.env.WIZDOM_MANIFEST_URL || 'https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club/manifest.json';

const QUEUE_CATEGORIES = [
  { catalogId: 'translations_in_progress', type: 'movie', name: 'תרגומים בתהליך', mode: 'translationQueue', queueFilter: 'active' },
  { catalogId: 'translations_completed', type: 'movie', name: 'תרגומים שהסתיימו', mode: 'translationQueue', queueFilter: 'done' },
  { catalogId: 'translations_ollama_library', type: 'movie', name: 'תרגומי Ollama', mode: 'translationQueue', queueFilter: 'all' }
];

const categories = [
  ...QUEUE_CATEGORIES,
  ...JSON.parse(fs.readFileSync(path.join(__dirname, 'categories.json'), 'utf8'))
];
const categoriesById = Object.fromEntries(categories.map((c) => [c.catalogId, c]));

const SUBTITLE_PROVIDERS = [
  { id: 'opensubtitles', name: 'OpenSubtitles', manifestUrl: OPENSUBTITLES_MANIFEST_URL },
  { id: 'ktuvit', name: 'Ktuvit', manifestUrl: KTUVIT_MANIFEST_URL },
  { id: 'wizdom', name: 'Wizdom', manifestUrl: WIZDOM_MANIFEST_URL }
].map((provider) => ({
  ...provider,
  baseUrl: String(provider.manifestUrl || '').replace(/\/manifest\.json(?:\?.*)?$/i, '')
}));

const manifest = {
  id: 'local.drax.hebrew.emby.ollama.v060',
  version: '0.6.0',
  name: 'DRAX Emby + Subtitles + Ollama',
  description: 'קטלוגי DRAX בעברית עבור Stremio, על בסיס Emby, עם כתוביות ותרגום Ollama',
  resources: [
    'catalog',
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['emby_movie_', 'emby_series_', 'transjob_'] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['emby_movie_', 'emby_series_'] },
    { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['emby_movie_', 'emby_series_', 'tt'] }
  ],
  types: ['movie', 'series'],
  catalogs: categories.map((c) => ({
    id: c.catalogId,
    type: c.type,
    name: c.name,
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false }
    ]
  })),
  behaviorHints: {
    configurable: false
  }
};

function log(...args) {
  console.log('[DRAX]', ...args);
}

function debug(...args) {
  if (DEBUG) console.log('[DRAX:DEBUG]', ...args);
}


function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { map.delete(key); return null; }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { ts: Date.now(), value });
  return value;
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function text(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(data);
}

function requireConfig() {
  return EMBY_BASE_URL && EMBY_USER_ID && EMBY_TOKEN;
}

function serverBaseFromRequest(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function buildEmbyUrl(endpoint, params = {}) {
  const url = new URL(EMBY_BASE_URL + endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  url.searchParams.set('format', 'json');
  return url.toString();
}

async function embyFetch(endpoint, params = {}) {
  const url = buildEmbyUrl(endpoint, params);
  debug('GET', url);
  const res = await fetch(url, {
    headers: {
      'X-Emby-Token': EMBY_TOKEN,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Emby ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function normalizeArrayResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.Items)) return data.Items;
  return [];
}

function proxyImage(base, kind, itemId) {
  return `${base}/img/${kind}/${encodeURIComponent(itemId)}`;
}

function stripIdPrefix(id) {
  return id.replace(/^emby_(movie|series|episode)_/, '');
}

function sanitizeOverview(value) {
  return typeof value === 'string' ? value : '';
}


function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeDataSvg(labelLines = [], opts = {}) {
  const width = Number(opts.width || 600);
  const height = Number(opts.height || 900);
  const title = escapeHtml(opts.title || 'DRAX');
  const subtitle = escapeHtml(opts.subtitle || '');
  const progress = Math.max(0, Math.min(100, Number(opts.progress || 0)));
  const lines = Array.isArray(labelLines) ? labelLines.slice(0, 5) : [];
  const lineSvg = lines.map((line, idx) => `<text x="50%" y="${260 + idx * 64}" text-anchor="middle" font-size="40" fill="#ffffff" font-family="Arial, sans-serif">${escapeHtml(line)}</text>`).join('');
  const progressWidth = Math.round((width - 120) * (progress / 100));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#18122B"/>
        <stop offset="100%" stop-color="#393053"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)" rx="28"/>
    <text x="50%" y="90" text-anchor="middle" font-size="34" fill="#d8c5ff" font-family="Arial, sans-serif">${title}</text>
    <text x="50%" y="150" text-anchor="middle" font-size="52" font-weight="700" fill="#ffffff" font-family="Arial, sans-serif">${subtitle}</text>
    ${lineSvg}
    <rect x="60" y="780" width="${width - 120}" height="30" rx="15" fill="#5b4f7a"/>
    <rect x="60" y="780" width="${progressWidth}" height="30" rx="15" fill="#8b5cf6"/>
    <text x="50%" y="855" text-anchor="middle" font-size="36" fill="#ffffff" font-family="Arial, sans-serif">${progress}%</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildQueuePoster(job) {
  const lines = [job.displayName || job.title || 'תרגום', job.stageLabel || statusToHebrew(job.status || ''), job.remainingLabel || ''];
  return makeDataSvg(lines, {
    title: 'DRAX Ollama',
    subtitle: job.providerName || 'Translation',
    progress: Number(job.progress || 0)
  });
}

function providerImdb(item) {
  return item?.ProviderIds?.Imdb || item?.ProviderIds?.IMDb || item?.ProviderIds?.imdb || '';
}

function encodeToken(data) {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeToken(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function registerSubtitleSource(info) {
  const base = {
    v: 1,
    key: info.sourceKey,
    provider: info.providerId,
    lang: info.sourceLang,
    title: info.title,
    year: info.year,
    mediaType: info.mediaType,
    displayName: info.displayName
  };
  const token = encodeToken(base);
  subtitleSourceCache.set(token, { ...info, token });
  return token;
}

function getRegisteredSubtitleSource(token) {
  const existing = subtitleSourceCache.get(token);
  if (existing) return existing;
  const decoded = decodeToken(token);
  if (!decoded || !decoded.key) return null;
  for (const job of translationJobs.values()) {
    if (job.token === token || job.sourceKey === decoded.key) return job.sourceInfo || null;
  }
  return null;
}

function fetchWithTimeout(url, options = {}, timeoutMs = SUBTITLE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const merged = { ...options, signal: controller.signal };
  return fetch(url, merged).finally(() => clearTimeout(timer));
}

async function fetchJsonAbsolute(url, options = {}, timeoutMs = SUBTITLE_REQUEST_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchTextAbsolute(url, options = {}, timeoutMs = SUBTITLE_REQUEST_TIMEOUT_MS) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return res.text();
}


function providerShort(providerName) {
  const key = String(providerName || '').toLowerCase();
  if (key.includes('opensubtitles')) return 'OS';
  if (key.includes('ktuvit')) return 'KT';
  if (key.includes('wizdom')) return 'WZ';
  return String(providerName || '').slice(0, 2).toUpperCase() || 'SB';
}

function displayLang(lang) {
  const raw = String(lang || '').trim();
  const key = raw.toLowerCase();
  const map = {
    heb: 'עברית', he: 'עברית', hebrew: 'עברית',
    eng: 'English', en: 'English', english: 'English',
    spa: 'Spanish', es: 'Spanish', spanish: 'Spanish',
    fre: 'French', fra: 'French', fr: 'French', french: 'French',
    ger: 'German', deu: 'German', de: 'German', german: 'German',
    ita: 'Italian', it: 'Italian',
    por: 'Portuguese', pt: 'Portuguese',
    rus: 'Russian', ru: 'Russian',
    ara: 'Arabic', ar: 'Arabic', arabic: 'Arabic',
    tur: 'Turkish', tr: 'Turkish',
    jpn: 'Japanese', ja: 'Japanese',
    kor: 'Korean', ko: 'Korean'
  };
  return map[key] || raw || 'Unknown';
}

function isHebrewish(lang) {
  const key = String(lang || '').trim().toLowerCase();
  return ['he', 'heb', 'hebrew', 'עברית'].includes(key);
}

function queueStatusBucket(job) {
  const status = String(job.status || '').toLowerCase();
  if (status === 'done') return 'done';
  if (status === 'error' || status === 'cancelled') return 'done';
  return 'active';
}

function statusToHebrew(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'done') return 'הסתיים';
  if (key === 'error') return 'נכשל';
  if (key === 'cancelled') return 'בוטל';
  if (key === 'running') return 'בתרגום';
  return key || 'ממתין';
}

function stageToHebrew(stage) {
  const value = String(stage || '').trim();
  if (!value) return 'ממתין';
  const lower = value.toLowerCase();
  if (lower.startsWith('translating')) return 'מתרגם';
  if (lower === 'queued') return 'ממתין בתור';
  if (lower === 'telegram') return 'שולח';
  if (lower === 'done') return 'הסתיים';
  if (lower === 'error') return 'נכשל';
  if (lower === 'cancelled') return 'בוטל';
  if (lower.includes('context')) return 'מנתח הקשר';
  return value;
}

function formatEta(etaSeconds) {
  const n = Number(etaSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mins = Math.round(n / 60);
  if (mins < 1) return 'פחות מדקה';
  if (mins < 60) return `נשארו ~${mins} דקות`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `נשארו ~${hrs}ש ${rem}ד` : `נשארו ~${hrs} שעות`;
}

function formatSourceDisplay(providerName, lang) {
  return `${displayLang(lang)}`;
}

function formatTranslateDisplay(providerName, lang) {
  return `תרגם דרך Ollama`;
}

async function resolveSubtitleContext(type, rawId) {
  const raw = String(rawId || '');

  if (raw.startsWith('tt')) {
    const parts = raw.split(':');
    const imdbId = parts[0];
    if (type === 'movie' || parts.length === 1) {
      return {
        type: 'movie',
        upstreamType: 'movie',
        upstreamId: imdbId,
        imdbId,
        title: imdbId,
        year: '',
        displayName: imdbId
      };
    }
    const season = Number(parts[1] || 0);
    const episode = Number(parts[2] || 0);
    return {
      type: 'series',
      upstreamType: 'series',
      upstreamId: `${imdbId}:${season}:${episode}`,
      imdbId,
      season,
      episode,
      title: imdbId,
      year: '',
      displayName: `${imdbId} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    };
  }

  if (type === 'movie') {
    const itemId = stripIdPrefix(rawId);
    const item = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items/${itemId}`, {
      Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags'
    });
    const imdbId = providerImdb(item);
    if (!imdbId) return null;
    return {
      type: 'movie',
      upstreamType: 'movie',
      upstreamId: imdbId,
      imdbId,
      title: item.Name || imdbId,
      year: item.ProductionYear ? String(item.ProductionYear) : '',
      displayName: item.Name || imdbId
    };
  }

  const afterPrefix = stripIdPrefix(rawId || '');
  const pieces = String(afterPrefix).split(':');
  const seriesId = pieces[0];
  const season = Number(pieces[1] || 0);
  const episode = Number(pieces[2] || 0);
  if (!seriesId || !season || !episode) return null;
  const seriesItem = await getSeriesById(seriesId);
  const imdbId = providerImdb(seriesItem);
  if (!imdbId) return null;
  const label = `${seriesItem.Name || imdbId} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  return {
    type: 'series',
    upstreamType: 'series',
    upstreamId: `${imdbId}:${season}:${episode}`,
    imdbId,
    season,
    episode,
    title: seriesItem.Name || imdbId,
    year: seriesItem.ProductionYear ? String(seriesItem.ProductionYear) : '',
    displayName: label
  };
}

async function fetchProviderSubtitles(provider, context) {
  if (!provider?.baseUrl || !context?.upstreamId) return [];
  const cacheKey = `${provider.id}|${context.upstreamType}|${context.upstreamId}`;
  const cached = cacheGet(subtitleListCache, cacheKey);
  if (cached) return cached;
  const url = `${provider.baseUrl}/subtitles/${context.upstreamType}/${encodeURIComponent(context.upstreamId)}.json`;
  try {
    const data = await fetchJsonAbsolute(url, {}, 20000);
    const list = Array.isArray(data?.subtitles) ? data.subtitles : [];
    return cacheSet(subtitleListCache, cacheKey, list);
  } catch (err) {
    debug('provider subtitles failed', provider.id, context.upstreamId, String(err));
    return cacheSet(subtitleListCache, cacheKey, []);
  }
}

function buildSourceInfo(provider, item, context) {
  return {
    sourceKey: `${provider.id}|${item.id || item.url}`,
    providerId: provider.id,
    providerName: provider.name,
    sourceId: item.id || item.url,
    sourceUrl: item.url,
    sourceLang: item.lang || 'und',
    title: context.title,
    year: context.year,
    mediaType: context.type,
    displayName: context.displayName
  };
}

function jobToMetaPreview(job) {
  return {
    id: `transjob_${job.queueId}`,
    type: 'movie',
    name: job.displayName || job.title || 'תרגום',
    poster: buildQueuePoster(job),
    posterShape: 'poster',
    description: `${job.stageLabel || ''}${job.remainingLabel ? ` • ${job.remainingLabel}` : ''}`.trim(),
    releaseInfo: job.year || undefined
  };
}

function buildQueueMeta(queueId) {
  const job = translationJobsByQueueId.get(queueId);
  if (!job) return { meta: { id: `transjob_${queueId}`, type: 'movie', name: 'תרגום לא נמצא', videos: [] } };
  return {
    meta: {
      id: `transjob_${job.queueId}`,
      type: 'movie',
      name: job.displayName || job.title || 'תרגום',
      poster: buildQueuePoster(job),
      background: buildQueuePoster(job),
      description: [
        `מקור: ${job.providerName || 'Unknown'} / ${displayLang(job.sourceLang)}`,
        `סטטוס: ${job.stageLabel || statusToHebrew(job.status)}`,
        job.remainingLabel || '',
        job.status === 'done' ? 'התרגום מוכן לבחירה מתוך רשימת הכתוביות.' : 'בחר שוב את כתובית ה-Ollama כדי לטעון מחדש את המצב.'
      ].filter(Boolean).join('\n'),
      videos: []
    }
  };
}

function cleanupTranslations() {
  const now = Date.now();
  for (const [key, job] of translationJobs.entries()) {
    const keepUntil = Number(job.keepUntil || 0);
    if (keepUntil && keepUntil < now) {
      translationJobs.delete(key);
      translationJobsByQueueId.delete(job.queueId);
    }
  }
}

async function refreshTranslationJob(job) {
  if (!job || !job.jobId || !TRANSLATE_SERVER_URL) return job;
  try {
    const statusUrl = `${TRANSLATE_SERVER_URL}/job_status?job_id=${encodeURIComponent(job.jobId)}`;
    const data = await fetchJsonAbsolute(statusUrl, {}, 15000);
    job.status = data.status || job.status || 'running';
    job.stage = data.stage || job.stage || '';
    job.progress = Number.isFinite(Number(data.progress)) ? Number(data.progress) : Number(job.progress || 0);
    job.eta_s = Number.isFinite(Number(data.eta_s)) ? Number(data.eta_s) : job.eta_s;
    job.updatedAt = Date.now();
    job.stageLabel = stageToHebrew(job.stage) || statusToHebrew(job.status);
    job.remainingLabel = formatEta(job.eta_s);
    if (job.status === 'done') {
      job.progress = 100;
      job.keepUntil = Date.now() + TRANSLATION_KEEP_MS;
    }
    if (job.status === 'error' || job.status === 'cancelled') {
      job.keepUntil = Date.now() + TRANSLATION_KEEP_MS;
    }
  } catch (err) {
    debug('refreshTranslationJob failed', job.jobId, String(err));
  }
  translationJobs.set(job.sourceKey, job);
  translationJobsByQueueId.set(job.queueId, job);
  return job;
}

async function fetchSourceSubtitleText(sourceInfo) {
  return fetchTextAbsolute(sourceInfo.sourceUrl, {}, 30000);
}

async function createTranslationJob(sourceInfo) {
  if (!TRANSLATE_SERVER_URL) {
    throw new Error('TRANSLATE_SERVER_URL is not configured');
  }
  const srtText = await fetchSourceSubtitleText(sourceInfo);
  const filenameBase = (sourceInfo.displayName || sourceInfo.title || 'subtitle').replace(/[^\w\u0590-\u05FF ._-]+/g, ' ').trim() || 'subtitle';
  const filename = `${filenameBase}.${String(sourceInfo.sourceLang || 'src').replace(/[^a-z0-9_-]/gi, '')}.srt`;
  const body = {
    client: 'stremio',
    send_telegram: 0,
    srt_text: srtText,
    title: sourceInfo.title || sourceInfo.displayName || '',
    year: sourceInfo.year || '',
    filename,
  };
  if (TRANSLATE_MODEL) body.model = TRANSLATE_MODEL;
  const data = await fetchJsonAbsolute(`${TRANSLATE_SERVER_URL}/translate_srt_job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 60000);
  const queueId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    queueId,
    token: sourceInfo.token,
    sourceInfo,
    sourceKey: sourceInfo.sourceKey,
    providerName: sourceInfo.providerName,
    sourceLang: sourceInfo.sourceLang,
    displayName: sourceInfo.displayName,
    title: sourceInfo.title,
    year: sourceInfo.year,
    mediaType: sourceInfo.mediaType,
    jobId: data.job_id || data.id || '',
    status: data.status || 'running',
    stage: data.stage || 'queued',
    progress: Number(data.progress || 1),
    eta_s: Number(data.eta_s || 0),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    keepUntil: 0
  };
  job.stageLabel = stageToHebrew(job.stage);
  job.remainingLabel = formatEta(job.eta_s);
  translationJobs.set(job.sourceKey, job);
  translationJobsByQueueId.set(job.queueId, job);
  return job;
}

async function getOrCreateTranslationJob(sourceInfo) {
  cleanupTranslations();
  let job = translationJobs.get(sourceInfo.sourceKey);
  if (!job) {
    job = await createTranslationJob(sourceInfo);
  }
  await refreshTranslationJob(job);
  return job;
}

function buildStatusSrt(job) {
  const status = job?.stageLabel || statusToHebrew(job?.status || 'running');
  const eta = job?.remainingLabel || 'התהליך בעבודה';
  const title = job?.displayName || job?.title || 'DRAX Ollama';
  return `1\n00:00:00,000 --> 00:00:06,000\n${title}\n\n2\n00:00:06,000 --> 00:00:12,000\n${status}\n\n3\n00:00:12,000 --> 00:00:18,000\n${eta}\n`;
}

function sendSubtitleText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/x-subrip; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function proxyRemoteSubtitle(req, res, token) {
  const sourceInfo = getRegisteredSubtitleSource(token);
  if (!sourceInfo?.sourceUrl) return sendSubtitleText(res, 404, '1\n00:00:00,000 --> 00:00:05,000\nSubtitle source not found\n');
  try {
    const srt = await fetchTextAbsolute(sourceInfo.sourceUrl, {}, 30000);
    return sendSubtitleText(res, 200, srt);
  } catch (err) {
    return sendSubtitleText(res, 502, `1\n00:00:00,000 --> 00:00:05,000\n${String(err.message || err)}\n`);
  }
}

async function proxyTranslatedSubtitle(req, res, token) {
  const sourceInfo = getRegisteredSubtitleSource(token);
  if (!sourceInfo) {
    return sendSubtitleText(res, 404, '1\n00:00:00,000 --> 00:00:05,000\nמקור התרגום לא נמצא\n');
  }
  if (!TRANSLATE_SERVER_URL) {
    return sendSubtitleText(res, 200, '1\n00:00:00,000 --> 00:00:06,000\nשרת התרגום לא מוגדר\n\n2\n00:00:06,000 --> 00:00:12,000\nיש להגדיר TRANSLATE_SERVER_URL בתוסף\n');
  }
  try {
    const job = await getOrCreateTranslationJob(sourceInfo);
    if (job.status === 'done') {
      const url = `${TRANSLATE_SERVER_URL}/subtitle/${encodeURIComponent(job.jobId)}.srt`;
      const srt = await fetchTextAbsolute(url, {}, 30000);
      return sendSubtitleText(res, 200, srt);
    }
    if (job.status === 'error' || job.status === 'cancelled') {
      return sendSubtitleText(res, 200, buildStatusSrt(job));
    }
    return sendSubtitleText(res, 200, buildStatusSrt(job));
  } catch (err) {
    return sendSubtitleText(res, 200, `1\n00:00:00,000 --> 00:00:06,000\nתרגום Ollama לא זמין כרגע\n\n2\n00:00:06,000 --> 00:00:12,000\n${String(err.message || err).slice(0, 120)}\n\n3\n00:00:12,000 --> 00:00:18,000\nבדוק ששרת התרגום נגיש מהשרת של התוסף\n`);
  }
}

async function buildSubtitles(type, rawId, base) {
  const context = await resolveSubtitleContext(type, rawId);
  if (!context) return { subtitles: [], cacheMaxAge: 10, staleRevalidate: 10, staleError: 60 };

  const allProviderResults = await Promise.all(SUBTITLE_PROVIDERS.map((provider) => fetchProviderSubtitles(provider, context).then((items) => ({ provider, items }))));
  const subtitles = [];
  const seen = new Set();

  for (const { provider, items } of allProviderResults) {
    for (const item of items) {
      if (!item || !item.url) continue;
      const sourceInfo = buildSourceInfo(provider, item, context);
      const token = registerSubtitleSource(sourceInfo);
      sourceInfo.token = token;
      subtitleSourceCache.set(token, sourceInfo);

      const originalKey = `orig|${provider.id}|${item.id || item.url}`;
      if (!seen.has(originalKey)) {
        seen.add(originalKey);
        subtitles.push({
          id: originalKey,
          url: `${base}/subtitle-proxy/${encodeURIComponent(token)}.srt`,
          lang: formatSourceDisplay(provider.name, item.lang)
        });
      }

      if (!isHebrewish(item.lang)) {
        const translatedKey = `tr|${provider.id}|${item.id || item.url}`;
        if (!seen.has(translatedKey)) {
          seen.add(translatedKey);
          subtitles.push({
            id: translatedKey,
            url: `${base}/subtitle-translate/${encodeURIComponent(token)}.srt`,
            lang: formatTranslateDisplay(provider.name, item.lang)
          });
        }
      }
    }
  }

  return { subtitles, cacheMaxAge: 5, staleRevalidate: 5, staleError: 60 };
}

function parseYouTubeIdFromUrl(urlValue) {
  if (!urlValue || typeof urlValue !== 'string') return null;
  try {
    const u = new URL(urlValue);
    const host = (u.hostname || '').toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v') || '';
        return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
      }
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0])) {
        const id = parts[1] || '';
        return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
      }
    }
  } catch (_) {}
  return null;
}

function trailersFromItem(item) {
  const remoteTrailers = Array.isArray(item?.RemoteTrailers) ? item.RemoteTrailers : [];
  const seen = new Set();
  const trailers = [];
  for (const trailer of remoteTrailers) {
    const ytId = parseYouTubeIdFromUrl(trailer?.Url);
    if (!ytId || seen.has(ytId)) continue;
    seen.add(ytId);
    trailers.push({ source: ytId, type: 'Trailer' });
  }
  return trailers;
}

function toMovieMetaPreview(item, base) {
  return {
    id: `emby_movie_${item.Id}`,
    type: 'movie',
    name: item.Name,
    poster: proxyImage(base, 'primary', item.Id),
    posterShape: 'poster',
    background: proxyImage(base, 'backdrop', item.Id),
    description: sanitizeOverview(item.Overview),
    releaseInfo: item.ProductionYear ? String(item.ProductionYear) : undefined,
    genres: item.Genres || [],
    trailers: trailersFromItem(item)
  };
}

function toSeriesMetaPreview(item, base) {
  return {
    id: `emby_series_${item.Id}`,
    type: 'series',
    name: item.Name,
    poster: proxyImage(base, 'primary', item.Id),
    posterShape: 'poster',
    background: proxyImage(base, 'backdrop', item.Id),
    description: sanitizeOverview(item.Overview),
    releaseInfo: item.ProductionYear ? String(item.ProductionYear) : undefined,
    genres: item.Genres || [],
    trailers: trailersFromItem(item)
  };
}

function uniqueById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || !item.Id || seen.has(item.Id)) continue;
    seen.add(item.Id);
    out.push(item);
  }
  return out;
}

function filterLooseItems(items, itemType) {
  const wantedRaw = String(itemType || '').toLowerCase();
  const wanted = new Set(wantedRaw.split(',').map((s) => s.trim()).filter(Boolean));
  return items.filter((item) => {
    const t = String(item.Type || item.MediaType || '').toLowerCase();
    if (wanted.has('movie') || wanted.has('video')) return ['movie', 'video'].includes(t);
    if (wanted.has('series')) return ['series'].includes(t);
    return true;
  });
}

async function getLibraryItems(parentId, itemType, search, skip = 0, limit = 50, sort = '') {
  const common = {
    ParentId: parentId,
    Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags',
    ImageTypeLimit: 1,
    IsMissing: false,
    Recursive: true,
    StartIndex: skip,
    Limit: limit
  };
  if (search) common.SearchTerm = search;

  const strictParams = { ...common, IncludeItemTypes: itemType };
  if (itemType === 'Movie') {
    strictParams.CollapseBoxSetItems = false;
    strictParams.GroupItemsIntoCollections = false;
  }
  if (sort === 'alpha') {
    strictParams.SortBy = 'SortName';
    strictParams.SortOrder = 'Ascending';
  }

  const strictData = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items`, strictParams);
  let items = normalizeArrayResponse(strictData);
  debug('strict items', parentId, itemType, items.length);
  if (items.length) return items;

  const looseParams = { ...common };
  if (sort === 'alpha') {
    looseParams.SortBy = 'SortName';
    looseParams.SortOrder = 'Ascending';
  }
  const looseData = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items`, looseParams);
  items = filterLooseItems(normalizeArrayResponse(looseData), itemType);
  debug('loose items', parentId, itemType, items.length);
  if (items.length) return uniqueById(items);

  const latestParams = {
    ParentId: parentId,
    Fields: common.Fields,
    ImageTypeLimit: 1,
    Limit: limit,
    IncludeItemTypes: itemType,
    Recursive: true
  };
  const latestData = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items/Latest`, latestParams);
  items = filterLooseItems(normalizeArrayResponse(latestData), itemType);
  debug('latest items', parentId, itemType, items.length);
  return uniqueById(items);
}


async function getRecentLibraryItems(parentId, itemType, search, skip = 0, limit = 50, years = '') {
  const params = {
    ParentId: parentId,
    Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags',
    ImageTypeLimit: 1,
    IsMissing: false,
    IncludeItemTypes: itemType,
    Recursive: true,
    StartIndex: skip,
    Limit: limit,
    SortBy: 'DateCreated',
    SortOrder: 'Descending',
    Filters: 'IsNotFolder'
  };
  if (itemType === 'Movie') {
    params.CollapseBoxSetItems = false;
    params.GroupItemsIntoCollections = false;
  }
  if (search) params.SearchTerm = search;
  if (years) params.Years = years;
  const data = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items`, params);
  return normalizeArrayResponse(data);
}

async function getLatestLibraryItems(parentId, itemType, search, skip = 0, limit = 50) {
  if (search || skip) {
    return getRecentLibraryItems(parentId, itemType, search, skip, limit);
  }
  const params = {
    ParentId: parentId,
    Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags',
    ImageTypeLimit: 1,
    IncludeItemTypes: itemType,
    Limit: limit
  };
  const data = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items/Latest`, params);
  return filterLooseItems(normalizeArrayResponse(data), itemType);
}

async function getLatestEpisodes(parentId, skip = 0, limit = 50) {
  const params = {
    ParentId: parentId,
    Fields: 'Overview,SeriesId,SeriesName,ParentIndexNumber,IndexNumber,PremiereDate,ImageTags',
    ImageTypeLimit: 1,
    IsMissing: false,
    IncludeItemTypes: 'Episode',
    Recursive: true,
    StartIndex: skip,
    Limit: limit,
    SortBy: 'DateCreated',
    SortOrder: 'Descending',
    Filters: 'IsNotFolder'
  };
  const data = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items`, params);
  let items = normalizeArrayResponse(data);
  if (items.length) return items;
  const latest = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items/Latest`, {
    ParentId: parentId,
    Fields: params.Fields,
    ImageTypeLimit: 1,
    Limit: limit,
    IncludeItemTypes: 'Episode'
  });
  items = normalizeArrayResponse(latest);
  return items;
}

async function getSeriesById(seriesId) {
  return embyFetch(`/emby/Users/${EMBY_USER_ID}/Items/${seriesId}`, {
    Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags'
  });
}

async function searchAllByType(type, search, base, skip = 0, limit = 50) {
  const itemType = type === 'movie' ? 'Movie,Video' : 'Series';
  const params = {
    SearchTerm: search,
    Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags',
    ImageTypeLimit: 1,
    IsMissing: false,
    IncludeItemTypes: itemType,
    Recursive: true,
    StartIndex: skip,
    Limit: limit,
    SortBy: 'SortName',
    SortOrder: 'Ascending'
  };
  if (type === 'movie') {
    params.CollapseBoxSetItems = false;
    params.GroupItemsIntoCollections = false;
  }
  const data = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items`, params);
  let items = uniqueById(filterLooseItems(normalizeArrayResponse(data), itemType));

  if (!items.length) {
    try {
      const hints = await embyFetch(`/emby/Search/Hints`, {
        UserId: EMBY_USER_ID,
        SearchTerm: search,
        IncludeItemTypes: itemType,
        Recursive: true,
        Limit: limit,
        ImageTypeLimit: 1,
        Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags'
      });
      items = uniqueById(filterLooseItems(normalizeArrayResponse(hints), itemType));
    } catch (e) {
      debug('search hints failed', String(e));
    }
  }

  const metas = items.map((item) => type === 'movie' ? toMovieMetaPreview(item, base) : toSeriesMetaPreview(item, base));
  return { metas };
}

async function buildCatalog(category, base, extra = {}) {
  const skip = Number(extra.skip || 0);
  const search = extra.search ? String(extra.search).trim() : '';

  if (search) {
    return searchAllByType(category.type, search, base, skip, 50);
  }

  if (category.mode === 'translationQueue') {
    cleanupTranslations();
    const jobs = Array.from(translationJobs.values())
      .filter((job) => {
        const bucket = queueStatusBucket(job);
        if (category.queueFilter === 'active') return bucket === 'active';
        if (category.queueFilter === 'done') return bucket === 'done';
        return true;
      })
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const metas = jobs.slice(skip, skip + 50).map((job) => jobToMetaPreview(job));
    return { metas };
  }

  if (category.mode === 'library') {
    const items = await getLibraryItems(category.parentId, category.itemType, search, skip, 50, category.sort || '');
    const metas = items.map((item) => category.type === 'movie' ? toMovieMetaPreview(item, base) : toSeriesMetaPreview(item, base));
    debug('catalog result', category.catalogId, metas.length);
    return { metas };
  }

  if (category.mode === 'recentMovies') {
    let items = await getRecentLibraryItems(category.parentId, category.itemType || 'Movie', search, skip, 50, category.years || '');
    if (!items.length) {
      items = await getLibraryItems(category.parentId, category.itemType || 'Movie', search, skip, 50, category.sort || '');
    }
    const metas = items.map((item) => toMovieMetaPreview(item, base));
    debug('catalog result', category.catalogId, metas.length);
    return { metas };
  }

  if (category.mode === 'latestMovies') {
    const items = await getLatestLibraryItems(category.parentId, category.itemType || 'Movie', search, skip, 50);
    const metas = items.map((item) => toMovieMetaPreview(item, base));
    debug('catalog result', category.catalogId, metas.length);
    return { metas };
  }

  if (category.mode === 'latestEpisodesToSeries') {
    const episodes = await getLatestEpisodes(category.parentId, skip, 50);
    const uniqueSeriesIds = [];
    for (const ep of episodes) {
      if (ep.SeriesId && !uniqueSeriesIds.includes(ep.SeriesId)) uniqueSeriesIds.push(ep.SeriesId);
    }
    const seriesItems = await Promise.all(uniqueSeriesIds.map((id) => getSeriesById(id).catch(() => null)));
    const metas = seriesItems.filter(Boolean).map((item) => toSeriesMetaPreview(item, base));
    debug('catalog result', category.catalogId, metas.length);
    return { metas };
  }

  return { metas: [] };
}

function fallbackReleased(ep, seriesItem) {
  if (ep && ep.PremiereDate) return ep.PremiereDate;
  if (seriesItem && seriesItem.PremiereDate) return seriesItem.PremiereDate;
  if (seriesItem && seriesItem.ProductionYear) return `${seriesItem.ProductionYear}-01-01T00:00:00.000Z`;
  return '2000-01-01T00:00:00.000Z';
}

function makeSeriesVideo(ep, base, seriesItem) {
  const season = Number(ep.ParentIndexNumber || 0);
  const episode = Number(ep.IndexNumber || 0);
  const safeSeason = season > 0 ? season : 1;
  const safeEpisode = episode > 0 ? episode : 1;
  const s = String(safeSeason).padStart(2, '0');
  const e = String(safeEpisode).padStart(2, '0');
  return {
    id: `emby_series_${seriesItem.Id}:${safeSeason}:${safeEpisode}`,
    title: ep.Name || `${s}x${e}`,
    released: fallbackReleased(ep, seriesItem),
    season: safeSeason,
    episode: safeEpisode
  };
}

async function buildMovieMeta(itemId, base) {
  const cacheKey = `movie:${itemId}`;
  const cached = cacheGet(metaCache, cacheKey);
  if (cached) return cached;
  const item = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items/${itemId}`, {
    Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags'
  });
  return cacheSet(metaCache, cacheKey, {
    meta: {
      id: `emby_movie_${item.Id}`,
      type: 'movie',
      name: item.Name,
      poster: proxyImage(base, 'primary', item.Id),
      background: proxyImage(base, 'backdrop', item.Id),
      description: sanitizeOverview(item.Overview),
      releaseInfo: item.ProductionYear ? String(item.ProductionYear) : undefined,
      genres: item.Genres || [],
      runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000000 / 60) : undefined,
      trailers: trailersFromItem(item)
    }
  });
}

async function getSeriesEpisodes(seriesId) {
  const cached = cacheGet(episodesCache, seriesId);
  if (cached) return cached;

  const common = {
    Fields: 'Overview,ParentIndexNumber,IndexNumber,PremiereDate,ImageTags,SeriesName',
    ImageTypeLimit: 1,
    IsMissing: false,
    IncludeItemTypes: 'Episode',
    Recursive: true,
    SortBy: 'ParentIndexNumber,IndexNumber',
    SortOrder: 'Ascending',
    Limit: 1000
  };

  const collect = (items) => uniqueById((items || []).filter((ep) => {
    const type = String(ep?.Type || ep?.MediaType || '').toLowerCase();
    return type === 'episode' || ep?.IndexNumber != null || ep?.ParentIndexNumber != null;
  }));

  const finish = (items) => cacheSet(episodesCache, seriesId, uniqueById(items).sort((a, b) => {
    const sa = Number(a?.ParentIndexNumber || 0);
    const sb = Number(b?.ParentIndexNumber || 0);
    if (sa !== sb) return sa - sb;
    return Number(a?.IndexNumber || 0) - Number(b?.IndexNumber || 0);
  }));

  try {
    const showEpisodes = await embyFetch(`/emby/Shows/${seriesId}/Episodes`, {
      UserId: EMBY_USER_ID,
      Fields: common.Fields,
      ImageTypeLimit: 1,
      IsMissing: false,
      Limit: 1000
    });
    const items = collect(normalizeArrayResponse(showEpisodes));
    debug('series show episodes', seriesId, items.length);
    if (items.length) return finish(items);
  } catch (e) { debug('series show episodes failed', seriesId, String(e)); }

  let seasons = [];
  try {
    const seasonsData = await embyFetch(`/emby/Shows/${seriesId}/Seasons`, {
      UserId: EMBY_USER_ID,
      Fields: 'Overview,ParentIndexNumber,IndexNumber,PremiereDate,ImageTags',
      ImageTypeLimit: 1,
      IsMissing: false
    });
    seasons = normalizeArrayResponse(seasonsData);
    debug('series show seasons', seriesId, seasons.length);
  } catch (e) { debug('series show seasons failed', seriesId, String(e)); }

  if (seasons.length) {
    const allEpisodes = [];
    for (const season of seasons) {
      try {
        const epsData = await embyFetch(`/emby/Shows/${season.Id}/Episodes`, {
          UserId: EMBY_USER_ID,
          Fields: common.Fields,
          ImageTypeLimit: 1,
          IsMissing: false,
          Limit: 1000
        });
        allEpisodes.push(...collect(normalizeArrayResponse(epsData)));
      } catch (e) { debug('season episodes failed', seriesId, season.Id, String(e)); }
    }
    if (allEpisodes.length) return finish(allEpisodes);
  }

  const tryUserItems = async (params) => {
    const data = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items`, { ...common, ...params });
    return collect(normalizeArrayResponse(data));
  };

  const directAttempts = [
    { ParentId: seriesId },
    { SeriesId: seriesId },
    { AncestorIds: seriesId }
  ];

  for (const params of directAttempts) {
    try {
      const items = await tryUserItems(params);
      debug('series direct episodes', seriesId, JSON.stringify(params), items.length);
      if (items.length) return finish(items);
    } catch (e) { debug('series direct episodes failed', seriesId, JSON.stringify(params), String(e)); }
  }

  if (!seasons.length) {
    try {
      const seasonsData = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items`, {
        ParentId: seriesId,
        IncludeItemTypes: 'Season',
        Recursive: false,
        Fields: 'Overview,ParentIndexNumber,IndexNumber,PremiereDate,ImageTags',
        ImageTypeLimit: 1,
        IsMissing: false,
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        Limit: 200
      });
      seasons = normalizeArrayResponse(seasonsData);
      debug('series user seasons', seriesId, seasons.length);
    } catch (e) { debug('series user seasons failed', seriesId, String(e)); }
  }

  const allEpisodes = [];
  for (const season of seasons) {
    try {
      const epsData = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items`, {
        ...common,
        ParentId: season.Id,
        Recursive: false,
        Limit: 1000
      });
      allEpisodes.push(...collect(normalizeArrayResponse(epsData)));
    } catch (e) { debug('season user episodes failed', seriesId, season.Id, String(e)); }
  }

  return finish(allEpisodes);
}

async function buildSeriesMeta(itemId, base) {
  const cacheKey = `series:${itemId}`;
  const cached = cacheGet(metaCache, cacheKey);
  if (cached) return cached;
  const item = await embyFetch(`/emby/Users/${EMBY_USER_ID}/Items/${itemId}`, {
    Fields: 'Overview,Genres,ProductionYear,PremiereDate,RunTimeTicks,ProviderIds,ImageTags'
  });
  const episodes = await getSeriesEpisodes(itemId);
  const seen = new Set();
  const videos = episodes.filter((ep) => {
    if (!ep || !ep.Id || seen.has(ep.Id)) return false;
    seen.add(ep.Id);
    return true;
  }).map((ep) => makeSeriesVideo(ep, base, item));
  return cacheSet(metaCache, cacheKey, {
    meta: {
      id: `emby_series_${item.Id}`,
      type: 'series',
      name: item.Name,
      poster: proxyImage(base, 'primary', item.Id),
      description: sanitizeOverview(item.Overview),
      releaseInfo: item.ProductionYear ? String(item.ProductionYear) : undefined,
      genres: item.Genres || [],
      trailers: trailersFromItem(item),
      videos
    }
  });
}

async function getPlaybackStream(itemId) {
  const data = await embyFetch(`/emby/Items/${itemId}/PlaybackInfo`, {
    UserId: EMBY_USER_ID,
    MaxStreamingBitrate: 75000000,
    EnableDirectPlay: true,
    EnableDirectStream: true,
    EnableTranscoding: true
  });
  const source = (data.MediaSources || [])[0];
  if (!source) return null;

  let rel = source.DirectStreamUrl || source.TranscodingUrl || '';

  if (!rel) {
    const fallback = new URL(`${EMBY_BASE_URL}/emby/Videos/${encodeURIComponent(itemId)}/stream`);
    fallback.searchParams.set('static', 'true');
    if (source.Id) fallback.searchParams.set('MediaSourceId', source.Id);
    fallback.searchParams.set('api_key', EMBY_TOKEN);
    rel = fallback.toString();
  }

  if (!/^https?:\/\//i.test(rel)) {
    rel = rel.startsWith('/') ? `${EMBY_BASE_URL}${rel}` : `${EMBY_BASE_URL}/${rel}`;
  }

  const url = new URL(rel);
  if ((source.AddApiKeyToDirectStreamUrl || !url.searchParams.has('api_key')) && !url.searchParams.has('X-MediaBrowser-Token')) {
    url.searchParams.set('api_key', EMBY_TOKEN);
  }

  const proxyHeaders = {};
  if (source.RequiredHttpHeaders && typeof source.RequiredHttpHeaders === 'object') {
    proxyHeaders.request = { ...source.RequiredHttpHeaders };
  }

  const descriptionBits = [];
  if (source.Container) descriptionBits.push(String(source.Container).toUpperCase());
  if (source.Name) descriptionBits.push(source.Name);

  const stream = {
    url: url.toString(),
    name: 'Emby',
    description: descriptionBits.join(' • ') || 'Emby Direct',
    behaviorHints: {
      notWebReady: true
    }
  };

  if (proxyHeaders.request && Object.keys(proxyHeaders.request).length) {
    stream.behaviorHints.proxyHeaders = proxyHeaders;
  }

  if (source.Path) {
    const filename = String(source.Path).split(/[\/]/).pop();
    if (filename) stream.behaviorHints.filename = filename;
  }

  return stream;
}

async function proxyImageResponse(req, res, kind, itemId) {
  const map = {
    primary: 'Primary',
    backdrop: 'Backdrop',
    logo: 'Logo',
    thumb: 'Thumb'
  };
  const imageType = map[kind] || 'Primary';
  const tryTypes = imageType === 'Primary' ? ['Primary'] : [imageType, 'Primary'];

  for (const t of tryTypes) {
    const maxWidth = t === 'Backdrop' ? 1280 : t === 'Logo' ? 400 : 600;
    const imageUrl = new URL(`${EMBY_BASE_URL}/emby/Items/${encodeURIComponent(itemId)}/Images/${t}`);
    imageUrl.searchParams.set('maxWidth', String(maxWidth));
    imageUrl.searchParams.set('quality', '90');
    imageUrl.searchParams.set('api_key', EMBY_TOKEN);
    const upstream = await fetch(imageUrl.toString());
    if (!upstream.ok) continue;
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(buffer);
    return;
  }

  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = decodeURIComponent(reqUrl.pathname);
    const base = serverBaseFromRequest(req);

    if (pathname === '/' || pathname === '/manifest.json') {
      if (!requireConfig()) {
        return json(res, 200, {
          ...manifest,
          description: 'יש להגדיר EMBY_BASE_URL, EMBY_USER_ID, EMBY_TOKEN לפני שימוש'
        });
      }
      return json(res, 200, manifest);
    }

    if (!requireConfig()) {
      return text(res, 500, 'Missing EMBY_BASE_URL / EMBY_USER_ID / EMBY_TOKEN');
    }

    const parts = pathname.split('/').filter(Boolean);

    if (parts[0] === 'img' && parts.length >= 3) {
      return await proxyImageResponse(req, res, parts[1], parts[2]);
    }

    if (parts[0] === 'subtitle-proxy' && parts.length >= 2) {
      const token = parts[1].replace(/\.srt$/i, '');
      return await proxyRemoteSubtitle(req, res, token);
    }

    if (parts[0] === 'subtitle-translate' && parts.length >= 2) {
      const token = parts[1].replace(/\.srt$/i, '');
      return await proxyTranslatedSubtitle(req, res, token);
    }

    if (parts[0] === 'subtitles' && parts.length >= 3) {
      const type = parts[1];
      const rawId = parts[2].replace(/\.json$/i, '');
      const data = await buildSubtitles(type, rawId, base);
      return json(res, 200, data);
    }

    if (parts[0] === 'catalog' && parts.length >= 3) {
      const type = parts[1];
      const id = parts[2].replace(/\.json$/i, '');
      const extraFromPath = parts[3] ? parseExtra(parts[3]) : {};
      const extra = { ...extraFromPath, ...Object.fromEntries(reqUrl.searchParams.entries()) };
      const category = categoriesById[id];
      if (!category || category.type !== type) return json(res, 404, { metas: [] });
      const data = await buildCatalog(category, base, extra);
      return json(res, 200, data);
    }

    if (parts[0] === 'meta' && parts.length >= 3) {
      const type = parts[1];
      const rawId = parts[2].replace(/\.json$/i, '');
      if (rawId.startsWith('transjob_')) {
        const queueId = rawId.replace(/^transjob_/, '');
        return json(res, 200, buildQueueMeta(queueId));
      }
      const itemId = stripIdPrefix(rawId);
      const data = type === 'movie' ? await buildMovieMeta(itemId, base) : await buildSeriesMeta(itemId, base);
      return json(res, 200, data);
    }

    if (parts[0] === 'stream' && parts.length >= 3) {
      const type = parts[1];
      const rawId = parts[2].replace(/\.json$/i, '');
      if (rawId.startsWith('transjob_')) return json(res, 200, { streams: [] });
      const rawVideoId = parts[3] ? parts[3].replace(/\.json$/i, '') : null;
      let playbackId = rawId;
      if (type === 'series') {
        const seriesVideoId = rawVideoId || rawId;
        if (seriesVideoId.includes(':')) {
          const afterPrefix = stripIdPrefix(seriesVideoId);
          const pieces = afterPrefix.split(':');
          if (pieces.length >= 3) {
            const seriesId = pieces[0];
            const seasonNum = Number(pieces[1] || 0);
            const episodeNum = Number(pieces[2] || 0);
            try {
              const eps = await getSeriesEpisodes(seriesId);
              const match = eps.find((ep) => Number(ep.ParentIndexNumber || 0) === seasonNum && Number(ep.IndexNumber || 0) === episodeNum);
              playbackId = match?.Id || seriesId;
            } catch (_) {
              playbackId = seriesId;
            }
          } else {
            playbackId = pieces[0] || afterPrefix;
          }
        } else {
          playbackId = rawVideoId || rawId;
        }
      }
      const itemId = stripIdPrefix(playbackId);
      const stream = await getPlaybackStream(itemId);
      return json(res, 200, { streams: stream ? [stream] : [] });
    }

    return text(res, 404, 'Not found');
  } catch (err) {
    return json(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`DRAX Hebrew Stremio addon listening on http://127.0.0.1:${PORT}/manifest.json`);
  if (DEBUG) log('DEBUG mode enabled');
});
