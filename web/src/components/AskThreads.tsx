import { useCallback, useEffect, useMemo, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { COLUMN_COLOR, ago } from '../format';
import type { Card, StartDraft, Status } from '../types';
import { StartModal } from './StartModal';
import { Button, LabelChip, Modal } from './ui';

interface AskItem {
  sessionId: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  answer: string | null;
  error: string | null;
  included: boolean;
  sizeBytes: number;
}

interface AskBatch {
  id: number;
  prompt: string;
  model: string;
  status: 'running' | 'done' | 'cancelled';
  items: AskItem[];
  markdown: string;
}

const STATUS_TEXT: Record<AskItem['status'], string> = {
  queued: 'Waiting',
  running: 'Asking…',
  done: 'Answered',
  failed: 'Failed',
  skipped: 'Skipped',
};

const NEXT_STEP =
  'Use the answers below to update the support bot: add what it should know and correct anything it got wrong. Check each point against the code or data before changing anything, and show me the changes before you commit.';

function mb(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function Picker({
  cards,
  preselected,
  status,
  onStarted,
}: {
  cards: Card[];
  preselected: string[];
  status: Status;
  onStarted: (id: number) => void;
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
      onStarted(id);
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 text-[13px]">
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
          className="rounded border border-rule-strong bg-strip px-2 py-1"
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
        <select aria-label="Model" className="rounded border border-rule-strong bg-strip px-2 py-1" value={model} onChange={(e) => setModel(e.target.value)}>
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

function Results({
  batchId,
  version,
  status,
  hasTabs,
  onCloseTabs,
}: {
  batchId: number;
  version: number;
  status: Status;
  hasTabs: (ids: string[]) => string[];
  onCloseTabs: (ids: string[]) => Promise<void>;
}) {
  const actions = useActions();
  const [batch, setBatch] = useState<AskBatch | null>(null);
  const [savePath, setSavePath] = useState('');
  const [starting, setStarting] = useState<StartDraft | null>(null);
  const [instruction, setInstruction] = useState(NEXT_STEP);

  const load = useCallback(() => void api.get<AskBatch>(`/ask/${batchId}`).then(setBatch), [batchId]);
  useEffect(load, [load, version]);
  useEffect(() => {
    if (batch?.status !== 'running') return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [batch?.status, load]);

  if (!batch) return <p className="text-[13px] text-muted">Loading…</p>;
  const included = batch.items.filter((i) => i.included && i.status === 'done');
  const pending = batch.items.filter((i) => i.status === 'queued' || i.status === 'running').length;

  const update = async (sessionId: string, patch: { included?: boolean; answer?: string }) => {
    await api.post(`/ask/${batch.id}/item`, { sessionId, ...patch });
    load();
  };

  const save = async () => {
    try {
      const { path } = await api.post<{ path: string }>(`/ask/${batch.id}/save`, { path: savePath.trim() });
      actions.toast(`Saved to ${path}`);
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  const tabIds = hasTabs(included.map((i) => i.sessionId));

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-muted">
          {pending > 0 ? `${batch.items.length - pending} of ${batch.items.length} answered, asking one at a time.` : `${included.length} answers selected.`}
        </p>
        {batch.status === 'running' && (
          <Button tone="quiet" onClick={() => void api.post(`/ask/${batch.id}/cancel`).then(load)}>
            Stop
          </Button>
        )}
      </div>
      <ol className="scroll-thin flex max-h-[42vh] flex-col gap-2 overflow-y-auto pr-1">
        {batch.items.map((i) => (
          <li key={i.sessionId} className="rounded border border-rule bg-strip px-3 py-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`Include ${i.title}`}
                checked={i.included}
                disabled={i.status !== 'done'}
                onChange={(e) => void update(i.sessionId, { included: e.target.checked })}
              />
              <span className="min-w-0 flex-1 truncate font-cond text-[14.5px] font-semibold">{i.title}</span>
              <span className="text-[12px] text-muted">
                {STATUS_TEXT[i.status]} · {mb(i.sizeBytes)}
              </span>
            </div>
            {i.status === 'done' && (
              <textarea
                aria-label={`Answer from ${i.title}`}
                className="mt-1.5 h-28 w-full rounded border border-rule bg-bg p-2 text-[12.5px]"
                defaultValue={i.answer ?? ''}
                onBlur={(e) => e.target.value !== i.answer && void update(i.sessionId, { answer: e.target.value })}
              />
            )}
            {i.status === 'failed' && <p className="mt-1 text-[12.5px] text-danger">{i.error}</p>}
          </li>
        ))}
      </ol>

      {pending === 0 && included.length > 0 && (
        <section className="flex flex-col gap-2 border-t border-rule pt-3">
          <h3 className="font-cond text-[15px] font-semibold">Then, once</h3>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void navigator.clipboard.writeText(batch.markdown).then(() => actions.toast('Copied all answers'))}>Copy as one message</Button>
            <input
              className="min-w-64 flex-1 rounded border border-rule-strong bg-bg px-2 py-1 font-mono text-[12px]"
              placeholder="/Users/you/notes/support-cases.md"
              value={savePath}
              onChange={(e) => setSavePath(e.target.value)}
              aria-label="Save path"
            />
            <Button disabled={!savePath.trim()} onClick={() => void save()}>
              Save to file
            </Button>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-muted">Start one new thread with all answers. Only that thread changes anything.</span>
            <textarea className="h-20 rounded border border-rule-strong bg-bg p-2" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="Instruction" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              tone="primary"
              onClick={() =>
                setStarting({
                  key: null,
                  title: `Follow-up from ${included.length} threads`,
                  url: null,
                  description: '',
                  branch: 'chore/follow-up',
                  prompt: `${instruction.trim()}\n\n${batch.markdown}`,
                  warnings: [],
                })
              }
            >
              Start a thread with these answers
            </Button>
            {tabIds.length > 0 && (
              <Button onClick={() => void onCloseTabs(tabIds)}>
                Mark {included.length} done and close {tabIds.length} {tabIds.length === 1 ? 'tab' : 'tabs'}
              </Button>
            )}
          </div>
        </section>
      )}
      {starting && <StartModal status={status} initialDraft={starting} onClose={() => setStarting(null)} />}
    </div>
  );
}

export function AskThreads({
  cards,
  preselected,
  status,
  version,
  onClose,
}: {
  cards: Card[];
  preselected: string[];
  status: Status;
  version: number;
  onClose: () => void;
}) {
  const actions = useActions();
  const [batchId, setBatchId] = useState<number | null>(null);
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  const closeTabs = async (ids: string[]) => {
    try {
      const { results } = await api.post<{ results: { sessionId: string; ok: boolean; error?: string }[] }>('/cleanup/close', { sessionIds: ids, markDone: true });
      const failed = results.filter((r) => !r.ok);
      actions.toast(failed.length ? `Closed ${results.length - failed.length}; ${failed.length} kept open: ${failed[0]!.error}` : `Closed ${results.length} tabs`, failed.length ? 'error' : 'info');
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal title={batchId ? 'Answers' : 'Ask several threads the same question'} onClose={onClose} width="max-w-3xl">
      {batchId === null ? (
        <Picker cards={cards} preselected={preselected} status={status} onStarted={setBatchId} />
      ) : (
        <Results
          batchId={batchId}
          version={version}
          status={status}
          hasTabs={(ids) => ids.filter((id) => byId.get(id)?.tab && !byId.get(id)?.closeBlock)}
          onCloseTabs={closeTabs}
        />
      )}
    </Modal>
  );
}
