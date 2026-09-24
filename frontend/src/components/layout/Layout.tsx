import { Link, Outlet, useSearchParams } from 'react-router-dom';
import { useEffect } from 'react';
import { Header } from './Header';
import { ToastHost } from '@/components/ui/Toast';
import { usePendingTicker } from '@/store/selectors';
import { useStore } from '@/store/useStore';
import { useWalletBridge } from '@/chain/useConnectWallet';

export function Layout() {
  usePendingTicker();
  // Mirrors the connected account into the demo store, so a real connection also opens the demo surfaces.
  useWalletBridge();
  // Demo controls (URL params): ?market=open|closed|auto forces the US market status.
  const [params] = useSearchParams();
  const setOverride = useStore((s) => s.setMarketOverride);
  const connect = useStore((s) => s.connect);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  useEffect(() => {
    const m = params.get('market');
    if (m === 'open' || m === 'closed' || m === 'auto') setOverride(m);
    // Demo control: ?wallet=demo connects the demo wallet on load.
    if (params.get('wallet') === 'demo') void connect();
    const t = params.get('theme');
    if (t === 'dark' || t === 'light') setTheme(t);
  }, [params, setOverride, connect, setTheme]);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto w-full max-w-[1280px] px-4 md:px-6 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto max-w-[1280px] px-4 md:px-6 min-h-12 py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-2xs text-ink-3">
          <span className="flex items-center gap-2">
            Poolmigo · <Link to="/live" className="text-up hover:underline">Live vault</Link> reads the deployed contract;
            everything else is prototype demo data.
          </span>
          <span>LP positions can lose value and may underperform holding the assets.</span>
        </div>
      </footer>
      <ToastHost />
    </div>
  );
}
