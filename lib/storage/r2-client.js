/**
 * R2 Storage Client — Cloudflare R2 (S3-compatible) for ZJP data files.
 *
 * Usage:
 *   const { createR2Client } = require('../storage/r2-client');
 *   const r2 = createR2Client();
 *   await r2.uploadJson('all_jobs.json', jobsArray);
 *   const data = await r2.downloadJson('all_jobs.json');
 */

let cachedSdk = null;

function loadS3Sdk() {
  if (!cachedSdk) {
    cachedSdk = require('@aws-sdk/client-s3');
  }
  return cachedSdk;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorStatus(err) {
  return err?.$metadata?.httpStatusCode || err?.statusCode || err?.status || null;
}

function errorCode(err) {
  return err?.name || err?.Code || err?.code || 'Error';
}

function classifyR2Error(err) {
  const status = errorStatus(err);
  const code = errorCode(err);
  const message = String(err?.message || '');
  const lowerCode = String(code).toLowerCase();
  const lowerMessage = message.toLowerCase();

  if (status === 401 || status === 403) {
    return { retryable: false, className: 'auth' };
  }
  if (status === 404 || code === 'NoSuchKey') {
    return { retryable: false, className: 'not_found' };
  }
  if (status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) {
    return { retryable: false, className: 'client' };
  }
  if ([408, 409, 425, 429, 500, 502, 503, 504, 522, 524].includes(status)) {
    return { retryable: true, className: status === 429 ? 'rate_limited' : 'transient_http' };
  }
  if (
    lowerCode.includes('timeout') ||
    lowerCode.includes('throttl') ||
    lowerCode === 'slowdown' ||
    lowerCode.includes('internal') ||
    lowerCode.includes('serviceunavailable') ||
    lowerCode.includes('network')
  ) {
    return { retryable: true, className: 'transient_code' };
  }
  if (
    lowerMessage.includes('please try again') ||
    lowerMessage.includes('internal error') ||
    lowerMessage.includes('temporarily unavailable') ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('etimedout') ||
    lowerMessage.includes('eai_again') ||
    lowerMessage.includes('socket hang up') ||
    lowerMessage.includes('network')
  ) {
    return { retryable: true, className: 'transient_message' };
  }

  return { retryable: false, className: 'unknown' };
}

function describeR2Error(err) {
  const status = errorStatus(err);
  const code = errorCode(err);
  const message = err?.message || String(err);
  const requestId = err?.$metadata?.requestId || err?.$metadata?.extendedRequestId || err?.requestId;
  const parts = [];
  if (status) parts.push(`status=${status}`);
  if (code) parts.push(`code=${code}`);
  if (requestId) parts.push(`request_id=${requestId}`);
  parts.push(`message=${message}`);
  return parts.join(' ');
}

/**
 * Create an R2 client from environment variables.
 *
 * Required env vars (set as GitHub Actions secrets):
 *   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_NAME
 *
 * @param {Object} [options] - Override defaults
 * @param {string} [options.prefix] - Key prefix for all operations (e.g. 'data/')
 * @param {number} [options.retries] - App-level attempts for transient R2 failures (default: 3)
 * @param {number} [options.sdkMaxAttempts] - AWS SDK attempts per app-level try (default: 1)
 * @param {number} [options.retryDelayMs] - Initial app-level retry delay in ms (default: 500)
 * @param {Object} [options.client] - Injected S3-compatible client for tests
 * @param {Object} [options.commands] - Injected command constructors for tests
 */
function createR2Client(options = {}) {
  const {
    prefix = '',
    retries = 3,
    sdkMaxAttempts = 1,
    retryDelayMs = 500,
    client: injectedClient = null,
    commands: injectedCommands = null,
  } = options;

  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error('R2_BUCKET_NAME env var not set');

  const sdk = injectedCommands || loadS3Sdk();
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    DeleteObjectCommand,
  } = sdk;

  const client = injectedClient || new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: sdkMaxAttempts,
  });

  function key(name) {
    return prefix ? `${prefix}${name}` : name;
  }

  function objectLabel(name) {
    const k = key(name);
    return k === name ? name : `${name} (${k})`;
  }

  async function sendWithRetry(operationFactory, label) {
    const attempts = Math.max(1, retries);
    let delayMs = Math.max(0, retryDelayMs);
    let lastErr = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await operationFactory();
      } catch (err) {
        lastErr = err;
        const classification = classifyR2Error(err);
        if (!classification.retryable || attempt === attempts) {
          err.r2Retry = {
            attempts: attempt,
            maxAttempts: attempts,
            className: classification.className,
            retryable: classification.retryable,
          };
          throw err;
        }
        console.warn(`R2 retry ${attempt}/${attempts - 1}: ${label} — ${classification.className} ${describeR2Error(err)}`);
        if (delayMs > 0) await sleep(delayMs);
        delayMs = Math.min(delayMs * 2 || 1, 5000);
      }
    }

    throw lastErr;
  }

  function logFailure(operation, name, err) {
    const retry = err?.r2Retry;
    const retryText = retry
      ? ` attempts=${retry.attempts}/${retry.maxAttempts} class=${retry.className}`
      : '';
    console.error(`R2 ${operation} FAILED: ${objectLabel(name)} —${retryText} ${describeR2Error(err)}`);
  }

  /**
   * Upload a JSON object to R2.
   * Uses atomic-write pattern: write to temp key, then copy to final key.
   * On failure, the temp key is cleaned up; final key remains unchanged.
   */
  async function uploadJson(name, data, metadata = {}) {
    const body = JSON.stringify(data);
    const finalKey = key(name);
    const tempKey = `${finalKey}.tmp-${Date.now()}`;

    try {
      await sendWithRetry(() => client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: tempKey,
        Body: body,
        ContentType: 'application/json',
        Metadata: metadata,
      })), `put temp ${tempKey}`);

      await sendWithRetry(() => client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: finalKey,
        Body: body,
        ContentType: 'application/json',
        Metadata: metadata,
      })), `put final ${finalKey}`);

      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: tempKey,
      })).catch(() => {});

      console.log(`R2 upload OK: ${objectLabel(name)} (${(body.length / 1024).toFixed(1)} KB)`);
      return true;
    } catch (err) {
      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: tempKey,
      })).catch(() => {});

      logFailure('upload', name, err);
      return false;
    }
  }

  /**
   * Upload a raw buffer or string to R2.
   */
  async function uploadRaw(name, body, contentType = 'application/octet-stream') {
    const finalKey = key(name);
    try {
      await sendWithRetry(() => client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: finalKey,
        Body: body,
        ContentType: contentType,
      })), `put ${finalKey}`);
      console.log(`R2 upload OK: ${objectLabel(name)} (${(body.length / 1024).toFixed(1)} KB)`);
      return true;
    } catch (err) {
      logFailure('upload', name, err);
      return false;
    }
  }

  /**
   * Download and parse a JSON object from R2.
   * Returns null if the key doesn't exist or parsing fails.
   */
  async function downloadJson(name) {
    const k = key(name);
    try {
      return await sendWithRetry(async () => {
        const resp = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: k,
        }));
        const body = await resp.Body.transformToString();
        return JSON.parse(body);
      }, `get ${k}`);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      logFailure('download', name, err);
      return null;
    }
  }

  /**
   * Download raw bytes from R2. Returns null if key doesn't exist.
   */
  async function downloadRaw(name) {
    const k = key(name);
    try {
      return await sendWithRetry(async () => {
        const resp = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: k,
        }));
        return await resp.Body.transformToByteArray();
      }, `get ${k}`);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      logFailure('download', name, err);
      return null;
    }
  }

  /**
   * Stream-download a file from R2 directly to filesystem.
   * Avoids loading entire file into heap (fixes OOM on large description files).
   * Returns {size, lines} on success, null on failure.
   */
  async function downloadToFile(name, destPath) {
    const { createWriteStream, renameSync, statSync, unlinkSync } = require('fs');
    const { Readable } = require('stream');
    const k = key(name);
    try {
      return await sendWithRetry(async () => {
        const resp = await client.send(new GetObjectCommand({
          Bucket: bucket,
          Key: k,
        }));
        const tempPath = `${destPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try {
          await new Promise((resolve, reject) => {
            const ws = createWriteStream(tempPath);
            const body = resp.Body;
            let source = null;
            let settled = false;
            function fail(err) {
              if (settled) return;
              settled = true;
              if (source && typeof source.destroy === 'function') source.destroy();
              ws.destroy();
              reject(err);
            }
            if (body && typeof body.pipe === 'function') {
              source = body;
            } else if (body && typeof body.getReader === 'function') {
              source = Readable.fromWeb(body);
            } else {
              fail(new Error('Unexpected body type: ' + typeof body));
              return;
            }
            source.once('error', fail);
            ws.once('finish', () => {
              if (settled) return;
              settled = true;
              resolve();
            });
            ws.once('error', fail);
            source.pipe(ws);
          });
          const size = statSync(tempPath).size;
          renameSync(tempPath, destPath);
          return { size };
        } catch (err) {
          try { unlinkSync(tempPath); } catch (_) {}
          throw err;
        }
      }, `get ${k}`);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      logFailure('downloadToFile', name, err);
      return null;
    }
  }

  /**
   * Check if a key exists and return its metadata (size, last modified).
   */
  async function head(name) {
    const k = key(name);
    try {
      const resp = await sendWithRetry(() => client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: k,
      })), `head ${k}`);
      return {
        size: resp.ContentLength,
        lastModified: resp.LastModified,
        contentType: resp.ContentType,
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * List keys with the given prefix.
   */
  async function list(prefixFilter = '') {
    const prefixKey = key(prefixFilter);
    const resp = await sendWithRetry(() => client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefixKey,
      MaxKeys: 1000,
    })), `list ${prefixKey}`);
    return (resp.Contents || []).map(obj => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
    }));
  }

  /**
   * Write the last-updated manifest — timestamp marker for freshness checks.
   */
  async function writeManifest(extra = {}) {
    return uploadJson('last-updated.json', {
      timestamp: new Date().toISOString(),
      source: 'zjp-pipeline',
      ...extra,
    });
  }

  /**
   * Upload multiple JSONL lines as a single file.
   */
  async function uploadJsonl(name, lines, contentType = 'application/x-jsonlines') {
    const body = Array.isArray(lines) ? lines.join('\n') : lines;
    return uploadRaw(name, body, contentType);
  }

  return {
    uploadJson,
    uploadRaw,
    downloadJson,
    downloadRaw,
    downloadToFile,
    head,
    list,
    writeManifest,
    uploadJsonl,
    bucket,
  };
}

module.exports = { createR2Client, classifyR2Error, describeR2Error };
