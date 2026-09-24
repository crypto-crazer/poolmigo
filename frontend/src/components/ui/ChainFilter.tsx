import { useEffect, useRef, useState } from 'react';
import { CHAINS, type ChainId } from '@/demo/data/chains';
import { ChainLogo } from './ChainLogo';
import { cx } from '@/lib/format';

const ORDER: ChainId[] = ['ethereum', 'robinhood', 'arc'];

/** Network picker in the Uniswap idiom: tile logos, "New" badges, check on the selected row. */
export function ChainFilter({ value, onChange }: { value: ChainId | 'all'; onChange: (v: ChainId | 'all') => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="h-10 pl-2 pr-3 rounded-md bg-panel border border-line hover:border-line-2 inline-flex items-center gap-2 text-sm font-medium text-ink"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {value === 'all' ? <AllNetworks size={22} /> : <ChainLogo chain={value} size={22} />}
        <span>{value === 'all' ? 'All networks' : CHAINS[value].name}</span>
        <svg viewBox="0 0 16 16" className={cx('h-4 w-4 text-ink-3 transition-transform', open && 'rotate-180')} fill="none" aria-hidden>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul role="listbox" className="absolute right-0 top-full mt-1.5 z-30 w-64 bg-panel border border-line rounded-lg shadow-pop p-1.5 animate-fade-in">
          <Item selected={value === 'all'} onClick={() => { onChange('all'); setOpen(false); }} icon={<AllNetworks size={28} />} label={`${ORDER.length} networks`} />
          {ORDER.map((id) => (
            <Item key={id} selected={value === id} onClick={() => { onChange(id); setOpen(false); }} icon={<ChainLogo chain={id} size={28} />} label={CHAINS[id].name} isNew={CHAINS[id].isNew} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Item({ selected, onClick, icon, label, isNew }: { selected: boolean; onClick: () => void; icon: React.ReactNode; label: string; isNew?: boolean }) {
  return (
    <li role="option" aria-selected={selected}>
      <button onClick={onClick} className={cx('w-full flex items-center gap-3 px-2.5 h-12 rounded-md text-md text-left hover:bg-panel-2', selected ? 'text-ink font-medium' : 'text-ink')}>
        {icon}
        <span className="flex-1 inline-flex items-center gap-2">
          {label}
          {isNew && <span className="h-5 px-1.5 rounded-md bg-apricot text-on-accent text-2xs font-medium inline-flex items-center">New</span>}
        </span>
        {selected && (
          <span className="h-5 w-5 rounded-full bg-aqua inline-flex items-center justify-center">
            <svg viewBox="0 0 16 16" className="h-3 w-3 text-on-primary" fill="none" aria-hidden>
              <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </button>
    </li>
  );
}

/** 2×2 grid of chain tiles standing in for "all networks". */
function AllNetworks({ size }: { size: number }) {
  const cell = Math.round(size * 0.46);
  return (
    <span className="grid grid-cols-2 gap-[2px] shrink-0" style={{ width: size, height: size }} aria-hidden>
      {ORDER.map((id) => <ChainLogo key={id} chain={id} size={cell} />)}
      <span className="rounded-[28%] bg-line" style={{ width: cell, height: cell }} />
    </span>
  );
}
