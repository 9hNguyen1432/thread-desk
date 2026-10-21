import { useCallback, useEffect, useRef, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { dayLabel, minutes, shiftDay } from '../format';
import type { Capture, SearchResult, StartDraft, Status, TodoView, TodosResponse } from '../types';
import { ImportThreads } from './ImportThreads';
import { StartModal } from './StartModal';
import { TodoCard } from './TodoCard';
import { Button, Empty, Modal } from './ui';

function LinkPicker({ todo, onClose, onLinked }: { todo: TodoView; onClose: () => void; onLinked: () => void }) {
  const actions = useActions();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchResult[]>([]);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void api.get<{ hits: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => current && setHits(r.hits));
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q]);

  const link = async (sessionId: string) => {
    try {
      await api.post(`/todos/${todo.id}/link`, { sessionId });
      actions.toast('Linked');
      onLinked();
      onClose();
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal title={`Link a thread to “${todo.title}”`} onClose={onClose} width="max-w-xl">
      <input
        className="w-full rounded border border-rule-strong bg-bg px-2.5 py-1.5 text-[13px]"
        placeholder="Search threads by words, ticket key or link"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search threads"
      />
      <ul className="scroll-thin mt-2 max-h-80 overflow-y-auto">
        {hits
          .filter((h) => !todo.threads.some((t) => t.id === h.card.id))
          .map((h) => (
            <li key={h.card.id}>
              <button type="button" className="w-full rounded px-2 py-1.5 text-left hover:bg-bay" onClick={() => void link(h.card.id)}>
                <div className="truncate font-cond text-[14.5px] font-semibold">{h.card.title}</div>
                <div className="truncate text-[12px] text-muted">{h.snippet ?? h.card.projectName}</div>
              </button>
            </li>
          ))}
      </ul>
    </Modal>
  );
}

