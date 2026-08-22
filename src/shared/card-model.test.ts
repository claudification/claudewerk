import { describe, expect, test } from 'bun:test'
import {
  CARD_MODEL_TAG_PREFIX,
  checkCardModel,
  clampCardModel,
  foldModelTags,
  modelFromTag,
  readCardModel,
} from './card-model'
import { WERK_REFINER_ORDER } from './werk-refiner-order'

describe('readCardModel', () => {
  test('takes a slug the spawn layer accepts', () => {
    expect(readCardModel('opus')).toBe('opus')
    expect(readCardModel('claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(readCardModel('  fable  ')).toBe('fable')
  })

  test('drops a slug nothing can resolve, rather than passing it to a spawn', () => {
    expect(readCardModel('gpt-9')).toBeUndefined()
  })

  test('a list where a scalar belongs reads as NOTHING, not as its first entry', () => {
    expect(readCardModel(['opus', 'haiku'])).toBeUndefined()
    expect(readCardModel(['opus'])).toBeUndefined()
  })

  test('absent, blank and non-string all read the same', () => {
    expect(readCardModel(undefined)).toBeUndefined()
    expect(readCardModel('')).toBeUndefined()
    expect(readCardModel('   ')).toBeUndefined()
    expect(readCardModel(7)).toBeUndefined()
  })
})

describe('the #model-<slug> tag alias', () => {
  test('yields the slug it names', () => {
    expect(modelFromTag('model-opus')).toBe('opus')
    expect(modelFromTag(`${CARD_MODEL_TAG_PREFIX}sonnet`)).toBe('sonnet')
  })

  test('an unknown slug is NOT a model tag -- the tag survives as a tag', () => {
    expect(modelFromTag('model-frobnicate')).toBeUndefined()
    expect(foldModelTags(['model-frobnicate', 'infra'])).toEqual({ tags: ['model-frobnicate', 'infra'] })
  })

  test('an ordinary tag is left alone', () => {
    expect(modelFromTag('modelling')).toBeUndefined()
    expect(modelFromTag('infra')).toBeUndefined()
  })

  test('folding removes the recognised tag and hands back the model', () => {
    expect(foldModelTags(['infra', 'model-opus', 'board'])).toEqual({ tags: ['infra', 'board'], model: 'opus' })
  })

  test('two model tags: the last one wins, like a key written twice', () => {
    expect(foldModelTags(['model-haiku', 'model-opus'])).toEqual({ tags: [], model: 'opus' })
  })
})

describe('clampCardModel -- the order still wins', () => {
  test('no hint leaves the order alone', () => {
    expect(clampCardModel(undefined, 'claude-haiku-4-5')).toEqual({})
  })

  test('no cap means nothing to narrow against, so the hint is the choice', () => {
    expect(clampCardModel('opus', undefined)).toEqual({ model: 'opus' })
  })

  test('a hint BELOW the cap is a real narrowing and survives', () => {
    const choice = clampCardModel('haiku', 'opus')
    expect(choice.model).toBe('haiku')
    expect(choice.note).toBeUndefined()
  })

  test('a hint at the cap survives untouched', () => {
    expect(clampCardModel('claude-haiku-4-5', 'claude-haiku-4-5')).toEqual({ model: 'claude-haiku-4-5' })
  })

  /** THE CARD'S OWN ACCEPTANCE TEST. `WERK-REFINER@1` caps at Haiku; a card asking
   *  for Opus must run on Haiku anyway, and must SAY it was clamped. */
  test('a `model: opus` card dispatched by WERK-REFINER@1 still runs on Haiku, and logs why', () => {
    const choice = clampCardModel('opus', WERK_REFINER_ORDER.caps.model)
    expect(choice.model).toBe('claude-haiku-4-5')
    expect(choice.note).toContain('opus')
    expect(choice.note).toContain('claude-haiku-4-5')
  })

  test('a hint above the cap is clamped, never refused', () => {
    const choice = clampCardModel('fable', 'sonnet')
    expect(choice.model).toBe('sonnet')
    expect(choice.note).toBeDefined()
  })

  /** A dynamic alias resolves to a different family every week, so it cannot be
   *  proven to be a narrowing -- and an unprovable narrowing is not one. */
  test('an unrankable hint keeps the cap rather than being trusted', () => {
    const choice = clampCardModel('best', 'claude-haiku-4-5')
    expect(choice.model).toBe('claude-haiku-4-5')
    expect(choice.note).toContain('cannot be ranked')
  })

  test('an unrankable CAP is equally not something to widen past', () => {
    const choice = clampCardModel('haiku', 'opusplan')
    expect(choice.model).toBe('opusplan')
    expect(choice.note).toContain('cannot be ranked')
  })
})

describe('checkCardModel', () => {
  test('says nothing about a card with no hint, or a usable one', () => {
    expect(checkCardModel({ id: 'c', meta: {} })).toEqual([])
    expect(checkCardModel({ id: 'c', meta: { model: '' } })).toEqual([])
    expect(checkCardModel({ id: 'c', meta: { model: 'opus' } })).toEqual([])
  })

  test('reports an unusable slug as a WARNING -- the board still renders', () => {
    const [finding] = checkCardModel({ id: 'c', meta: { model: 'gpt-9' } })
    expect(finding.check).toBe('card-model-invalid')
    expect(finding.severity).toBe('warning')
    expect(finding.problem).toContain('gpt-9')
    expect(finding.remedy).toBeTruthy()
  })

  test('reports a list where one slug belongs', () => {
    const [finding] = checkCardModel({ id: 'c', meta: { model: ['opus', 'haiku'] } })
    expect(finding.check).toBe('card-model-invalid')
    expect(finding.problem).toContain('list')
  })
})
