import { useCallback, useEffect, useRef, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import type { StartDraft, Status } from '../types';
import { StartModal } from './StartModal';
import { Button } from './ui';

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
  status: 'running' | 'done' | 'cancelled';
  items: AskItem[];
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

/** Same layout as the server's combined file, built from what is on screen right now. */
function combine(batch: AskBatch, edits: Record<string, string>): string {
  const chosen = batch.items.filter((i) => i.included && i.status === 'done');
  const parts = [`Question asked to ${chosen.length} ${chosen.length === 1 ? 'thread' : 'threads'}: ${batch.prompt}`, ''];
  for (const i of chosen) {
    const answer = (edits[i.sessionId] ?? i.answer ?? '').trim();
    if (answer) parts.push(`## ${i.title}`, '', answer, '');
  }
  return parts.join('\n').trim() + '\n';
}

export function AskResults({ batchId, version, status }: { batchId: number; version: number; status: Status }) {
  const actions = useActions();
  const [batch, setBatch] = useState<AskBatch | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savePath, setSavePath] = useState('');
  const [starting, setStarting] = useState<StartDraft | null>(null);
  const [started, setStarted] = useState(false);
  const [closeTabs, setCloseTabs] = useState(true);
  const [instruction, setInstruction] = useState(NEXT_STEP);
  const saving = useRef(new Map<string, Promise<unknown>>());

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
    const request = api.post(`/ask/${batch.id}/item`, { sessionId, ...patch });
    saving.current.set(sessionId, request);
    await request;
    saving.current.delete(sessionId);
    load();
  };

  /** Waits for answer edits still being saved, so files and follow-ups get the latest text. */
  const flush = () => Promise.all([...saving.current.values()]);

  const save = async () => {
    try {
      await flush();
      const { path } = await api.post<{ path: string }>(`/ask/${batch.id}/save`, { path: savePath.trim() });
      actions.toast(`Saved to ${path}`);
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  const finish = async () => {
    try {
      await flush();
      const r = await api.post<{ done: number; closed: number; kept: number }>(`/ask/${batch.id}/finish`, { closeTabs });
      actions.toast(`Marked ${r.done} done${closeTabs ? `, closed ${r.closed} tabs${r.kept ? `, ${r.kept} kept open` : ''}` : ''}`);
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-muted">
          {pending > 0 ? `${batch.items.length - pending} of ${batch.items.length} answered, asking one at a time.` : `${included.length} answers selected.`}
        </p>
        {pending > 0 && (
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
                value={edits[i.sessionId] ?? i.answer ?? ''}
                onChange={(e) => setEdits((prev) => ({ ...prev, [i.sessionId]: e.target.value }))}
                onBlur={(e) => e.target.value !== i.answer && void update(i.sessionId, { answer: e.target.value })}
              />
            )}
            {(i.status === 'failed' || (i.status === 'skipped' && i.error)) && <p className="mt-1 text-[12.5px] text-danger">{i.error}</p>}
          </li>
        ))}
      </ol>

      {pending === 0 && included.length > 0 && (
        <section className="flex flex-col gap-2 border-t border-rule pt-3">
          <h3 className="font-cond text-[15px] font-semibold">Then, once</h3>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void navigator.clipboard.writeText(combine(batch, edits)).then(() => actions.toast('Copied all answers'))}>
              Copy as one message
            </Button>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button
              tone="primary"
              disabled={started}
              onClick={() =>
                void flush().then(() =>
                  setStarting({
                    key: null,
                    title: `Follow-up from ${included.length} threads`,
                    url: null,
                    description: '',
                    branch: `chore/follow-up-${batch.id}`,
                    prompt: `${instruction.trim()}\n\n${combine(batch, edits)}`,
                    warnings: [],
                  }),
                )
              }
            >
              {started ? 'Follow-up thread started' : 'Start a thread with these answers'}
            </Button>
            <span className="flex-1" />
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={closeTabs} onChange={(e) => setCloseTabs(e.target.checked)} />
              close their tabs that are safe to close
            </label>
            <Button onClick={() => void finish()}>Mark {included.length} done</Button>
          </div>
        </section>
      )}
      {starting && (
        <StartModal status={status} initialDraft={starting} defaultWorktree={false} onLaunched={() => setStarted(true)} onClose={() => setStarting(null)} />
      )}
    </div>
  );
}
