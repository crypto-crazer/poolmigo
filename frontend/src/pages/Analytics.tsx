import { useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip as RTooltip, XAxis } from 'recharts';
import { PROTOCOL } from '@/demo/data/protocol';
import { VAULTS } from '@/demo/data/vaults';
import * as m from '@/demo/math';
import { emissionsSeries, hashSeed, mulberry32 } from '@/demo/series';
import { cx, fmtPct, fmtPctSigned, fmtUsd } from '@/lib/format';
import { Segmented } from '@/components/ui/Tabs';
import { Stat, StatRow } from '@/components/ui/Stat';
import { usePalette } from '@/lib/theme';
import { DemoBadge } from '@/components/ui/DataBadge';

type Window = 'week' | 'all';
type Metric = 'volumeUsd' | 'feesUsd' | 'revenueUsd' | 'buybacksUsd';

const POOL_FEE = 0.0025; // average swap fee tier across vaults

interface Week { date: string; volumeUsd: number; feesUsd: number; revenueUsd: number; buybacksUsd: number; emissionsUsd: number }

/** Weekly series: this week is pinned to protocol figures; earlier weeks scale with buyback growth. */
function useWeeks(): Week[] {
  return useMemo(() => {
    const base = emissionsSeries(PROTOCOL.weeklyEmissionsUsd, PROTOCOL.buybackThisWeekUsd);
    const feesNow = (m.dailyFees(VAULTS) * 365) / 52;
    const last = base[base.length - 1].buybacksUsd;
    const now = Date.now();
    const rnd = mulberry32(hashSeed('analytics'));
    return base.map((w, i) => {
      const pinned = i === base.length - 1;
      const k = w.buybacksUsd / last;
      const jitter = () => (pinned ? 1 : 0.94 + rnd() * 0.12);
      const fees = feesNow * k * jitter();
      return {
        date: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(now - (base.length - 1 - i) * 7 * 86_400_000)),
        volumeUsd: (fees / POOL_FEE) * jitter(),
        feesUsd: fees,
        revenueUsd: PROTOCOL.lastWeekRevenueUsd * k * jitter(),
        buybacksUsd: w.buybacksUsd,
        emissionsUsd: w.emissionsUsd,
      };
    });
  }, []);
}

export function Analytics() {
  const pal = usePalette();
  const AQUA = pal.aqua, GLASS = pal.glass, UP = pal.up, PMG = pal.apricot;
  const [win, setWin] = useState<Window>('week');
  const weeks = useWeeks();
  const last = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2];
  const sum = (k: Metric | 'emissionsUsd') => weeks.reduce((a, w) => a + w[k], 0);
  const pick = (k: Metric) => (win === 'week' ? last[k] : sum(k));
  const delta = (k: Metric) => last[k] / prev[k] - 1;
  const coverage = m.buybackCoverage(pick('buybacksUsd'), win === 'week' ? last.emissionsUsd : sum('emissionsUsd'));

  const metrics: Array<{ k: Metric; label: string; color: string; tone?: 'aqua' | 'up' }> = [
    { k: 'volumeUsd', label: 'Volume', color: GLASS },
    { k: 'feesUsd', label: 'Fees', color: UP, tone: 'up' },
    { k: 'revenueUsd', label: 'Revenue', color: PMG },
    { k: 'buybacksUsd', label: 'Buybacks', color: AQUA, tone: 'aqua' },
  ];

  return (
    <div className="space-y-6 max-w-[1080px] mx-auto">
      <section className="bg-panel border border-line rounded-lg p-5 md:p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="display text-2xl font-semibold">Protocol analytics</h1>
              <DemoBadge />
            </div>
            <p className="text-sm text-ink-2 mt-1">Poolmigo vaults across Ethereum, Robinhood Chain and Arc.</p>
          </div>
          <Segmented<Window> size="sm" value={win} onChange={setWin} options={[{ value: 'week', label: 'This week' }, { value: 'all', label: '8 weeks' }]} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 bg-deep border border-line rounded-lg divide-x divide-line">
          {metrics.map((mt) => (
            <Tile
              key={mt.k}
              label={mt.label}
              value={fmtUsd(pick(mt.k), { compact: pick(mt.k) >= 1_000_000 })}
              tone={mt.tone}
              sub={
                win === 'week' ? (
                  <span className={delta(mt.k) >= 0 ? 'text-up' : 'text-down'}>{fmtPctSigned(delta(mt.k))} from prior week</span>
                ) : (
                  'Last 8 weeks'
                )
              }
            />
          ))}
        </div>
        <p className="text-2xs text-ink-3">Revenue is the protocol's 10% share of fees plus zap swap fees. Buybacks are funded from revenue and paid to lockers.</p>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {metrics.map((mt) => (
          <BarCard key={mt.k} title={mt.label} data={weeks} k={mt.k} color={mt.color} />
        ))}
      </div>

      <StatRow>
        <Stat label="Emissions this week" value={fmtUsd(last.emissionsUsd, { compact: false })} tone="tide" />
        <Stat label="Buyback coverage" value={fmtPct(coverage)} tone={coverage >= 0.6 ? 'aqua' : 'amber'} />
        <Stat label="Lock rate" value={fmtPct(PROTOCOL.lockRate, 0)} />
        <Stat label="Market cap" value={fmtUsd(m.circulatingMarketCap(PROTOCOL.circulatingTide))} />
      </StatRow>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: 'aqua' | 'up' }) {
  return (
    <div className="p-5">
      <div className="text-xs text-ink-3">{label}</div>
      <div className={cx('display num text-3xl md:text-4xl font-semibold mt-2 leading-none', tone === 'aqua' ? 'text-aqua' : tone === 'up' ? 'text-up' : 'text-ink')}>{value}</div>
      {sub && <div className="text-xs text-ink-2 mt-2 num">{sub}</div>}
    </div>
  );
}

function BarCard({ title, data, k, color }: { title: string; data: Week[]; k: Metric; color: string }) {
  const pal = usePalette();
  const lastIdx = data.length - 1;
  const total = data.reduce((a, w) => a + w[k], 0);
  return (
    <section className="bg-panel border border-line rounded-lg p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="display text-md font-semibold">{title}</h3>
        <span className="text-sm text-ink-2 num">{fmtUsd(total)} <span className="text-ink-3 text-xs">8 weeks</span></span>
      </div>
      <div className="h-40 mt-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="30%">
            <XAxis dataKey="date" tick={{ fill: pal.ink3, fontSize: 11 }} tickLine={false} axisLine={false} ticks={[data[0].date, data[4].date, data[lastIdx].date]} />
            <RTooltip
              cursor={{ fill: pal.panel2 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as Week;
                return (
                  <div className="bg-panel border border-line rounded-md shadow-pop px-2.5 py-1.5 text-xs num">
                    <div className="text-ink-3">Week of {p.date}</div>
                    <div className="text-ink font-medium">{fmtUsd(p[k], { compact: p[k] >= 1_000_000 })}</div>
                  </div>
                );
              }}
            />
            <Bar dataKey={k} radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {data.map((_, i) => <Cell key={i} fill={color} fillOpacity={i === lastIdx ? 1 : 0.4} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
