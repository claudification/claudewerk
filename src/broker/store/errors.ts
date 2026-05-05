class StoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

export class ConversationNotFound extends StoreError {
  constructor(id: string) {
    super(`Conversation not found: ${id}`)
    this.name = 'SessionNotFound'
  }
}

class EntryNotFound extends StoreError {
  constructor(id: number) {
    super(`Entry not found: ${id}`)
    this.name = 'EntryNotFound'
  }
}

export class DuplicateEntry extends StoreError {
  constructor(message: string) {
    super(message)
    this.name = 'DuplicateEntry'
  }
}
