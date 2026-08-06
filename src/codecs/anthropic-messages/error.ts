/**
 * Anthropic Messages error codec (FR-011, TC-023).
 */
import type { CanonicalError, ErrorKind } from "../../errors.js";
import type { ErrorCodec } from "../protocol-adapter.js";

const KIND_TO_TYPE: Record<ErrorKind, string> = {
  validation: "invalid_request_error",
  upstream: "api_error",
  rate_limit: "rate_limit_error",
  timeout: "timeout_error",
  cancelled: "api_error",
  stream_protocol: "api_error",
  unsupported: "invalid_request_error",
};

export const anthropicErrorCodec: ErrorCodec = {
  parseError(payload: unknown, status?: number): CanonicalError {
    const p = payload as {
      error?: {
        type?: unknown;
        message?: unknown;
        request_id?: unknown;
      };
      type?: unknown;
      message?: unknown;
      request_id?: unknown;
    };
    const err = p?.error ?? {};
    const type = typeof err.type === "string" ? err.type : "";
    const message = typeof err.message === "string" ? err.message : String(p?.message ?? "upstream error");

    let kind: ErrorKind = "upstream";
    if (type === "rate_limit_error") kind = "rate_limit";
    else if (type === "invalid_request_error") kind = "validation";
    else if (type === "timeout_error") kind = "timeout";
    else if (type.includes("authentication") || type.includes("permission")) kind = "upstream";

    return {
      kind,
      message,
      status,
      providerCode: type || undefined,
      requestId:
        typeof err.request_id === "string"
          ? err.request_id
          : typeof p.request_id === "string"
            ? p.request_id
            : undefined,
    };
  },

  renderError(error: CanonicalError): unknown {
    return {
      type: "error",
      error: {
        type: KIND_TO_TYPE[error.kind] ?? "api_error",
        message: error.message,
        ...(error.requestId ? { request_id: error.requestId } : {}),
      },
    };
  },
};
