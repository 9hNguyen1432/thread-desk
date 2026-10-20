import type { Config } from './config.js';
import type { Card } from './store.js';

export type CleanupReason = 'marked_done' | 'pr_closed' | 'ticket_done' | 'idle';

export interface CleanupSuggestion {
  sessionId: string;
  title: string;
  ref: string;
  memoryBytes: number;
  lastAt: number | null;
  note: string | null;
  reasons: CleanupReason[];
  detail: string[];
}

/** A tab is only suggested when closing it cannot interrupt work in progress. */
export function suggestCleanup(cards: Card[], cfg: Config['cleanup'], now: number): CleanupSuggestion[] {
  const out: CleanupSuggestion[] = [];
  for (const card of cards) {
    if (!card.tab || card.closeBlock) continue;

    const reasons: CleanupReason[] = [];
    const detail: string[] = [];

    if (cfg.markedDone && (card.lifecycle === 'done' || card.lifecycle === 'archived')) {
      reasons.push('marked_done');
      detail.push(card.lifecycle === 'done' ? 'Marked done' : 'Archived');
    }

    const createdPrs = card.links.filter((l) => l.kind === 'pr' && l.source === 'pr-link');
    if (cfg.prClosed && createdPrs.length > 0 && createdPrs.every((p) => p.category === 'done')) {
      reasons.push('pr_closed');
      detail.push(createdPrs.map((p) => `${p.key} ${p.state?.toLowerCase() ?? 'closed'}`).join(', '));
    }

    if (cfg.ticketDone && card.primaryTicket) {
      const ticket = card.links.find((l) => l.kind === 'ticket' && l.key === card.primaryTicket);
      if (ticket?.category === 'done') {
        reasons.push('ticket_done');
        detail.push(`${ticket.key} ${ticket.state ?? 'done'}`);
      }
    }

    const last = card.lastAt ?? 0;
    const idleHours = (now - last) / 3_600_000;
    if (cfg.idleHours > 0 && idleHours >= cfg.idleHours) {
      reasons.push('idle');
      detail.push(`Idle ${idleHours >= 48 ? `${Math.floor(idleHours / 24)}d` : `${Math.floor(idleHours)}h`}`);
    }

    if (reasons.length === 0) continue;
    out.push({
      sessionId: card.id,
      title: card.title,
      ref: card.tab.ref,
      memoryBytes: card.tab.memoryBytes,
      lastAt: card.lastAt,
      note: card.note,
      reasons,
      detail,
    });
  }
  return out.sort((a, b) => b.memoryBytes - a.memoryBytes);
}
