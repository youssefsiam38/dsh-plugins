/**
 * Durable comparison records in the storage domain `model_compare`. The lane
 * index they give is what re-applies the lane tool restriction when a lane
 * session is resumed after a Host restart, so it is written before a lane
 * session exists and never shrinks.
 * @module dsh-model-compare/store
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CompareRecord } from './types.ts'

const lane = z.object({
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  label: z.string(),
}).strict()

/** Validates one stored comparison. */
export const compareRecordSchema = z.object({
  compareId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  prompt: z.string(),
  createdAt: z.number(),
  tools: z.enum(['none', 'read-only', 'all']),
  status: z.enum(['open', 'adopted', 'discarded']),
  lanes: z.array(lane),
  adoptedLane: z.string().optional(),
  continuation: z.string().optional(),
}).strict() as z.ZodType<CompareRecord>

/** Storage domain spec: one record per comparison, keyed by compare id. */
export const compareDomainSpec = defineDomain({
  name: 'model_compare',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    compares: domainTable<string, CompareRecord>(compareRecordSchema),
  },
})
