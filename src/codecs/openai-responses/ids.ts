/**
 * Synthetic ID Factory (responses.md §8.3, D-8).
 *
 * Generates translator-owned structural identifiers for the *target* Responses
 * response/SSE (response.id, output item ids, SSE item_id references). It never
 * fabricates provider-originated metadata (usage, reasoning content), and never
 * impersonates native upstream IDs: the `origin` is only recorded in the trace.
 *
 * Scope (v0.3 narrowed):
 * - only serves the target Responses response/SSE;
 * - outbound `/v1/responses` requests do NOT generate by default (native
 *   preserve / omit; a synthetic call_id is generated only when required to
 *   associate a tool result, §5.2A);
 * - native mode: synthetic IDs are never sent back to a real OpenAI upstream
 *   as provider identity.
 */

export type SyntheticItemKind = "message" | "reasoning" | "function" | "custom";
export type SyntheticIdOrigin = "native" | "synthetic";

/** Target-shape prefixes (v0.3): `resp_*` / `msg_*` / `rs_*` / `fc_*` / `ctc_*`. */
const ITEM_PREFIX: Record<SyntheticItemKind, string> = {
  message: "msg_",
  reasoning: "rs_",
  function: "fc_",
  custom: "ctc_",
};

export interface SyntheticIdFactory {
  responseId(): string;
  itemId(kind: SyntheticItemKind): string;
  /** Only when a source call_id is missing and association is required. */
  callId(): string;
  /** Origin is trace-only; never written into the ID itself. */
  mark(origin: SyntheticIdOrigin): void;
}

function genId(prefix: string): string {
  // 24 hex chars from a UUID; stable for the lifetime of the factory instance.
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function createSyntheticIdFactory(): SyntheticIdFactory {
  const used = new Set<string>();
  const unique = (prefix: string): string => {
    for (;;) {
      const id = genId(prefix);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  return {
    responseId: () => unique("resp_"),
    itemId: (kind) => unique(ITEM_PREFIX[kind]),
    callId: () => unique("call_"),
    mark: () => {
      /* origin recorded by the caller into the trace; nothing to store here */
    },
  };
}
