import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { useActions } from '../actions';
import { api } from '../api';
import { COLUMN_COLOR, COLUMN_LABEL, ago } from '../format';
import type { SearchResult } from '../types';
import { Kbd } from './ui';

const MATCH_LABEL: Record<SearchResult['matchedBy'], string> = {
  link: 'linked',
  title: 'title',
  text: 'conversation',
};

export function Palette({ initial, onClose }: { initial: string; onClose: () => void }) {
  const actions = useActions();
  const [query, setQuery] = useState(initial);
  const [hits, setHits] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    setLoading(true);
    let current = true;
    const timer = setTimeout(() => {
      api
        .get<{ hits: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => current && setHits(r.hits))
        .catch((e: Error) => current && actions.toast(e.message, 'error'))
        .finally(() => current && setLoading(false));
    }, 140);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, actions]);

  return (
    <Command.Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      label="Find a thread"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-40 bg-black/30"
      contentClassName="fixed top-[10vh] left-1/2 z-50 w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-md border border-rule-strong bg-strip shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          const selected = document.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
          const id = selected?.dataset.id;
          if (id) {
            e.preventDefault();
            actions.select(id);
            onClose();
          }
        }
      }}
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Ticket key, PR or Slack link, or any words from the conversation"
        className="w-full border-b border-rule bg-transparent px-4 py-3 text-[15px] outline-none"
      />
      <Command.List className="scroll-thin max-h-[60vh] overflow-y-auto p-1.5">
        {query.trim() && !loading && <Command.Empty className="px-3 py-6 text-center text-muted">No thread matches “{query.trim()}”.</Command.Empty>}
        {!query.trim() && (
          <p className="px-3 py-4 text-[13px] text-muted">
            Try <span className="font-medium text-ink">ENG-1442</span>, a GitHub PR URL, a Slack permalink, or words like “reschedule bug”.
            Add <span className="font-medium text-ink">project:api</span> or <span className="font-medium text-ink">is:done</span> to narrow it.
          </p>
        )}
        {hits.map((h) => (
          <Command.Item
            key={h.card.id}
            value={h.card.id}
            data-id={h.card.id}
            onSelect={() => {
              onClose();
              void actions.open(h.card);
            }}
            className="cursor-pointer rounded px-3 py-2"
          >
            <div className="flex items-baseline gap-2">
              <span className="size-2 shrink-0 rounded-full" style={{ background: COLUMN_COLOR[h.card.column] }} title={COLUMN_LABEL[h.card.column]} />
              <span className="flex-1 truncate font-cond text-[15px] font-semibold">{h.card.title}</span>
              <span className="shrink-0 text-[12px] text-muted">
                {MATCH_LABEL[h.matchedBy]} {ago(h.card.lastAt)}
              </span>
            </div>
            <div className="mt-0.5 truncate pl-4 text-[12px] text-muted">
              {h.card.projectName}
              {h.card.branch ? ` on ${h.card.branch}` : ''}
              {h.card.primaryTicket ? `, ${h.card.primaryTicket}` : ''}
            </div>
            {h.snippet && <p className="mt-1 line-clamp-2 pl-4 text-[12.5px]">{h.snippet}</p>}
          </Command.Item>
        ))}
      </Command.List>
      <footer className="flex gap-4 border-t border-rule px-4 py-2 text-[12px] text-muted">
        <span>
          <Kbd>Enter</Kbd> jump or resume
        </span>
        <span>
          <Kbd>⌘ Enter</Kbd> show details
        </span>
        <span>
          <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </Command.Dialog>
  );
}
