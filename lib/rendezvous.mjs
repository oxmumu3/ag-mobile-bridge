import crypto from 'node:crypto';
import { fetchBypassingVpn } from './tunnel.mjs';

const TOPIC_CONTEXT = 'ag-mobile-rendezvous-topic-v1';
const KEY_PREFIX = 'ag-mobile-rendezvous-aes256gcm-v1:';
const WIRE_PREFIX = 'agbox1:';
const RETRY_DELAYS_MS = [3000, 10_000, 30_000, 120_000];

/**
 * Deterministically derive an unguessable ntfy topic name from the paired bearerToken.
 */
export function deriveRendezvousTopic(bearerToken) {
  if (typeof bearerToken !== 'string' || !bearerToken) {
    throw new Error('bearerToken is required to derive rendezvous topic');
  }
  const hex = crypto
    .createHmac('sha256', Buffer.from(bearerToken, 'utf8'))
    .update(TOPIC_CONTEXT)
    .digest('hex');
  return `agmb1-${hex.slice(0, 32)}`;
}

/**
 * Deterministically derive a 32-byte AES-256-GCM symmetric key from the paired bearerToken.
 */
export function deriveRendezvousKey(bearerToken) {
  if (typeof bearerToken !== 'string' || !bearerToken) {
    throw new Error('bearerToken is required to derive rendezvous key');
  }
  return crypto.createHash('sha256').update(`${KEY_PREFIX}${bearerToken}`, 'utf8').digest();
}

/**
 * Encrypt tunnel location metadata into an Apple CryptoKit-compatible combined AES-256-GCM wire string.
 */
export function encryptRendezvousBeacon(bearerToken, payload) {
  if (!payload || typeof payload.funnelUrl !== 'string' || !payload.funnelUrl.startsWith('https://')) {
    throw new Error('Rendezvous payload requires an https:// funnelUrl');
  }
  const normalized = {
    v: 1,
    funnelUrl: payload.funnelUrl,
    lanUrl: payload.lanUrl ?? null,
    hostName: payload.hostName ?? null,
    instanceId: payload.instanceId ?? null,
    updatedAtMs: typeof payload.updatedAtMs === 'number' ? payload.updatedAtMs : Date.now(),
  };

  const key = deriveRendezvousKey(bearerToken);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(normalized), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, ciphertext, authTag]).toString('base64');
  return `${WIRE_PREFIX}${combined}`;
}

/**
 * Decrypt and validate an `agbox1:` AES-256-GCM wire string.
 */
export function decryptRendezvousBeacon(bearerToken, wireString) {
  if (typeof wireString !== 'string' || !wireString.startsWith(WIRE_PREFIX)) {
    throw new Error('Invalid rendezvous beacon prefix');
  }
  const b64 = wireString.slice(WIRE_PREFIX.length).trim();
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 28) {
    throw new Error('Rendezvous beacon payload too short');
  }

  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);

  const key = deriveRendezvousKey(bearerToken);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  if (!parsed || typeof parsed.funnelUrl !== 'string' || !parsed.funnelUrl.startsWith('https://')) {
    throw new Error('Rendezvous beacon missing valid https funnelUrl');
  }
  return parsed;
}

/**
 * Scan ntfy NDJSON poll output and return up to `maxCount` distinct decrypted beacons sorted newest first.
 */
export function extractCandidateRendezvousBeacons(bearerToken, ndjsonText, maxCount = 3) {
  if (typeof ndjsonText !== 'string' || !ndjsonText.trim()) return [];
  const all = [];

  for (const rawLine of ndjsonText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.event !== 'message' || typeof obj?.message !== 'string') continue;
    if (!obj.message.startsWith(WIRE_PREFIX)) continue;

    try {
      const decoded = decryptRendezvousBeacon(bearerToken, obj.message);
      all.push(decoded);
    } catch {
      // Ignore malformed or mismatched beacons
    }
  }

  all.sort((a, b) => (typeof b.updatedAtMs === 'number' ? b.updatedAtMs : 0) - (typeof a.updatedAtMs === 'number' ? a.updatedAtMs : 0));

  const seenUrls = new Set();
  const deduped = [];
  for (const item of all) {
    const norm = String(item.funnelUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    if (!norm || seenUrls.has(norm)) continue;
    seenUrls.add(norm);
    deduped.push(item);
    if (deduped.length >= maxCount) break;
  }
  return deduped;
}

/**
 * Scan ntfy NDJSON poll output and return the newest valid decrypted beacon.
 */
export function extractLatestRendezvousBeacon(bearerToken, ndjsonText) {
  return extractCandidateRendezvousBeacons(bearerToken, ndjsonText, 1)[0] || null;
}

