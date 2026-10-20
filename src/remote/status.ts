import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { LinkKind } from '../links.js';
import { ghAvailable, githubIssue, githubPr, jiraCreds, jiraIssue, linearIssue, linearKey, type RemoteItem } from './trackers.js';

export interface RemoteRef {
  kind: LinkKind;
  key: string;
  url: string | null;
}

export interface Integrations {
  github: boolean;
  jira: boolean;
  linear: boolean;
  slack: boolean;
}

const TTL_MS: Partial<Record<LinkKind, number>> = { pr: 10 * 60_000, issue: 15 * 60_000, ticket: 15 * 60_000 };
const CONCURRENCY = 4;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export class RemoteStatus {
  private gh: boolean | null = null;
  private inflight = new Set<string>();
  readonly errors = new Map<string, { message: string; at: number; attempts: number }>();

  constructor(
    private readonly db: DB,
    private config: Config,
    private readonly onChange: () => void,
  ) {}

  setConfig(config: Config): void {
    this.config = config;
  }

  async integrations(): Promise<Integrations> {
    this.gh ??= await ghAvailable();
    return {
      github: this.gh,
      jira: jiraCreds(this.config.trackers.jira.site) !== null,
      linear: linearKey() !== null,
      slack: Boolean(process.env.THREAD_DESK_SLACK_TOKEN),
    };
  }

  trackerFor(key: string): 'jira' | 'linear' | null {
    const prefix = key.split('-')[0]!.toUpperCase();
    const linearKeys = this.config.trackers.linear.keys.map((k) => k.toUpperCase());
    if (linearKey() && linearKeys.includes(prefix)) return 'linear';
    const jiraKeys = this.config.trackers.jira.keys.map((k) => k.toUpperCase());
    if (jiraCreds(this.config.trackers.jira.site) && (jiraKeys.length === 0 || jiraKeys.includes(prefix))) return 'jira';
    if (linearKey() && linearKeys.length === 0) return 'linear';
    return null;
  }

  async fetchItem(ref: RemoteRef): Promise<RemoteItem | null> {
    const integrations = await this.integrations();
    switch (ref.kind) {
      case 'pr':
        return integrations.github && ref.url ? githubPr(ref.url) : null;
      case 'issue':
        return integrations.github && ref.url ? githubIssue(ref.url) : null;
      case 'ticket': {
        const tracker = this.trackerFor(ref.key);
        if (tracker === 'jira') return jiraIssue(jiraCreds(this.config.trackers.jira.site)!, ref.key);
        if (tracker === 'linear') return linearIssue(linearKey()!, ref.key);
        return null;
      }
      default:
        return null;
    }
  }

  private isFresh(ref: RemoteRef): boolean {
    const ttl = TTL_MS[ref.kind];
    if (!ttl) return true;
    const failure = this.errors.get(`${ref.kind}:${ref.key}`);
    if (failure && Date.now() - failure.at < BACKOFF_MS[Math.min(failure.attempts, BACKOFF_MS.length) - 1]!) return true;
    const row = this.db.prepare('select fetched_at from remote_status where kind = ? and key = ?').get(ref.kind, ref.key) as
      | { fetched_at: number }
      | undefined;
    return row !== undefined && Date.now() - row.fetched_at < ttl;
  }

  /** Fetches stale statuses in the background; callers read results from `remote_status`. */
  async refresh(refs: RemoteRef[], force = false): Promise<void> {
    const todo = refs.filter((r) => TTL_MS[r.kind] && !this.inflight.has(`${r.kind}:${r.key}`) && (force || !this.isFresh(r)));
    const unique = [...new Map(todo.map((r) => [`${r.kind}:${r.key}`, r])).values()];
    if (unique.length === 0) return;
    for (const r of unique) this.inflight.add(`${r.kind}:${r.key}`);
    const save = this.db.prepare(`
      insert into remote_status (kind, key, state, category, title, url, fetched_at) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(kind, key) do update set state = excluded.state, category = excluded.category, title = excluded.title,
        url = coalesce(excluded.url, remote_status.url), fetched_at = excluded.fetched_at`);
    let changed = false;
    const queue = [...unique];
    const worker = async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        const id = `${ref.kind}:${ref.key}`;
        try {
          const item = await this.fetchItem(ref);
          if (item) {
            save.run(ref.kind, ref.key, item.state, item.category, item.title, item.url, Date.now());
            this.errors.delete(id);
            changed = true;
          }
        } catch (e) {
          const attempts = (this.errors.get(id)?.attempts ?? 0) + 1;
          this.errors.set(id, { message: (e as Error).message, at: Date.now(), attempts });
        } finally {
          this.inflight.delete(id);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (changed) this.onChange();
  }
}
