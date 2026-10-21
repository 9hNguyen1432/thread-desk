import { useEffect, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { dayLabel, minutes, shiftDay } from '../format';
import type { Capture, CaptureLine, WeekSummary } from '../types';
import { TODO_COLOR } from './TodoCard';
import { Button, Empty } from './ui';

const LINE_LABEL: Record<CaptureLine['status'], string> = { done: 'Done', wip: 'WIP', dropped: 'Dropped', unplanned: 'Unplanned' };
const LINE_COLOR: Record<CaptureLine['status'], string> = {
  done: TODO_COLOR.done,
  wip: TODO_COLOR.wip,
  dropped: TODO_COLOR.dropped,
  unplanned: 'var(--st-waiting)',
};

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function Log({ version }: { version: number }) {
  const actions = useActions();
  const [day, setDay] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [week, setWeek] = useState<WeekSummary | null>(null);
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => {
    const target = day ?? 'today';
    void api.get<Capture>(`/days/${target}/capture`).then((c) => {
      setCapture(c);
      if (!day) setToday(c.day);
    });
    void api.get<WeekSummary>(`/days/${target}/week`).then(setWeek);
  }, [day, version]);

  if (!capture) return null;
  const current = capture.day;
  const maxWeek = Math.max(1, ...(week?.days.map((d) => d.totalMinutes) ?? [1]));

  return (
    <div className="mx-auto max-w-3xl px-4 pb-10">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button tone="quiet" onClick={() => setDay(shiftDay(current, -1))} aria-label="Previous day">
          ‹
        </Button>
        <h2 className="min-w-28 text-center font-cond text-[18px] font-bold">{dayLabel(current, today ?? undefined)}</h2>
        <Button tone="quiet" onClick={() => setDay(shiftDay(current, 1))} disabled={current === today} aria-label="Next day">
          ›
        </Button>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">{minutes(capture.totalMinutes)} tracked</span>
        <Button onClick={() => void navigator.clipboard.writeText(capture.markdown).then(() => actions.toast('Log copied'))}>Copy text</Button>
        <Button onClick={() => download(`thread-desk-${current}.csv`, capture.csv)}>Download CSV</Button>
      </div>

      {capture.lines.length === 0 ? (
        <Empty title="Nothing tracked on this day">Only todos you worked on or finished, and threads you touched, show up here.</Empty>
      ) : (
        <table className="w-full border-separate border-spacing-y-1 text-[13px]">
          <thead className="text-left text-[12px] text-muted">
            <tr>
              <th className="w-20 font-normal">Status</th>
              <th className="font-normal">Work</th>
              <th className="font-normal">Project</th>
              <th className="text-right font-normal">Time</th>
            </tr>
          </thead>
          <tbody>
            {capture.lines.map((l, i) => (
              <tr key={`${l.todoId ?? 's'}-${l.threads[0]?.id ?? i}`} className="bg-strip">
                <td className="rounded-l py-2 pl-2">
                  <span className="rounded px-1.5 py-0.5 text-[12px] text-white" style={{ background: LINE_COLOR[l.status] }}>
                    {LINE_LABEL[l.status]}
                  </span>
                </td>
                <td className="py-2">
                  <div className="font-cond text-[14.5px] font-semibold">{l.title}</div>
                  {l.reportedDay && l.reportedDay !== current && <div className="text-[12px] text-muted">reported {dayLabel(l.reportedDay)}</div>}
                </td>
                <td className="py-2 text-muted">{l.projects.join(', ')}</td>
                <td className="rounded-r py-2 pr-3 text-right tabular-nums">{minutes(l.minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {capture.projects.length > 0 && (
        <p className="mt-2 text-[13px] text-muted">
          By project: {capture.projects.map((p) => `${p.name} ${minutes(p.minutes)}`).join(', ')}
        </p>
      )}

      {week && (
        <section className="mt-8">
          <div className="flex items-baseline justify-between">
            <h2 className="font-cond text-[17px] font-bold">Week of {dayLabel(week.start)}, {minutes(week.totalMinutes)}</h2>
            <button type="button" className="text-[12px] underline" onClick={() => void navigator.clipboard.writeText(week.markdown).then(() => actions.toast('Week copied'))}>
              Copy week
            </button>
          </div>
          <ul className="mt-2 flex flex-col gap-1">
            {week.days.map((d) => (
              <li key={d.day}>
                <button type="button" className="flex w-full items-center gap-3 rounded px-1 py-1 text-left text-[13px] hover:bg-bay" onClick={() => setDay(d.day)}>
                  <span className={`w-24 shrink-0 ${d.day === current ? 'font-semibold' : ''}`}>{dayLabel(d.day)}</span>
                  <span className="h-2 flex-1 rounded bg-bay">
                    <span className="block h-2 rounded bg-running" style={{ width: `${(d.totalMinutes / maxWeek) * 100}%` }} />
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums">{minutes(d.totalMinutes)}</span>
                  <span className="w-40 shrink-0 text-[12px] text-muted">
                    {d.done} done, {d.wip} WIP, {d.unplanned} unplanned
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {week.projects.length > 0 && (
            <p className="mt-2 text-[13px] text-muted">By project: {week.projects.map((p) => `${p.name} ${minutes(p.minutes)}`).join(', ')}</p>
          )}
        </section>
      )}
    </div>
  );
}
