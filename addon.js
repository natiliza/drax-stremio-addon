
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 7000);
const EMBY_BASE_URL = 'http://57.129.112.137:8096'.replace(/\/$/, '');
const EMBY_USER_ID = '5bbad1d3da464abc8cd7d5e00b64a716';
const EMBY_TOKEN = 'efd9652de753477caf10a2031a367672';
const DEBUG = String(process.env.DEBUG_DRAX || '').toLowerCase() === '1' || String(process.env.DEBUG_DRAX || '').toLowerCase() === 'true';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);
const metaCache = new Map();
const episodesCache = new Map();

const categories = JSON.parse(fs.readFileSync(path.join(__dirname, 'categories.json'), 'utf8'));
const categoriesById = Object.fromEntries(categories.map((c) => [c.catalogId, c]));

const manifest = {
  id: 'local.drax.hebrew.emby.v053',
  version: '0.5.3',
  name: 'DRAX Emby עברית FIX 3',
  description: 'קטלוגי DRAX בעברית עבור Stremio, על בסיס Emby',
  resources: [
    'catalog',
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['emby_movie_', 'emby_series_'] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['emby_movie_', 'emby_series_'] }
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

function parseExtra(extraSegment) {
  if (!extraSegment) return {};
  const clean = extraSegment.replace(/\.json$/i, '');
  const params = new URLSearchParams(clean.replace(/\//g, '&'));
  return Object.fromEntries(params.entries());
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
      const itemId = stripIdPrefix(rawId);
      const data = type === 'movie' ? await buildMovieMeta(itemId, base) : await buildSeriesMeta(itemId, base);
      return json(res, 200, data);
    }

    if (parts[0] === 'stream' && parts.length >= 3) {
      const type = parts[1];
      const rawId = parts[2].replace(/\.json$/i, '');
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
