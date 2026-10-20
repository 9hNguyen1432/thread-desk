import { useEffect, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { COLUMN_COLOR, COLUMN_LABEL, ago, prLabel } from '../format';
import type { Status, TicketGroup } from '../types';
import { Empty } from './ui';

const CATEGORY_LABEL: Record<string, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done', open: 'Open' };

export function Tickets({ version, status, onConfigure }: { version: number; status: Status | null; onConfigure: () => void }) {
  const actions = useActions();
  const [tickets, setTickets] = useState<TicketGroup[]>([]);
  const [hideDone, setHideDone] = useState(false);

  useEffect(() => {
    void api.get<{ tickets: TicketGroup[] }>('/tickets').then((r) => setTickets(r.tickets));
  }, [version]);

  const noTracker = status && !status.integrations.jira && !status.integrations.linear;
  const shown = hideDone ? tickets.filter((t) => t.category !== 'done') : tickets;

  if (tickets.length === 0) {
    return (
      <Empty title="No tickets linked yet">
        {status?.ticketKeys.length ? (
          <>Threads that mention {status.ticketKeys.join(', ')} keys in their branch, title or your prompts are grouped here.</>
        ) : (
          <>
            Tell Thread Desk which ticket prefixes you use.{' '}
            <button type="button" className="underline" onClick={onConfigure}>
              Open settings
            </button>
          </>
        )}
      </Empty>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10">
      <div className="mb-3 flex items-center gap-4 text-[13px] text-muted">
        <span className="flex-1">
          {noTracker
            ? 'Ticket status needs THREAD_DESK_JIRA_EMAIL and THREAD_DESK_JIRA_TOKEN (or THREAD_DESK_LINEAR_KEY) in the environment.'
            : 'Ticket and PR status refresh every 15 minutes.'}
        </span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
          Hide done tickets
        </label>
      </div>
      <ul className="flex flex-col gap-2">
        {shown.map((t) => (
          <li key={t.key} className="rounded border border-rule bg-strip px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3">
              {t.url ? (
                <a href={t.url} target="_blank" rel="noreferrer" className="font-cond text-[16px] font-bold hover:underline">
                  {t.key}
                </a>
              ) : (
                <span className="font-cond text-[16px] font-bold">{t.key}</span>
              )}
              <span className="flex-1 truncate">{t.title ?? ''}</span>
              {t.state && (
                <span className="text-[12.5px]">
                  {t.state}
                  {t.category && t.category !== 'open' ? ` (${CATEGORY_LABEL[t.category] ?? t.category})` : ''}
                </span>
              )}
              <span className="text-[12px] text-muted">{ago(t.lastAt)}</span>
            </div>
            <div className="mt-2 grid gap-3 text-[13px] md:grid-cols-[2fr_1fr]">
              <ul className="flex flex-col gap-1">
                {t.threads.map((th) => (
                  <li key={th.id} className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: COLUMN_COLOR[th.column] }} title={COLUMN_LABEL[th.column]} />
                    <button type="button" className="truncate text-left hover:underline" onClick={() => actions.select(th.id)}>
                      {th.title}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap content-start gap-x-3 gap-y-1 text-[12.5px]">
                {t.prs.map((p) => (
                  <a key={p.key} href={p.url ?? undefined} target="_blank" rel="noreferrer" className="hover:underline">
                    PR {prLabel(p.key)}
                    {p.state ? ` ${p.state.toLowerCase()}` : ''}
                  </a>
                ))}
                {t.slack.map((s) => (
                  <a key={s.key} href={s.url ?? undefined} target="_blank" rel="noreferrer" className="text-muted hover:underline">
                    Slack thread
                  </a>
                ))}
                {t.figma.map((f) => (
                  <a key={f.key} href={f.url ?? undefined} target="_blank" rel="noreferrer" className="text-muted hover:underline">
                    Figma file
                  </a>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
