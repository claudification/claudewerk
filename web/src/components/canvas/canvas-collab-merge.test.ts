import { describe, expect, it } from 'vitest'
import {
  parseSceneElements,
  parseSceneFiles,
  peerToApply,
  pointerCollaborator,
  prunePeers,
  type RemoteCollaborator,
} from './canvas-collab-merge'

// Local roster shape (avoids importing the protocol pkg into a test).
type Peer = { peerId: string; name: string; color: string }

describe('pointerCollaborator', () => {
  it('maps a full pointer message', () => {
    const c = pointerCollaborator({ peerId: 'p', name: 'Ada', color: '#abc', x: 3, y: 4 })
    expect(c).toEqual({
      username: 'Ada',
      color: { background: '#abc', stroke: '#1e293b' },
      pointer: { x: 3, y: 4, tool: 'pointer' },
      button: 'up',
    })
  })
  it('applies defaults for missing fields', () => {
    const c = pointerCollaborator({})
    expect(c.username).toBe('guest')
    expect(c.color.background).toBe('#888')
    expect(c.pointer).toEqual({ x: 0, y: 0, tool: 'pointer' })
    expect(c.button).toBe('up')
  })
  it('carries laser tool + down button so Excalidraw draws the remote trail', () => {
    // The whole point: without tool==='laser' AND button==='down' reaching the
    // collaborators map, no laser trail is ever drawn for the peer.
    const c = pointerCollaborator({ name: 'Bo', x: 1, y: 2, tool: 'laser', button: 'down' })
    expect(c.pointer).toEqual({ x: 1, y: 2, tool: 'laser' })
    expect(c.button).toBe('down')
  })
  it('narrows unknown tool/button values to safe defaults', () => {
    const c = pointerCollaborator({ tool: 'wat', button: 'sideways' })
    expect(c.pointer?.tool).toBe('pointer')
    expect(c.button).toBe('up')
  })
})

describe('peerToApply', () => {
  it('returns the id + collaborator for a foreign peer', () => {
    const r = peerToApply({ peerId: 'b', name: 'Bo', x: 1, y: 2 }, 'a')
    expect(r?.id).toBe('b')
    expect(r?.collaborator.username).toBe('Bo')
  })
  it('ignores our own cursor and id-less messages', () => {
    expect(peerToApply({ peerId: 'a' }, 'a')).toBeNull()
    expect(peerToApply({}, 'a')).toBeNull()
  })
})

describe('parseSceneElements', () => {
  it('returns the elements array', () => {
    expect(parseSceneElements('{"elements":[{"id":"a"}]}')).toEqual([{ id: 'a' }])
  })
  it('returns [] when elements is absent', () => {
    expect(parseSceneElements('{}')).toEqual([])
  })
  it('returns null for non-string / malformed input', () => {
    expect(parseSceneElements(42)).toBeNull()
    expect(parseSceneElements('{bad')).toBeNull()
  })
})

describe('parseSceneFiles', () => {
  it('returns the image file values (what addFiles wants)', () => {
    const scene = JSON.stringify({ elements: [], files: { abc: { id: 'abc', dataURL: 'data:...' } } })
    expect(parseSceneFiles(scene)).toEqual([{ id: 'abc', dataURL: 'data:...' }])
  })
  it('returns [] when files is absent (no image on the canvas)', () => {
    expect(parseSceneFiles('{"elements":[]}')).toEqual([])
  })
  it('returns [] for non-string / malformed input, never throws', () => {
    expect(parseSceneFiles(42)).toEqual([])
    expect(parseSceneFiles('{bad')).toEqual([])
  })
})

describe('prunePeers', () => {
  it('drops collaborators not in the roster', () => {
    const map = new Map<string, RemoteCollaborator>([
      ['a', pointerCollaborator({ name: 'A' })],
      ['b', pointerCollaborator({ name: 'B' })],
    ])
    const roster: Peer[] = [{ peerId: 'a', name: 'A', color: '#111' }]
    prunePeers(map, roster)
    expect([...map.keys()]).toEqual(['a'])
  })
})
