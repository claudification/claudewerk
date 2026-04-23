import type { StoreConfig, StoreDriver } from './types'

export function createStore(config: StoreConfig): StoreDriver {
  switch (config.type) {
    case 'sqlite': {
      const { createSqliteDriver } = require('./sqlite/driver') as typeof import('./sqlite/driver')
      return createSqliteDriver(config)
    }
    case 'memory': {
      const { createMemoryDriver } = require('./memory/driver') as typeof import('./memory/driver')
      return createMemoryDriver()
    }
    default:
      throw new Error(`Unknown store type: ${(config as StoreConfig).type}`)
  }
}

export * from './errors'
export type { StoreConfig, StoreDriver } from './types'
