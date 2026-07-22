/**
 * Transcript component barrel export.
 * Re-exports TranscriptView as the primary public API.
 */

export { TranscriptDropZone } from './drop-zone'
// The renderer switch (transcriptRenderer pref) is the public entry; the concrete
// renderers are imported directly by it, not re-exported here.
export { TranscriptViewSwitch } from './transcript-view-switch'
