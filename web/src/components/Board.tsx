import { DragDropProvider, KeyboardSensor, PointerSensor, useDroppable } from '@dnd-kit/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useActions } from '../actions';
import { COLUMN_COLOR, COLUMN_HINT, COLUMN_LABEL } from '../format';
import type { Card, Column, Lifecycle } from '../types';
import { Strip } from './Strip';

const LIVE_COLUMNS: Column[] = ['needs_you', 'running', 'idle', 'paused'];
const USER_COLUMNS: Column[] = ['waiting_others', 'done', 'archived'];
const PAGE = 30;

// Enter opens a strip's details, so only Space picks a strip up for keyboard dragging.
const SENSORS = [
  PointerSensor,
  KeyboardSensor.configure({
    keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ['Space'], end: ['Space', 'Tab'] },
  }),
];

function lifecycleForColumn(column: Column): Lifecycle {
  return column === 'waiting_others' || column === 'done' || column === 'archived' ? column : 'active';
}

function Bay({
  column,
  cards,
  arrived,
  now,
  divider,
}: {
  column: Column;
  cards: Card[];
  arrived: Set<string>;
  now: number;
  divider: boolean;
}) {
  const { ref, isDropTarget } = useDroppable({ id: column });
  const [limit, setLimit] = useState(PAGE);
  const shown = cards.slice(0, limit);
  return (
    <section
      ref={ref}
      aria-label={COLUMN_LABEL[column]}
      className={`flex min-w-[188px] max-w-[360px] flex-1 flex-col rounded-md bg-bay ${divider ? 'ml-3' : ''} ${
        isDropTarget ? 'outline-2 outline-offset-[-2px]' : ''
      }`}
      style={isDropTarget ? { outlineColor: COLUMN_COLOR[column], outlineStyle: 'solid' } : undefined}
    >
      <header className="flex items-baseline gap-2 px-3 pt-2.5 pb-1.5" title={COLUMN_HINT[column]}>
        <span className="size-2 translate-y-[-1px] rounded-full" style={{ background: COLUMN_COLOR[column] }} aria-hidden />
        <h2 className="font-cond text-[15px] font-bold">{COLUMN_LABEL[column]}</h2>
        <span className="text-[13px] text-muted tabular-nums">{cards.length}</span>
      </header>
      <div className="scroll-thin flex min-h-24 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
        {cards.length === 0 && <p className="px-1.5 py-3 text-[12.5px] text-muted">{COLUMN_HINT[column]}</p>}
        {shown.map((card) => (
          <Strip key={card.id} card={card} arrived={arrived.has(card.id)} now={now} />
        ))}
        {cards.length > limit && (
          <button type="button" className="rounded py-1.5 text-[12.5px] text-muted hover:bg-strip" onClick={() => setLimit((l) => l + PAGE * 2)}>
            Show {Math.min(PAGE * 2, cards.length - limit)} more
          </button>
        )}
      </div>
    </section>
  );
}

export function BoardView({ cards, showArchived, now }: { cards: Card[]; showArchived: boolean; now: number }) {
  const actions = useActions();
  const previous = useRef(new Map<string, Column>());
  const [arrived, setArrived] = useState<Set<string>>(new Set());

  const byColumn = useMemo(() => {
    const map = new Map<Column, Card[]>();
    for (const card of cards) map.set(card.column, [...(map.get(card.column) ?? []), card]);
    return map;
  }, [cards]);

  useEffect(() => {
    const fresh = new Set<string>();
    const prev = previous.current;
    if (prev.size > 0) {
      for (const card of cards) if (card.column === 'needs_you' && prev.get(card.id) !== 'needs_you') fresh.add(card.id);
    }
    previous.current = new Map(cards.map((c) => [c.id, c.column]));
    if (fresh.size) setArrived(fresh);
  }, [cards]);

  const columns = [...LIVE_COLUMNS, ...USER_COLUMNS.filter((c) => c !== 'archived' || showArchived)];
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  return (
    <DragDropProvider
      sensors={SENSORS}
      onDragEnd={(event) => {
        if (event.canceled) return;
        const source = event.operation.source;
        const target = event.operation.target;
        if (!source || !target) return;
        const card = byId.get(String(source.id));
        if (!card) return;
        const lifecycle = lifecycleForColumn(target.id as Column);
        if (lifecycle !== card.lifecycle) void actions.setLifecycle(card, lifecycle);
      }}
    >
      <div className="scroll-thin flex h-full gap-2 overflow-x-auto px-4 pb-4">
        {columns.map((column) => (
          <Bay
            key={column}
            column={column}
            cards={byColumn.get(column) ?? []}
            arrived={arrived}
            now={now}
            divider={column === 'waiting_others'}
          />
        ))}
      </div>
    </DragDropProvider>
  );
}
