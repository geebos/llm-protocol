/**
 * Unified stream block location/key (docs/07.ir-native-codec.md §7.1, DEC-13).
 *
 * Validator, Privacy Restore, Renderer and projection state must all key blocks
 * with the same structure, so two choices at the same content index never
 * collide. `createStreamBlockKey` is the parser-boundary factory: it requires a
 * resolved content index instead of silently defaulting (`content ?? 0` would
 * alias distinct blocks onto one key).
 */
import { validationError } from "../errors.js";

/** Multi-level location of a streamed element. */
export interface StreamLocation {
  choice?: number;
  /** Reserved: Responses output item. */
  output?: number;
  content?: number;
  /** Reserved: reasoning summary part. */
  summary?: number;
  annotation?: number;
}

export type StreamBlockKind = "text" | "tool" | "reasoning" | "refusal";

/** A content-block location with the content index resolved at the parser boundary. */
export type ResolvedStreamLocation = StreamLocation & { content: number };

export interface StreamBlockKey {
  choice: number;
  kind: StreamBlockKind;
  content: number;
}

export function streamBlockKey(
  choice: number,
  kind: StreamBlockKind,
  content: number,
): StreamBlockKey {
  return { choice, kind, content };
}

export function streamBlockKeyId(key: StreamBlockKey): string {
  return `${key.choice}:${key.kind}:${key.content}`;
}

/**
 * Build a stable block key from a validated location. The parser must assign a
 * content index; a single-candidate stream defaults `choice` to 0.
 */
export function createStreamBlockKey(
  kind: StreamBlockKind,
  location: StreamLocation,
): StreamBlockKey {
  if (location.content === undefined) {
    throw validationError(
      `stream ${kind} block is missing a content index at the parser boundary`,
    );
  }
  return { choice: location.choice ?? 0, kind, content: location.content };
}