function parseRetryAfterMs(headerValue, fallbackMs) {
  if (!headerValue) return fallbackMs;
  const trimmed = String(headerValue).trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(600_000, Math.max(1_000, Number(trimmed) * 1000));
  }
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return Math.min(600_000, Math.max(1_000, ts - Date.now()));
  }
  return fallbackMs;
}

/**
 * Periodically publish & self-audit encrypted endpoint updates on a zero-knowledge rendezvous topic.
 */
export function startRendezvousPublisher({
  bearerToken,
  getPayload,
  baseUrl = 'https://ntfy.sh',
  refreshIntervalMs = 30 * 60 * 1000,
  followUpAuditDelayMs = 8_000,
} = {}) {
  const topic = deriveRendezvousTopic(bearerToken);
  const cleanBase = String(baseUrl || 'https://ntfy.sh').replace(/\/+$/, '');
  const postUrl = `${cleanBase}/${topic}`;
  const pollUrl = `${cleanBase}/${topic}/json?poll=1&since=2h`;

  let stopped = false;
  let retryTimer = null;
  let followUpAuditTimer = null;
  let retryIndex = 0;
  let inFlightPromise = null;
  let auditInFlight = null;
  let pendingResend = false;
  let lastTimestampMs = 0;
  let lastAcceptedUrl = null;
  let lastReadbackVerifiedUrl = null;
  let lastPublishedAtMs = 0;
  let rateLimitedUntilMs = 0;

  const normalizeUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

  const nextTimestampMs = (candidate) => {
    const base = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : Date.now();
    lastTimestampMs = Math.max(Date.now(), base, lastTimestampMs + 1);
    return lastTimestampMs;
  };

  const clearRetryTimer = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const clearFollowUpAuditTimer = () => {
    if (followUpAuditTimer) {
      clearTimeout(followUpAuditTimer);
      followUpAuditTimer = null;
    }
  };

  const scheduleRetry = (explicitDelayMs = null) => {
    if (stopped || retryTimer) return;
    const baseDelay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    const delayMs = explicitDelayMs != null ? Math.max(1_000, explicitDelayMs) : baseDelay;
    if (explicitDelayMs == null) {
      retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS_MS.length - 1);
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) {
        void publishNow();
      }
    }, delayMs);
    retryTimer.unref?.();
  };

  const publishNow = () => {
    if (stopped) return Promise.resolve(false);
    if (inFlightPromise) {
      pendingResend = true;
      return inFlightPromise;
    }
    if (Date.now() < rateLimitedUntilMs) {
      pendingResend = true;
      scheduleRetry(rateLimitedUntilMs - Date.now());
      return Promise.resolve(false);
    }

    const run = (async () => {
      await Promise.resolve();
      let ok = false;
      try {
        do {
          pendingResend = false;
          if (stopped) break;
          if (Date.now() < rateLimitedUntilMs) {
            pendingResend = true;
            scheduleRetry(rateLimitedUntilMs - Date.now());
            ok = false;
            break;
          }
          const rawPayload = typeof getPayload === 'function' ? getPayload() : null;
          if (!rawPayload || typeof rawPayload.funnelUrl !== 'string' || !rawPayload.funnelUrl.startsWith('https://')) {
            lastAcceptedUrl = null;
            lastReadbackVerifiedUrl = null;
            ok = false;
            continue;
          }
          const payload = {
            ...rawPayload,
            updatedAtMs: nextTimestampMs(rawPayload.updatedAtMs),
          };
          const wire = encryptRendezvousBeacon(bearerToken, payload);
          const res = await fetchBypassingVpn(postUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              Cache: 'yes',
            },
            body: wire,
            timeoutMs: 8000,
          });
          if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.statusCode = res.status;
            if (res.status === 429) {
              const fallbackMs = Math.max(30_000, RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)]);
              err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), fallbackMs);
              rateLimitedUntilMs = Date.now() + err.retryAfterMs;
            }
            throw err;
          }
          ok = true;
          const publishedNorm = normalizeUrl(payload.funnelUrl);
          lastAcceptedUrl = publishedNorm;
          if (lastReadbackVerifiedUrl !== publishedNorm) {
            lastReadbackVerifiedUrl = null;
          }
          lastPublishedAtMs = payload.updatedAtMs;
          rateLimitedUntilMs = 0;
          retryIndex = 0;
          clearRetryTimer();
        } while (pendingResend && !stopped);
      } catch (err) {
        ok = false;
        if (err?.statusCode === 429 && err.retryAfterMs) {
          pendingResend = true;
          scheduleRetry(err.retryAfterMs);
        } else {
          scheduleRetry();
        }
      }
      return ok;
    })();

    const tracked = run.finally(() => {
      if (inFlightPromise === tracked) {
        inFlightPromise = null;
      }
    });
    inFlightPromise = tracked;
    return tracked;
  };

  const pollLatestFromRendezvous = async () => {
    const res = await fetchBypassingVpn(pollUrl, {
      timeoutMs: 6000,
    });
    if (!res.ok) {
      const err = new Error(`Poll HTTP ${res.status}`);
      err.statusCode = res.status;
      if (res.status === 429) {
        err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), 30_000);
        rateLimitedUntilMs = Date.now() + err.retryAfterMs;
      }
      throw err;
    }
    const ndjson = await res.text();
    const latest = extractLatestRendezvousBeacon(bearerToken, ndjson);
    if (latest && typeof latest.updatedAtMs === 'number') {
      lastTimestampMs = Math.max(lastTimestampMs, latest.updatedAtMs);
    }
    return latest;
  };

  const auditAndHealNow = () => {
    if (stopped) return Promise.resolve(false);
    if (auditInFlight) return auditInFlight;

    const run = (async () => {
      await Promise.resolve();
      try {
        if (inFlightPromise) {
          await inFlightPromise;
        }
        if (stopped) return false;
        if (Date.now() < rateLimitedUntilMs) {
          pendingResend = true;
          scheduleRetry(rateLimitedUntilMs - Date.now());
          return false;
        }

        const currentPayload = typeof getPayload === 'function' ? getPayload() : null;
        if (!currentPayload || typeof currentPayload.funnelUrl !== 'string' || !currentPayload.funnelUrl.startsWith('https://')) {
          lastAcceptedUrl = null;
          lastReadbackVerifiedUrl = null;
          return false;
        }
        const expectedUrl = normalizeUrl(currentPayload.funnelUrl);
        const expectedLanUrl = normalizeUrl(currentPayload.lanUrl);

        const latest = await pollLatestFromRendezvous();
        const latestUrl = normalizeUrl(latest?.funnelUrl);
        const latestLanUrl = normalizeUrl(latest?.lanUrl);
        const lanMatches = !expectedLanUrl || latestLanUrl === expectedLanUrl;
        const ageMs = latest?.updatedAtMs ? (Date.now() - latest.updatedAtMs) : Infinity;
        if (latest && latestUrl === expectedUrl && lanMatches && ageMs < 3 * 3600 * 1000) {
          lastAcceptedUrl = expectedUrl;
          lastReadbackVerifiedUrl = expectedUrl;
          lastPublishedAtMs = latest.updatedAtMs || lastPublishedAtMs;
          return true;
        }

        lastReadbackVerifiedUrl = null;
        const pushed = await publishNow();
        if (!pushed || stopped || Date.now() < rateLimitedUntilMs) {
          return false;
        }
        try {
          const confirmed = await pollLatestFromRendezvous();
          const confirmedUrl = normalizeUrl(confirmed?.funnelUrl);
          if (confirmed && confirmedUrl === expectedUrl) {
            lastReadbackVerifiedUrl = expectedUrl;
            return true;
          }
        } catch {}
        return pushed;
      } catch (err) {
        lastReadbackVerifiedUrl = null;
        if (err?.statusCode === 429 && err.retryAfterMs) {
          pendingResend = true;
          scheduleRetry(err.retryAfterMs);
        } else {
          scheduleRetry();
        }
        return false;
      }
    })();

    const tracked = run.finally(() => {
      if (auditInFlight === tracked) {
        auditInFlight = null;
      }
    });
    auditInFlight = tracked;
    return tracked;
  };

  const refreshTimer = setInterval(() => {
    if (!stopped) {
      void auditAndHealNow();
    }
  }, refreshIntervalMs);
  refreshTimer.unref?.();

  return {
    topic,
    publishNow,
    auditAndHealNow,
    getStatus: () => ({
      lastPublishedUrl: lastAcceptedUrl,
      lastPublishedAtMs,
      lastAccepted: Boolean(lastAcceptedUrl),
      lastReadbackVerifiedUrl,
      lastVerifiedSync: Boolean(lastAcceptedUrl && lastReadbackVerifiedUrl === lastAcceptedUrl),
    }),
    notifyChanged: () => {
      if (stopped) return;
      if (Date.now() < rateLimitedUntilMs) {
        pendingResend = true;
        scheduleRetry(rateLimitedUntilMs - Date.now());
        return;
      }
      retryIndex = 0;
      clearRetryTimer();
      void publishNow();
      if (followUpAuditDelayMs > 0) {
        clearFollowUpAuditTimer();
        followUpAuditTimer = setTimeout(() => {
          followUpAuditTimer = null;
          if (!stopped) {
            void auditAndHealNow();
          }
        }, followUpAuditDelayMs);
        followUpAuditTimer.unref?.();
      }
    },
    stop: () => {
      stopped = true;
      clearRetryTimer();
      clearFollowUpAuditTimer();
      clearInterval(refreshTimer);
    },
  };
}
