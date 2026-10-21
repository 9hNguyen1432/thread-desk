import { useEffect, useMemo, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { COLUMN_COLOR, ago } from '../format';
import type { Card, Status } from '../types';
import { Button, LabelChip } from './ui';

interface RecentBatch {
  id: number;
  prompt: string;
  status: string;
  createdAt: number;
  count: number;
  done: number;
}

export function AskPicker({
  cards,
  preselected,
  status,
  onOpen,
}: {
  cards: Card[];
  preselected: string[];
  status: Status;
  onOpen: (id: number) => void;
}) {
  const actions = useActions();
  const candidates = useMemo(
    () => cards.filter((c) => c.transcriptExists && (c.tab || c.agent || (c.lastAt ?? 0) > Date.now() - 14 * 86_400_000)),
    [cards],
  );
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preselected.filter((id) => candidates.some((c) => c.id === id))));
  const [template, setTemplate] = useState(0);
  const [prompt, setPrompt] = useState(status.ask.templates[0]?.prompt ?? '');
  const [model, setModel] = useState(status.ask.model);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<RecentBatch[]>([]);

  useEffect(() => {
    void api.get<{ batches: RecentBatch[] }>('/ask').then((r) => setRecent(r.batches.slice(0, 5)));
  }, []);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = async () => {
    setBusy(true);
    try {
      const { id } = await api.post<{ id: number }>('/ask', { sessionIds: [...picked], prompt, model });
      onOpen(id);
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      {recent.length > 0 && (
        <section>
          <h3 className="text-[12px] font-medium text-muted">Earlier questions</h3>
          <ul className="mt-1 flex flex-col gap-0.5">
            {recent.map((b) => (
              <li key={b.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-bay" onClick={() => onOpen(b.id)}>
                  <span className="min-w-0 flex-1 truncate">{b.prompt}</span>
                  <span className="shrink-0 text-[12px] text-muted">
                    {b.status === 'running' ? `asking, ${b.done}/${b.count}` : `${b.done}/${b.count} answered`}
                  </span>
                  <span className="w-16 shrink-0 text-right text-[12px] text-muted">{ago(b.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-muted">
        Each thread answers in a read-only copy: its history, open tab and files are not touched. Threads are asked one at a time; long threads cost more because
        Claude reads their whole history.
      </p>
      <ul className="scroll-thin flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded border border-rule p-1">
        {candidates.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-bay">
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: COLUMN_COLOR[c.column] }} />
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {c.label?.name && <LabelChip name={c.label.name} />}
              <span className="shrink-0 text-[12px] text-muted">{ago(c.lastAt)}</span>
            </label>
          </li>
        ))}
        {candidates.length === 0 && <li className="px-2 py-3 text-muted">No recent threads with a transcript.</li>}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Question template"
          className="rounded border border-rule-strong bg-strip pl-2 py-1"
          value={template}
          onChange={(e) => {
            const i = Number(e.target.value);
            setTemplate(i);
            setPrompt(status.ask.templates[i]?.prompt ?? '');
          }}
        >
          {status.ask.templates.map((t, i) => (
            <option key={t.name} value={i}>
              {t.name}
            </option>
          ))}
        </select>
        <select aria-label="Model" className="rounded border border-rule-strong bg-strip pl-2 py-1" value={model} onChange={(e) => setModel(e.target.value)}>
          {['haiku', 'sonnet', 'opus'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <textarea aria-label="Question" className="h-28 w-full rounded border border-rule-strong bg-bg p-2" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="flex justify-end">
        <Button tone="primary" disabled={busy || picked.size === 0 || !prompt.trim()} onClick={() => void start()}>
          {busy ? 'Starting…' : `Ask ${picked.size} ${picked.size === 1 ? 'thread' : 'threads'}`}
        </Button>
      </div>
    </div>
  );
}
