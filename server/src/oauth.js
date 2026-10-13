import https from 'node:https';
import crypto from 'node:crypto';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from './config.js';

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';

const tokenCache = new Map();

function agentFor(proxyUrl) {
    if (!proxyUrl) return undefined;
    if (proxyUrl.startsWith('http')) return new HttpsProxyAgent(proxyUrl);
    // socks5h: let the proxy resolve login.microsoftonline.com too.
    return new SocksProxyAgent(proxyUrl.replace(/^socks5?:/i, 'socks5h:').replace(/^socks:/i, 'socks5h:'));
}

function postForm(url, form, agent) {
    const body = new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const req = https.request(
            url,
            {
                method: 'POST',
                agent,
                timeout: config.connectTimeoutMs,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body)
                }
            },
            res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    let json = {};
                    try {
                        json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch {
                        // non-JSON error page
                    }
                    resolve({ status: res.statusCode, json });
                });
            }
        );
        req.on('timeout', () => req.destroy(Object.assign(new Error('OAuth request timed out'), { code: 'ETIMEDOUT' })));
        req.on('error', err => reject(Object.assign(err, { stage: 'proxy' })));
        req.end(body);
    });
}

/** Exchanges a Microsoft refresh token for an IMAP access token, through the same proxy as IMAP. */
export async function microsoftAccessToken({ refreshToken, clientId }, proxyUrl) {
    const key = crypto.createHash('sha256').update(`${clientId}\n${refreshToken}`).digest('hex');
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

    const { status, json } = await postForm(
        TOKEN_URL,
        { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE },
        agentFor(proxyUrl)
    );
    if (status !== 200 || !json.access_token) {
        const err = new Error(json.error_description || `Microsoft token endpoint returned ${status}`);
        err.code = 'OAUTH_FAILED';
        err.oauthError = json.error;
        throw err;
    }
    tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 });
    if (tokenCache.size > 5000) tokenCache.delete(tokenCache.keys().next().value);
    return json.access_token;
}
