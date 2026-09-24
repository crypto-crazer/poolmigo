/**
 * Seeded, smooth mock time series for charts. Deterministic per seed so the
 * demo looks identical on every load.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Smooth random walk from `start` to exactly `end` over `n` points.
 * `vol` is per-step noise (as a fraction), smoothed with an EMA so there are
 * no saw-tooth jumps.
 */
export function smoothPath(seed: number, n: number, start: number, end: number, vol: number): number[] {
  const rnd = mulberry32(seed);
  const noise: number[] = [];
  let ema = 0;
  for (let i = 0; i < n; i++) {
    const r = (rnd() - 0.5) * 2 * vol;
    ema = ema * 0.55 + r * 0.45;
    noise.push(ema);
  }
  // cumulative, then detrend so endpoints are exact
  const cum: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += noise[i];
    cum.push(acc);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const drift = start + (end - start) * t;
    const residual = cum[i] - cum[0] - (cum[n - 1] - cum[0]) * t; // zero at both ends
    out.push(drift * (1 + residual));
  }
  return out;
}

export interface NavPoint {
  day: number; // 0..n-1
  date: string; // ISO date
  tdlp: number;
  hodl: number;
}

/** 30-day NAV series: migoLP price (pricePerShare) vs HODL 50/50 benchmark. */
export function navSeries(vaultId: string, ppsEnd: number, benchmarkLead: number, days = 30, now = new Date()): NavPoint[] {
  const s = hashSeed(vaultId);
  const tdlp = smoothPath(s, days, 1.0, ppsEnd, 0.0022);
  const hodl = smoothPath(s ^ 0x9e3779b9, days, 1.0, ppsEnd - benchmarkLead, 0.0062);
  const out: NavPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    out.push({ day: i, date: d.toISOString().slice(0, 10), tdlp: tdlp[i], hodl: hodl[i] });
  }
  return out;
}

export interface WeekPoint {
  week: string;
  emissionsUsd: number;
  buybacksUsd: number;
  coverage: number;
}

/**
 * 8-week Emissions vs Buybacks. Emissions wobble $38–42K; buybacks climb
 * smoothly to `buybackEnd`. The final week is pinned to the protocol numbers
 * so the chart, the top stats and the "This week" card all agree.
 */
export function emissionsSeries(emissionsEnd: number, buybackEnd: number, weeks = 8): WeekPoint[] {
  const rnd = mulberry32(hashSeed('flywheel'));
  const out: WeekPoint[] = [];
  for (let i = 0; i < weeks; i++) {
    const t = i / (weeks - 1);
    const last = i === weeks - 1;
    const emissions = last ? emissionsEnd : 38_000 + rnd() * 4_000;
    // ease-in climb from $3.2K
    const buyback = last ? buybackEnd : 3_200 + (buybackEnd - 3_200) * Math.pow(t, 1.35) * (0.96 + rnd() * 0.06);
    out.push({
      week: `W${i + 1}`,
      emissionsUsd: Math.round(emissions),
      buybacksUsd: Math.round(buyback),
      coverage: buyback / emissions,
    });
  }
  return out;
}

export interface PricePoint {
  t: number; // epoch ms
  price: number;
}

/**
 * 7-day price path ending exactly at `end`. Starts near `center` so the path
 * reads as "mostly inside the range" for in-range vaults and "drifted out"
 * for out-of-range ones. 2-hour resolution.
 */
export function priceSeries(vaultId: string, center: number, end: number, widthPct: number, now = new Date()): PricePoint[] {
  const points = 85; // 7d × 12 + 1
  const seed = hashSeed(`${vaultId}-price`);
  const rnd = mulberry32(seed);
  const start = center * (1 + (rnd() - 0.5) * widthPct * 0.6);
  const path = smoothPath(seed ^ 0x51ed270b, points, start, end, widthPct * 0.045);
  const stepMs = (7 * 86_400_000) / (points - 1);
  const t0 = now.getTime() - 7 * 86_400_000;
  return path.map((price, i) => ({ t: t0 + i * stepMs, price }));
}

/**
 * Hourly price path for the last `days` days — an Ornstein–Uhlenbeck walk that
 * mean-reverts toward `center` (so in-range vaults spend most of the window
 * inside the band) and is pinned to end exactly at `end`.
 */
export function priceSeriesHourly(vaultId: string, center: number, end: number, widthPct: number, days = 30, now = new Date()): PricePoint[] {
  const n = days * 24 + 1;
  const rnd = mulberry32(hashSeed(`${vaultId}-hourly`));
  const gauss = () => {
    const u = 1 - rnd();
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const sigma = widthPct * 0.035; // hourly vol as a fraction of price
  const theta = 0.012;
  const raw: number[] = [center * (1 + (rnd() - 0.5) * widthPct * 0.5)];
  for (let i = 1; i < n; i++) {
    const x = raw[i - 1];
    const next = x + theta * (center - x) + sigma * center * gauss();
    raw.push(Math.max(next, center * 0.2));
  }
  // pin the end while keeping the shape: blend a linear shift over the last 25%.
  const shift = end - raw[n - 1];
  const tail = Math.floor(n * 0.25);
  const out: number[] = raw.map((p, i) => {
    const k = i < n - tail ? 0 : (i - (n - tail)) / (tail - 1);
    return p + shift * k;
  });
  const hourMs = 3_600_000;
  const t0 = Math.floor(now.getTime() / hourMs) * hourMs - (n - 1) * hourMs;
  return out.map((price, i) => ({ t: t0 + i * hourMs, price }));
}
