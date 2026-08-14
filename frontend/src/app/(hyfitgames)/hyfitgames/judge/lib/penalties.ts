export const penaltyFields = [
  'station1penalty',
  'station2penalty',
  'station3penalty',
  'station4penalty',
  'station5penalty',
  'station6penalty',
  'cognitiveskillpenalty',
] as const;

export type PenaltyField = (typeof penaltyFields)[number];
export type PenaltySaveStatus = 'draft' | 'pending' | 'saved' | 'failed';

export type PenaltyOperation = {
  operationId: string;
  bib: string;
  fieldName: PenaltyField;
  value: number;
  createdAt: string;
  attemptCount: number;
  lastError?: string;
};

export type PenaltyFieldState = {
  value: number;
  status: PenaltySaveStatus;
  savedAt?: string;
};

export function stationPenaltyField(stationIndex: number): PenaltyField {
  if (!Number.isInteger(stationIndex) || stationIndex < 0 || stationIndex > 5) {
    throw new Error('Station index must be between 0 and 5');
  }
  return `station${stationIndex + 1}penalty` as PenaltyField;
}

export function isPenaltyField(value: unknown): value is PenaltyField {
  return typeof value === 'string' && penaltyFields.includes(value as PenaltyField);
}

export function isNumericBib(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

export function isPenaltyValue(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3600;
}

export function upsertPenaltyOperation(
  operations: PenaltyOperation[],
  operation: PenaltyOperation,
) {
  return [
    ...operations.filter(
      (existing) => !(existing.bib === operation.bib && existing.fieldName === operation.fieldName),
    ),
    operation,
  ];
}
