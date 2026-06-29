/**
 * I/O layer: where transcript bytes come from and go to. Decoupled from format
 * (that's the adapter) so the compactor runs identically against an in-memory
 * string in tests and a file in production -- no logic changes between them.
 */

export interface Reader {
  read(): Promise<string>
}

export interface Writer {
  write(data: string): Promise<void>
}

/** In-memory source for tests. */
export class StringReader implements Reader {
  constructor(private readonly data: string) {}
  read(): Promise<string> {
    return Promise.resolve(this.data)
  }
}

/** In-memory sink for tests; inspect `.output` after a run. */
export class StringWriter implements Writer {
  output = ''
  write(data: string): Promise<void> {
    this.output = data
    return Promise.resolve()
  }
}

/** Reads a transcript file (Bun). Production I/O; consumed when wired to the agent host. */
// fallow-ignore-next-line unused-export
export class FileReader implements Reader {
  constructor(private readonly path: string) {}
  read(): Promise<string> {
    return Bun.file(this.path).text()
  }
}

/** Writes a transcript file (Bun). Production I/O; consumed when wired to the agent host. */
// fallow-ignore-next-line unused-export
export class FileWriter implements Writer {
  constructor(private readonly path: string) {}
  async write(data: string): Promise<void> {
    await Bun.write(this.path, data)
  }
}
