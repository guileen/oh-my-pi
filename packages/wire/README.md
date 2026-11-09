# @oh-my-pi/pi-wire

Shared TypeScript wire contracts and browser-safe Graph observation consumers for omp.

The package has no runtime dependencies. Its collab contracts are consumed by the host CLI (`@oh-my-pi/pi-coding-agent`) and browser guest (`@oh-my-pi/collab-web`); the separate Graph entry can be consumed without installing the agent or coding-agent packages.

## Exports

```ts
import type { GuestFrame, HostFrame, SessionEntry } from "@oh-my-pi/pi-wire";
import { COLLAB_PROTO, DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH } from "@oh-my-pi/pi-wire";
```

Graph clients use the dedicated entry, which shares its scalar types, record validation and deterministic serializer with the producer:

```ts
import { GRAPH_WIRE_PROTOCOL, GraphWireSourceState } from "@oh-my-pi/pi-wire/graph";
import type { GraphCursor, GraphRef, GraphWireSourceFrame } from "@oh-my-pi/pi-wire/graph";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
```

`GraphWireSourceState` is transport-independent and preserves authorized scopes, atomic snapshots, replay checkpoints and unsupported-state handling. It does not authenticate connections or provide a Host, persistence layer, transport or UI. Graph record validators are available from `@oh-my-pi/pi-wire/graph/wire-records` and `@oh-my-pi/pi-wire/graph/wire-execution-records`.

`validateGraphWireAuthoringRequest`, `validateGraphWireDefinitionFrame`, `validateGraphWireAuthorResultFrame` and `validateGraphWireReconciliationFrame` validate exact definition-authoring envelopes, bounded Markdown, finite JSON and receipt-state coherence without importing a Host. They do not authorize requests, reconcile durable intents or enable execution; those belong to the authenticated transport and common authoring service. Protected definition text must not enter service-worker caches.

Key groups:

- message and transcript entry shapes rendered by collab guests,
- live agent event and task-subagent bus payload shapes,
- `GuestFrame`, `HostFrame`, and `WireFrame` unions for AES-GCM sealed payloads,
- relay control TEXT messages,
- link/envelope constants shared by host, guest, and local relay code.

## Protocol boundary

The collab contract does not encode, decode, validate, encrypt, or route frames. It defines the shared shapes used at those boundaries:

1. callers build a `GuestFrame` or `HostFrame`,
2. transport code serializes it as JSON inside an encrypted payload,
3. relay code routes opaque envelopes using the plaintext peer-id prefix,
4. receivers switch on `frame.t` and tolerate unknown future fields.

Keep protocol changes backward-aware: bump `COLLAB_PROTO` only when old hosts and guests must reject each other.
