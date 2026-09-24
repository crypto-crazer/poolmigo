import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

const tones = {
  ok: 'border-up/40 bg-up/10 text-up',
  warn: 'border-amber/40 bg-amber/10 text-amber',
  error: 'border-down/40 bg-down/10 text-down',
  info: 'border-line-2 bg-deep text-ink-2',
} as const;

/** Inline transaction/preview feedback. Errors are decoded contract errors, never raw hex. */
export function Message({ tone, children }: { tone: keyof typeof tones; children: ReactNode }) {
  return <div className={cx('rounded-md border px-3 py-2 text-xs leading-snug break-words', tones[tone])}>{children}</div>;
}
