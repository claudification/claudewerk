# Terminal Routing Flow

## Identity Model

```
conversationId = physical identity (this machine, this process, this PTY)
sessionId = logical identity (Claude Code session, can be shared via --continue)
```

Multiple wrappers can share a sessionId. Each wrapper has exactly one PTY.
A session only ends when its LAST wrapper disconnects.

## Data Flow

```mermaid
graph TD
    subgraph "Host Machine A"
        WA[rclaude wrapper A<br/>conversationId: abc-123]
        PTYA[PTY A]
        WA --- PTYA
    end

    subgraph "Host Machine B"
        WB[rclaude wrapper B<br/>conversationId: def-456]
        PTYB[PTY B]
        WB --- PTYB
    end

    subgraph "Concentrator"
        SS[Session Store<br/>sessionSockets: Map sessionId → Map conversationId → ws<br/>terminalViewers: Map conversationId → Set ws]
        WS[WebSocket Server]
        WS --> SS
    end

    subgraph "Browser"
        DASH[Dashboard]
        TERM[WebTerminal<br/>props: conversationId]
        TABS[Wrapper Tabs<br/>one tab per conversationId]
        TERM --> TABS
    end

    WA -->|"meta {sessionId, conversationId: abc}"| WS
    WB -->|"meta {sessionId, conversationId: def}"| WS

    TERM -->|"terminal_attach {conversationId: abc}"| WS
    WS -->|"terminal_attach {conversationId: abc}"| WA
    WA -->|"terminal_data {conversationId: abc, data}"| WS
    WS -->|"terminal_data {conversationId: abc, data}"| TERM
    TERM -->|"terminal_data {conversationId: abc, data}"| WS
    WS -->|"terminal_data {conversationId: abc, data}"| WA
```

## Terminal Message Routing

All terminal messages route by `conversationId`, never `sessionId`:

```mermaid
sequenceDiagram
    participant Browser as Browser (WebTerminal)
    participant Conc as Concentrator
    participant Wrapper as rclaude (conversationId)

    Note over Browser: User clicks TTY button<br/>resolves session.conversationIds[0]

    Browser->>Conc: terminal_attach {conversationId, cols, rows}
    Conc->>Conc: addTerminalViewer(conversationId, browserWs)
    Conc->>Conc: getSessionSocketByWrapper(conversationId)
    Conc->>Wrapper: terminal_attach {conversationId, cols, rows}
    Wrapper->>Wrapper: Start PTY forwarding

    loop PTY output
        Wrapper->>Conc: terminal_data {conversationId, data}
        Conc->>Conc: getTerminalViewers(conversationId)
        Conc->>Browser: terminal_data {conversationId, data}
    end

    loop User keystrokes
        Browser->>Conc: terminal_data {conversationId, data}
        Conc->>Conc: getSessionSocketByWrapper(conversationId)
        Conc->>Wrapper: terminal_data {conversationId, data}
    end

    Browser->>Conc: terminal_detach {conversationId}
    Conc->>Conc: removeTerminalViewer(conversationId, browserWs)
    Note over Conc: If last viewer removed:
    Conc->>Wrapper: terminal_detach {conversationId}
```

## Store & UI Routing

```mermaid
graph LR
    subgraph "Zustand Store"
        TWI[terminalWrapperId: string | null]
        ST[showTerminal: boolean]
        OT["openTerminal(conversationId)"]
    end

    subgraph "session-detail.tsx"
        TTY[TTY Button click]
        TTY -->|"session.conversationIds[0]"| OT
    end

    subgraph "app.tsx"
        KBD["Ctrl+Shift+T"]
        SW[Switcher select]
        KBD -->|"session.conversationIds[0]"| OT
        SW -->|"session.conversationIds[0]"| OT
    end

    subgraph "web-terminal.tsx"
        WT["WebTerminal(conversationId)"]
        WTABS["Wrapper Tabs"]
        WT --> WTABS
        WTABS -->|"click tab"| OT
    end

    OT --> TWI
    OT --> ST
    TWI --> WT
```

## Session Lifecycle with Multiple Wrappers

```mermaid
sequenceDiagram
    participant W1 as Wrapper A (conversationId: abc)
    participant W2 as Wrapper B (conversationId: def)
    participant C as Concentrator
    participant D as Dashboard

    W1->>C: meta {sessionId: S1, conversationId: abc}
    C->>C: setSessionSocket(S1, abc, ws1)
    C->>D: session_created {conversationIds: [abc]}

    W2->>C: meta {sessionId: S1, conversationId: def}
    Note over W2,C: Same sessionId via --continue
    C->>C: setSessionSocket(S1, def, ws2)
    C->>D: session_update {conversationIds: [abc, def]}

    W2->>C: end {sessionId: S1}
    C->>C: removeSessionSocket(S1, def)
    C->>C: getActiveWrapperCount(S1) = 1
    Note over C: Still 1 wrapper alive - session stays active
    C->>D: session_update {conversationIds: [abc]}

    W1->>C: end {sessionId: S1}
    C->>C: removeSessionSocket(S1, abc)
    C->>C: getActiveWrapperCount(S1) = 0
    Note over C: Last wrapper gone - NOW end the session
    C->>C: endSession(S1)
    C->>D: session_ended
```

## Revive Flow with Pre-assigned conversationId

```mermaid
sequenceDiagram
    participant D as Dashboard
    participant C as Concentrator
    participant A as sentinel
    participant R as revive-session.sh
    participant W as New rclaude

    D->>C: POST /sessions/{sessionId}/revive
    C->>C: Generate conversationId = randomUUID()
    C->>A: revive {sessionId, cwd, conversationId}
    A->>R: spawn with RCLAUDE_CONVERSATION_ID env
    R->>R: tmux new-session with env
    R->>W: rclaude starts with RCLAUDE_CONVERSATION_ID
    W->>C: meta {sessionId, conversationId}
    Note over C: conversationId matches pre-assigned -<br/>concentrator can correlate
```

## URL Hash Routing

| Hash | Meaning |
|------|---------|
| `#session/{sessionId}` | Select session in main panel |
| `#terminal/{conversationId}` | Open terminal overlay for wrapper |
| `#popout-terminal/{conversationId}` | Popout terminal window for wrapper |
