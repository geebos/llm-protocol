/**
 * OpenAI Chat error codec (FR-011, TC-023).
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

export const openaiChatErrorCodec: ErrorCodec = {
  parseError(payload: unknown, status?: number): CanonicalError {
    const p = payload as {
      error?: {
        message?: unknown;
        type?: unknown;
        code?: unknown;
        param?: unknown;
        request_id?: unknown;
      };
      message?: unknown;
      request_id?: unknown;
    };
    const err = p?.error ?? {};
    const type = typeof err.type === "string" ? err.type : "";
    const message = typeof err.message === "string" ? err.message : String(p?.message ?? "upstream error");

    let kind: ErrorKind = "upstream";
    if (type.includes("rate_limit") || status === 429) kind = "rate_limit";
    else if (type.includes("invalid_request") || status === 400 || status === 422) {
      kind = "validation";
    } else if (type.includes("timeout")) kind = "timeout";
    else if (type.includes("authentication") || type.includes("permission")) {
      kind = "upstream";
    }

    return {
      kind,
      message,
      status,
      providerCode:
        typeof err.code === "string" ? err.code : type || undefined,
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
        message: error.message,
        type: KIND_TO_TYPE[error.kind] ?? "server_error",
        ...(error.providerCode ? { code: error.providerCode } : {}),
        param: null,
        ...(error.requestId ? { request_id: error.requestId } : {}),
      },
    };
  },
};
