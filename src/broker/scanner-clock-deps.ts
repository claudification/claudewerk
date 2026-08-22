/**
 * WIRING THE TWO CLOCKED SCANNERS TO THE REAL BROKER SEAMS.
 *
 * `refine` and `work-order` are written against injected effects and nothing
 * else -- a board reader, the conversation registry, a clock, a logger and a
 * dispatch -- which is the property that makes every branch of them testable
 * without a broker, a sentinel or a CC process. This module is the one place
 * those effects become the real ones, kept apart from `scanner-clock.ts` for the
 * same reason `scheduled-tasks/wiring.ts` is kept apart from its engine: the
 * clock stays about cadence, this stays about plumbing.
 *
 * THE DRAIN IS WIRED HERE TOO, and it is the one thing in this file that WRITES.
 * `buildRefineDrain` is plumbing by the same definition as the builders beside it
 * -- the rule lives in `tag-clear.ts`, the evidence in `refine-drain.ts`, and the
 * cadence stays with the clock. What lands here is which board door and which tag.
 *
 * IT WIRES NO GATE AND NO STAMP. Both are the CLOCK's, not a dep's -- see
 * `scanner-gate.ts`. By the time either builder below is called the project has
 * already passed the opt-in, which is what "skipped before any token is spent"
 * means: an opted-out project never reaches this file, so it never costs a board
 * RPC either.
 */

import { NEEDS_REFINE_TAG } from '../shared/epic-ready'
import { WORK_ORDER_CONCURRENCY } from '../shared/scanner-contracts'
import type { SpawnCallerContext } from '../shared/spawn-permissions'
import { listBoardCards } from './board-cards'
import { callBoard } from './board-rpc'
import type { ConversationStore } from './conversation-store'
import { getGlobalSettings } from './global-settings'
import { getProjectSettings } from './project-settings'
import { drainRefineTag } from './refine-drain'
import { DEFAULT_REFINE_CONCURRENCY, type RefineDeps } from './scanners/refine-scanner'
import type { WorkOrderDeps } from './scanners/work-order-scanner'
import { dispatchSpawn, type SpawnDispatchDeps } from './spawn-dispatch'
import { clearCardTag } from './tag-clear'
import { werkLiveness } from './werk-liveness'

/**
 * THE SCANNER FABRIC'S IDENTITY AT THE PERMISSION GATE.
 *
 * BENEVOLENT, and it is a hard requirement rather than a preference: every WERK
 * order declares `minTrust: 'benevolent'` (`epic-orders.ts` says why -- it fell
 * out of the seats naming `bypassPermissions`, and the field now states it), and
 * `evaluateSpawnPermission` refuses below it. At `trusted` the honest declaration
 * would 403 and both scanners would dispatch nothing at all, forever, while
 * looking healthy.
 *
 * WHAT MAKES THAT LEGITIMATE HERE is the opt-in and only the opt-in. This is the
 * broker spawning into a project because a human ticked that project's box for
 * this specific scanner, having read the contract card that names the seat, the
 * tag and the cost. Default-deny is what turns a standing loop into a delegated
 * authority; without it, benevolent trust on a clock would be the broker granting
 * itself the run.
 *
 * SEPARATE FROM THE EPIC SWEEP'S `EPIC_CALLER` on purpose, though the four fields
 * are identical today. That one is authorised by a human pressing RUN on a
 * specific epic; this one by a checkbox on a project. Two different authorisations
 * that happen to agree is not one authorisation, and folding them together is how
 * a future narrowing of one silently narrows the other.
 */
const SCANNER_CALLER: SpawnCallerContext = {
  kind: 'mcp',
  hasSpawnPermission: true,
  trustLevel: 'benevolent',
  callerProject: null,
}

/** The registry reads both scanners need. Structural, so a test hands over a
 *  plain object rather than a whole `ConversationStore`. */
interface ScanStore {
  getAllConversations: ConversationStore['getAllConversations']
  getActiveConversationCount: (id: string) => number
  hasAnyTranscript: (id: string) => boolean
}

