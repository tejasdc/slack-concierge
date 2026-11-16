export const CHECKPOINT_CUSTODY = 'private-fixed-sql' as const;

/** This certifies the private fixed-SQL connection's native close, not a full OS thread join. */
export type CheckpointClosed = {
  kind: 'ledger-closed'; workerId: string; retirementId: number | null;
  pendingStatements: 0; inTransaction: false; finalized: number;
  nativeClosed: true; custody: typeof CHECKPOINT_CUSTODY;
};

export function checkpointCloseCertificate(value: any, workerId: string, retirementId?: number): value is CheckpointClosed {
  return value?.kind === 'ledger-closed' && value.workerId === workerId
    && (value.retirementId === null || value.retirementId === retirementId)
    && value.pendingStatements === 0 && value.inTransaction === false
    && value.nativeClosed === true && value.custody === CHECKPOINT_CUSTODY
    && Number.isSafeInteger(value.finalized) && value.finalized >= 0;
}
