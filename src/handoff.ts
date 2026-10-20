import type { Card } from './store.js';

export interface HandoffTarget {
  kind: 'jira' | 'slack';
  key: string;
  label: string;
}

export function handoffTargets(card: Card, jiraEnabled: boolean, slackEnabled: boolean): HandoffTarget[] {
  const targets: HandoffTarget[] = [];
  const links = [...card.links, ...card.mentioned];
  if (jiraEnabled) {
    for (const l of links) if (l.kind === 'ticket' && !targets.some((t) => t.key === l.key)) targets.push({ kind: 'jira', key: l.key, label: l.key });
  }
  if (slackEnabled) {
    for (const l of links) if (l.kind === 'slack') targets.push({ kind: 'slack', key: l.key, label: `Slack ${l.key.split('/')[1] ?? ''}` });
  }
  return targets;
}

export function draftHandoff(card: Card): string {
  const lines: string[] = [];
  lines.push(`Update: ${card.title}`);
  if (card.recap) {
    if (card.recap.done) lines.push(`Done: ${card.recap.done}`);
    if (card.recap.next) lines.push(`Next: ${card.recap.next}`);
    if (card.recap.blocker) lines.push(`Blocker: ${card.recap.blocker}`);
  } else if (card.lastAssistant) {
    lines.push(`Latest: ${card.lastAssistant.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  if (card.note) lines.push(`Note: ${card.note}`);
  const prs = card.links.filter((l) => l.kind === 'pr');
  if (prs.length) lines.push(`PRs: ${prs.map((p) => `${p.url ?? p.key}${p.state ? ` (${p.state.toLowerCase()})` : ''}`).join(', ')}`);
  return lines.join('\n');
}
