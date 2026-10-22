import { useEffect, useMemo, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { ago, bytes, tabNoun } from '../format';
import type { Card, CleanupSuggestion, Status } from '../types';
import { AskThreads } from './AskThreads';
import { Button, Empty } from './ui';

export function Cleanup({ version, status, label, agent, cards }: { version: number; status: Status | null; label: string; agent: string; cards: Card[] }) {
  const actions = useActions();
  const [all, setItems] = useState<CleanupSuggestion[]>([]);
  const items = useMemo(() => {
    const shown = agent ? new Set(cards.map((c) => c.id)) : null;
    return all.filter((i) => (!shown || shown.has(i.sessionId)) && (!label || (label === '-' ? !i.label : i.label === label)));
  }, [all, label, agent, cards]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [markDone, setMarkDone] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    void api.get<{ suggestions: CleanupSuggestion[] }>('/cleanup').then((r) => {
      setItems(r.suggestions);
      setSelected((prev) => {
        const ids = new Set(r.suggestions.map((s) => s.sessionId));
        return new Set([...prev].filter((id) => ids.has(id)));
      });
    });
  }, [version]);

  // Only rows on screen count; a selection hidden by the label filter is never closed by accident.
  const chosen = useMemo(() => items.filter((i) => selected.has(i.sessionId)), [items, selected]);
  const total = chosen.reduce((sum, i) => sum + i.memoryBytes, 0);
  const labelNames = status?.labels.names ?? [];

  /** `value` is a label name, "" for "no label", or "auto" to go back to the automatic label. */
  const setKind = async (ids: string[], value: string) => {
    try {
      for (const id of ids) await api.post(`/sessions/${id}/label`, { label: value === 'auto' ? null : value });
      setItems((prev) =>
        prev.map((i) => (ids.includes(i.sessionId) && value !== 'auto' ? { ...i, label: value || null, labelPicked: true } : i)),
      );
      if (ids.length > 1) actions.toast(`Set ${ids.length} threads to ${value === 'auto' ? 'automatic' : value || 'no label'}`);
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    }
  };

  const askButton = status && (
    <Button onClick={() => setAsking(true)} title="Ask several threads the same question, then act on the answers once">
      Ask threads…
    </Button>
  );
  const askDialog = asking && status && (
    <AskThreads cards={cards} preselected={chosen.map((i) => i.sessionId)} status={status} version={version} onClose={() => setAsking(false)} />
  );
  // The ask dialog always renders in the same place, so switching between these views never resets it.
  const withDialog = (body: React.ReactNode) => (
    <>
      {body}
      {askDialog}
    </>
  );

  if (status?.terminal === 'none') {
    return withDialog(
      <Empty title="Cleanup needs a terminal it can control">
        Thread Desk closes tabs through cmux, tmux or kitty. Without one you can still mark threads done, and ask threads questions.
        <div className="mt-3">{askButton}</div>
      </Empty>,
    );
  }
  if (items.length === 0) {
    return withDialog(
      <Empty title="No tabs to close">
        Tabs show up here when their thread is done, its PRs are merged, its ticket is closed, or it has been idle for {status?.idleHours ?? 24} hours.
        <div className="mt-3">{askButton}</div>
      </Empty>,
    );
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const close = async () => {
    setBusy(true);
    try {
      const { results } = await api.post<{ results: { sessionId: string; ok: boolean; error?: string }[] }>('/cleanup/close', {
        sessionIds: chosen.map((i) => i.sessionId),
        markDone,
      });
      const failed = results.filter((r) => !r.ok);
      actions.toast(
        failed.length ? `Closed ${results.length - failed.length}, ${failed.length} failed: ${failed[0]!.error}` : `Closed ${results.length} tabs`,
        failed.length ? 'error' : 'info',
      );
      setSelected(new Set());
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return withDialog(
    <div className="mx-auto max-w-4xl px-4 pb-10">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="flex-1 text-[13px] text-muted">
          These tabs are safe to close: nothing is running in them. Closed threads stay on the board and resume with their full history.
        </p>
        {askButton}
        <Button onClick={() => setSelected(new Set(items.map((i) => i.sessionId)))}>Select all</Button>
        <select
          aria-label="Set kind for selected"
          className="rounded border border-rule-strong bg-strip pl-2 py-1 text-[13px]"
          value="-"
          disabled={chosen.length === 0}
          onChange={(e) => {
            if (e.target.value !== '-') void setKind(chosen.map((i) => i.sessionId), e.target.value);
          }}
        >
          <option value="-">Set kind for selected…</option>
          {labelNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value="">No label</option>
          <option value="auto">Automatic</option>
        </select>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} />
          Also mark done
        </label>
        <Button tone="primary" disabled={chosen.length === 0 || busy} onClick={() => setConfirming(true)}>
          Close {chosen.length} {chosen.length === 1 ? 'tab' : 'tabs'}
          {chosen.length > 0 && `, free ${bytes(total)}`}
        </Button>
      </div>

      {confirming && (
        <div role="alertdialog" className="mb-3 flex items-center gap-3 rounded border border-danger/50 bg-strip p-3 text-[13px]">
          <span className="flex-1">
            Close {chosen.length} {tabNoun(status?.terminal ?? 'none', chosen.length !== 1)} now? Running processes in them will stop.
          </span>
          <Button tone="quiet" onClick={() => setConfirming(false)}>
            Keep them
          </Button>
          <Button tone="danger" disabled={busy} onClick={() => void close()}>
            {busy ? 'Closing…' : 'Close tabs'}
          </Button>
        </div>
      )}

      <table className="w-full border-separate border-spacing-y-1 text-[13px]">
        <thead className="text-left text-[12px] text-muted">
          <tr>
            <th className="w-8" />
            <th className="font-normal">Thread</th>
            <th className="w-40 font-normal">Kind</th>
            <th className="font-normal">Why</th>
            <th className="text-right font-normal whitespace-nowrap">Memory</th>
            <th className="pr-3 text-right font-normal whitespace-nowrap">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.sessionId} className="bg-strip" onClick={() => toggle(item.sessionId)}>
              <td className="rounded-l px-2 py-2">
                <input
                  type="checkbox"
                  aria-label={`Select ${item.title}`}
                  checked={selected.has(item.sessionId)}
                  onChange={() => toggle(item.sessionId)}
                  onClick={(e) => e.stopPropagation()}
                />
              </td>
              <td className="py-2 pr-4">
                <button type="button" className="text-left text-[14.5px] font-medium hover:underline" onClick={(e) => (e.stopPropagation(), actions.select(item.sessionId))}>
                  {item.title}
                </button>
                {item.note && <div className="text-[12px] text-muted italic">{item.note}</div>}
              </td>
              <td className="py-2 pr-4" onClick={(e) => e.stopPropagation()}>
                <select
                  aria-label={`Kind of ${item.title}`}
                  className={`w-full rounded border bg-strip py-1 pl-2 text-[12.5px] ${item.labelPicked ? 'border-rule-strong font-medium' : 'border-rule text-muted'}`}
                  title={item.labelPicked ? 'You picked this' : 'Picked automatically; choose one to keep it'}
                  value={item.labelPicked ? (item.label ?? '') : 'auto'}
                  onChange={(e) => void setKind([item.sessionId], e.target.value)}
                >
                  <option value="auto">{item.label && !item.labelPicked ? item.label : 'No kind yet'}</option>
                  {labelNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                  <option value="">No label</option>
                </select>
              </td>
              <td className="py-2 text-muted">{item.detail.join(', ')}</td>
              <td className="py-2 text-right whitespace-nowrap tabular-nums">{bytes(item.memoryBytes)}</td>
              <td className="rounded-r py-2 pr-3 text-right whitespace-nowrap text-muted">{ago(item.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
  );
}
