import { useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';

interface Props {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  className?: string;
  wide?: boolean;
}

/** Hover/focus tooltip. Pure CSS positioning, no portal — fine for a demo. */
export function Tooltip({ content, children, side = 'top', align = 'center', className, wide }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={cx('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cx(
            'absolute z-40 rounded-md bg-ink text-deep px-2.5 py-1.5 text-xs leading-snug animate-fade-in shadow-lg',
            wide ? 'w-72' : 'w-max max-w-[260px]',
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
            align === 'center' && 'left-1/2 -translate-x-1/2',
            align === 'start' && 'left-0',
            align === 'end' && 'right-0',
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}

export function InfoDot({ tip, wide }: { tip: ReactNode; wide?: boolean }) {
  return (
    <Tooltip content={tip} wide={wide}>
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-ink-3 text-[9px] leading-none text-ink-3 cursor-help">
        i
      </span>
    </Tooltip>
  );
}
