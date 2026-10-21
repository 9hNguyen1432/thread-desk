export type Lifecycle = 'active' | 'waiting_others' | 'done' | 'archived';
export type LiveStatus = 'running' | 'needs_you' | 'idle';
export type Column = LiveStatus | 'paused' | 'waiting_others' | 'done' | 'archived';
export type LinkKind = 'pr' | 'issue' | 'ticket' | 'slack' | 'figma';

export interface LinkView {
  kind: LinkKind;
  key: string;
  url: string | null;
  mentions: number;
  source: string;
  state: string | null;
  category: string | null;
  title: string | null;
}

export interface Recap {
  goal: string;
  done: string;
  next: string;
  blocker: string;
}

export interface TabInfo {
  ref: string;
  windowRef: string;
  title: string;
  memoryBytes: number;
}

export interface Card {
  id: string;
  title: string;
  cwd: string | null;
  project: string | null;
  projectName: string | null;
  branch: string | null;
  firstAt: number | null;
  lastAt: number | null;
  lastHumanAt: number | null;
  lastAssistantAt: number | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastAssistant: string | null;
  humanCount: number;
  messageCount: number;
  lifecycle: Lifecycle;
  note: string | null;
  doneAt: number | null;
  snoozedUntil: number | null;
  column: Column;
  live: LiveStatus | null;
  agent: { kind: string; pid: number | null; status: string | null; state: string | null; waitingFor: string | null } | null;
  tab: TabInfo | null;
  closeBlock: string | null;
  todos: { id: number; title: string }[];
  label: { name: string; source: 'rule' | 'manual' | 'ai' } | null;
  links: LinkView[];
  mentioned: LinkView[];
  primaryTicket: string | null;
  recap: Recap | null;
  recapAt: number | null;
  transcriptExists: boolean;
  continuedIn: string | null;
  claudeVersion: string | null;
}

export interface Board {
  cards: Card[];
  totals: { tabs: number; memoryBytes: number; live: number };
  at: number;
}

export interface Status {
  terminal: 'cmux' | 'none';
  integrations: { github: boolean; jira: boolean; linear: boolean; slack: boolean };
  hooksInstalled: boolean;
  indexing: { running: boolean; done: number; total: number };
  indexErrors: number;
  liveErrors: string[];
  retentionDays: number;
  ticketKeys: string[];
  ticketKeySuggestions: { prefix: string; count: number }[];
  onDone: 'ask' | 'close' | 'keep';
  idleHours: number;
  recap: { enabled: boolean; remainingToday: number };
  jiraSite: string;
  labels: { names: string[]; ai: boolean };
  ask: { model: string; templates: { name: string; prompt: string }[] };
  projects: { project: string; name: string; count: number }[];
}

export interface SearchResult {
  card: Card;
  matchedBy: 'link' | 'title' | 'text';
  snippet: string | null;
}

export interface CleanupSuggestion {
  sessionId: string;
  title: string;
  ref: string;
  memoryBytes: number;
  lastAt: number | null;
  note: string | null;
  reasons: string[];
  detail: string[];
  label: string | null;
}

export interface TicketGroup {
  key: string;
  title: string | null;
  state: string | null;
  category: string | null;
  url: string | null;
  lastAt: number;
  threads: { id: string; title: string; column: Column; lifecycle: Lifecycle; lastAt: number | null }[];
  prs: { key: string; url: string | null; state: string | null }[];
  slack: { key: string; url: string | null; state: string | null }[];
  figma: { key: string; url: string | null; state: string | null }[];
}

export interface Digest {
  from: number;
  to: number;
  markdown: string;
  done: Card[];
  active: Card[];
  waiting: Card[];
  prs: { key: string; url: string | null; state: string | null; title: string | null; sessionTitle: string }[];
  tickets: string[];
}

export interface StartDraft {
  key: string | null;
  title: string;
  url: string | null;
  description: string;
  branch: string;
  prompt: string;
  warnings: string[];
}

export interface OpenResult {
  action: 'focused' | 'opened' | 'copy';
  command: string;
  sessionId: string;
}

export interface Message {
  role: string;
  ts: number | null;
  text: string;
}

export type TodoStatus = 'todo' | 'wip' | 'done' | 'dropped';

export interface TodoThread {
  id: string;
  title: string;
  column: Column;
  lifecycle: Lifecycle;
  projectName: string | null;
  origin: 'auto' | 'accepted' | 'manual' | 'started';
  minutes: number;
  label: string | null;
}

export interface TodoView {
  id: number;
  title: string;
  notes: string | null;
  status: TodoStatus;
  reportedDay: string;
  closedDay: string | null;
  carriedDays: number;
  keys: { kind: LinkKind; key: string; url: string | null }[];
  threads: TodoThread[];
  minutes: number;
  suggestions: { sessionId: string; title: string; projectName: string | null; reason: string }[];
  doneHint: string | null;
}

export interface TodosResponse {
  day: string;
  today: string;
  todos: TodoView[];
}

export interface CaptureLine {
  todoId: number | null;
  title: string;
  status: 'wip' | 'done' | 'dropped' | 'unplanned';
  reportedDay: string | null;
  minutes: number;
  projects: string[];
  threads: { id: string; title: string; minutes: number }[];
}

export interface Capture {
  day: string;
  lines: CaptureLine[];
  totalMinutes: number;
  projects: { name: string; minutes: number }[];
  markdown: string;
  csv: string;
}

export interface WeekSummary {
  start: string;
  days: { day: string; totalMinutes: number; done: number; wip: number; unplanned: number }[];
  projects: { name: string; minutes: number }[];
  totalMinutes: number;
  markdown: string;
}
