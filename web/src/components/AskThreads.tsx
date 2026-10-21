import { useState } from 'react';
import type { Card, Status } from '../types';
import { AskPicker } from './AskPicker';
import { AskResults } from './AskResults';
import { Modal } from './ui';

export function AskThreads({
  cards,
  preselected,
  status,
  version,
  onClose,
}: {
  cards: Card[];
  preselected: string[];
  status: Status;
  version: number;
  onClose: () => void;
}) {
  const [batchId, setBatchId] = useState<number | null>(null);
  return (
    <Modal title={batchId ? 'Answers' : 'Ask several threads the same question'} onClose={onClose} width="max-w-3xl">
      {batchId === null ? (
        <AskPicker cards={cards} preselected={preselected} status={status} onOpen={setBatchId} />
      ) : (
        <AskResults batchId={batchId} version={version} status={status} />
      )}
    </Modal>
  );
}
