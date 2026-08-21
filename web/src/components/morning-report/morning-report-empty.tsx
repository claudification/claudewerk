/**
 * The two states that are NOT a list of proposals -- and both of them say which
 * one they are.
 *
 * NO REPORT AT ALL is the health signal this entire feature was built around. It
 * is rendered loudly, with the reason it is probably happening (the scanner is
 * off by default for every project) and where to change it. An empty panel that
 * just says "nothing here" is indistinguishable from a sweep that has been
 * broken for a month, which is precisely how the other unattended engines in
 * this codebase died.
 *
 * NOTHING MOVED is the cheap path, not a failure: HEAD and the board were
 * unchanged since the last sweep, so the fold short-circuited. Saying so is what
 * keeps it from being read as the first state.
 */

import { CalendarX, CoffeeIcon } from 'lucide-react'

export function NoReportYet() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <CalendarX className="size-6 text-muted-foreground" />
      <p className="text-xs font-medium">No morning report has ever arrived for this project.</p>
      <p className="max-w-sm text-[10px] leading-relaxed text-muted-foreground">
        The report is produced by a scheduled sweep, not by opening this panel -- so an empty page here means the sweep
        has not run, which is exactly what it is supposed to tell you.
      </p>
      <p className="max-w-sm text-[10px] leading-relaxed text-muted-foreground">
        The <code className="font-mono">morning-report</code> scanner is off by default for every project. Turn it on in
        Project settings &rarr; Scanners, and give the project a schedule whose action is a board sweep.
      </p>
    </div>
  )
}

export function NothingMoved({ idleReason }: { idleReason?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <CoffeeIcon className="size-6 text-muted-foreground" />
      <p className="text-xs font-medium">Nothing moved.</p>
      <p className="max-w-sm text-[10px] leading-relaxed text-muted-foreground">
        {idleReason ?? 'HEAD and the board are unchanged since the last sweep'} -- the fold short-circuited and computed
        nothing. This is the cheap path, not a failure.
      </p>
    </div>
  )
}

export function NoProposals({ idleReason }: { idleReason?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <CoffeeIcon className="size-6 text-muted-foreground" />
      <p className="text-xs font-medium">The sweep ran and had nothing to propose.</p>
      <p className="max-w-sm text-[10px] leading-relaxed text-muted-foreground">
        {idleReason ?? 'Nothing on the board earned a proposal.'} Duplicates are ABSENT rather than empty: no judge is
        wired into the sweep, so nobody looked -- which is not the same claim as "there are none".
      </p>
    </div>
  )
}
