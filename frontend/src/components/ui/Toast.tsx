import { useStore } from '@/store/useStore';
import { cx } from '@/lib/format';

export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(
            'animate-fade-in bg-panel border rounded-lg shadow-pop px-3.5 py-3 flex items-start gap-3',
            t.tone === 'tide' ? 'border-tide/50' : t.tone === 'up' ? 'border-up/50' : t.tone === 'amber' ? 'border-amber/50' : 'border-aqua/50',
          )}
        >
          <span
            className={cx(
              'mt-1 h-2 w-2 rounded-full shrink-0',
              t.tone === 'tide' ? 'bg-tide' : t.tone === 'up' ? 'bg-up' : t.tone === 'amber' ? 'bg-amber' : 'bg-aqua',
            )}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ink num">{t.title}</div>
            {t.detail && <div className="text-xs text-ink-2 mt-0.5 num">{t.detail}</div>}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-ink-3 hover:text-ink text-xs leading-none mt-0.5" aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
