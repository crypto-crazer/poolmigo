import { useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';

export function Collapsible({ title, children, defaultOpen = false }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-panel border border-line rounded-md">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 h-11 text-left" aria-expanded={open}>
        <span className="display text-sm font-semibold">{title}</span>
        <svg viewBox="0 0 16 16" className={cx('h-4 w-4 text-ink-3 transition-transform duration-150', open && 'rotate-180')} fill="none">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="px-4 pb-4 text-sm text-ink-2 leading-relaxed animate-fade-in">{children}</div>}
    </div>
  );
}
