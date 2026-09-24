import { useRef } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { WalletButton } from './WalletButton';
import { ChainSelector } from './ChainSelector';
import { useStore } from '@/store/useStore';
import { cx } from '@/lib/format';

const NAV = [
  { to: '/', label: 'Earn' },
  { to: '/live', label: 'Live vault' },
  { to: '/analytics', label: 'Analytics' },
];

export function Header() {
  const reset = useStore((s) => s.reset);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const pushToast = useStore((s) => s.pushToast);
  const navigate = useNavigate();
  const clicks = useRef<number[]>([]);

  // Hidden demo reset: 5 clicks on the logo within 2.5s.
  const onLogo = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 2500), now];
    if (clicks.current.length >= 5) {
      clicks.current = [];
      reset();
      pushToast({ title: 'Demo reset', detail: 'Wallet disconnected. Positions restored to defaults.', tone: 'amber' });
      navigate('/');
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-deep/95 backdrop-blur border-b border-line">
      <div className="mx-auto max-w-[1280px] px-4 md:px-6 min-h-14 py-2 md:py-0 flex flex-wrap items-center gap-x-6 gap-y-2">
        <button onClick={onLogo} className="flex items-center select-none py-2" aria-label="Poolmigo">
          <img src={`${import.meta.env.BASE_URL}brand/poolmigo-wordmark-${theme === 'dark' ? 'reverse' : 'dark'}.svg`} alt="Poolmigo" className="h-7 w-auto" draggable={false} />
        </button>
        <nav className="flex items-center gap-1 order-last w-full md:order-none md:w-auto overflow-x-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cx('h-9 px-3 rounded text-sm font-medium inline-flex items-center transition-colors', isActive ? 'text-ink bg-panel-2' : 'text-ink-2 hover:text-ink')
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ChainSelector />
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="h-9 w-9 inline-flex items-center justify-center rounded-md border border-line bg-panel text-ink-2 hover:text-ink hover:border-line-2"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <circle cx="10" cy="10" r="3.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M16.5 12.3A7 7 0 0 1 7.7 3.5a7 7 0 1 0 8.8 8.8Z" />
              </svg>
            )}
          </button>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
