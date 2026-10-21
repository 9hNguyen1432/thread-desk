import { useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { COLUMN_COLOR, dayLabel, minutes } from '../format';
import type { TodoStatus, TodoView } from '../types';
import { Button, LabelChip } from './ui';

export const TODO_COLOR: Record<TodoStatus, string> = {
  todo: 'var(--st-idle)',
  wip: 'var(--st-running)',
  done: 'var(--st-done)',
  dropped: 'var(--st-archived)',
};

const STATUS_LABEL: Record<TodoStatus, string> = { todo: 'To do', wip: 'WIP', done: 'Done', dropped: 'Dropped' };

export function TodoCard({
  todo,
  editable,
  onChanged,
  onLink,
  onStart,
}: {
  todo: TodoView;
  editable: boolean;
  onChanged: () => void;
  onLink: (todo: TodoView) => void;
  onStart: (todo: TodoView) => void;
}) {
  const actions = useActions();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [showNotes, setShowNotes] = useState(false);
  const color = TODO_COLOR[todo.status];
  const closed = todo.status === 'done' || todo.status === 'dropped';

  const call = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      await fn();
      if (message) actions.toast(message);
      onChanged();
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  const setStatus = (status: TodoStatus) => call(() => api.patch(`/todos/${todo.id}`, { status }), `Marked ${STATUS_LABEL[status].toLowerCase()}`);
  const saveTitle = () => {
    setEditing(false);
    if (title.trim() && title.trim() !== todo.title) void call(() => api.patch(`/todos/${todo.id}`, { title }));
    else setTitle(todo.title);
  };

  return (
    <li className={`relative rounded border border-rule bg-strip py-2.5 pr-3 pl-4 ${closed ? 'opacity-75' : ''}`}>
      <span className="absolute inset-y-0 left-0 w-[5px] rounded-l" style={{ background: color }} aria-hidden />
      <div className="flex items-start gap-3">
        <div role="radiogroup" aria-label="Status" className="mt-0.5 flex shrink-0 overflow-hidden rounded border border-rule-strong text-[12px]">
          {(['todo', 'wip', 'done'] as TodoStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={todo.status === s}
              disabled={!editable}
              onClick={() => void setStatus(s)}
              className={`px-1.5 py-0.5 ${todo.status === s ? 'text-white' : 'text-muted hover:text-ink'}`}
              style={todo.status === s ? { background: TODO_COLOR[s] } : undefined}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              aria-label="Todo title"
              className="w-full rounded border border-rule-strong bg-bg px-2 py-0.5 font-cond text-[15px] font-semibold"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') {
                  setTitle(todo.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <h3
              className={`font-cond text-[15.5px] leading-snug font-semibold ${todo.status === 'dropped' ? 'line-through' : ''}`}
              onDoubleClick={() => editable && setEditing(true)}
              title={editable ? 'Double-click to rename' : undefined}
            >
              {todo.title}
            </h3>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-muted">
            {[...new Set(todo.threads.map((t) => t.label).filter((l): l is string => Boolean(l)))].map((l) => (
              <LabelChip key={l} name={l} />
            ))}
            {todo.carriedDays > 0 && <span>reported {dayLabel(todo.reportedDay)}, day {todo.carriedDays + 1}</span>}
            {todo.minutes > 0 && <span>{minutes(todo.minutes)} on this day</span>}
            {todo.status === 'dropped' && <span>dropped</span>}
            {editable && (
              <button
                type="button"
                className="hover:text-danger"
                onClick={() => {
                  if (window.confirm(`Delete “${todo.title}”? Its history is removed too.`)) void call(() => api.post(`/todos/${todo.id}/delete`), 'Todo deleted');
                }}
              >
                Delete
              </button>
            )}
            {todo.notes && (
              <button type="button" className="underline" onClick={() => setShowNotes((v) => !v)}>
                {showNotes ? 'Hide note' : 'Show note'}
              </button>
            )}
          </div>
          {showNotes && todo.notes && <p className="mt-1.5 rounded bg-bay px-2.5 py-1.5 text-[13px] whitespace-pre-wrap">{todo.notes}</p>}
        </div>
        {editable && !closed && (
          <div className="flex shrink-0 gap-1">
            <Button tone="quiet" onClick={() => onLink(todo)}>
              Link thread
            </Button>
            <Button tone="quiet" onClick={() => onStart(todo)}>
              Start thread
            </Button>
            <Button tone="quiet" onClick={() => void setStatus('dropped')} title="Not doing this any more">
              Drop
            </Button>
          </div>
        )}
      </div>

      {todo.doneHint && editable && (
        <div className="mt-2 flex items-center gap-2 rounded border border-done/40 px-2.5 py-1.5 text-[13px]">
          <span className="flex-1">{todo.doneHint}. Mark this todo done?</span>
          <Button tone="primary" onClick={() => void setStatus('done')}>
            Mark done
          </Button>
        </div>
      )}

      {todo.threads.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {todo.threads.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-[13px]">
              <span className="size-2 shrink-0 rounded-full" style={{ background: COLUMN_COLOR[t.column] }} />
              <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => actions.select(t.id)}>
                {t.title}
              </button>
              {t.projectName && <span className="shrink-0 text-[12px] text-muted">{t.projectName}</span>}
              {t.minutes > 0 && <span className="shrink-0 text-[12px] text-muted tabular-nums">{minutes(t.minutes)}</span>}
              <span className="flex-1" />
              {t.origin === 'auto' && <span className="text-[12px] text-muted">linked automatically</span>}
              {editable && (
                <button
                  type="button"
                  className="shrink-0 px-1 text-[12px] text-muted hover:text-danger"
                  title={t.origin === 'auto' ? 'Unlink and never link this thread again' : 'Unlink'}
                  onClick={() =>
                    void call(() => api.post(`/todos/${todo.id}/${t.origin === 'auto' ? 'reject' : 'unlink'}`, { sessionId: t.id }), 'Unlinked')
                  }
                >
                  {t.origin === 'auto' ? 'Not this' : 'Unlink'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && todo.suggestions.length > 0 && (
        <div className="mt-2 rounded bg-bay px-2.5 py-1.5">
          <p className="text-[12px] font-medium text-muted">Looks related</p>
          <ul className="mt-1 flex flex-col gap-1">
            {todo.suggestions.map((s) => (
              <li key={s.sessionId} className="flex items-center gap-2 text-[13px]">
                <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => actions.select(s.sessionId)}>
                  {s.title}
                </button>
                <span className="shrink-0 text-[12px] text-muted">{s.reason}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 font-medium hover:bg-strip"
                  onClick={() => void call(() => api.post(`/todos/${todo.id}/link`, { sessionId: s.sessionId, origin: 'accepted' }), 'Linked')}
                >
                  Link
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 text-muted hover:bg-strip"
                  onClick={() => void call(() => api.post(`/todos/${todo.id}/reject`, { sessionId: s.sessionId }))}
                >
                  Not related
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
