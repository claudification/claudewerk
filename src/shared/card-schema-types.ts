/**
 * What one KNOWN card frontmatter key declares. Types only, so the spec tables
 * (card-schema-keys.ts), the registry surface (card-schema.ts) and the validator
 * (card-schema-validate.ts) can all depend on this without a cycle.
 *
 * OPEN, and that word decides the whole design. `project-card-file.ts` carries
 * the scar: the old store rebuilt every card from a fixed key list, so it
 * silently destroyed the DONE-gate's machine-authored `evidence_*` on every
 * update. Anything that REJECTS an unknown key re-creates that bug in a nastier
 * form -- as a gate people route around. A `CardKeySpec` therefore describes
 * what is KNOWN, never what is ALLOWED. No spec for a key is not an error.
 */

/**
 * The types the FRONTMATTER SUBSET can actually express -- and that is the whole
 * list, deliberately. `frontmatter.ts` is NOT YAML: it is flat `key: value`
 * lines plus inline `[a, b]`, with no nesting, no quoting and no multi-line
 * values. Declaring a richer type system would mean validating against a parser
 * this repo does not have.
 *
 * `number` and `date` both come back as STRINGS from the parser (only the
 * serializer ever knew the difference), so they describe how a value must READ,
 * not its JavaScript type.
 */
export type CardValueType = 'string' | 'number' | 'date' | 'string[]' | 'enum'

/** Who writes a key -- which is what says whether a human should hand-edit it. */
export type CardKeyOwner =
  /** The store writes it and renders it in a fixed position. */
  | 'store'
  /** Hand-authored configuration the store only ever passes through. */
  | 'human'
  /** Machine-authored at transition time. Hand-editing it is forging evidence. */
  | 'machine'

/** Mirrors `DoctorSeverity` deliberately instead of importing it: the doctor
 *  depends on the registry, never the other way round. */
export type CardKeySeverity = 'error' | 'warning' | 'info'

/**
 * How one class of problem with this key gets reported: at this severity, under
 * this SHIPPED check id. The ids are spelled out rather than derived from the
 * key name, because `card-status-missing` and `card-status-invalid` are already
 * a greppable vocabulary in the CLI output and its tests -- the same call
 * `LinkageChecks` makes in card-linkage.ts, for the same reason.
 */
export interface CardKeyFinding {
  check: string
  severity: CardKeySeverity
  /** Overrides the generated remedy line. Set it only when there is a COMMAND
   *  worth naming -- a generated "add a `title:` line" is already the truth. */
  remedy?: string
}

export interface CardKeySpec {
  /** The key exactly as written on disk. snake_case: that is what cards carry. */
  key: string
  type: CardValueType
  /** The allowed values. Required for `type: 'enum'`, meaningless otherwise. */
  values?: readonly string[]
  /** One line, used verbatim in doctor remedies and the generated export. */
  doc: string
  /**
   * WHAT THE BOARD DOES when this key says nothing -- absent, empty, or holding
   * a value the reader cannot use. All three are the same fact from the card's
   * point of view, which is why one clause covers them: "the board silently
   * renders it as `inbox`" is the entire reason a typo'd lane is worth a
   * finding. Without it a report says something is wrong and not why it matters.
   */
  consequence?: string
  owner: CardKeyOwner
  /** Set on the store-owned keys: they render in registry order, before all
   *  others. Everything else follows in whatever order the file already had. */
  ordered?: true
  /** Set when an ABSENT value is worth reporting. */
  required?: CardKeyFinding
  /** How a value of the WRONG type is reported. Defaults to `card-key-type` at
   *  `warning` -- set it only to keep a check id that already shipped. */
  invalid?: CardKeyFinding
  /**
   * True for a key `card-linkage.ts` owns. Its shape and its targets are checked
   * THERE -- arity, resolution, aliases, deprecation -- so this registry knows
   * the key exists and what it means and stays out of the rest. Two passes
   * reporting one root cause is how a report gets ignored wholesale.
   */
  linkage?: true
  /**
   * Set when the key is still PARSED but must not be written any more, carrying
   * the remedy verbatim from whichever table deprecated it. The registry claims
   * to describe every key the board knows, and "you may not write this one" is
   * part of knowing it -- a reader that has to consult `card-linkage.ts` to find
   * that out is a reader that will not.
   */
  deprecated?: string
  /**
   * Set on an ALIAS, naming the key its values are actually stored as. Two
   * entries whose `doc` reads identically (`blocked_by` and `depends_on` say the
   * same fact) are indistinguishable to a reader without this -- and a reader
   * who picks the alias by coin-flip is the drift aliases exist to prevent.
   */
  storedAs?: string
}
