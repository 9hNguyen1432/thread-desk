import { useEffect, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { COLUMN_COLOR, COLUMN_LABEL, ago } from '../format';
import type { Column } from '../types';
import { Button, Modal } from './ui';

interface ImportGroup {
  key: string;
  title: string;
  ticket: string | null;
  threads: { id: string; title: string; column: Column; projectName: string | null; lastAt: number | null }[];
  suggested: boolean;
  existingTodo: { id: number; title: string } | null;
}

export function ImportThreads({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const actions = useActions();
  const [groups, setGroups] = useState<ImportGroup[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ groups: ImportGroup[] }>('/todos/import-candidates').then((r) => {
      setGroups(r.groups);
      setPicked(new Set(r.groups.filter((g) => g.suggested).map((g) => g.key)));
      setTitles(Object.fromEntries(r.groups.map((g) => [g.key, g.title])));
    });
  }, []);

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const create = async () => {
    if (!groups) return;
    setBusy(true);
    try {
      const chosen = groups.filter((g) => picked.has(g.key));
      await api.post('/todos/import', {
        groups: chosen.map((g) => ({
          title: (titles[g.key] ?? g.title).trim() || g.title,
          sessionIds: g.threads.map((t) => t.id),
          todoId: g.existingTodo?.id,
        })),
      });
      const joined = chosen.filter((g) => g.existingTodo).length;
      const created = chosen.length - joined;
      actions.toast([created && `Added ${created} ${created === 1 ? 'todo' : 'todos'}`, joined && `linked ${joined} to existing todos`].filter(Boolean).join(', '));
      onDone();
      onClose();
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Bring in your open threads" onClose={onClose} width="max-w-3xl">
      {!groups ? (
        <p className="text-[13px] text-muted">Looking at your threads…</p>
      ) : groups.length === 0 ? (
        <p className="text-[13px] text-muted">Every open or recent thread already belongs to a todo.</p>
      ) : (
        <>
          <p className="mb-2 text-[13px] text-muted">
            Threads that share a ticket become one todo. Threads active in the last three days are ticked; rename a todo before adding it if you like.
          </p>
          <ul className="scroll-thin flex max-h-[55vh] flex-col gap-1 overflow-y-auto pr-1">
            {groups.map((g) => (
              <li key={g.key} className={`flex items-start gap-2.5 rounded border px-2.5 py-2 ${picked.has(g.key) ? 'border-rule-strong bg-strip' : 'border-transparent'}`}>
                <input type="checkbox" className="mt-1.5" aria-label={`Add ${g.title}`} checked={picked.has(g.key)} onChange={() => toggle(g.key)} />
                <div className="min-w-0 flex-1">
                  {g.existingTodo ? (
                    <p className="px-1 text-[14.5px] font-medium">
                      <span className="font-normal text-muted">Adds to:</span> {g.existingTodo.title}
                    </p>
                  ) : (
                    <input
                      aria-label="Todo title"
                      className="w-full rounded border border-transparent bg-transparent px-1 text-[14.5px] font-medium hover:border-rule focus:border-rule-strong"
                      value={titles[g.key] ?? g.title}
                      onChange={(e) => setTitles((t) => ({ ...t, [g.key]: e.target.value }))}
                    />
                  )}
                  <ul className="mt-0.5 flex flex-col gap-0.5 pl-1">
                    {g.threads.map((t) => (
                      <li key={t.id} className="flex items-center gap-2 text-[12.5px] text-muted">
                        <span className="size-1.5 shrink-0 rounded-full" style={{ background: COLUMN_COLOR[t.column] }} title={COLUMN_LABEL[t.column]} />
                        <span className="truncate">{t.title}</span>
                        {t.projectName && <span className="shrink-0">{t.projectName}</span>}
                        <span className="shrink-0">{ago(t.lastAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-2">
            <Button tone="quiet" onClick={() => setPicked(new Set(groups.map((g) => g.key)))}>
              Select all
            </Button>
            <Button tone="quiet" onClick={() => setPicked(new Set())}>
              Select none
            </Button>
            <span className="flex-1" />
            <Button tone="primary" disabled={busy || picked.size === 0} onClick={() => void create()}>
              {busy ? 'Adding…' : `Add ${picked.size} ${picked.size === 1 ? 'todo' : 'todos'}`}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
