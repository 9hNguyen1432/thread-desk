import { useEffect, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { ago } from '../format';
import type { Card } from '../types';
import { Empty, Kbd, LinkChip } from './ui';

export function Inbox({ version }: { version: number }) {
  const actions = useActions();
  const [cards, setCards] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    void api.get<{ cards: Card[] }>('/inbox').then((r) => setCards(r.cards));
  }, [version]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, cards.length - 1)));
  }, [cards.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], aside') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter' && target.closest('button, a')) return;
      const card = cards[index];
      if (e.key === 'j' || e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, cards.length - 1));
      else if (e.key === 'k' || e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
      else if (!card) return;
      else if (e.key === 'Enter') void actions.open(card);
      else if (e.key === 'd') void actions.setLifecycle(card, 'done');
      else if (e.key === 'n') actions.select(card.id);
      else if (e.key === 'x') {
        void api.post(`/sessions/${card.id}/snooze`, { minutes: 60 }).then(() => actions.toast('Snoozed for an hour'));
        setCards((list) => list.filter((c) => c.id !== card.id));
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards, index, actions]);

  useEffect(() => {
    document.getElementById(`inbox-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (cards.length === 0) {
    return <Empty title="Nothing is waiting on you">When Claude finishes or asks a question in any thread, it shows up here.</Empty>;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-10">
      <p className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <span>
          <Kbd>j</Kbd> <Kbd>k</Kbd> move
        </span>
        <span>
          <Kbd>Enter</Kbd> jump to tab
        </span>
        <span>
          <Kbd>d</Kbd> done
        </span>
        <span>
          <Kbd>n</Kbd> details and note
        </span>
        <span>
          <Kbd>x</Kbd> snooze 1h
        </span>
      </p>
      <ol className="flex flex-col gap-2">
        {cards.map((card, i) => (
          <li
            key={card.id}
            id={`inbox-${i}`}
            onClick={() => setIndex(i)}
            onDoubleClick={() => void actions.open(card)}
            className={`relative rounded border bg-strip py-3 pr-4 pl-5 ${i === index ? 'border-ink' : 'border-rule'}`}
          >
            <span className="absolute inset-y-0 left-0 w-[5px] rounded-l bg-needs" aria-hidden />
            <div className="flex items-baseline gap-3">
              <h3 className="flex-1 font-cond text-[16px] font-semibold">{card.title}</h3>
              <span className="text-[12px] text-muted">waiting {ago(card.lastAssistantAt ?? card.lastAt)}</span>
            </div>
            <div className="text-[12px] text-muted">
              {card.projectName}
              {card.branch ? ` on ${card.branch}` : ''}
            </div>
            {card.agent?.waitingFor && <p className="mt-1 text-[13px] font-medium">Waiting for {card.agent.waitingFor}</p>}
            {card.lastAssistant && <p className="mt-1.5 line-clamp-4 text-[13.5px] leading-relaxed whitespace-pre-wrap">{card.lastAssistant}</p>}
            {card.links.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {card.links.slice(0, 5).map((l) => (
                  <LinkChip key={`${l.kind}:${l.key}`} link={l} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
