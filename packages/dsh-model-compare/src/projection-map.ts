/**
 * Declaration merge of the `model-compare` session projection, shared by the
 * Host and browser programs.
 * @module dsh-model-compare/projection-map
 */

import type { LaneStatsState } from './stats.ts'
import type { LaneStatsView } from './types.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Statistics fold of a comparison lane's first own turn (`dsh-model-compare`). */
    'model-compare': LaneStatsState
  }
  interface SessionProjectionMap {
    /** Statistics of a comparison lane's first own turn (`dsh-model-compare`). */
    'model-compare': LaneStatsView
  }
}
