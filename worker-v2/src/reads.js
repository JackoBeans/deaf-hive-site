// ════════════════════════════════════════════════════════════════════════
// Public read endpoints — /organisations, /events, /videos.
//
// Each one checks the edge cache first; on miss, queries D1, shapes the
// rows, writes the response back to cache, and returns it.
// ════════════════════════════════════════════════════════════════════════

import { jsonResponse, withCors } from './cors.js';
import { cacheGet, cachePut } from './cache.js';
import {
  fetchApprovedOrganisations,
  fetchApprovedEvents,
  fetchApprovedVideos,
} from './db.js';

export const READ_PATHS = ['/organisations', '/events', '/videos'];

const FETCHERS = {
  '/organisations': fetchApprovedOrganisations,
  '/events':        fetchApprovedEvents,
  '/videos':        fetchApprovedVideos,
};

export async function handleRead(request, env, ctx, url, origin) {
  const fetcher = FETCHERS[url.pathname];
  if (!fetcher) {
    return jsonResponse({ error: 'not_found' }, 404, env, origin);
  }

  // Cache hit — re-stamp with caller's CORS and return.
  const cached = await cacheGet(url.toString());
  if (cached) {
    return withCors(cached, env, origin);
  }

  // Cache miss — query D1.
  let records;
  try {
    records = await fetcher(env);
  } catch (err) {
    return jsonResponse(
      { error: 'db_error', message: String(err?.message || err) },
      500,
      env,
      origin,
    );
  }

  const body = JSON.stringify({ records });
  const response = new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  await cachePut(ctx, url.toString(), response, env);
  return withCors(response, env, origin);
}
