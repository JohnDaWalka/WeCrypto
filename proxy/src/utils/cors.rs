use axum::http::{HeaderMap, HeaderName, HeaderValue};

// ── Strip from outgoing upstream requests ─────────────────────────────────────
const STRIP_UPSTREAM: &[&str] = &[
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
];

// ── Strip from upstream responses before sending to the WebView ───────────────
// We rip out every CORS header the exchange sent and replace with our own.
const STRIP_RESPONSE: &[&str] = &[
    // hop-by-hop
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
    // Cloudflare / CDN noise
    "cf-cache-status", "cf-ray", "cf-request-id", "cf-connecting-ip",
    "cf-visitor", "cf-ipcountry", "nel", "report-to", "alt-svc",
    // server identity
    "server", "x-powered-by",
    // security policy headers that block WebView embedding
    "x-frame-options", "x-xss-protection", "x-content-type-options",
    "content-security-policy", "content-security-policy-report-only",
    // ALL existing CORS — we forcefully rewrite these below
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-allow-credentials",
    "access-control-expose-headers",
    "access-control-max-age",
];

/// Build request headers for the upstream call.
/// Strips client hop-by-hop headers, injects a full Chrome 136 browser fingerprint,
/// and spoofs Origin + Referer to the exchange's own domain so it looks like a
/// legitimate browser request (defeats basic CORS + Referer checks).
pub fn build_upstream_headers(incoming: &HeaderMap, spoof_origin: &str) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(20);

    // Forward safe passthrough headers (Authorization, x-api-key, content-type, etc.)
    for (k, v) in incoming {
        if !STRIP_UPSTREAM.contains(&k.as_str()) {
            out.insert(k.clone(), v.clone());
        }
    }

    // Chrome 136 fingerprint — overwrite anything the client sent for these
    s(&mut out, "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");
    s(&mut out, "accept",            "application/json, text/plain, */*");
    s(&mut out, "accept-language",   "en-US,en;q=0.9");
    s(&mut out, "accept-encoding",   "gzip, deflate, br, zstd");
    s(&mut out, "cache-control",     "no-cache");
    s(&mut out, "pragma",            "no-cache");
    s(&mut out, "sec-fetch-dest",    "empty");
    s(&mut out, "sec-fetch-mode",    "cors");
    s(&mut out, "sec-fetch-site",    "cross-site");
    s(&mut out, "sec-ch-ua-mobile",  "?0");

    // These contain quotes — use from_str so invalid bytes return Err instead of panic
    sdyn(&mut out, "sec-ch-ua",
        r#""Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99""#);
    sdyn(&mut out, "sec-ch-ua-platform", r#""Windows""#);

    // CloudFront geo-blocking bypass headers (appear as legitimate US browser requests)
    s(&mut out, "cf-ipcountry",      "US");
    s(&mut out, "x-forwarded-for",   "203.0.113.42");
    s(&mut out, "x-forwarded-proto", "https");

    // Spoof Origin + Referer to the exchange's own domain
    if !spoof_origin.is_empty() {
        sdyn(&mut out, "origin",  spoof_origin);
        sdyn(&mut out, "referer", &format!("{spoof_origin}/"));
    }

    out
}

/// Strip all upstream CORS / CF / policy headers then forcefully inject
/// permissive CORS.  Every response that leaves the proxy has these headers —
/// no exceptions.
pub fn filter_response_headers(upstream: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(upstream.len() + 8);
    for (k, v) in upstream {
        if !STRIP_RESPONSE.contains(&k.as_str()) {
            out.insert(k.clone(), v.clone());
        }
    }
    inject_cors(&mut out);
    out
}

/// Forcefully write permissive CORS on any HeaderMap — call on every response.
pub fn inject_cors(h: &mut HeaderMap) {
    s(h, "access-control-allow-origin",   "*");
    s(h, "access-control-allow-methods",  "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    s(h, "access-control-allow-headers",  "*");
    s(h, "access-control-expose-headers", "*");
    s(h, "access-control-max-age",        "86400");
    s(h, "vary",                          "Origin");
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Insert a statically-known header name + value (both validated at compile time).
#[inline]
fn s(h: &mut HeaderMap, name: &'static str, val: &'static str) {
    h.insert(HeaderName::from_static(name), HeaderValue::from_static(val));
}

/// Insert a dynamic value — skips silently if the value contains illegal bytes.
#[inline]
fn sdyn(h: &mut HeaderMap, name: &'static str, val: &str) {
    if let Ok(v) = HeaderValue::from_str(val) {
        h.insert(HeaderName::from_static(name), v);
    }
}
