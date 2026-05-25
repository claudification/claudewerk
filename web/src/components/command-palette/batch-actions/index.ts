import { BROADCAST_ACTION } from './broadcast'
import { INTERRUPT_ACTION } from './interrupt'
import { REASSIGN_ACTION } from './reassign'
import { RECAP_ACTION } from './recap'
import { TERMINATE_ACTION } from './terminate'
import type { BatchAction } from './types'

export type { BatchAction, BatchActionRunResult } from './types'

export const ALL_BATCH_ACTIONS: BatchAction[] = [
  BROADCAST_ACTION,
  RECAP_ACTION,
  INTERRUPT_ACTION,
  TERMINATE_ACTION,
  REASSIGN_ACTION,
]
