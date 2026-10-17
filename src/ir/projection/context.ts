/**
 * Bidirectional projection context (docs/07.ir-native-codec.md §6.1, DEC-12).
 *
 * `from` is the client protocol and `to` is the upstream protocol. Request
 * projection goes from -> to; response/stream projection goes to -> from. The
 * direction must be explicit so the response path never checks upstream
 * capability when it should check the client protocol's.
 */
import type { ApiFormat } from "../../formats.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";

export type ProjectionPhase = "request" | "response" | "stream";

export interface ProjectionContext {
  phase: ProjectionPhase;
  inputFormat: ApiFormat;
  outputFormat: ApiFormat;
  inputProfile: ProviderProfile;
  outputProfile: ProviderProfile;
}

/**
 * Build a projection context for one phase.
 *
 * @param from Client-facing protocol.
 * @param to   Upstream protocol.
 * @param sourceProfile Profile for `from`.
 * @param targetProfile Profile for `to`.
 */
export function projectionContext(
  phase: ProjectionPhase,
  from: ApiFormat,
  to: ApiFormat,
  sourceProfile: ProviderProfile,
  targetProfile: ProviderProfile,
): ProjectionContext {
  if (phase === "request") {
    return {
      phase,
      inputFormat: from,
      outputFormat: to,
      inputProfile: sourceProfile,
      outputProfile: targetProfile,
    };
  }
  return {
    phase,
    inputFormat: to,
    outputFormat: from,
    inputProfile: targetProfile,
    outputProfile: sourceProfile,
  };
}
