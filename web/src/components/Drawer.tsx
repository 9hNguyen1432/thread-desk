import { useCallback, useEffect, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { COLUMN_COLOR, COLUMN_LABEL, ago, bytes } from '../format';
import type { Card, Lifecycle, LinkView, Message, Status, TodosResponse } from '../types';
import { HandoffModal } from './HandoffModal';
import { Button, LinkChip } from './ui';

const LIFECYCLE_OPTIONS: { value: Lifecycle; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'waiting_others', label: 'Waiting on others' },
  { value: 'done', label: 'Done' },
  { value: 'archived', label: 'Archived' },
];

interface Detail {
  card: Card;
  messages: Message[];
  resumeCommand: string;
}

function MessageItem({ m }: { m: Message }) {
  const [full, setFull] = useState(false);
  const long = m.text.length > 600;
  const text = full || !long ? m.text : m.text.slice(0, 600) + '…';
  const user = m.role === 'user';
  return (
    <li className={`rounded px-3 py-2 ${user ? 'bg-bay' : ''}`}>
      <div className="mb-0.5 text-[12px] text-muted">
        {user ? 'You' : 'Claude'} {m.ts ? ago(m.ts) : ''}
      </div>
      <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">{text}</p>
      {long && (
        <button type="button" className="mt-1 text-[12px] text-muted underline" onClick={() => setFull((f) => !f)}>
          {full ? 'Show less' : 'Show all'}
        </button>
      )}
    </li>
  );
}

