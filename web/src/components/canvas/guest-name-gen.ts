/**
 * Fun display name for an anonymous canvas guest -- an adjective + animal handle
 * like "Snarky Whale". Beats a room full of identical "Guest" cursors: everyone
 * gets a distinct, memorable label the first time they land, no prompt required.
 * Pure (injectable rng) so it unit-tests without touching Math.random.
 */

const ADJECTIVES = [
  'Snarky', 'Sleepy', 'Sneaky', 'Grumpy', 'Jazzy', 'Cosmic', 'Feral', 'Salty',
  'Zippy', 'Wobbly', 'Sassy', 'Dizzy', 'Turbo', 'Mellow', 'Rowdy', 'Sly',
  'Plucky', 'Cranky', 'Peppy', 'Groovy', 'Fuzzy', 'Nifty', 'Spicy', 'Bouncy',
]

const ANIMALS = [
  'Whale', 'Otter', 'Fox', 'Badger', 'Heron', 'Lynx', 'Moose', 'Raccoon',
  'Wombat', 'Puffin', 'Gecko', 'Walrus', 'Mantis', 'Newt', 'Ferret', 'Toucan',
  'Narwhal', 'Panda', 'Koala', 'Falcon', 'Beaver', 'Marmot', 'Ibis', 'Yak',
]

/** Generate a random handle. Pass a [0,1) rng to make it deterministic in tests. */
export function generateGuestName(rng: () => number = Math.random): string {
  const adj = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)]
  const animal = ANIMALS[Math.floor(rng() * ANIMALS.length)]
  return `${adj} ${animal}`
}
