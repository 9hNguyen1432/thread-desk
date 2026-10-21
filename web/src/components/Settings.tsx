import { useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import type { Status } from '../types';
import { Button, Modal } from './ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-start gap-3 border-t border-rule py-3 first:border-t-0">
      <span className="pt-1 font-medium">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span style={{ color: ok ? 'var(--st-done)' : 'var(--muted)' }}>{ok ? '●' : '○'}</span>
      <span>{children}</span>
    </li>
  );
}

export function Settings({ status, onClose, onSaved }: { status: Status; onClose: () => void; onSaved: (s: Status) => void }) {
  const actions = useActions();
  const [keys, setKeys] = useState(status.ticketKeys.join(', '));
  const [onDone, setOnDone] = useState(status.onDone);
  const [idleHours, setIdleHours] = useState(status.idleHours);
  const [recap, setRecap] = useState(status.recap.enabled);
  const [jiraSite, setJiraSite] = useState(status.jiraSite);
  const [labelNames, setLabelNames] = useState(status.labels.names.join(', '));
  const [labelsAi, setLabelsAi] = useState(status.labels.ai);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.patch<Status>('/settings', {
        ticketKeys: keys.split(/[\s,]+/).filter(Boolean),
        onDone,
        idleHours,
        recapEnabled: recap,
        jiraSite,
        labelNames: labelNames.split(',').map((n) => n.trim()).filter(Boolean),
        labelsAi,
      });
      onSaved(next);
      actions.toast('Settings saved');
      onClose();
    } catch (e) {
      actions.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addKey = (prefix: string) => setKeys((k) => [...k.split(/[\s,]+/).filter(Boolean), prefix].join(', '));
  const field = 'w-full rounded border border-rule-strong bg-bg px-2.5 py-1.5';

  return (
    <Modal title="Settings" onClose={onClose} width="max-w-2xl">
      <div className="scroll-thin max-h-[65vh] overflow-y-auto pr-1 text-[13px]">
        <Row label="Ticket prefixes">
          <input className={field} value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="ENG, OPS" aria-label="Ticket prefixes" />
          <p className="mt-1 text-muted">Keys like CN-123 in branches, titles and prompts link a thread to its ticket. Changing this re-reads all transcripts.</p>
          {status.ticketKeySuggestions.length > 0 && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-muted">Seen in your prompts:</span>
              {status.ticketKeySuggestions.map((s) => (
                <button key={s.prefix} type="button" className="rounded border border-rule-strong px-1.5 hover:border-ink" onClick={() => addKey(s.prefix)}>
                  {s.prefix} ({s.count})
                </button>
              ))}
            </p>
          )}
        </Row>
        <Row label="Kinds of work">
          <input className={field} value={labelNames} onChange={(e) => setLabelNames(e.target.value)} aria-label="Labels" />
          <p className="mt-1 text-muted">
            Comma-separated. Threads get one automatically from their branch and first prompt (rules live in config.json); pick one in a thread's details to override.
          </p>
          <label className="mt-1.5 flex items-center gap-2">
            <input type="checkbox" checked={labelsAi} onChange={(e) => setLabelsAi(e.target.checked)} />
            Let Claude Haiku label recent threads no rule matches (up to 100 a day)
          </label>
        </Row>
        <Row label="When marked done">
          <select className="rounded border border-rule-strong bg-strip px-2 py-1" value={onDone} onChange={(e) => setOnDone(e.target.value as Status['onDone'])}>
            <option value="ask">Ask whether to close the tab</option>
            <option value="close">Close the tab right away</option>
            <option value="keep">Keep the tab open</option>
          </select>
        </Row>
        <Row label="Idle after">
          <label className="flex items-center gap-2">
            <input type="number" min={0} className="w-20 rounded border border-rule-strong bg-bg px-2 py-1" value={idleHours} onChange={(e) => setIdleHours(Number(e.target.value))} />
            hours without activity, suggest closing the tab (0 turns this off)
          </label>
        </Row>
        <Row label="AI summaries">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={recap} onChange={(e) => setRecap(e.target.checked)} />
            Summarize recently active threads with Claude Haiku
          </label>
          <p className="mt-1 text-muted">
            Runs <code>claude -p</code> with your own login, no tools, no hooks and no saved session. About $0.001 per summary, at most 60 a day. {status.recap.remainingToday} left today.
          </p>
        </Row>
        <Row label="Jira site">
          <input className={field} value={jiraSite} onChange={(e) => setJiraSite(e.target.value)} placeholder="yourteam.atlassian.net" aria-label="Jira site" />
          <p className="mt-1 text-muted">Credentials come from THREAD_DESK_JIRA_EMAIL and THREAD_DESK_JIRA_TOKEN; they are never written to disk.</p>
        </Row>
        <Row label="Connections">
          <ul className="flex flex-col gap-1">
            <Check ok={status.terminal === 'cmux'}>{status.terminal === 'cmux' ? 'cmux: tabs, memory, jump and close' : 'cmux not found: resume by copying a command'}</Check>
            <Check ok={status.integrations.github}>GitHub via gh CLI {status.integrations.github ? '' : '(run gh auth login)'}</Check>
            <Check ok={status.integrations.jira}>Jira</Check>
            <Check ok={status.integrations.linear}>Linear (THREAD_DESK_LINEAR_KEY)</Check>
            <Check ok={status.integrations.slack}>Slack (THREAD_DESK_SLACK_TOKEN)</Check>
            <Check ok={status.hooksInstalled}>
              Live hooks {status.hooksInstalled ? 'installed' : <>off. Run <code>thread-desk hooks install</code> for instant updates</>}
            </Check>
          </ul>
        </Row>
        <Row label="History">
          <p>
            Claude Code deletes transcripts after {status.retentionDays} days. Older threads stay searchable here but cannot be resumed. Set{' '}
            <code>cleanupPeriodDays</code> in ~/.claude/settings.json to keep them longer.
          </p>
          <Button className="mt-2" onClick={() => void api.post('/reindex').then(() => actions.toast('Re-reading transcripts'))}>
            Re-read all transcripts
          </Button>
        </Row>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button tone="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </Modal>
  );
}
