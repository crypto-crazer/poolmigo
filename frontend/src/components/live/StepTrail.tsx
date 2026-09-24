import { cx } from '@/lib/format';

export type StepState = 'todo' | 'active' | 'done';

/** Approve → deposit → done, rendered as a hairline trail. No animation beyond the active dot. */
export function StepTrail({ steps }: { steps: Array<{ label: string; state: StepState }> }) {
  return (
    <ol className="flex items-center gap-2 text-2xs">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2">
          <span
            className={cx(
              'inline-flex items-center gap-1.5',
              s.state === 'done' ? 'text-up' : s.state === 'active' ? 'text-ink' : 'text-ink-3',
            )}
          >
            <span
              className={cx(
                'h-4 w-4 rounded-full border inline-flex items-center justify-center leading-none',
                s.state === 'done' ? 'border-up bg-up/15' : s.state === 'active' ? 'border-ink' : 'border-line-2',
              )}
            >
              {s.state === 'done' ? '✓' : i + 1}
            </span>
            {s.label}
          </span>
          {i < steps.length - 1 && <span className="h-px w-4 bg-line-2" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}
