// ================================================================
// blockchain-scan.js  — Live on-chain metrics for all 7 tracked coins
// Pulls from free public APIs: mempool.space, Blockscout, Solana RPC,
// XRPL Cluster, BSC Blockscout, Blockchair, Hyperliquid
// window.BlockchainScan.get(sym), .getAll(), .start(), .stop()
// ================================================================

(function () {
  'use strict';

  const CACHE = {};
  let _timer = null;
  const INTERVAL_MS = 45000; // poll every 45 s

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtCompact(n) {
    n = parseFloat(n);
    if (isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(2);
  }

  function fmtHashrate(h) {
    const n = parseFloat(h);
    if (isNaN(n)) return h;
    if (n >= 1e18) return (n / 1e18).toFixed(2) + ' EH/s';
    if (n >= 1e15) return (n / 1e15).toFixed(2) + ' PH/s';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TH/s';
    if (n >= 1e9)  return (n / 1e9).toFixed(2)  + ' GH/s';
    return n.toFixed(2) + ' H/s';
  }

  function fmtBytes(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  function scoreLabel(s) {
    if (s > 0.15) return 'BULLISH';
    if (s < -0.1) return 'BEARISH';
    return 'NEUTRAL';
  }

  async function safeJson(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ── BTC — mempool.space ────────────────────────────────────────────────────
  async function fetchBTC() {
    const [mR, fR, hR] = await Promise.allSettled([
      safeJson('https://mempool.space/api/mempool'),
      safeJson('https://mempool.space/api/fees/recommended'),
      safeJson('https://mempool.space/api/blocks/tip/height'),
    ]);
    const m = mR.status === 'fulfilled' ? mR.value : {};
    const f = fR.status === 'fulfilled' ? fR.value : {};
    const height = hR.status === 'fulfilled' ? hR.value : null;
    const vsize = m.vsize || 0;
    const feeFast = f.fastestFee || 0;
    const score = vsize > 200e6 ? 0.55 : vsize > 80e6 ? 0.25 : vsize < 5e6 ? -0.1 : 0;
    return {
      sym: 'BTC', label: 'Bitcoin', chain: 'Bitcoin Network',
      source: 'mempool.space', explorerUrl: 'https://mempool.space',
      metrics: [
        { k: 'Mempool Txs',   v: (m.count || 0).toLocaleString() },
        { k: 'Mempool Size',  v: fmtBytes(vsize) },
        { k: 'Fee Fast',      v: feeFast ? `${feeFast} sat/vB` : '—' },
        { k: 'Fee Med',       v: f.halfHourFee  ? `${f.halfHourFee} sat/vB`  : '—' },
        { k: 'Fee Slow',      v: f.minimumFee   ? `${f.minimumFee} sat/vB`   : '—' },
        { k: 'Block Height',  v: height != null ? Number(height).toLocaleString() : '—' },
      ],
      congestion: vsize > 150e6 ? 'HIGH' : vsize > 60e6 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
    };
  }

  // ── ETH — Blockscout mainnet ───────────────────────────────────────────────
  async function fetchETH() {
    const [sR, gR] = await Promise.allSettled([
      safeJson('https://eth.blockscout.com/api/v2/stats'),
      safeJson('https://eth.blockscout.com/api/v2/gas-price-oracle'),
    ]);
    const s = sR.status === 'fulfilled' ? sR.value : {};
    const g = gR.status === 'fulfilled' ? gR.value : {};
    const gasAvg = parseFloat(g.average || g.medium || 0);
    const score = gasAvg > 60 ? 0.5 : gasAvg > 25 ? 0.2 : gasAvg < 5 ? -0.15 : 0;
    return {
      sym: 'ETH', label: 'Ethereum', chain: 'Ethereum Mainnet',
      source: 'Blockscout', explorerUrl: 'https://eth.blockscout.com',
      metrics: [
        { k: 'Gas Avg',      v: gasAvg ? `${gasAvg.toFixed(1)} Gwei` : '—' },
        { k: 'Gas Fast',     v: (g.fast || g.high) ? `${parseFloat(g.fast || g.high).toFixed(1)} Gwei` : '—' },
        { k: 'Gas Slow',     v: (g.slow || g.low)  ? `${parseFloat(g.slow || g.low).toFixed(1)} Gwei`  : '—' },
        { k: 'Txs Today',    v: s.transactions_today    ? parseInt(s.transactions_today).toLocaleString()    : '—' },
        { k: 'Total Addrs',  v: s.total_addresses       ? parseInt(s.total_addresses).toLocaleString()       : '—' },
        { k: 'Total Txs',    v: s.total_transactions    ? parseInt(s.total_transactions).toLocaleString()    : '—' },
      ],
      congestion: gasAvg > 50 ? 'HIGH' : gasAvg > 20 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
    };
  }

  // ── SOL — Solana mainnet JSON-RPC ──────────────────────────────────────────
  async function fetchSOL() {
    const [perfR, epochR] = await Promise.allSettled([
      safeJson('https://api.mainnet-beta.solana.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPerformanceSamples', params: [10] }),
      }),
      safeJson('https://api.mainnet-beta.solana.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getEpochInfo', params: [] }),
      }),
    ]);
    const samples = perfR.status === 'fulfilled' ? (perfR.value.result || []) : [];
    const epoch   = epochR.status === 'fulfilled' ? (epochR.value.result || {}) : {};
    const avgTPS  = samples.length
      ? Math.round(samples.reduce((s, x) => s + (x.numTransactions / (x.samplePeriodSecs || 60)), 0) / samples.length)
      : 0;
    const peakTPS = samples.length
      ? Math.round(Math.max(...samples.map(x => x.numTransactions / (x.samplePeriodSecs || 60))))
      : 0;
    const score = avgTPS > 3000 ? 0.5 : avgTPS > 1500 ? 0.2 : avgTPS < 500 ? -0.2 : 0;
    return {
      sym: 'SOL', label: 'Solana', chain: 'Solana Mainnet',
      source: 'Solana RPC', explorerUrl: 'https://solscan.io',
      metrics: [
        { k: 'Avg TPS',      v: avgTPS.toLocaleString() },
        { k: 'Peak TPS',     v: peakTPS.toLocaleString() },
        { k: 'Epoch',        v: epoch.epoch != null ? epoch.epoch.toLocaleString() : '—' },
        { k: 'Slot Height',  v: epoch.absoluteSlot != null ? epoch.absoluteSlot.toLocaleString() : '—' },
        { k: 'Slot Index',   v: epoch.slotIndex != null ? epoch.slotIndex.toLocaleString() : '—' },
        { k: 'Samples',      v: samples.length ? `${samples.length} blocks` : '—' },
      ],
      congestion: avgTPS > 3000 ? 'HIGH' : avgTPS > 1500 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
    };
  }

  // ── XRP — XRPL cluster JSON-RPC ───────────────────────────────────────────
  async function fetchXRP() {
    const data = await safeJson('https://xrplcluster.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'server_info', params: [{}] }),
    });
    const info   = data.result?.info   || {};
    const ledger = info.validated_ledger || {};
    const loadFactor = info.load_factor || 1;
    const score = loadFactor > 256 ? 0.4 : loadFactor > 16 ? 0.15 : 0;
    return {
      sym: 'XRP', label: 'XRP Ledger', chain: 'XRPL',
      source: 'XRPL Cluster', explorerUrl: 'https://xrpscan.com',
      metrics: [
        { k: 'Ledger Index',  v: ledger.seq != null ? ledger.seq.toLocaleString() : '—' },
        { k: 'Txns/Ledger',   v: ledger.txn_count != null ? ledger.txn_count.toLocaleString() : '—' },
        { k: 'Base Fee',      v: ledger.base_fee_xrp != null ? `${ledger.base_fee_xrp} XRP` : '—' },
        { k: 'Load Factor',   v: loadFactor.toLocaleString() },
        { k: 'Server State',  v: info.server_state || '—' },
        { k: 'Peers',         v: info.peers != null ? info.peers.toString() : '—' },
      ],
      congestion: loadFactor > 256 ? 'HIGH' : loadFactor > 16 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
    };
  }

  // ── BNB — BSC Blockscout ───────────────────────────────────────────────────
  async function fetchBNB() {
    const [sR, gR] = await Promise.allSettled([
      safeJson('https://bsc.blockscout.com/api/v2/stats'),
      safeJson('https://bsc.blockscout.com/api/v2/gas-price-oracle'),
    ]);
    const s = sR.status === 'fulfilled' ? sR.value : {};
    const g = gR.status === 'fulfilled' ? gR.value : {};
    const gasAvg = parseFloat(g.average || g.medium || 0);
    const score = gasAvg > 8 ? 0.4 : gasAvg > 3 ? 0.1 : 0;
    return {
      sym: 'BNB', label: 'BNB Chain', chain: 'BSC Mainnet',
      source: 'BSC Blockscout', explorerUrl: 'https://bscscan.com',
      metrics: [
        { k: 'Gas Avg',      v: gasAvg ? `${gasAvg.toFixed(2)} Gwei` : '—' },
        { k: 'Gas Fast',     v: (g.fast || g.high) ? `${parseFloat(g.fast || g.high).toFixed(2)} Gwei` : '—' },
        { k: 'Gas Slow',     v: (g.slow || g.low)  ? `${parseFloat(g.slow || g.low).toFixed(2)} Gwei`  : '—' },
        { k: 'Txs Today',    v: s.transactions_today ? parseInt(s.transactions_today).toLocaleString() : '—' },
        { k: 'Total Addrs',  v: s.total_addresses    ? parseInt(s.total_addresses).toLocaleString()    : '—' },
        { k: 'Total Txs',    v: s.total_transactions ? parseInt(s.total_transactions).toLocaleString() : '—' },
      ],
      congestion: gasAvg > 5 ? 'HIGH' : gasAvg > 2 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
    };
  }

  // ── DOGE — Blockchair ──────────────────────────────────────────────────────
  async function fetchDOGE() {
    const data = await safeJson('https://api.blockchair.com/dogecoin/stats');
    const s = data.data || {};
    const txs24h = s.transactions_24h || 0;
    const score = txs24h > 100000 ? 0.4 : txs24h > 50000 ? 0.2 : 0;
    return {
      sym: 'DOGE', label: 'Dogecoin', chain: 'Dogecoin Network',
      source: 'Blockchair', explorerUrl: 'https://blockchair.com/dogecoin',
      metrics: [
        { k: 'Txs 24h',      v: txs24h ? txs24h.toLocaleString() : '—' },
        { k: 'Mempool Txs',  v: s.mempool_transactions != null ? s.mempool_transactions.toLocaleString() : '—' },
        { k: 'Block Height', v: s.best_block_height ? s.best_block_height.toLocaleString() : '—' },
        { k: 'Hashrate 24h', v: s.hashrate_24h ? fmtHashrate(s.hashrate_24h) : '—' },
        { k: 'Difficulty',   v: s.difficulty    ? Number(s.difficulty).toExponential(2)    : '—' },
        { k: 'Outputs 24h',  v: s.outputs_24h   ? s.outputs_24h.toLocaleString()           : '—' },
      ],
      congestion: (s.mempool_transactions || 0) > 5000 ? 'HIGH' : (s.mempool_transactions || 0) > 1000 ? 'MED' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
    };
  }

  // ── HYPE — Hyperliquid L1 ──────────────────────────────────────────────────
  async function fetchHYPE() {
    const data = await safeJson('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const meta = Array.isArray(data) ? data[0] : {};
    const ctxs = Array.isArray(data) ? data[1] : [];
    const idx  = (meta?.universe || []).findIndex(a => a.name === 'HYPE');
    const ctx  = idx >= 0 ? ctxs[idx] : null;
    const funding = ctx ? parseFloat(ctx.funding || 0) : 0;
    const oi      = ctx ? parseFloat(ctx.openInterest || 0) : 0;
    const vol     = ctx ? parseFloat(ctx.dayNtlVlm || 0) : 0;
    const score   = funding < -0.001 ? 0.3 : funding > 0.001 ? -0.2 : 0;
    return {
      sym: 'HYPE', label: 'HyperLiquid', chain: 'Hyperliquid L1',
      source: 'Hyperliquid API', explorerUrl: 'https://hypurrscan.io',
      metrics: [
        { k: 'Funding Rate',  v: ctx ? `${(funding * 100).toFixed(4)}%/hr` : '—' },
        { k: 'Open Interest', v: oi  ? `$${fmtCompact(oi)}`  : '—' },
        { k: 'Day Volume',    v: vol ? `$${fmtCompact(vol)}` : '—' },
        { k: 'Universe Sz',   v: (meta?.universe?.length != null) ? meta.universe.length.toString() : '—' },
        { k: 'Mark Price',    v: ctx?.markPx ? `$${parseFloat(ctx.markPx).toFixed(4)}` : '—' },
        { k: 'Prev Day Px',   v: ctx?.prevDayPx ? `$${parseFloat(ctx.prevDayPx).toFixed(4)}` : '—' },
      ],
      congestion: Math.abs(funding) > 0.001 ? 'HIGH' : 'LOW',
      score, signal: scoreLabel(score), ts: Date.now(),
    };
  }

  // ── Main fetch orchestrator ────────────────────────────────────────────────
  const FETCHERS = [
    { sym: 'BTC',  fn: fetchBTC  },
    { sym: 'ETH',  fn: fetchETH  },
    { sym: 'SOL',  fn: fetchSOL  },
    { sym: 'XRP',  fn: fetchXRP  },
    { sym: 'BNB',  fn: fetchBNB  },
    { sym: 'DOGE', fn: fetchDOGE },
    { sym: 'HYPE', fn: fetchHYPE },
  ];

  async function fetchAll() {
    const results = await Promise.allSettled(FETCHERS.map(f => f.fn()));
    FETCHERS.forEach(({ sym }, i) => {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value?.sym) {
        CACHE[r.value.sym] = r.value;
      } else {
        CACHE[sym] = {
          sym, error: r.reason?.message || 'fetch failed',
          label: sym, chain: '—', source: '—', metrics: [],
          score: 0, signal: 'NEUTRAL', ts: Date.now(),
        };
      }
    });
    window.dispatchEvent(new CustomEvent('blockchain-scan-update', { detail: { ...CACHE } }));
    return { ...CACHE };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.BlockchainScan = {
    get:           (sym) => CACHE[sym] || null,
    getAll:        () => ({ ...CACHE }),
    fetchAll,
    fmtCompact,
    fmtHashrate,
    start: () => {
      if (_timer) return;
      fetchAll();
      _timer = setInterval(fetchAll, INTERVAL_MS);
    },
    stop: () => { clearInterval(_timer); _timer = null; },
  };

})();
