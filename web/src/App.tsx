import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionsContext, type Actions } from './actions';
import { api, token } from './api';
import { BoardView } from './components/Board';
import { Cleanup } from './components/Cleanup';
import { DigestView } from './components/DigestView';
import { Drawer } from './components/Drawer';
import { Inbox } from './components/Inbox';
import { Log } from './components/Log';
import { Today } from './components/Today';
import { Palette } from './components/Palette';
import { Settings } from './components/Settings';
import { StartModal } from './components/StartModal';
import { Tickets } from './components/Tickets';
import { Button, Kbd, Modal } from './components/ui';
import { bytes } from './format';
import type { Board, Card, Lifecycle, OpenResult, Status, TabInfo } from './types';

type View = 'board' | 'today' | 'inbox' | 'cleanup' | 'tickets' | 'log' | 'digest';
const VIEWS: { id: View; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'today', label: 'Today' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'cleanup', label: 'Cleanup' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'log', label: 'Log' },
  { id: 'digest', label: 'Digest' },
];

const LIFECYCLE_TOAST: Record<Lifecycle, string> = {
  active: 'Moved back to active',
  waiting_others: 'Marked as waiting on others',
  done: 'Marked done',
  archived: 'Archived',
};

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are a convenience; ignore blocked storage.
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest('input, textarea, select, [contenteditable="true"]'));
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [view, setView] = useState<View>(() => stored('td.view', 'board') as View);
  const [project, setProject] = useState(() => stored('td.project', ''));
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [palette, setPalette] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [settings, setSettings] = useState(false);
  const [closePrompt, setClosePrompt] = useState<{ card: Card; tab: TabInfo } | null>(null);
  const [rememberChoice, setRememberChoice] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [unauthorized, setUnauthorized] = useState(false);

  const toast = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);

  const loadBoard = useCallback(async () => {
    try {
      const b = await api.get<Board>(`/board${project ? `?project=${encodeURIComponent(project)}` : ''}`);
      setBoard(b);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setUnauthorized(true);
    }
  }, [project]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.get<Status>('/status'));
    } catch (e) {
      if ((e as { status?: number }).status === 401) setUnauthorized(true);
    }
  }, []);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard, version]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, version]);

  useEffect(() => {
    const source = new EventSource(`/api/events?t=${encodeURIComponent(token())}`);
    source.addEventListener('board', () => setVersion((v) => v + 1));
    source.addEventListener('toast', (e) => {
      const data = JSON.parse((e as MessageEvent<string>).data) as { message: string };
      toast(data.message);
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      source.close();
      clearInterval(tick);
    };
  }, [toast]);

  useEffect(() => store('td.view', view), [view]);
  useEffect(() => store('td.project', project), [project]);

  const actions: Actions = useMemo(
    () => ({
      select: setSelected,
      toast,
      filterByLink: (key) => setPalette(key),
      async open(card) {
        try {
          const r = await api.post<OpenResult>(`/sessions/${card.id}/open`);
          if (r.action === 'focused') toast(`Switched to “${card.title}”`);
          else if (r.action === 'opened') toast('Resumed in a new cmux tab');
          else {
            await navigator.clipboard.writeText(r.command).catch(() => undefined);
            toast('Resume command copied. Paste it in a terminal.');
          }
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      },
      async setLifecycle(card, lifecycle) {
        try {
          const r = await api.post<{ card: Card; closePrompt: TabInfo | null; closed: boolean }>(`/sessions/${card.id}/lifecycle`, { lifecycle });
          if (r.closePrompt) setClosePrompt({ card: r.card, tab: r.closePrompt });
          else toast(r.closed ? 'Marked done and closed its tab' : LIFECYCLE_TOAST[lifecycle]);
          setVersion((v) => v + 1);
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      },
      async closeTab(card) {
        try {
          await api.post(`/sessions/${card.id}/close-tab`);
          toast(`Closed the tab for “${card.title}”`);
          setVersion((v) => v + 1);
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      },
    }),
    [toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => (p === null ? '' : null));
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey || palette !== null || selected) return;
      if (e.key === '/') {
        e.preventDefault();
        setPalette('');
      }
      const n = Number(e.key);
      if (n >= 1 && n <= VIEWS.length) setView(VIEWS[n - 1]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, selected]);

  const answerClosePrompt = async (close: boolean, remember = rememberChoice) => {
    if (!closePrompt) return;
    const { card } = closePrompt;
    setClosePrompt(null);
    setRememberChoice(false);
    if (remember) {
      await api.patch('/settings', { onDone: close ? 'close' : 'keep' }).catch(() => undefined);
    }
    if (close) await actions.closeTab(card);
    else toast('Marked done; the tab stays open');
  };

  if (unauthorized) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div>
          <h1 className="font-cond text-2xl font-semibold">Thread Desk is locked</h1>
          <p className="mt-2 text-muted">
            Open the link printed in your terminal, or run <code>thread-desk url</code>.
          </p>
        </div>
      </div>
    );
  }

  const cards = board?.cards ?? [];
  const needsYou = cards.filter((c) => c.column === 'needs_you').length;

  return (
    <ActionsContext.Provider value={actions}>
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 pt-3 pb-3">
          <h1 className="font-cond text-[22px] leading-none font-bold tracking-tight">Thread Desk</h1>
          <nav aria-label="Views" className="flex gap-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-current={view === v.id ? 'page' : undefined}
                onClick={() => setView(v.id)}
                className={`rounded px-2.5 py-1 font-cond text-[15px] font-semibold ${view === v.id ? 'bg-ink text-bg' : 'text-muted hover:text-ink'}`}
              >
                {v.label}
                {v.id === 'inbox' && needsYou > 0 && (
                  <span className="ml-1.5 rounded-full bg-needs px-1.5 text-[12px] text-white">{needsYou}</span>
                )}
              </button>
            ))}
          </nav>
          <select
            aria-label="Project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="max-w-56 rounded border border-rule-strong bg-strip px-2 py-1 text-[13px]"
          >
            <option value="">All projects</option>
            {status?.projects.map((p) => (
              <option key={p.project} value={p.project}>
                {p.name} ({p.count})
              </option>
            ))}
          </select>
          {view === 'board' && (
            <label className="flex items-center gap-1.5 text-[13px] text-muted">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived
            </label>
          )}
          <span className="flex-1" />
          {board && board.totals.tabs > 0 && (
            <span className="text-[13px] text-muted" title="Memory used by open cmux tabs">
              {board.totals.tabs} tabs open, {bytes(board.totals.memoryBytes)}
            </span>
          )}
          <Button onClick={() => setPalette('')}>
            Find <Kbd>⌘K</Kbd>
          </Button>
          <Button onClick={() => setStarting(true)}>New thread</Button>
          <Button tone="quiet" onClick={() => setSettings(true)} disabled={!status}>
            Settings
          </Button>
        </header>

        {status?.indexing.running && (
          <p className="mx-4 mb-2 rounded bg-bay px-3 py-1.5 text-[13px]">
            Reading transcripts: {status.indexing.done} of {status.indexing.total || '…'}
          </p>
        )}
        {status && status.liveErrors.length > 0 && (
          <p className="mx-4 mb-2 rounded border border-needs/60 px-3 py-1.5 text-[13px]" title={status.liveErrors.join('\n')}>
            Live status is partly unavailable: {status.liveErrors[0]}
          </p>
        )}
        {status && status.indexErrors > 0 && !status.indexing.running && (
          <p className="mx-4 mb-2 rounded border border-needs/60 px-3 py-1.5 text-[13px]">
            {status.indexErrors} transcript {status.indexErrors === 1 ? 'file' : 'files'} could not be read and will be retried when they change.
          </p>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto">
          {view === 'board' && <BoardView cards={cards} showArchived={showArchived} now={now} />}
          {view === 'today' && <Today version={version} status={status} />}
          {view === 'inbox' && <Inbox version={version} />}
          {view === 'cleanup' && <Cleanup version={version} status={status} />}
          {view === 'tickets' && <Tickets version={version} status={status} onConfigure={() => setSettings(true)} />}
          {view === 'log' && <Log version={version} />}
          {view === 'digest' && <DigestView version={version} />}
        </main>
      </div>

      {selected && <Drawer id={selected} status={status} version={version} />}
      {palette !== null && <Palette initial={palette} onClose={() => setPalette(null)} />}
      {starting && <StartModal status={status} onClose={() => setStarting(false)} />}
      {settings && status && <Settings status={status} onClose={() => setSettings(false)} onSaved={setStatus} />}
      {closePrompt && (
        <Modal title="Close the cmux tab too?" onClose={() => void answerClosePrompt(false, false)}>
          <p className="text-[13.5px]">
            “{closePrompt.card.title}” is done. Its tab {closePrompt.tab.ref} uses {bytes(closePrompt.tab.memoryBytes)}. You can resume the thread later from
            search.
          </p>
          <label className="mt-3 flex items-center gap-1.5 text-[13px] text-muted">
            <input type="checkbox" checked={rememberChoice} onChange={(e) => setRememberChoice(e.target.checked)} />
            Remember my choice
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <Button tone="quiet" onClick={() => void answerClosePrompt(false)}>
              Keep tab open
            </Button>
            <Button tone="primary" onClick={() => void answerClosePrompt(true)}>
              Close tab
            </Button>
          </div>
        </Modal>
      )}

      <div aria-live="polite" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded px-3.5 py-2 text-[13px] shadow-lg ${t.tone === 'error' ? 'bg-danger text-white' : 'bg-ink text-bg'}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ActionsContext.Provider>
  );
}
