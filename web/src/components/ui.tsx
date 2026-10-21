import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { labelColor, prLabel } from '../format';
import type { LinkView } from '../types';

type Tone = 'default' | 'primary' | 'quiet' | 'danger';

const TONES: Record<Tone, string> = {
  default: 'border border-rule-strong bg-strip text-ink hover:border-ink',
  primary: 'border border-transparent bg-ink text-bg hover:opacity-90',
  quiet: 'border border-transparent text-muted hover:text-ink hover:bg-bay',
  danger: 'border border-transparent bg-danger text-white hover:opacity-90',
};

export function Button({ tone = 'default', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[13px] font-medium whitespace-nowrap transition-colors ${TONES[tone]} ${className}`}
      {...props}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-lg',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${width} rounded-md border border-rule-strong bg-strip p-5 shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 font-cond text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<LinkView['kind'], string> = {
  pr: 'PR',
  issue: 'Issue',
  ticket: '',
  slack: 'Slack',
  figma: 'Figma',
};

function stateColor(link: LinkView): string | null {
  if (link.kind === 'pr') {
    if (link.state === 'MERGED') return 'var(--st-waiting)';
    if (link.state === 'CLOSED') return 'var(--danger)';
    if (link.state === 'OPEN') return 'var(--st-done)';
  }
  if (link.category === 'done') return 'var(--st-done)';
  if (link.category === 'in_progress') return 'var(--st-running)';
  return null;
}

export function linkText(link: LinkView): string {
  if (link.kind === 'pr' || link.kind === 'issue') return prLabel(link.key);
  if (link.kind === 'slack') return link.key.split('/')[1] ?? 'thread';
  if (link.kind === 'figma') return link.title ?? 'file';
  return link.key;
}

export function LinkChip({ link, onClick }: { link: LinkView; onClick?: (link: LinkView) => void }) {
  const color = stateColor(link);
  const label = KIND_LABEL[link.kind];
  const title = [link.title, link.state, link.url].filter(Boolean).join('\n');
  const content = (
    <>
      {color && <span className="size-1.5 rounded-full" style={{ background: color }} />}
      {label && <span className="text-muted">{label}</span>}
      <span className="font-medium">{linkText(link)}</span>
    </>
  );
  const cls =
    'inline-flex max-w-full items-center gap-1 truncate rounded-sm border border-rule bg-bg/60 px-1.5 py-px text-[12px] leading-5 hover:border-rule-strong';
  if (onClick) {
    return (
      <button type="button" className={cls} title={title} onClick={(e) => (e.stopPropagation(), onClick(link))}>
        {content}
      </button>
    );
  }
  return link.url ? (
    <a className={cls} href={link.url} target="_blank" rel="noreferrer" title={title} onClick={(e) => e.stopPropagation()}>
      {content}
    </a>
  ) : (
    <span className={cls} title={title}>
      {content}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-rule-strong px-1 font-sans text-[11px] text-muted">{children}</kbd>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="font-cond text-lg font-semibold">{title}</p>
      {children && <div className="mt-2 text-muted">{children}</div>}
    </div>
  );
}

export function LabelChip({ name, guessed }: { name: string; guessed?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm border border-rule px-1.5 text-[11.5px] leading-[18px] font-medium"
      title={guessed ? 'Guessed from the thread; pick one in the details to change it' : undefined}
    >
      <span className="size-1.5 rounded-full" style={{ background: labelColor(name) }} />
      {name}
    </span>
  );
}
