import { useDraggable } from '@dnd-kit/react';
import { useActions } from '../actions';
import { COLUMN_COLOR, ago, bytes } from '../format';
import type { Card } from '../types';
import { LabelChip, LinkChip } from './ui';

const MAX_CHIPS = 4;

export function Strip({ card, arrived, now }: { card: Card; arrived: boolean; now: number }) {
  const actions = useActions();
  const { ref, isDragging } = useDraggable({ id: card.id, data: { card } });
  const color = COLUMN_COLOR[card.column];
  const chips = card.links.slice(0, MAX_CHIPS);
  const extra = card.links.length - chips.length;
  const showAssistant = card.column === 'needs_you' && card.lastAssistant;

  return (
    <article
      ref={ref}
      tabIndex={0}
      aria-label={card.title}
      onClick={() => actions.select(card.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') actions.select(card.id);
      }}
      className={`group relative cursor-grab rounded-md border border-rule bg-strip py-2.5 pr-3 pl-3.5 hover:border-rule-strong ${
        isDragging ? 'opacity-60' : ''
      } ${arrived ? 'strip-arrive' : ''}`}
    >
      <span className="absolute inset-y-2.5 left-0 w-[3px] rounded-r" style={{ background: color }} aria-hidden />
      <div className="flex items-start gap-2">
        <h3 className="line-clamp-2 flex-1 text-[14.5px] leading-snug font-medium">{card.title}</h3>
        <span className="shrink-0 pt-0.5 text-[12px] text-muted tabular-nums">{ago(card.lastAt, now)}</span>
      </div>

      <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[12px] text-muted">
        {card.label?.name && <LabelChip name={card.label.name} guessed={card.label.source !== 'manual'} />}
        {card.projectName && <span className="shrink-0">{card.projectName}</span>}
        {card.branch && <span className="truncate font-mono text-[11px]">{card.branch}</span>}
      </div>

      {showAssistant && <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug">{card.lastAssistant}</p>}

      {card.note && (
        <p className="mt-1.5 border-l-2 pl-2 text-[12.5px] leading-snug italic" style={{ borderColor: color }}>
          {card.note}
        </p>
      )}

      {card.todos.length > 0 && (
        <p className="mt-1.5 truncate text-[12px] text-muted" title={card.todos.map((t) => t.title).join('\n')}>
          For: <span className="font-medium text-ink">{card.todos[0]!.title}</span>
          {card.todos.length > 1 ? ` +${card.todos.length - 1}` : ''}
        </p>
      )}

      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {chips.map((l) => (
            <LinkChip key={`${l.kind}:${l.key}`} link={l} />
          ))}
          {extra > 0 && <span className="px-1 text-[12px] text-muted">+{extra}</span>}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted">
        {card.tab ? (
          <span title={`cmux ${card.tab.ref}`}>{bytes(card.tab.memoryBytes)}</span>
        ) : (
          !card.transcriptExists && <span title="Claude Code deleted this transcript">transcript expired</span>
        )}
        {card.live && card.lifecycle !== 'active' && (
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: COLUMN_COLOR[card.live] }} />
            {card.live === 'running' ? 'running' : 'open'}
          </span>
        )}
        <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {(card.tab || card.transcriptExists) && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 font-medium text-ink hover:bg-bay"
              onClick={(e) => (e.stopPropagation(), void actions.open(card))}
            >
              {card.tab ? 'Jump' : 'Resume'}
            </button>
          )}
          {card.lifecycle !== 'done' && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 font-medium text-done hover:bg-bay"
              onClick={(e) => (e.stopPropagation(), void actions.setLifecycle(card, 'done'))}
            >
              Done
            </button>
          )}
        </span>
      </div>
    </article>
  );
}
