import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  Legend,
} from 'recharts';
import {
  TrendingUp, Activity, Shield, ChevronDown, ChevronUp,
  Upload, X, Github, Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuditData } from '@/hooks/useAuditData';

// ─── Color constants ─────────────────────────────────────────────────────────
const C_GREEN = '#22c55e';
const C_RED = '#ef4444';
const C_AMBER = '#f59e0b';
const C_CYAN = '#00d4ff';
const C_PURPLE = '#a855f7';
const C_MUTED = 'rgba(255,255,255,0.4)';

// ─── Custom dark tooltip ──────────────────────────────────────────────────────
function DarkTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number | string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-[#0d0d14] px-3 py-2 text-xs shadow-xl">
      {label && <p className="mb-1 font-mono text-white/50">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} className="font-mono" style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(1) : p.value}
        </p>
      ))}
    </div>
  );
}

// ─── Animated section wrapper ────────────────────────────────────────────────
function Section({ children, delay = 0, className = '' }: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.5, delay, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ─── Stat card ───────────────────────────────────────────────────────────────
function StatCard({
  label, value, sub, color = 'text-foreground', icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  icon?: React.ElementType;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-card p-5 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-widest font-mono">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </div>
      <div className={cn('text-3xl font-mono font-bold', color)}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground font-mono">{sub}</div>}
    </div>
  );
}

// ─── Section title ───────────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm uppercase tracking-widest font-mono text-white/40 mb-4">
      {children}
    </h2>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Home() {
  const { predLog, kalshiLog, hasRealData, importData, clearData } = useAuditData();
  const [importOpen, setImportOpen] = useState(!hasRealData);
  const [jsonInput, setJsonInput] = useState('');

  // ── Derived metrics ─────────────────────────────────────────────────────
  const metrics = useMemo(() => {
    const directional = predLog.filter(p => p.predDir !== 'FLAT');
    const flat = predLog.filter(p => p.predDir === 'FLAT');
    const correct = directional.filter(p => p.correct);
    const accuracy = directional.length > 0 ? (correct.length / directional.length) * 100 : 0;

    const upPreds = predLog.filter(p => p.predDir === 'UP');
    const downPreds = predLog.filter(p => p.predDir === 'DOWN');

    // Per-coin accuracy
    const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'];
    const coinStats = coins.map(sym => {
      const entries = directional.filter(p => p.sym === sym);
      const coinCorrect = entries.filter(p => p.correct).length;
      const acc = entries.length > 0 ? (coinCorrect / entries.length) * 100 : 0;
      return { sym, accuracy: Math.round(acc * 10) / 10, n: entries.length };
    });

    // Kalshi metrics
    const kalshiValid = kalshiLog.filter(k => k.modelCorrect !== null);
    const kModelCorrect = kalshiValid.filter(k => k.modelCorrect).length;
    const kMarketCorrect = kalshiLog.filter(k => k.marketCorrect).length;
    const modelKalshiAcc = kalshiValid.length > 0
      ? (kModelCorrect / kalshiValid.length) * 100 : 0;
    const marketKalshiAcc = kalshiLog.length > 0
      ? (kMarketCorrect / kalshiLog.length) * 100 : 0;

    // Rolling accuracy (window=10)
    const rollingData: Array<{ date: string; accuracy: number; idx: number }> = [];
    if (directional.length >= 10) {
      for (let i = 9; i < directional.length; i++) {
        const window = directional.slice(i - 9, i + 1);
        const windowAcc = (window.filter(p => p.correct).length / 10) * 100;
        const d = new Date(directional[i].ts);
        rollingData.push({
          date: `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
          accuracy: Math.round(windowAcc * 10) / 10,
          idx: i,
        });
      }
    }

    // Move distribution buckets
    const buckets = [
      { label: '<-0.5%', min: -Infinity, max: -0.5 },
      { label: '-0.5–0%', min: -0.5, max: 0 },
      { label: '0–0.5%', min: 0, max: 0.5 },
      { label: '0.5–1%', min: 0.5, max: 1 },
      { label: '>1%', min: 1, max: Infinity },
    ];
    const moveDistData = buckets.map(b => {
      const entries = directional.filter(
        p => Math.abs(p.pctMove) >= b.min && Math.abs(p.pctMove) < b.max
      );
      return {
        label: b.label,
        correct: entries.filter(p => p.correct).length,
        incorrect: entries.filter(p => !p.correct).length,
      };
    });

    // Kalshi per-coin comparison
    const kalshiCoinStats = coins.map(sym => {
      const entries = kalshiLog.filter(k => k.sym === sym);
      const mCorrect = entries.filter(k => k.modelCorrect).length;
      const mkCorrect = entries.filter(k => k.marketCorrect).length;
      return {
        sym,
        model: entries.length > 0 ? Math.round((mCorrect / entries.length) * 1000) / 10 : 0,
        market: entries.length > 0 ? Math.round((mkCorrect / entries.length) * 1000) / 10 : 0,
        n: entries.length,
      };
    });

    const lastTs = predLog.length > 0 ? predLog[predLog.length - 1].ts : Date.now();

    return {
      totalDirectional: directional.length,
      totalFlat: flat.length,
      totalAll: predLog.length,
      accuracy,
      upCount: upPreds.length,
      downCount: downPreds.length,
      flatCount: flat.length,
      coinStats,
      modelKalshiAcc,
      marketKalshiAcc,
      rollingData,
      moveDistData,
      kalshiCoinStats,
      lastTs,
      breakeven: accuracy - 54,
    };
  }, [predLog, kalshiLog]);

  // ── Import handler ──────────────────────────────────────────────────────
  function handleImport() {
    if (!jsonInput.trim()) {
      toast.error('Please paste JSON data first');
      return;
    }
    try {
      const result = importData(jsonInput);
      toast.success(`Imported ${result.predCount} predictions${result.kalshiCount ? ` + ${result.kalshiCount} Kalshi entries` : ''}`);
      setJsonInput('');
      setImportOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed');
    }
  }

  function handleClear() {
    clearData();
    toast.info('Data cleared — showing demo data');
    setImportOpen(true);
  }

  const accColor = metrics.accuracy >= 60 ? 'text-green-400'
    : metrics.accuracy >= 50 ? 'text-amber-400'
    : 'text-red-400';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container py-8 space-y-10">

        {/* ── A. Header ─────────────────────────────────────────────────── */}
        <Section delay={0}>
          <div className="text-center space-y-3 py-8">
            <div className="flex items-center justify-center gap-3 mb-2">
              {hasRealData ? (
                <span className="flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1 text-xs font-mono text-green-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
                  </span>
                  Live Data
                </span>
              ) : (
                <span className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-mono text-amber-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
                  </span>
                  Demo Data
                </span>
              )}
            </div>
            <h1
              className="text-5xl md:text-7xl font-mono font-bold tracking-tighter"
              style={{
                color: C_CYAN,
                textShadow: `0 0 40px ${C_CYAN}66, 0 0 80px ${C_CYAN}33`,
              }}
            >
              WE|||CRYPTO
            </h1>
            <p className="text-lg md:text-xl text-white/60 font-mono">
              CFM Orbital Signal Engine — Independent Accuracy Audit
            </p>
            <p className="text-sm text-white/35 font-mono">
              15-minute directional predictions across 7 crypto assets
            </p>
          </div>
        </Section>

        {/* ── B. Import Panel ───────────────────────────────────────────── */}
        <Section delay={0.05}>
          <div className="rounded-xl border border-white/10 bg-card overflow-hidden">
            <button
              onClick={() => setImportOpen(o => !o)}
              className="w-full flex items-center justify-between px-5 py-4 text-sm font-mono text-white/70 hover:text-white/90 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Import Data from WE|||CRYPTO App
              </span>
              {importOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {importOpen && (
              <div className="px-5 pb-5 space-y-4 border-t border-white/10 pt-4">
                <div className="rounded-lg border border-white/5 bg-black/30 p-4 text-xs font-mono text-white/50 space-y-1">
                  <p className="text-white/70 font-semibold mb-2">How to export your data:</p>
                  <p>1. Open the WE|||CRYPTO Electron app</p>
                  <p>2. Open DevTools → Console (F12)</p>
                  <p className="font-mono text-cyan-400 bg-black/40 rounded px-2 py-1 mt-1">
                    copy(JSON.stringify({"{"} predLog: window._predLog, kalshiLog: window._kalshiLog {"}"}))
                  </p>
                  <p className="mt-1">3. Paste the clipboard contents below</p>
                </div>
                <textarea
                  value={jsonInput}
                  onChange={e => setJsonInput(e.target.value)}
                  placeholder='Paste JSON here: {"predLog": [...], "kalshiLog": [...]}'
                  className="w-full h-32 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs font-mono text-white/80 placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 resize-none"
                />
                <div className="flex gap-3">
                  <button
                    onClick={handleImport}
                    className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-mono font-semibold transition-all"
                    style={{
                      background: `${C_CYAN}22`,
                      border: `1px solid ${C_CYAN}44`,
                      color: C_CYAN,
                    }}
                  >
                    <Upload className="h-4 w-4" />
                    Import
                  </button>
                  {hasRealData && (
                    <button
                      onClick={handleClear}
                      className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm font-mono text-white/50 hover:text-white/80 transition-colors"
                    >
                      <X className="h-4 w-4" />
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* ── C. Summary Stats ──────────────────────────────────────────── */}
        <Section delay={0.1}>
          <SectionTitle>Summary Statistics</SectionTitle>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Total Evaluated"
              value={metrics.totalDirectional.toString()}
              sub={`+${metrics.flatCount} FLAT filtered`}
              icon={Activity}
            />
            <StatCard
              label="Directional Accuracy"
              value={`${metrics.accuracy.toFixed(1)}%`}
              sub="of directional calls correct"
              color={accColor}
              icon={TrendingUp}
            />
            <StatCard
              label="Model vs Market"
              value={`${metrics.modelKalshiAcc.toFixed(0)}% / ${metrics.marketKalshiAcc.toFixed(0)}%`}
              sub={metrics.modelKalshiAcc > metrics.marketKalshiAcc
                ? '✓ model beats market consensus'
                : 'market leads on Kalshi'}
              color={metrics.modelKalshiAcc > metrics.marketKalshiAcc ? 'text-green-400' : 'text-amber-400'}
              icon={Shield}
            />
            <StatCard
              label="Signal Selection"
              value={`${metrics.totalDirectional}/${metrics.totalAll}`}
              sub={`Active: ${metrics.totalAll > 0 ? ((metrics.totalDirectional / metrics.totalAll) * 100).toFixed(0) : 0}% | FLAT: ${metrics.totalAll > 0 ? ((metrics.flatCount / metrics.totalAll) * 100).toFixed(0) : 0}%`}
              icon={Clock}
            />
          </div>
        </Section>

        {/* ── D. Accuracy Over Time ─────────────────────────────────────── */}
        <Section delay={0.15}>
          <SectionTitle>Rolling 10-Prediction Accuracy Over Time</SectionTitle>
          <div className="rounded-xl border border-white/10 bg-card p-5">
            {metrics.rollingData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={metrics.rollingData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: C_MUTED, fontSize: 10, fontFamily: 'monospace' }}
                    tickLine={false}
                    interval={Math.floor(metrics.rollingData.length / 8)}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fill: C_MUTED, fontSize: 10, fontFamily: 'monospace' }}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <Tooltip content={<DarkTooltip />} />
                  <ReferenceLine y={50} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" label={{ value: '50% random', fill: 'rgba(255,255,255,0.25)', fontSize: 10, fontFamily: 'monospace' }} />
                  <ReferenceLine y={54} stroke={C_AMBER} strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: '54% breakeven', fill: C_AMBER, fontSize: 10, fontFamily: 'monospace' }} />
                  <Line
                    type="monotone"
                    dataKey="accuracy"
                    name="Accuracy %"
                    stroke={C_GREEN}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: C_GREEN }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[260px] flex items-center justify-center text-white/30 font-mono text-sm">
                Not enough data for rolling window (need ≥10 directional predictions)
              </div>
            )}
          </div>
        </Section>

        {/* ── E. Per-Coin Accuracy ──────────────────────────────────────── */}
        <Section delay={0.2}>
          <SectionTitle>Per-Coin Directional Accuracy</SectionTitle>
          <div className="rounded-xl border border-white/10 bg-card p-5">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={metrics.coinStats}
                layout="vertical"
                margin={{ top: 4, right: 48, bottom: 4, left: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                <XAxis
                  type="number"
                  domain={[0, 100]}
                  tick={{ fill: C_MUTED, fontSize: 10, fontFamily: 'monospace' }}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <YAxis
                  type="category"
                  dataKey="sym"
                  tick={{ fill: 'rgba(255,255,255,0.7)', fontSize: 11, fontFamily: 'monospace' }}
                  tickLine={false}
                  width={44}
                />
                <Tooltip content={<DarkTooltip />} />
                <ReferenceLine x={60} stroke={C_GREEN} strokeDasharray="3 3" strokeOpacity={0.4} />
                <ReferenceLine x={50} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />
                <Bar
                  dataKey="accuracy"
                  name="Accuracy %"
                  radius={4}
                  label={{
                    position: 'right' as const,
                    fill: C_MUTED,
                    fontSize: 10,
                    fontFamily: 'monospace',
                    formatter: (v: number) => `${v.toFixed(0)}%`,
                  }}
                >
                  {metrics.coinStats.map((entry) => (
                    <Cell
                      key={entry.sym}
                      fill={entry.accuracy >= 60 ? C_GREEN : entry.accuracy >= 50 ? C_AMBER : C_RED}
                      fillOpacity={0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="flex gap-4 mt-2 flex-wrap">
              {metrics.coinStats.map(c => (
                <span key={c.sym} className="text-xs font-mono text-white/35">
                  {c.sym} N={c.n}
                </span>
              ))}
            </div>
          </div>
        </Section>

        {/* ── F. Model vs Market on Kalshi ──────────────────────────────── */}
        <Section delay={0.25}>
          <SectionTitle>Model vs Market Accuracy on Kalshi Contracts</SectionTitle>
          <div className="rounded-xl border border-white/10 bg-card p-5">
            {metrics.kalshiCoinStats.some(k => k.n > 0) ? (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={metrics.kalshiCoinStats.filter(k => k.n > 0)}
                  margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="sym"
                    tick={{ fill: C_MUTED, fontSize: 11, fontFamily: 'monospace' }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fill: C_MUTED, fontSize: 10, fontFamily: 'monospace' }}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <Tooltip content={<DarkTooltip />} />
                  <Legend wrapperStyle={{ fontFamily: 'monospace', fontSize: 11, color: C_MUTED }} />
                  <ReferenceLine y={50} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                  <Bar dataKey="model" name="Model %" fill={C_CYAN} fillOpacity={0.85} radius={[4, 4, 0, 0] as unknown as number} />
                  <Bar dataKey="market" name="Market (Kalshi) %" fill={C_PURPLE} fillOpacity={0.7} radius={[4, 4, 0, 0] as unknown as number} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[280px] flex items-center justify-center text-white/30 font-mono text-sm">
                No Kalshi data available. Import data with kalshiLog entries.
              </div>
            )}
          </div>
        </Section>

        {/* ── G. Directional Distribution ───────────────────────────────── */}
        <Section delay={0.3}>
          <SectionTitle>Signal Directional Distribution</SectionTitle>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="rounded-xl border border-white/10 bg-card p-5">
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={[
                      { name: 'UP', value: metrics.upCount },
                      { name: 'DOWN', value: metrics.downCount },
                      { name: 'FLAT', value: metrics.flatCount },
                    ]}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                    label={({ name, percent }: { name: string; percent?: number }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                    labelLine={{ stroke: 'rgba(255,255,255,0.2)' }}
                  >
                    <Cell fill={C_GREEN} fillOpacity={0.85} />
                    <Cell fill={C_RED} fillOpacity={0.85} />
                    <Cell fill={C_AMBER} fillOpacity={0.85} />
                  </Pie>
                  <Tooltip content={<DarkTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="rounded-xl border border-white/10 bg-card p-5 flex flex-col justify-center gap-4">
              {[
                { label: 'UP predictions', value: metrics.upCount, color: C_GREEN, pct: metrics.totalAll > 0 ? (metrics.upCount / metrics.totalAll * 100).toFixed(1) : '0' },
                { label: 'DOWN predictions', value: metrics.downCount, color: C_RED, pct: metrics.totalAll > 0 ? (metrics.downCount / metrics.totalAll * 100).toFixed(1) : '0' },
                { label: 'FLAT (filtered)', value: metrics.flatCount, color: C_AMBER, pct: metrics.totalAll > 0 ? (metrics.flatCount / metrics.totalAll * 100).toFixed(1) : '0' },
              ].map(item => (
                <div key={item.label} className="space-y-1">
                  <div className="flex justify-between text-xs font-mono">
                    <span style={{ color: item.color }}>{item.label}</span>
                    <span className="text-white/50">{item.value} ({item.pct}%)</span>
                  </div>
                  <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${item.pct}%`,
                        background: item.color,
                        opacity: 0.8,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ── H. Move Distribution ──────────────────────────────────────── */}
        <Section delay={0.35}>
          <SectionTitle>Move Size Distribution (Correct vs Incorrect)</SectionTitle>
          <div className="rounded-xl border border-white/10 bg-card p-5">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={metrics.moveDistData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: C_MUTED, fontSize: 10, fontFamily: 'monospace' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: C_MUTED, fontSize: 10, fontFamily: 'monospace' }}
                  tickLine={false}
                />
                <Tooltip content={<DarkTooltip />} />
                <Legend wrapperStyle={{ fontFamily: 'monospace', fontSize: 11, color: C_MUTED }} />
                <Bar dataKey="correct" name="Correct" stackId="a" fill={C_GREEN} fillOpacity={0.85} radius={[0, 0, 0, 0] as unknown as number} />
                <Bar dataKey="incorrect" name="Incorrect" stackId="a" fill={C_RED} fillOpacity={0.7} radius={[4, 4, 0, 0] as unknown as number} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        {/* ── I. Addressing the Audit Critique ─────────────────────────── */}
        <Section delay={0.4}>
          <SectionTitle>Addressing the Audit Critique</SectionTitle>
          <div className="grid md:grid-cols-2 gap-4">
            {[
              {
                icon: Shield,
                title: '"Selection Effect"',
                color: C_CYAN,
                body: `Yes, the engine filters signals. Active rate: ${metrics.totalAll > 0 ? ((metrics.totalDirectional / metrics.totalAll) * 100).toFixed(0) : 0}% of raw signals produce a directional call. This is a feature, not a bug — the FLAT bucket protects capital when the model lacks conviction. Only high-confidence signals are acted upon.`,
              },
              {
                icon: Clock,
                title: '"Future Close Scoring"',
                color: C_GREEN,
                body: 'On Kalshi 15-minute binary contracts, the evaluation window IS the settlement window. You buy YES/NO at the quoted price before expiry. There is no slippage on a binary contract — the settlement is deterministic at the close of the 15-minute bucket.',
              },
              {
                icon: TrendingUp,
                title: '"Execution Friction"',
                color: C_AMBER,
                body: `Kalshi binary fees ≈ 1%. Minimum directional edge needed: ~54%. Current model accuracy: ${metrics.accuracy.toFixed(1)}%. Edge above breakeven: ${metrics.breakeven >= 0 ? '+' : ''}${metrics.breakeven.toFixed(1)}%. ${metrics.breakeven >= 0 ? 'The model clears the fee hurdle.' : 'More data needed to establish consistent edge.'}`,
              },
              {
                icon: Activity,
                title: '"100% Win Rate Illusion"',
                color: C_RED,
                body: `Full distribution shown above. Win rate is not 100% — it is ${metrics.accuracy.toFixed(1)}%, measured on ${metrics.totalDirectional} evaluated 15m buckets. FLAT signals (${metrics.flatCount} total) are excluded by design as they represent periods of low model conviction.`,
              },
            ].map((item) => (
              <div key={item.title} className="rounded-xl border border-white/10 bg-card p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <item.icon className="h-4 w-4 shrink-0" style={{ color: item.color }} />
                  <h3 className="font-mono font-semibold text-sm" style={{ color: item.color }}>
                    {item.title}
                  </h3>
                </div>
                <p className="text-sm text-white/60 leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ── J. Footer ─────────────────────────────────────────────────── */}
        <Section delay={0.45}>
          <div className="border-t border-white/10 pt-8 pb-4 flex flex-col md:flex-row items-center justify-between gap-4 text-xs font-mono text-white/25">
            <span>
              Data source: WE|||CRYPTO CFM Orbital Engine v2.1 | beta1_pred_log |{' '}
              Last updated: {new Date(metrics.lastTs).toLocaleString()}
              {!hasRealData && ' (demo data)'}
            </span>
            <a
              href="https://github.com"
              className="flex items-center gap-1.5 hover:text-white/50 transition-colors"
            >
              <Github className="h-3.5 w-3.5" />
              GitHub
            </a>
          </div>
        </Section>

      </div>
    </div>
  );
}

