import { useEffect, useMemo, useRef } from 'react';
import { AreaSeries, BaselineSeries, ColorType, LineSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Vault } from '@/lib/types';
import * as m from '@/demo/math';
import type { MarketStatus } from '@/lib/market';
import { priceSeriesHourly } from '@/demo/series';
import { fmtQuote, fmtRelativeDays } from '@/lib/format';

import { usePalette } from '@/lib/theme';

interface Props {
  vault: Vault;
  market: MarketStatus;
}

/** Decimal precision for the price scale, from the price magnitude. */
function precisionFor(p: number): number {
  if (p >= 1000) return 1;
  if (p >= 10) return 2;
  if (p >= 1) return 3;
  if (p >= 0.01) return 4;
  return 6;
}

/**
 * Price range — a real price chart (TradingView lightweight-charts): drag the
 * price axis to rescale, drag/scroll the time axis to pan and zoom. The LP
 * range is the shaded band with Upper/Lower marked on the axis.
 */
export function PriceRange({ vault: v, market }: Props) {
  const pal = usePalette();
  const AQUA = pal.aqua, AMBER = pal.amber, RED = pal.down, INK = pal.ink;
  const g = m.rangeGeometry(v, market);
  const inBand = v.currentPrice >= g.lower && v.currentPrice <= g.upper;
  const tone = g.defensive ? AMBER : AQUA;
  const priceTone = inBand ? (g.defensive ? AMBER : AQUA) : RED;
  const data = useMemo(() => priceSeriesHourly(v.id, v.rangeCenter, v.currentPrice, v.rangeWidthPct), [v]);

  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<'Area'> | null>(null);
  const band = useRef<ISeriesApi<'Baseline'> | null>(null);
  const last = useRef<ISeriesApi<'Line'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);

  // Create the chart once per vault.
  useEffect(() => {
    if (!host.current) return;
    const precision = precisionFor(v.currentPrice);
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: pal.ink3, fontFamily: 'Rubik, Arial, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
      rightPriceScale: { borderColor: pal.line, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: pal.line, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { horzLine: { color: pal.ink3, labelBackgroundColor: pal.ink2 }, vertLine: { color: pal.ink3, labelBackgroundColor: pal.ink2 } },
      localization: { priceFormatter: (p: number) => fmtQuote(p) },
    });
    const bandSeries = c.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: g.lower },
      topLineColor: 'rgba(0,0,0,0)',
      bottomLineColor: 'rgba(0,0,0,0)',
      topFillColor1: 'rgba(0,0,0,0)',
      topFillColor2: 'rgba(0,0,0,0)',
      bottomFillColor1: 'rgba(0,0,0,0)',
      bottomFillColor2: 'rgba(0,0,0,0)',
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
    });
    const priceSeries = c.addSeries(AreaSeries, {
      lineColor: INK,
      lineWidth: 2,
      topColor: 'rgba(0,0,0,0)',
      bottomColor: 'rgba(0,0,0,0)',
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerRadius: 4,
      priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
    });
    const lastSeries = c.addSeries(LineSeries, {
      color: AQUA,
      lineVisible: false,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: 1,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
    });
    const points = data.map((d) => ({ time: Math.floor(d.t / 1000) as UTCTimestamp, value: d.price }));
    priceSeries.setData(points);
    lastSeries.setData([points[points.length - 1]]);
    c.timeScale().setVisibleLogicalRange({ from: points.length - 24 * 10, to: points.length + 4 });
    chart.current = c;
    price.current = priceSeries;
    band.current = bandSeries;
    last.current = lastSeries;
    return () => {
      c.remove();
      chart.current = null;
      lines.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.id, data, pal]);

  // Apply range band, Upper/Lower price lines and the last-price colour whenever geometry changes.
  useEffect(() => {
    const c = chart.current;
    const p = price.current;
    const b = band.current;
    const l = last.current;
    if (!c || !p || !b || !l) return;
    const rgba = (hex: string, a: number) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };
    b.applyOptions({
      baseValue: { type: 'price', price: g.lower },
      topFillColor1: rgba(tone, 0.12),
      topFillColor2: rgba(tone, 0.12),
      // keep both bounds in view on autoscale; the user can still drag the axis
      autoscaleInfoProvider: () => ({ priceRange: { minValue: g.lower, maxValue: g.upper } }),
    });
    b.setData(data.map((d) => ({ time: Math.floor(d.t / 1000) as UTCTimestamp, value: g.upper })));
    for (const line of lines.current) p.removePriceLine(line);
    lines.current = [
      p.createPriceLine({ price: g.upper, color: tone, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Upper' }),
      p.createPriceLine({ price: g.lower, color: tone, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Lower' }),
    ];
    l.applyOptions({ color: priceTone, priceLineColor: priceTone });
  }, [g.lower, g.upper, tone, priceTone, data]);

  return (
    <section className="bg-panel border border-line rounded-lg">
      <header className="flex items-center justify-between px-4 h-11 border-b border-line">
        <h3 className="display text-sm font-semibold">Price range</h3>
        <span className="text-xs text-ink-3 num">Last rebalance {fmtRelativeDays(v.lastRebalanceDaysAgo)}</span>
      </header>
      <div ref={host} className="h-80 w-full" />
    </section>
  );
}
