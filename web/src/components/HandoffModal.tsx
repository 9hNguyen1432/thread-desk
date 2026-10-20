import { useEffect, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import type { Card } from '../types';
import { Button, Modal } from './ui';

export function HandoffModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const actions = useActions();
  const [targets, setTargets] = useState<{ kind: string; key: string; label: string }[]>([]);
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ draft: string; targets: { kind: string; key: string; label: string }[] }>(`/sessions/${card.id}/handoff`).then((r) => {
      setText(r.draft);
      setTargets(r.targets);
      setTarget(r.targets[0] ? `${r.targets[0].kind}|${r.targets[0].key}` : '');
    });
  }, [card.id]);

  const post = async () => {
    const [kind, key] = target.split('|');
    setBusy(true);
    try {
      await api.post(`/sessions/${card.id}/handoff`, { target: { kind, key }, text });
      actions.toast(`Posted to ${key}`);
      onClose();
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Post an update" onClose={onClose} width="max-w-xl">
      <textarea
        className="h-48 w-full rounded border border-rule-strong bg-bg p-2 text-[13px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Update text"
      />
      {targets.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">
          No place to post to. Link a Jira ticket or Slack thread to this thread, and set THREAD_DESK_JIRA_* or THREAD_DESK_SLACK_TOKEN.
          You can still copy the text.
        </p>
      ) : (
        <label className="mt-3 flex items-center gap-2 text-[13px]">
          Post to
          <select className="rounded border border-rule-strong bg-strip px-2 py-1" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={`${t.kind}|${t.key}`} value={`${t.kind}|${t.key}`}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={() => void navigator.clipboard.writeText(text).then(() => actions.toast('Copied'))}>
          Copy text
        </Button>
        <Button tone="primary" disabled={!target || busy || !text.trim()} onClick={() => void post()}>
          {busy ? 'Posting…' : 'Post update'}
        </Button>
      </div>
    </Modal>
  );
}
