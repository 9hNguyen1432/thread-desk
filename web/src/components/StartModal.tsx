import { useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import type { StartDraft, Status } from '../types';
import { Button, Modal } from './ui';

export function StartModal({
  status,
  onClose,
  initialDraft,
  todoId,
  defaultWorktree = true,
  onLaunched,
}: {
  status: Status | null;
  onClose: () => void;
  initialDraft?: StartDraft;
  todoId?: number;
  defaultWorktree?: boolean;
  onLaunched?: () => void;
}) {
  const actions = useActions();
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<StartDraft | null>(initialDraft ?? null);
  const [projects, setProjects] = useState<{ project: string; name: string }[]>(status?.projects ?? []);
  const [cwd, setCwd] = useState(status?.projects[0]?.project ?? '');
  const [worktree, setWorktree] = useState(defaultWorktree);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);

  const fetchDraft = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ draft: StartDraft; projects: { project: string; name: string }[] }>('/start/draft', { input });
      setDraft(r.draft);
      setProjects(r.projects);
      if (!cwd && r.projects[0]) setCwd(r.projects[0].project);
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const launch = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await api.post<{ dir: string; command: string; opened: boolean }>('/start/launch', {
        cwd,
        title: draft.key && !draft.title.startsWith(draft.key) ? `${draft.key} ${draft.title}` : draft.title,
        prompt: draft.prompt,
        worktree,
        branch: draft.branch,
        key: draft.key,
        todoId,
      });
      onLaunched?.();
      if (r.opened) {
        actions.toast(`Started in ${r.dir}`);
        onClose();
      } else {
        setCommand(r.command);
      }
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const field = 'mt-1 w-full rounded border border-rule-strong bg-bg px-2.5 py-1.5 text-[13px]';

  return (
    <Modal title={todoId ? 'Start a thread for this todo' : 'Start a thread'} onClose={onClose} width="max-w-2xl">
      {!initialDraft && (
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void fetchDraft();
        }}
      >
        <input
          className={field + ' mt-0 flex-1'}
          placeholder="Ticket key, GitHub issue, Slack thread link, or a short description"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="What to work on"
        />
        <Button type="submit" disabled={!input.trim() || busy}>
          {busy && !draft ? 'Loading…' : 'Prepare'}
        </Button>
      </form>
      )}

      {draft && (
        <div className="mt-4 flex flex-col gap-3 text-[13px]">
          {draft.warnings.map((w) => (
            <p key={w} className="rounded border border-needs/50 px-2.5 py-1.5">
              {w}
            </p>
          ))}
          <label>
            Title
            <input className={field} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label>
            Repository or folder
            <input className={field + ' font-mono text-[12px]'} list="td-projects" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            <datalist id="td-projects">
              {projects.map((p) => (
                <option key={p.project} value={p.project}>
                  {p.name}
                </option>
              ))}
            </datalist>
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-1.5 pb-1.5">
              <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
              Create a git worktree
            </label>
            {worktree && (
              <label className="flex-1">
                Branch
                <input className={field + ' font-mono text-[12px]'} value={draft.branch} onChange={(e) => setDraft({ ...draft, branch: e.target.value })} />
              </label>
            )}
          </div>
          <label>
            First prompt
            <textarea className={field + ' h-40'} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
          </label>
          {command ? (
            <div>
              <p className="mb-1">No supported terminal found. Run this to start:</p>
              <pre className="overflow-x-auto rounded bg-bay p-2 font-mono text-[12px]">{command}</pre>
              <div className="mt-2 flex justify-end">
                <Button tone="primary" onClick={() => void navigator.clipboard.writeText(command).then(() => actions.toast('Command copied'))}>
                  Copy command
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button tone="quiet" onClick={onClose}>
                Cancel
              </Button>
              <Button tone="primary" disabled={busy || !cwd.trim() || !draft.prompt.trim()} onClick={() => void launch()}>
                {busy ? 'Starting…' : status?.terminal === 'cmux' ? 'Start in cmux' : 'Prepare command'}
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
