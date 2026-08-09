/**
 * OpenAI Responses error codec (responses.md §17.1, FR-011).
 *
 * Responses error bodies carry `{ error: { code, message, param, request_id } }`
 * with an HTTP status; the codec maps them to the canonical error model.
 */
import type { CanonicalError, ErrorKind } from "../../errors.js";
import type { ErrorCodec } from "../protocol-adapter.js";

const KIND_TO_TYPE: Record<ErrorKind, string> = {
  validation: "invalid_request_error",
  upstream: "server_error",
  rate_limit: "rate_limit_error",
  timeout: "timeout",
  cancelled: "server_error",
  stream_protocol: "server_error",
  unsupported: "invalid_request_error",
};

export const openaiResponsesErrorCodec: ErrorCodec = {
  parseError(payload: unknown, status?: number): CanonicalError {
    const p = payload as {
      error?: {
        message?: unknown;
        code?: unknown;
        type?: unknown;
        param?: unknown;
        request_id?: unknown;
      };
      message?: unknown;
      request_id?: unknown;
    };
    const err = p?.error ?? {};
    const code = typeof err.code === "string" ? err.code : "";
    const type = typeof err.type === "string" ? err.type : "";
    const message =
      typeof err.message === "string"
        ? err.message
        : String(p?.message ?? "upstream error");

    let kind: ErrorKind = "upstream";
    if (code.includes("rate_limit") || type.includes("rate_limit") || status === 429) {
      kind = "rate_limit";
    } else if (
      code.includes("invalid") ||
      type.includes("invalid_request") ||
      status === 400 ||
      status === 422
    ) {
      kind = "validation";
    } else if (type.includes("timeout")) {
      kind = "timeout";
    } else if (type.includes("authentication") || type.includes("permission")) {
      kind = "upstream";
    }

    return {
      kind,
      message,
      status,
      providerCode: code || type || undefined,
      requestId:
        typeof p.request_id === "string"
          ? p.request_id
          : typeof err.request_id === "string"
            ? err.request_id
            : undefined,
    };
  },

  renderError(error: CanonicalError): unknown {
    return {
      error: {
        code: error.providerCode ?? null,
        message: error.message,
        param: null,
        type: KIND_TO_TYPE[error.kind] ?? "server_error",
        ...(error.requestId ? { request_id: error.requestId } : {}),
      },
    };
  },
};