/** Everything `dispatchSpawn` needs, for a seat nobody is awake to approve. */
function spawnDeps(store: ConversationStore): SpawnDispatchDeps {
  return {
    conversationStore: store,
    getProjectSettings,
    getGlobalSettings,
    callerContext: SCANNER_CALLER,
    rendezvousCallerConversationId: null,
    // An unattended sweep must never stall on a human approval dialog -- the
    // same reasoning, and the same flag, as every scheduled fire and every epic
    // beat. Hard rejects are not bypassable either way.
    bypassApprovalGate: true,
  }
}

/**
 * The four effects every scanner takes, from the real store.
 *
 * `producedOutput` is durable-first (`hasAnyTranscript`) for the reason the epic
 * sweep gives at length: a dead seat that never wrote a transcript entry did not
 * finish, it never started, and folding the two together cost a generation per
 * sweep on 2026-08-20.
 */
function baseDeps(s: ScanStore) {
  return {
    getAllConversations: s.getAllConversations,
    isLive: werkLiveness(s.getActiveConversationCount),
    producedOutput: (conv: { id: string }) => s.hasAnyTranscript(conv.id),
    log: (line: string) => console.log(line),
    now: Date.now,
  }
}

/**
 * THE REFINE SCANNER'S DEPS for one project.
 *
 * `projectRoot` IS THE PROJECT URI, which reads wrong and is right: the prompt
 * uses it to name the card file, and a `claude://` URI is the form a seat can
 * actually open. `epic-beat-actions.ts`'s `spawnCtx` made the identical call for
 * the identical reason, and the two must agree or a werk-refiner dispatched by the
 * clock would be told to edit a different path than one dispatched by an epic.
 */
export function buildRefineDeps(store: ConversationStore, project: string): RefineDeps {
  return {
    ...baseDeps(store as unknown as ScanStore),
    getCards: () => listBoardCards(callBoard, store, project),
    concurrency: DEFAULT_REFINE_CONCURRENCY,
    project,
    projectRoot: project,
    dispatch: async request => (await dispatchSpawn(request, spawnDeps(store))).ok,
  }
}

/**
 * THE REFINE TAG'S DRAIN for one project -- the clock's step, not the scanner's.
 *
 * READS THE BOARD ITSELF rather than sharing the pass's list, and that second RPC
 * is the point: the drain WRITES, and a scan that then selected from a pre-drain
 * snapshot would dispatch a second werk-refiner at the card this very tick just
 * cleared. Two reads a minute per opted-in project buys an ordering that cannot
 * race itself.
 *
 * A BOARD NOBODY CAN READ IS AN EMPTY DRAIN, never a throw: `listBoardCards`
 * answers `[]` when the sentinel is gone, and clearing nothing is the correct
 * behaviour for an engine that cannot see the queue.
 */
export function buildRefineDrain(store: ConversationStore, project: string): () => Promise<void> {
  return async () => {
    const s = store as unknown as ScanStore
    await drainRefineTag({
      cards: await listBoardCards(callBoard, store, project),
      getAllConversations: s.getAllConversations,
      isLive: werkLiveness(s.getActiveConversationCount),
      producedOutput: conv => s.hasAnyTranscript(conv.id),
      untag: slug => clearCardTag(callBoard, store, project, slug, NEEDS_REFINE_TAG),
      log: line => console.log(line),
    })
  }
}

/**
 * THE WORK-ORDER SCANNER'S DEPS for one project.
 *
 * `trustLevel` is left absent so `planWerkWorkerSpawn` composes the order's caps
 * at its own default (benevolent), which is the trust `SCANNER_CALLER` above
 * actually carries. Passing anything lower would refuse `WERK-WORKER@1` at plan
 * time; passing anything higher would be a claim this caller cannot back.
 */
export function buildWorkOrderDeps(store: ConversationStore, project: string): WorkOrderDeps {
  return {
    ...baseDeps(store as unknown as ScanStore),
    getCards: () => listBoardCards(callBoard, store, project),
    concurrency: WORK_ORDER_CONCURRENCY,
    spawnCtx: { project, projectRoot: project },
    dispatch: async plan => (await dispatchSpawn(plan, spawnDeps(store))).ok,
  }
}
