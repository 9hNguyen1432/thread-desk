import { createContext, useContext } from 'react';
import type { Card, Lifecycle } from './types';

export interface Actions {
  select(id: string | null): void;
  open(card: Pick<Card, 'id' | 'title'>): Promise<void>;
  setLifecycle(card: Card, lifecycle: Lifecycle): Promise<void>;
  closeTab(card: Pick<Card, 'id' | 'title'>): Promise<void>;
  toast(message: string, tone?: 'info' | 'error'): void;
  filterByLink(key: string): void;
}

export const ActionsContext = createContext<Actions | null>(null);

export function useActions(): Actions {
  const value = useContext(ActionsContext);
  if (!value) throw new Error('ActionsContext missing');
  return value;
}
