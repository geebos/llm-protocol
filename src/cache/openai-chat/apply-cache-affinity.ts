/**
 * Inject a cache affinity into an OpenAI Chat request as `prompt_cache_key`.
 *
 * Gated by the target profile capability (`capabilities.cache.promptCacheKey`):
 * unknown/absent capability means unsupported, so nothing is sent to providers
 * that would reject the field. An explicitly present `prompt_cache_key` on the
 * body is never overridden. Every lossy/approximate decision surfaces as a
 * warning in the shared codec context (and in the returned report).
 */
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import type { CodecContext } from "../../codecs/protocol-adapter.js";
import type { TranslationWarning } from "../../ir/fidelity.js";
import type { CacheAffinity, CacheTranslationReport, CacheTranslationWarning } from "../types.js";

export interface CacheApplication {
  body: unknown;
  report: CacheTranslationReport;
}

/** All cache warnings pushed to ctx; also collected for the report. */
function warn(
  ctx: CodecContext,
  warnings: CacheTranslationWarning[],
  w: CacheTranslationWarning,
): void {
  warnings.push(w);
  const trace: TranslationWarning = {
    code: w.code,
    message: w.message,
    fidelity: w.fidelity,
    field: w.code === "cache_ttl_not_representable" ? "cache_control.ttl" : "prompt_cache_key",
  };
  ctx.warnings.push(trace);
}

export function applyOpenAIChatCacheAffinity(
  body: unknown,
  affinity: CacheAffinity | undefined,
  profile: ProviderProfile,
  ctx: CodecContext,
): CacheApplication {
  const warnings: CacheTranslationWarning[] = [];

  if (!affinity?.key) {
    return {
      body,
      report: {
        detected: false,
        targetKeyInjected: false,
        anchorCount: 0,
        degraded: false,
        warnings,
      },
    };
  }

  const source = affinity.source;
  const anchorCount = affinity.anchors?.length ?? 0;
  const b = body as Record<string, unknown>;

  // An explicitly provided key on the body wins; never override it (23).
  if (typeof b.prompt_cache_key === "string" && b.prompt_cache_key !== "") {
    return {
      body,
      report: {
        detected: true,
        source,
        targetKeyInjected: false,
        anchorCount,
        degraded: false,
        warnings,
      },
    };
  }

  const supports = profile.capabilities.cache?.promptCacheKey === true;
  if (!supports) {
    warn(ctx, warnings, {
      code: "cache_target_unsupported",
      message:
        "Cache anchors detected but the target profile does not declare prompt_cache_key support; dropped",
      fidelity: "LOSSY",
    });
    return {
      body,
      report: {
        detected: true,
        source,
        targetKeyInjected: false,
        anchorCount,
        degraded: true,
        warnings,
      },
    };
  }

  // TTL is cache policy, not cache identity (25); it does not change the key.
  const hasTtl = affinity.anchors?.some((a) => a.cacheControl.ttl !== undefined) === true;
  if (hasTtl) {
    warn(ctx, warnings, {
      code: "cache_ttl_not_representable",
      message: "cache_control ttl is not representable in OpenAI Chat prompt_cache_key",
      fidelity: "COMPATIBLE",
    });
  }

  warn(ctx, warnings, {
    code: "cache_control_downgraded_to_cache_key",
    message:
      "Anthropic cache_control approximated as OpenAI Chat prompt_cache_key (cache affinity, not lossless semantics)",
    fidelity: "COMPATIBLE",
  });

  return {
    body: { ...b, prompt_cache_key: affinity.key },
    report: {
      detected: true,
      source,
      targetKeyInjected: true,
      anchorCount,
      degraded: affinity.lossy === true,
      warnings,
    },
  };
}
