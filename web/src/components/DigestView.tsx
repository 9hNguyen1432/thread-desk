import { useEffect, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import type { Digest } from '../types';
import { Button } from './ui';

type Range = 'today' | 'yesterday' | 'week';

function bounds(range: Range): { from: number; to: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (range === 'today') return { from: start.getTime(), to: Date.now() };
  if (range === 'yesterday') return { from: start.getTime() - day, to: start.getTime() };
  return { from: start.getTime() - 6 * day, to: Date.now() };
}

const RANGE_LABEL: Record<Range, string> = { today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days' };

export function DigestView({ version }: { version: number }) {
  const actions = useActions();
  const [range, setRange] = useState<Range>('yesterday');
  const [digest, setDigest] = useState<Digest | null>(null);

  useEffect(() => {
    const { from, to } = bounds(range);
    void api.get<Digest>(`/digest?from=${from}&to=${to}`).then(setDigest);
  }, [range, version]);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-10">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Range" className="flex gap-1">
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              onClick={() => setRange(r)}
              className={`rounded border px-2.5 py-1 text-[13px] ${range === r ? 'border-ink bg-ink text-bg' : 'border-rule-strong'}`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button tone="primary" disabled={!digest} onClick={() => digest && void navigator.clipboard.writeText(digest.markdown).then(() => actions.toast('Digest copied'))}>
          Copy for Slack
        </Button>
      </div>
      {digest && (
        <>
          <p className="mb-2 text-[13px] text-muted">
            {digest.done.length} done, {digest.prs.length} PRs, {digest.active.length} in progress, {digest.waiting.length} waiting.
          </p>
          <pre className="rounded border border-rule bg-strip p-4 font-sans text-[13.5px] leading-relaxed whitespace-pre-wrap">{digest.markdown}</pre>
        </>
      )}
    </div>
  );
}
