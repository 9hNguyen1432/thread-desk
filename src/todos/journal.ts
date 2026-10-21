import { addDays, weekStart, type Day } from './day.js';
import type { TodoService } from './service.js';

export interface CaptureLine {
  todoId: number | null;
  title: string;
  status: 'wip' | 'done' | 'dropped' | 'unplanned';
  reportedDay: Day | null;
  minutes: number;
  projects: string[];
  threads: { id: string; title: string; minutes: number }[];
}

export interface Capture {
  day: Day;
  lines: CaptureLine[];
  totalMinutes: number;
  projects: { name: string; minutes: number }[];
  markdown: string;
  csv: string;
}

export interface WeekSummary {
  start: Day;
  days: { day: Day; totalMinutes: number; done: number; wip: number; unplanned: number }[];
  projects: { name: string; minutes: number }[];
  totalMinutes: number;
  markdown: string;
}

export function formatMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h${String(rest).padStart(2, '0')}` : `${h}h`;
}

function csvCell(value: string | number): string {
  // Spreadsheets run cells starting with these characters as formulas.
  const s = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function longDay(day: Day): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export function captureDay(svc: TodoService, day: Day): Capture {
  const views = svc.view(day);
  const cards = svc.cards();
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const activity = svc.activityOn(day);
  const eventsToday = new Map<number, string[]>();
  for (const e of svc.store.eventsOnDay(day)) eventsToday.set(e.todo_id, [...(eventsToday.get(e.todo_id) ?? []), e.kind]);
  // Threads of todos shown for this day; anything else worked on counts as unplanned.
  const linked = new Set(views.flatMap((v) => v.threads.map((t) => t.id)));

  const lines: CaptureLine[] = [];
  for (const v of views) {
    const worked = v.threads.some((t) => (activity.get(t.id)?.humanMessages ?? 0) > 0) || (eventsToday.get(v.id) ?? []).includes('wip');
    const closedToday = v.closedDay === day && (v.status === 'done' || v.status === 'dropped');
    if (!(worked || (closedToday && v.status === 'done'))) continue;
    const status: CaptureLine['status'] = closedToday ? (v.status as 'done' | 'dropped') : 'wip';
    lines.push({
      todoId: v.id,
      title: v.title,
      status,
      reportedDay: v.reportedDay,
      minutes: v.minutes,
      projects: [...new Set(v.threads.filter((t) => t.minutes > 0 && t.projectName).map((t) => t.projectName!))],
      threads: v.threads.filter((t) => t.minutes > 0).map((t) => ({ id: t.id, title: t.title, minutes: t.minutes })),
    });
  }
  for (const [sessionId, a] of activity) {
    if (linked.has(sessionId) || a.humanMessages === 0) continue;
    const card = cardById.get(sessionId);
    if (!card) continue;
    lines.push({
      todoId: null,
      title: card.title,
      status: 'unplanned',
      reportedDay: null,
      minutes: a.minutes,
      projects: card.projectName ? [card.projectName] : [],
      threads: [{ id: sessionId, title: card.title, minutes: a.minutes }],
    });
  }

  const projectMinutes = new Map<string, number>();
  for (const l of lines) {
    for (const t of l.threads) {
      const name = cardById.get(t.id)?.projectName ?? 'other';
      projectMinutes.set(name, (projectMinutes.get(name) ?? 0) + t.minutes);
    }
  }
  const projects = [...projectMinutes.entries()].map(([name, minutes]) => ({ name, minutes })).sort((a, b) => b.minutes - a.minutes);
  const totalMinutes = lines.reduce((sum, l) => sum + l.minutes, 0);

  const order = { done: 0, wip: 1, dropped: 2, unplanned: 3 } as const;
  lines.sort((a, b) => order[a.status] - order[b.status] || b.minutes - a.minutes);
  const label = { done: 'Done', wip: 'WIP', dropped: 'Dropped', unplanned: 'Unplanned' } as const;
  const md = [`*${longDay(day)}*, ${formatMinutes(totalMinutes)} tracked`, ''];
  for (const l of lines) {
    const reported = l.reportedDay && l.reportedDay !== day ? `, reported ${l.reportedDay}` : '';
    const project = l.projects.length ? ` (${l.projects.join(', ')})` : '';
    md.push(`- [${label[l.status]}] ${l.title}${project}, ${formatMinutes(l.minutes)}${reported}`);
  }
  if (lines.length === 0) md.push('_Nothing tracked for this day._');
  if (projects.length) md.push('', `By project: ${projects.map((p) => `${p.name} ${formatMinutes(p.minutes)}`).join(', ')}`);

  const csv = [
    ['date', 'todo', 'status', 'reported', 'projects', 'minutes', 'threads'].join(','),
    ...lines.map((l) =>
      [day, l.title, l.status, l.reportedDay ?? '', l.projects.join('; '), Math.round(l.minutes), l.threads.map((t) => t.title).join('; ')]
        .map(csvCell)
        .join(','),
    ),
  ].join('\n');

  return { day, lines, totalMinutes, projects, markdown: md.join('\n') + '\n', csv: csv + '\n' };
}

export function weekSummary(svc: TodoService, day: Day): WeekSummary {
  const start = weekStart(day);
  const projectMinutes = new Map<string, number>();
  const days: WeekSummary['days'] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (d > svc.today()) break;
    const c = captureDay(svc, d);
    days.push({
      day: d,
      totalMinutes: c.totalMinutes,
      done: c.lines.filter((l) => l.status === 'done').length,
      wip: c.lines.filter((l) => l.status === 'wip').length,
      unplanned: c.lines.filter((l) => l.status === 'unplanned').length,
    });
    for (const p of c.projects) projectMinutes.set(p.name, (projectMinutes.get(p.name) ?? 0) + p.minutes);
  }
  const projects = [...projectMinutes.entries()].map(([name, minutes]) => ({ name, minutes })).sort((a, b) => b.minutes - a.minutes);
  const totalMinutes = days.reduce((s, d) => s + d.totalMinutes, 0);
  const md = [
    `*Week of ${longDay(start)}*, ${formatMinutes(totalMinutes)} tracked`,
    '',
    ...days.map((d) => `- ${longDay(d.day)}: ${formatMinutes(d.totalMinutes)}, ${d.done} done, ${d.wip} in progress, ${d.unplanned} unplanned`),
    '',
    `By project: ${projects.map((p) => `${p.name} ${formatMinutes(p.minutes)}`).join(', ') || 'none'}`,
  ];
  return { start, days, projects, totalMinutes, markdown: md.join('\n') + '\n' };
}
