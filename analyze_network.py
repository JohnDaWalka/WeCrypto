import json

with open('COPILOT_DEBUG/networkdebug.har', encoding='utf-8', errors='ignore') as f:
    data = json.load(f)

print("=== NETWORK DEBUG ANALYSIS ===\n")

# 403 CORS Anywhere
cors_403 = [e for e in data['log']['entries'] if e['response'].get('status') == 403]
print(f"1. 403 CORS Anywhere ({len(cors_403)} requests)")
if cors_403:
    print(f"   - {cors_403[0]['request']['url'][:100]}")
print("   - ⚠️  CRITICAL: CORS Anywhere is rate-limited and blocked")
print("   - Should NOT be in code - these must route through local proxy\n")

# 303 Double-wrapped
cors_303 = [e for e in data['log']['entries'] if e['response'].get('status') == 303]
print(f"2. 303 Redirects ({len(cors_303)} requests)")
if cors_303:
    url = cors_303[0]['request']['url']
    print(f"   - {url[:100]}")
    if 'cors-anywhere' in url and '/https://' in url:
        print("   - Problem: URL appears double-wrapped!")
print()

# ERR_ABORTED
abort_entries = [e for e in data['log']['entries'] if e['response'].get('_error') == 'net::ERR_ABORTED']
print(f"3. net::ERR_ABORTED ({len(abort_entries)} requests)")
abort_urls = list(set([e['request']['url'] for e in abort_entries]))[:3]
for url in abort_urls:
    print(f"   - {url[:90]}")
print("   - These requests were cancelled/aborted mid-stream\n")

# 401 Unauthorized
auth_401 = [e for e in data['log']['entries'] if e['response'].get('status') == 401]
print(f"4. 401 Unauthorized ({len(auth_401)} requests)")
if auth_401:
    for e in auth_401[:2]:
        print(f"   - {e['request']['url'][:90]}")
print("   - CoinGecko may require API key\n")

# 429 Rate limit
rate_429 = [e for e in data['log']['entries'] if e['response'].get('status') == 429]
print(f"5. 429 Rate Limited ({len(rate_429)} requests)")
print()

# 404 Not found
not_404 = [e for e in data['log']['entries'] if e['response'].get('status') == 404]
print(f"6. 404 Not Found ({len(not_404)} requests)")
if not_404:
    for e in not_404[:2]:
        print(f"   - {e['request']['url'][:90]}")
print()

print("=== CRITICAL FINDINGS ===")
print(f"Total requests: {len(data['log']['entries'])}")
print(f"Failed: {len(cors_403) + len(cors_303) + len(abort_entries) + len(auth_401) + len(rate_429) + len(not_404)}")
print()
print("IMMEDIATE FIX: Remove CORS Anywhere (403s + 303s = {} errors)".format(len(cors_403) + len(cors_303)))
print("These MUST use local proxy routing instead of hardcoded URLs")
