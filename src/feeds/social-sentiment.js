// social-sentiment.js — X.com sentiment via Twitter API v2
// App: WECRYPTO — OAuth2 Client Credentials (Client ID + Client Secret)
// Fetches real tweets per coin, scores sentiment via keyword + engagement weighting.
// Cache TTL 14.5 min aligns with 15-min quarter-hour polling window.

(function () {
  'use strict';

  // OAuth 2.0 v2 endpoint (Client ID + Client Secret — not OAuth 1.0a)
  const TOKEN_ENDPOINT_V2 = 'https://api.twitter.com/2/oauth2/token';
  // OAuth 1.0a fallback (Consumer Key + Consumer Secret)
  const TOKEN_ENDPOINT_V1 = 'https://api.twitter.com/oauth2/token';
  const SEARCH_ENDPOINT   = 'https://api.twitter.com/2/tweets/search/recent';
  const CACHE_TTL_MS  = 14.5 * 60 * 1000;
  const TOKEN_GRACE   = 5 * 60 * 1000;
  const cache         = {};   // sym → { score, bullish, bearish, neutral, summary, momentum, ts }

  // ── Credential helpers ──────────────────────────────────────────────────────
  // Keys use "twitter_" prefix to avoid collision with any xAI/Grok integrations
  // that also use the "xai_" namespace.
  function getConsumerKey()    { return localStorage.getItem('twitter_client_id')     || ''; }
  function getConsumerSecret() { return localStorage.getItem('twitter_client_secret') || ''; }
  function getStoredToken()    { return localStorage.getItem('twitter_access_token')  || ''; }
  function getTokenExpiry()    { return Number(localStorage.getItem('twitter_token_expiry') || 0); }

  function hasCredentials() { return !!(getConsumerKey() && getConsumerSecret()); }

  // ── OAuth2 App-Only token exchange ──────────────────────────────────────────
  let _tokenFetchPromise = null;

  async function _fetchAppOnlyToken() {
    const key    = getConsumerKey();
    const secret = getConsumerSecret();
    if (!key || !secret) return false;

    // Try OAuth 2.0 client_credentials (v2) first
    const ok = await _tryTokenEndpoint(TOKEN_ENDPOINT_V2, key, secret);
    if (ok) return true;

    // Fall back to OAuth 1.0a bearer token (v1 — Consumer Key + Secret)
    console.info('[WECRYPTO Sentiment] OAuth2 v2 failed, trying OAuth1 v1 Bearer…');
    return _tryTokenEndpoint(TOKEN_ENDPOINT_V1, key, secret);
  }

  async function _tryTokenEndpoint(endpoint, key, secret) {
    try {
      const basicAuth = btoa(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`);
      const resp = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type':  'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });

      if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        console.warn(`[WECRYPTO Sentiment] ${endpoint} → ${resp.status}`, err);
        return false;
      }

      const json  = await resp.json();
      const token = json.access_token || json.token_type && json.access_token || '';
      if (!token) { console.warn('[WECRYPTO Sentiment] No access_token in response'); return false; }

      const expiry = Date.now() + ((json.expires_in || 86400) * 1000);
      localStorage.setItem('twitter_access_token', token);
      localStorage.setItem('twitter_token_expiry',  String(expiry));
      console.info('[WECRYPTO Sentiment] Bearer token obtained ✓ via', endpoint);
      return true;
    } catch (e) {
      console.warn('[WECRYPTO Sentiment] Token fetch error:', e.message);
      return false;
    }
  }

  async function _ensureToken() {
    const stored  = getStoredToken();
    const expiry  = getTokenExpiry();
    if (stored && Date.now() < (expiry - TOKEN_GRACE)) return true;
    if (!_tokenFetchPromise) {
      _tokenFetchPromise = _fetchAppOnlyToken().finally(() => { _tokenFetchPromise = null; });
    }
    return _tokenFetchPromise;
  }

  // ── Sentiment keyword scoring ───────────────────────────────────────────────
  const BULL_WORDS = [
    'moon','pump','bull','long','buy','calls','up','gains','rip','hodl','hold',
    'breakout','surge','rally','ath','bounce','support','green','accumulate',
    '🚀','💎','📈','🟢','fire','🔥','print','printing','parabolic','squeeze'
  ];
  const BEAR_WORDS = [
    'dump','crash','bear','short','sell','down','loss','rekt','drop','correction',
    'tank','fear','bleed','capitulate','rug','scam','dead','nuked','overvalued',
    '💀','📉','🔻','🩸','red','warning','breakdown','resistance','reject'
  ];

  function scoreTweets(tweets) {
    let bullish = 0, bearish = 0, neutral = 0;
    let weightedScore = 0, totalWeight = 0;

    for (const tw of tweets) {
      const text   = (tw.text || '').toLowerCase();
      const mets   = tw.public_metrics || {};
      const weight = 1 + Math.log1p((mets.like_count || 0) + (mets.retweet_count || 0) * 2);

      let bull = 0, bear = 0;
      for (const w of BULL_WORDS) if (text.includes(w)) bull++;
      for (const w of BEAR_WORDS) if (text.includes(w)) bear++;

      if (bull > bear)      { bullish++; weightedScore += weight * (bull - bear); }
      else if (bear > bull) { bearish++; weightedScore -= weight * (bear - bull); }
      else                  { neutral++; }

      totalWeight += weight;
    }

    const rawScore = totalWeight > 0 ? (weightedScore / totalWeight) * 40 : 0;
    const score    = Math.max(-100, Math.min(100, Math.round(rawScore)));
    const total    = bullish + bearish + neutral || 1;

    let momentum = 'flat';
    const bullRatio = bullish / total;
    if (bullRatio > 0.55)      momentum = 'rising';
    else if (bullRatio < 0.35) momentum = 'falling';

    const summary = `${bullish} bullish, ${bearish} bearish, ${neutral} neutral across ${tweets.length} tweets`;
    return { score, bullish, bearish, neutral, summary, momentum };
  }

  // ── Per-coin query config ───────────────────────────────────────────────────
  const COIN_QUERIES = {
    BTC:  'bitcoin OR btc OR $BTC',
    ETH:  'ethereum OR eth OR $ETH',
    SOL:  'solana OR sol OR $SOL',
    XRP:  'ripple OR xrp OR $XRP',
    DOGE: 'dogecoin OR doge OR $DOGE',
    BNB:  'binance OR bnb OR $BNB',
    HYPE: 'hyperliquid OR hype OR $HYPE'
  };

  async function fetchCoinSentiment(sym, name) {
    if (!hasCredentials()) return null;

    const tokenOk = await _ensureToken();
    if (!tokenOk) return null;

    const token = getStoredToken();
    if (!token) return null;

    const now = Date.now();
    if (cache[sym] && (now - cache[sym].ts) < CACHE_TTL_MS) return cache[sym];

    const query = COIN_QUERIES[sym] || `${name.toLowerCase()} OR $${sym}`;

    try {
      const url = new URL(SEARCH_ENDPOINT);
      url.searchParams.set('query',        query);
      url.searchParams.set('max_results',  '30');
      url.searchParams.set('tweet.fields', 'public_metrics,created_at');

      const resp = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (resp.status === 401) {
        localStorage.removeItem('twitter_access_token');
        localStorage.removeItem('twitter_token_expiry');
        console.warn('[WECRYPTO Sentiment] 401 — cleared token, will retry next cycle');
        return null;
      }

      if (!resp.ok) {
        console.warn(`[WECRYPTO Sentiment] ${sym} → HTTP ${resp.status}`);
        return null;
      }

      const data   = await resp.json();
      const tweets = data.data || [];
      if (tweets.length === 0) {
        const result = { score: 0, bullish: 0, bearish: 0, neutral: 0, summary: 'No recent tweets found', momentum: 'flat', ts: now };
        cache[sym] = result;
        return result;
      }

      const result = { ...scoreTweets(tweets), ts: now };
      cache[sym] = result;
      return result;
    } catch (e) {
      console.warn('[WECRYPTO Sentiment]', sym, e.message);
      return null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.SocialSentiment = {

    /** Store Consumer Key + Secret and immediately fetch a Bearer token */
    async setCredentials(consumerKey, consumerSecret) {
      const k = (consumerKey    || '').trim();
      const s = (consumerSecret || '').trim();
      if (k) localStorage.setItem('twitter_client_id',     k);
      else   localStorage.removeItem('twitter_client_id');
      if (s) localStorage.setItem('twitter_client_secret', s);
      else   localStorage.removeItem('twitter_client_secret');

      localStorage.removeItem('twitter_access_token');
      localStorage.removeItem('twitter_token_expiry');

      if (k && s) return _fetchAppOnlyToken();
      return false;
    },

    disconnect() {
      ['twitter_client_id','twitter_client_secret','twitter_access_token','twitter_token_expiry']
        .forEach(k => localStorage.removeItem(k));
    },

    hasKey()  { return hasCredentials(); },
    isOAuth() { return hasCredentials(); },
    getApiKey() { return ''; },  // legacy compat stub

    async fetchAll() {
      const coins = window.PREDICTION_COINS || [];
      await Promise.allSettled(coins.map(c => fetchCoinSentiment(c.sym, c.name)));
    },
    async fetchCoin(sym, name) { return fetchCoinSentiment(sym, name); },
    getCoin(sym) { return cache[sym] || null; },
    getAll()     { return { ...cache }; }
  };
})();