function WrapUp({ day, isToday, todos, onChanged, onClose }: { day: string; isToday: boolean; todos: TodoView[]; onChanged: () => void; onClose: () => void }) {
  const actions = useActions();
  const [capture, setCapture] = useState<Capture | null>(null);
  const load = useCallback(() => void api.get<Capture>(`/days/${day}/capture`).then(setCapture), [day]);
  useEffect(load, [load, todos]);

  const ready = todos.filter((t) => t.doneHint && (t.status === 'todo' || t.status === 'wip'));
  const carrying = todos.filter((t) => t.status === 'todo' || t.status === 'wip');
  const unplanned = capture?.lines.filter((l) => l.status === 'unplanned') ?? [];

  const markDone = async (id: number) => {
    await api.patch(`/todos/${id}`, { status: 'done' });
    onChanged();
  };

  const addUnplanned = async (title: string, sessionId: string, status: 'done' | 'wip') => {
    try {
      const { ids } = await api.post<{ ids: number[] }>('/todos/import', { groups: [{ title, sessionIds: [sessionId] }] });
      await api.patch(`/todos/${ids[0]}`, { status });
      actions.toast(status === 'done' ? 'Added to today as done' : 'Added to today as in progress');
      onChanged();
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal title={isToday ? 'Wrap up the day' : `Review ${dayLabel(day)}`} onClose={onClose} width="max-w-2xl">
      <div className="scroll-thin flex max-h-[65vh] flex-col gap-4 overflow-y-auto text-[13px]">
        <section>
          <h3 className="font-cond text-[15px] font-semibold">Ready to mark done</h3>
          {ready.length === 0 && <p className="mt-1 text-muted">Nothing finished by its threads yet.</p>}
          <ul className="mt-1 flex flex-col gap-1">
            {ready.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="text-[12px] text-muted">{t.doneHint}</span>
                {isToday && <Button onClick={() => void markDone(t.id)}>Done</Button>}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="font-cond text-[15px] font-semibold">Worked on, but not on your list</h3>
          {unplanned.length === 0 && <p className="mt-1 text-muted">Every thread you touched belongs to a todo.</p>}
          <ul className="mt-1 flex flex-col gap-1">
            {unplanned.map((l) => (
              <li key={l.threads[0]!.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{l.title}</span>
                <span className="text-[12px] text-muted">{minutes(l.minutes)}</span>
                {isToday && (
                  <>
                    <Button onClick={() => void addUnplanned(l.title, l.threads[0]!.id, 'wip')}>Add as WIP</Button>
                    <Button onClick={() => void addUnplanned(l.title, l.threads[0]!.id, 'done')}>Add as done</Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="font-cond text-[15px] font-semibold">{isToday ? 'Moving to tomorrow' : 'Left open that day'}</h3>
          <p className="mt-1 text-muted">
            {carrying.length === 0
              ? 'Nothing left open.'
              : `${carrying.length} open ${carrying.length === 1 ? 'todo moves' : 'todos move'} to tomorrow on their own and keep their reported day.`}
          </p>
        </section>
        {capture && (
          <section>
            <div className="flex items-baseline justify-between">
              <h3 className="font-cond text-[15px] font-semibold">Log, {minutes(capture.totalMinutes)}</h3>
              <button type="button" className="text-[12px] underline" onClick={() => void navigator.clipboard.writeText(capture.markdown).then(() => actions.toast('Log copied'))}>
                Copy
              </button>
            </div>
            <pre className="mt-1 rounded bg-bay p-2.5 font-sans text-[12.5px] whitespace-pre-wrap">{capture.markdown}</pre>
          </section>
        )}
      </div>
    </Modal>
  );
}

export function Today({ version, status }: { version: number; status: Status | null }) {
  const actions = useActions();
  const [day, setDay] = useState<string | null>(null);
  const [data, setData] = useState<TodosResponse | null>(null);
  const [text, setText] = useState('');
  const [linking, setLinking] = useState<TodoView | null>(null);
  const [starting, setStarting] = useState<{ todo: TodoView; draft: StartDraft } | null>(null);
  const [wrapping, setWrapping] = useState(false);
  const [importing, setImporting] = useState(false);
  const adding = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<TodosResponse>(`/todos?day=${day ?? 'today'}`));
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  }, [day, actions]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const add = async () => {
    if (!text.trim() || adding.current) return;
    adding.current = true;
    const value = text;
    setText('');
    try {
      await api.post('/todos', { text: value });
      void load();
    } catch (e) {
      setText(value);
      actions.toast((e as Error).message, 'error');
    } finally {
      adding.current = false;
    }
  };

  const start = async (todo: TodoView) => {
    try {
      const { draft } = await api.post<{ draft: StartDraft }>(`/todos/${todo.id}/start-draft`);
      setStarting({ todo, draft });
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  if (!data) return null;
  const isToday = data.day === data.today;
  const total = data.todos.reduce((sum, t) => sum + t.minutes, 0);
  const open = data.todos.filter((t) => t.status === 'todo' || t.status === 'wip');
  const closed = data.todos.filter((t) => t.status === 'done' || t.status === 'dropped');

  return (
    <div className="mx-auto max-w-3xl px-4 pb-10">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button tone="quiet" onClick={() => setDay(shiftDay(data.day, -1))} aria-label="Previous day">
          ‹
        </Button>
        <h2 className="min-w-28 text-center font-cond text-[18px] font-bold">{dayLabel(data.day, data.today)}</h2>
        <Button tone="quiet" onClick={() => setDay(shiftDay(data.day, 1))} disabled={isToday} aria-label="Next day">
          ›
        </Button>
        {!isToday && (
          <Button tone="quiet" onClick={() => setDay(null)}>
            Back to today
          </Button>
        )}
        <span className="flex-1" />
        {total > 0 && <span className="text-[13px] text-muted">{minutes(total)} on your todos</span>}
        {isToday && <Button onClick={() => setImporting(true)}>Bring in threads</Button>}
        <Button onClick={() => setWrapping(true)}>{isToday ? 'Wrap up the day' : 'Review this day'}</Button>
      </div>

      {isToday && (
        <form
          className="mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <textarea
            rows={text.includes('\n') ? 4 : 1}
            className="w-full resize-none rounded border border-rule-strong bg-strip px-3 py-2 text-[14px]"
            placeholder="Add a todo. Paste a Slack message, ticket or PR link and it links threads by itself."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter also confirms a word in Vietnamese and CJK input methods; never submit then.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && !e.shiftKey && (!text.includes('\n') || e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void add();
              }
            }}
            aria-label="New todo"
          />
          <p className="mt-1 text-[12px] text-muted">Enter to add. The first line becomes the title; Shift+Enter for more lines, then ⌘Enter.</p>
        </form>
      )}

      {data.todos.length === 0 ? (
        <Empty title={isToday ? 'Nothing planned yet' : 'No todos on this day'}>
          {isToday ? (
            <>
              <p>Type what you want to get done today, or start from the threads you already have open.</p>
              <Button tone="primary" className="mt-3" onClick={() => setImporting(true)}>
                Bring in your open threads
              </Button>
            </>
          ) : null}
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...open, ...closed].map((t) => (
            <TodoCard key={t.id} todo={t} editable={isToday} onChanged={() => void load()} onLink={setLinking} onStart={(todo) => void start(todo)} />
          ))}
        </ul>
      )}

      {linking && <LinkPicker todo={linking} onClose={() => setLinking(null)} onLinked={() => void load()} />}
      {starting && (
        <StartModal status={status} initialDraft={starting.draft} todoId={starting.todo.id} onClose={() => setStarting(null)} />
      )}
      {importing && <ImportThreads onClose={() => setImporting(false)} onDone={() => void load()} />}
      {wrapping && <WrapUp day={data.day} isToday={isToday} todos={data.todos} onChanged={() => void load()} onClose={() => setWrapping(false)} />}
    </div>
  );
}
