import type { OpenOptions, Tab, TerminalAdapter } from './types.js';

/** Used when no supported terminal is available: no tabs, resume by copying the command. */
export class NoneAdapter implements TerminalAdapter {
  readonly name = 'none' as const;

  async listTabs(): Promise<Tab[]> {
    return [];
  }

  async sessionIdForTab(): Promise<string | null> {
    return null;
  }

  async focus(): Promise<void> {
    throw new Error('No terminal integration available');
  }

  async close(): Promise<void> {
    throw new Error('No terminal integration available');
  }

  async open(_opts: OpenOptions): Promise<void> {
    throw new Error('No terminal integration available');
  }

  async setBadge(): Promise<void> {}
}