function TodoSection({ card, onChanged }: { card: Card; onChanged: () => void }) {
  const actions = useActions();
  const [open, setOpen] = useState<{ id: number; title: string }[] | null>(null);
  const [choice, setChoice] = useState('');

  const loadTodos = async () => {
    const r = await api.get<TodosResponse>('/todos?day=today');
    const candidates = r.todos.filter((t) => (t.status === 'todo' || t.status === 'wip') && !card.todos.some((c) => c.id === t.id));
    setOpen(candidates.map((t) => ({ id: t.id, title: t.title })));
    setChoice(candidates[0] ? String(candidates[0].id) : '');
  };

  const add = async () => {
    try {
      await api.post(`/todos/${choice}/link`, { sessionId: card.id });
      actions.toast('Added to todo');
      setOpen(null);
      onChanged();
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  return (
    <section className="mt-5">
      <h3 className="font-cond text-[15px] font-semibold">Todo</h3>
      {card.todos.length === 0 && open === null && <p className="mt-1 text-[13px] text-muted">Not part of any open todo.</p>}
      <ul className="mt-1 flex flex-col gap-1 text-[13px]">
        {card.todos.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <button
              type="button"
              className="text-[12px] text-muted hover:text-danger"
              onClick={() =>
                void api
                  .post(`/todos/${t.id}/unlink`, { sessionId: card.id })
                  .then(onChanged)
                  .catch((e: Error) => actions.toast(e.message, 'error'))
              }
            >
              Unlink
            </button>
          </li>
        ))}
      </ul>
      {open === null ? (
        <button type="button" className="mt-1 text-[12px] underline" onClick={() => void loadTodos()}>
          Add to a todo
        </button>
      ) : open.length === 0 ? (
        <p className="mt-1 text-[13px] text-muted">No other open todos today. Add one in the Today tab.</p>
      ) : (
        <div className="mt-1.5 flex gap-2">
          <select aria-label="Todo" className="min-w-0 flex-1 rounded border border-rule-strong bg-strip px-2 py-1 text-[13px]" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {open.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <Button onClick={() => void add()}>Add</Button>
        </div>
      )}
    </section>
  );
}

export function Drawer({ id, status, version }: { id: string; status: Status | null; version: number }) {
  const actions = useActions();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [note, setNote] = useState('');
  const [handoff, setHandoff] = useState(false);
  const [showMentioned, setShowMentioned] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get<Detail>(`/sessions/${id}`);
      setDetail(d);
      setNote((current) => (document.activeElement?.id === 'note-input' ? current : (d.card.note ?? '')));
    } catch (e) {
      actions.toast((e as Error).message, 'error');
      actions.select(null);
    }
  }, [id, actions]);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !handoff) actions.select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, handoff]);

  if (!detail) return null;
  const { card, messages, resumeCommand } = detail;

  const saveNote = async () => {
    if ((card.note ?? '') === note.trim()) return;
    await api.post(`/sessions/${card.id}/note`, { note });
    actions.toast('Note saved');
  };

  const hideLink = async (link: LinkView) => {
    await api.post(`/sessions/${card.id}/links/hide`, { kind: link.kind, key: link.key });
    void load();
  };

  const refreshRecap = async () => {
    try {
      await api.post(`/sessions/${card.id}/recap`);
      actions.toast('Summary queued');
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[520px] flex-col border-l border-rule-strong bg-strip shadow-2xl"
      aria-label="Thread details"
    >
      <header className="border-b border-rule px-5 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <h2 className="flex-1 font-cond text-xl leading-tight font-semibold">{card.title}</h2>
          <button type="button" className="rounded px-2 text-xl text-muted hover:bg-bay" aria-label="Close details" onClick={() => actions.select(null)}>
            ×
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
          <span className="inline-flex items-center gap-1.5 font-medium text-ink">
            <span className="size-2 rounded-full" style={{ background: COLUMN_COLOR[card.column] }} />
            {COLUMN_LABEL[card.column]}
          </span>
          {card.agent?.waitingFor && <span>waiting for {card.agent.waitingFor}</span>}
          {card.tab && <span>{bytes(card.tab.memoryBytes)} in {card.tab.ref}</span>}
          {card.tab && card.closeBlock && <span>{card.closeBlock}</span>}
          {card.lastAt && <span>active {ago(card.lastAt)} ago</span>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(card.tab || card.transcriptExists) && (
            <Button tone="primary" onClick={() => void actions.open(card)}>
              {card.tab ? 'Jump to tab' : 'Resume in new tab'}
            </Button>
          )}
          {card.tab && (
            <Button onClick={() => void actions.closeTab(card)} disabled={Boolean(card.closeBlock)} title={card.closeBlock ?? 'Close this cmux tab'}>
              Close tab
            </Button>
          )}
          <Button onClick={() => setHandoff(true)}>Post update</Button>
          <Button tone="quiet" onClick={() => void navigator.clipboard.writeText(resumeCommand).then(() => actions.toast('Resume command copied'))}>
            Copy resume command
          </Button>
        </div>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
        <div role="radiogroup" aria-label="Status" className="flex flex-wrap gap-1">
          {LIFECYCLE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={card.lifecycle === o.value}
              onClick={() => void actions.setLifecycle(card, o.value)}
              className={`rounded border px-2.5 py-1 text-[13px] ${
                card.lifecycle === o.value ? 'border-ink bg-ink text-bg' : 'border-rule-strong hover:border-ink'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-[13px] font-medium" htmlFor="note-input">
          Next step
        </label>
        <input
          id="note-input"
          className="mt-1 w-full rounded border border-rule-strong bg-bg px-2.5 py-1.5 text-[13px]"
          placeholder="What happens next, or who you are waiting for"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => void saveNote()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />

        <section className="mt-5">
          <div className="flex items-baseline justify-between">
            <h3 className="font-cond text-[15px] font-semibold">Summary</h3>
            {status?.recap.enabled && (
              <button type="button" className="text-[12px] text-muted underline" onClick={() => void refreshRecap()}>
                {card.recap ? 'Refresh' : 'Summarize'}
              </button>
            )}
          </div>
          {card.recap ? (
            <dl className="mt-1.5 grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-[13px]">
              <dt className="text-muted">Goal</dt>
              <dd>{card.recap.goal}</dd>
              <dt className="text-muted">Done</dt>
              <dd>{card.recap.done}</dd>
              <dt className="text-muted">Next</dt>
              <dd>{card.recap.next}</dd>
              {card.recap.blocker && (
                <>
                  <dt className="text-muted">Blocked by</dt>
                  <dd>{card.recap.blocker}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="mt-1 text-[13px] text-muted">
              {status?.recap.enabled ? 'No summary yet.' : 'Turn on AI summaries in Settings to get a four-line recap of each thread.'}
            </p>
          )}
        </section>

        <TodoSection card={card} onChanged={() => void load()} />

        <section className="mt-5">
          <h3 className="font-cond text-[15px] font-semibold">Links</h3>
          {card.links.length === 0 && <p className="mt-1 text-[13px] text-muted">No tickets, PRs or threads found yet.</p>}
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {card.links.map((l) => (
              <li key={`${l.kind}:${l.key}`} className="inline-flex items-center">
                <LinkChip link={l} />
                <button type="button" className="ml-0.5 px-1 text-muted hover:text-danger" aria-label={`Remove ${l.key}`} onClick={() => void hideLink(l)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {card.mentioned.length > 0 && (
            <div className="mt-2">
              <button type="button" className="text-[12px] text-muted underline" onClick={() => setShowMentioned((s) => !s)}>
                {showMentioned ? 'Hide' : 'Show'} {card.mentioned.length} links Claude mentioned
              </button>
              {showMentioned && (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {card.mentioned.map((l) => (
                    <li key={`${l.kind}:${l.key}`}>
                      <LinkChip link={l} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="mt-5 text-[12.5px]">
          <h3 className="font-cond text-[15px] font-semibold">Where</h3>
          <dl className="mt-1.5 grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1">
            <dt className="text-muted">Folder</dt>
            <dd className="font-mono text-[12px] break-all">{card.cwd ?? 'unknown'}</dd>
            {card.branch && (
              <>
                <dt className="text-muted">Branch</dt>
                <dd className="font-mono text-[12px] break-all">{card.branch}</dd>
              </>
            )}
            <dt className="text-muted">Session</dt>
            <dd className="font-mono text-[12px] break-all">{card.id}</dd>
            <dt className="text-muted">Messages</dt>
            <dd>
              {card.humanCount} from you, {card.messageCount - card.humanCount} from Claude
            </dd>
            {!card.transcriptExists && (
              <>
                <dt className="text-muted">Transcript</dt>
                <dd>Deleted by Claude Code's cleanup. Search still works; resuming does not.</dd>
              </>
            )}
          </dl>
        </section>

        <section className="mt-5">
          <h3 className="font-cond text-[15px] font-semibold">Latest messages</h3>
          <ol className="mt-1.5 flex flex-col gap-1">
            {messages.map((m, i) => (
              <MessageItem key={i} m={m} />
            ))}
          </ol>
        </section>
      </div>
      {handoff && <HandoffModal card={card} onClose={() => setHandoff(false)} />}
    </aside>
  );
}
