// Requires Cloudflare compatibility flag: nodejs_compat
import { createHash, createPublicKey, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {collector, processDeletions} from './collector.mjs';

const ENDPOINT = 'https://libyan-collector-notifications.ahmedamaartrack.workers.dev/';
const API = 'https://api.ebay.com';
const keys = new Map();
let oauth;
const reply = (text, status = 200) => new Response(text, {
  status, headers: { 'Cache-Control': 'no-store' }
});

async function ebayJson(url, options) {
  const response = await fetch(url, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`EBAY_HTTP_${response.status}`);
  return response.json();
}

async function appToken(env) {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error('Missing eBay production credentials');
  }
  if (oauth && oauth.expires > Date.now() && oauth.client === env.EBAY_CLIENT_ID) {
    return oauth.token;
  }
  const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString('base64');
  const data = await ebayJson(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    }).toString()
  });
  if (typeof data.access_token !== 'string') throw new Error('No application token');
  oauth = {
    token: data.access_token, client: env.EBAY_CLIENT_ID,
    expires: Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000
  };
  return oauth.token;
}

async function publicKey(kid, env) {
  const cached = keys.get(kid);
  if (cached && cached.expires > Date.now()) return cached.value;
  const token = await appToken(env);
  const data = await ebayJson(`${API}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (typeof data.key !== 'string') throw new Error('Missing public key');
  if (keys.size >= 100) keys.delete(keys.keys().next().value);
  keys.set(kid, { value: data, expires: Date.now() + 3600000 });
  return data;
}

export function signatureValid(message, header, key) {
  if (String(header.alg).toLowerCase() !== 'ecdsa' ||
      String(key.algorithm).toUpperCase() !== 'ECDSA') return false;
  // Use the trusted key response to select the digest; never arbitrary input.
  const digest = String(key.digest).toUpperCase().replaceAll('-', '');
  if (!['SHA1', 'SHA256', 'SHA384', 'SHA512'].includes(digest)) return false;
  if (String(header.digest).toUpperCase().replaceAll('-', '') !== digest) return false;
  const pem = key.key
    .replace('-----BEGIN PUBLIC KEY-----', '-----BEGIN PUBLIC KEY-----\n')
    .replace('-----END PUBLIC KEY-----', '\n-----END PUBLIC KEY-----');
  const parsed = createPublicKey(pem);
  if (parsed.asymmetricKeyType !== 'ec') return false;
  // eBay's Node SDK verifies the compact JSON serialization.
  return verify(digest.toLowerCase(), Buffer.from(JSON.stringify(message)), parsed,
    Buffer.from(header.signature, 'base64'));
}

async function boundedBody(request) {
  if (!request.body) throw new Error('Empty body');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export default {
  async fetch(request, env) {
    let stage = 'request';
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/collector/')) return await collector(request, env, appToken);
      if (url.pathname !== '/') return reply('Not found', 404);
      if (request.method === 'GET') {
        const challenge = url.searchParams.get('challenge_code');
        if (!challenge) return reply('Notification receiver is running.');
        if (challenge.length > 1024) return reply('Invalid challenge', 400);
        if (!/^[A-Za-z0-9_-]{32,80}$/.test(env.EBAY_VERIFICATION_TOKEN || '')) {
          return reply('Verification secret needs configuration', 503);
        }
        const challengeResponse = createHash('sha256')
          .update(challenge + env.EBAY_VERIFICATION_TOKEN + ENDPOINT).digest('hex');
        return Response.json({ challengeResponse }, {
          headers: { 'Cache-Control': 'no-store' }
        });
      }
      if (request.method !== 'POST') return reply('Method not allowed', 405);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return reply('JSON required', 415);
      }
      const encoded = request.headers.get('x-ebay-signature');
      if (!encoded || encoded.length > 8192) return reply('Signature required', 412);
      let header, message;
      try {
        header = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        if (!header || typeof header.kid !== 'string' ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(header.kid) ||
            typeof header.signature !== 'string') return reply('Invalid signature header', 412);
        message = await boundedBody(request);
      } catch {
        return reply('Invalid notification', 400);
      }
      stage = 'signature-key';
      const key = await publicKey(header.kid, env);
      let valid = false;
      try { valid = signatureValid(message, header, key); } catch {}
      if (!valid) return reply('Signature verification failed', 412);
      const notice = message.notification;
      if (message.metadata?.topic !== 'MARKETPLACE_ACCOUNT_DELETION' ||
          message.metadata?.schemaVersion !== '1.0' ||
          typeof notice?.notificationId !== 'string' ||
          !notice.notificationId || notice.notificationId.length > 512 ||
          !notice.data || !['userId', 'username', 'eiasToken'].some(
            field => typeof notice.data[field] === 'string' && notice.data[field].length > 0)) {
        return reply('Unsupported notification schema', 400);
      }
      if (!env.DB) return reply('Database binding missing', 503);
      // Queue durably before acknowledging. Duplicate delivery never resets progress.
      const minimal = { data: {} };
      for (const field of ['userId', 'username', 'eiasToken']) {
        if (typeof notice.data[field] === 'string') minimal.data[field] = notice.data[field];
      }
      stage = 'database-enqueue';
      const result = await env.DB.prepare(
        'INSERT INTO deletion_requests (notification_id, payload_json) VALUES (?, ?) ON CONFLICT(notification_id) DO NOTHING'
      ).bind(notice.notificationId, JSON.stringify(minimal)).run();
      if (!result.success) return reply('Unable to persist notification', 503);
      await processDeletions(env);
      return new Response(null, { status: 204 });
    } catch (error) {
      console.error(JSON.stringify({ event: 'notification_failure', stage,
        code: /^EBAY_HTTP_\d{3}$/.test(error?.message || '') ? error.message : 'INTERNAL_FAILURE' }));
      // Never log request bodies, credentials, identifiers, or eBay error responses.
      return reply('Receiver temporarily unavailable; configuration or upstream service needs attention.', 503);
    }
  }
};
