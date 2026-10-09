/**
 * Privacy engine (PR-002, §5.1).
 *
 * A convenience facade for text-level `redact` / `restore` independent of the
 * protocol pipeline. Sessions are request-scoped and read-only to callers.
 */
import { randomUUID } from "node:crypto";
import { resolvePrivacyConfig } from "./config.js";
import { redactRegions, setRegionAction } from "./redact.js";
import { restoreString } from "./restore.js";
import { PrivacySession } from "./session.js";
import type {
  PrivacyEngine,
  PrivacyRecognizer,
  PrivacySessionOptions,
  PrivacySessionView,
  RecognizerContext,
} from "./types.js";

const DEFAULT_MAX_PLACEHOLDER_LENGTH = 128;

export function createPrivacyEngine(): PrivacyEngine {
  const sessions = new Map<string, PrivacySession>();

  const createSession = (
    id?: string,
    options: PrivacySessionOptions = {},
  ): PrivacySessionView => {
    const resolved = resolvePrivacyConfig({
      recognizers: [{ priority: 0, recognize: () => [] }],
      mapping: {
        template: options.template,
        tagMode: options.tagMode,
        tagBytes: options.tagBytes,
      },
    });
    const session = new PrivacySession(id ?? randomUUID(), {
      compiled: resolved.template,
      tagMode: resolved.tagMode,
      tagBytes: resolved.tagBytes,
      namespace: resolved.namespace,
    });
    sessions.set(session.id, session);
    return session;
  };

  const requireSession = (view: PrivacySessionView): PrivacySession => {
    if (view instanceof PrivacySession) return view;
    const found = sessions.get(view.id);
    if (!found) {
      throw new Error("privacy session is no longer active");
    }
    return found;
  };

  return {
    createSession,

    getSession(id: string): PrivacySessionView | undefined {
      return sessions.get(id);
    },

    destroySession(id: string): void {
      sessions.delete(id);
    },

    async redact(
      text: string,
      session: PrivacySessionView,
      recognizers: PrivacyRecognizer[],
      context?: Partial<RecognizerContext>,
    ): Promise<string> {
      const active = requireSession(session);
      const config = resolvePrivacyConfig({
        recognizers,
        mapping: {
          template: active.compiled.raw,
          tagMode: active.compiled.tagMode,
          tagBytes: active.compiled.tagBytes,
        },
      });
      const holder = { value: text };
      const region = setRegionAction(
        {
          channel: context?.channel ?? "text",
          path: context?.path ?? "text",
          segments: [
            {
              get: () => holder.value,
              set: (v: string) => {
                holder.value = v;
              },
            },
          ],
        },
        "redact",
      );
      await redactRegions([region], active, config);
      return holder.value;
    },

    restore(text: string, session: PrivacySessionView): string {
      const active = requireSession(session);
      return restoreString(
        text,
        active.compiled,
        active.snapshot(),
        DEFAULT_MAX_PLACEHOLDER_LENGTH,
      ).text;
    },
  };
}
