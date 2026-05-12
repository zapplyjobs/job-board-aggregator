'use strict';

const https = require('https');

/**
 * Shared HTTP client for custom fetchers.
 *
 * Provides getJson, getHtml, postJson, and delay — eliminating duplicated
 * HTTP plumbing across 9 custom fetchers (~2,000 lines removed).
 *
 * All functions return null on error/timeout (matching existing fetcher contracts).
 * JSON functions return {status, data}. HTML functions return {status, html}.
 */

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; job-board-bot/1.0)';

function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    timeout = DEFAULT_TIMEOUT,
    body = null,
    followRedirects = false,
  } = options;

  return new Promise((resolve) => {
    let urlObj;
    try { urlObj = new URL(url); } catch (_) { return resolve(null); }
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'User-Agent': DEFAULT_USER_AGENT, ...headers },
    };

    if (body) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(reqOptions, (res) => {
      if (followRedirects && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl;
        try { redirectUrl = new URL(res.headers.location, url).href; } catch (_) {
          let d = ''; res.on('data', chunk => d += chunk); res.on('end', () => resolve({ status: res.statusCode, body: d }));
          return;
        }
        return request(redirectUrl, { ...options, method: 'GET', body: null }).then(resolve);
      }
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });

    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));

    if (body) req.write(body);
    req.end();
  });
}

async function getHtml(url, options = {}) {
  const { maxRetries = 0, retryDelay = 5000, ...reqOpts } = options;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await request(url, { ...reqOpts, followRedirects: true });
    if (result !== null) return { status: result.status, html: result.body };
    if (attempt < maxRetries) await delay(retryDelay);
  }
  return null;
}

async function getJson(url, options = {}) {
  const result = await request(url, options);
  if (!result) return null;
  try {
    return { status: result.status, data: JSON.parse(result.body) };
  } catch (_) {
    return { status: result.status, data: null };
  }
}

async function postJson(url, payload, options = {}) {
  const body = JSON.stringify(payload);
  const result = await request(url, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body,
  });
  if (!result) return null;
  try {
    return { status: result.status, data: JSON.parse(result.body) };
  } catch (_) {
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { getJson, getHtml, postJson, delay };
