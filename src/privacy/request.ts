/**
 * IR channel walk (§7.1): build privacy regions from the canonical request.
 *
 * Consecutive text parts are grouped into a single detection region so the
 * detection boundary matches the target codec's semantic join boundary
 * (PR-020, §7.2). Tool argument strings use JSON Value-only replacement and a
 * detection on a JSON key is a rejection (§7.3).
 */
import type { CanonicalRequest, ContentPart } from "../ir/types.js";
import { getCacheControl } from "../ir/native/accessors.js";
import type { NormalizedCoverage } from "./coverage.js";
import { extensionAction } from "./coverage.js";
import { nativeAction } from "./coverage.js";
import { Region, setRegionAction, TextSegment } from "./redact.js";

type Action = "redact" | "allow" | "reject";

export interface RequestRegions {
  regions: Region[];
  /** Model-visible strings in default-allow extensions (collision / egress). */
  extraHaystack: string[];
  /** Extension paths with a non-allow coverage action (PR-014 evidence 2). */
  extensionsCoverage: { path: string; action: "redact" | "reject" }[];
}

function textSegments(parts: ContentPart[], indices: number[]): TextSegment[] {
  return indices.map((i) => {
    const part = parts[i] as Extract<ContentPart, { type: "text" }>;
    return {
      get: () => part.text,
      set: (v: string) => {
        part.text = v;
      },
      cache: getCacheControl(part) !== undefined,
    };
  });
}

/** Build one detection region for a run of adjacent text parts. */
function pushTextRegion(
  parts: ContentPart[],
  indices: number[],
  channel: Region["channel"],
  path: string,
  action: Action,
  regions: Region[],
): void {
  if (!indices.length) return;
  regions.push(
    setRegionAction(
      {
        channel,
        path,
        segments: textSegments(parts, indices),
        detectOnly: action === "reject",
        rejectCode: "privacy_uncovered_channel",
      },
      action,
    ),
  );
}

/**
 * Build one region per run of ADJACENT text parts. A non-text part is never
 * crossed, so the detection boundary stays equal to the codec's semantic join
 * boundary and a detection can never span an unrewritable gap (INV-13).
 */
function pushTextRuns(
  parts: ContentPart[],
  channel: Region["channel"],
  path: string,
  action: Action,
  regions: Region[],
): void {
  let i = 0;
  while (i < parts.length) {
    if (parts[i].type !== "text") {
      i++;
      continue;
    }
    let j = i;
    const indices: number[] = [];
    while (j < parts.length && parts[j].type === "text") {
      indices.push(j);
      j++;
    }
    pushTextRegion(parts, indices, channel, path, action, regions);
    i = j;
  }
}

interface JsonHolder {
  value: unknown;
}

interface JsonSlots {
  holder: JsonHolder;
  values: TextSegment[];
  keys: string[];
}

function collectJsonSlots(root: unknown): JsonSlots {
  const holder: JsonHolder = { value: root };
  const values: TextSegment[] = [];
  const keys: string[] = [];

  const walk = (value: unknown, assign: (v: unknown) => void): void => {
    if (typeof value === "string") {
      let current = value;
      values.push({
        get: () => current,
        set: (v: string) => {
          current = v;
          assign(v);
        },
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, (v) => {
        value[i] = v;
      }));
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        keys.push(key);
        walk(obj[key], (v) => {
          obj[key] = v;
        });
      }
    }
  };
  walk(root, (v) => {
    holder.value = v;
  });
  return { holder, values, keys };
}

function addJsonRegion(
  jsonText: string,
  channel: Region["channel"],
  path: string,
  action: Action,
  regions: Region[],
  setText: (text: string) => void,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Not JSON: fall back to raw substring handling for this channel.
    regions.push(
      setRegionAction(
        {
          channel,
          path,
          segments: [{ get: () => jsonText, set: setText }],
          detectOnly: action === "reject",
          rejectCode: "privacy_uncovered_channel",
        },
        action,
      ),
    );
    return;
  }
  const slots = collectJsonSlots(parsed);
  // JSON keys must not carry sensitive values (§7.3): detection-only region.
  for (const key of slots.keys) {
    regions.push({
      channel,
      path,
      segments: [{ get: () => key, set: () => undefined }],
      detectOnly: true,
      rejectCode: "privacy_json_key_placeholder",
      escapable: false,
    });
  }
  if (!slots.values.length) return;
  regions.push(
    setRegionAction(
      {
        channel,
        path,
        segments: slots.values,
        detectOnly: action === "reject",
        rejectCode: "privacy_uncovered_channel",
        serialize: () => JSON.stringify(slots.holder.value) ?? "null",
        write: (text: string) => setText(text),
      },
      action,
    ),
  );
}

function walkSchema(
  schema: unknown,
  path: string,
  coverage: NormalizedCoverage,
  regions: Region[],
): void {
  const visit = (node: unknown, p: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        if (typeof item === "string") {
          const arr = node as unknown[];
          if (coverage.toolSchema.valueBearing === "reject") {
            regions.push({
              channel: "tool_schema",
              path: `${p}[${i}]`,
              segments: [{ get: () => arr[i] as string, set: () => undefined }],
              detectOnly: true,
              rejectCode: "privacy_uncovered_channel",
              escapable: false,
            });
          }
        } else {
          visit(item, `${p}[${i}]`);
        }
      });
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const childPath = `${p}.${key}`;
      if (typeof value === "string") {
        // Schema `description` text is redactable; enum/default/examples are
        // value-bearing and rejected only when a sensitive value is detected.
        if (key === "description" || key === "title") {
          if (coverage.toolSchema.text === "redact") {
            regions.push(
              setRegionAction(
                {
                  channel: "tool_schema",
                  path: childPath,
                  segments: [
                    {
                      get: () => obj[key] as string,
                      set: (v: string) => {
                        obj[key] = v;
                      },
                    },
                  ],
                },
                "redact",
              ),
            );
          }
        } else if (coverage.toolSchema.valueBearing === "reject") {
          regions.push({
            channel: "tool_schema",
            path: childPath,
            segments: [{ get: () => obj[key] as string, set: () => undefined }],
            detectOnly: true,
            rejectCode: "privacy_uncovered_channel",
            escapable: false,
          });
        }
      } else {
        visit(value, childPath);
      }
    }
  };
  visit(schema, path);
}

/** Build all privacy regions for a canonical request, in document order. */
export function collectRequestRegions(
  canonical: CanonicalRequest,
  coverage: NormalizedCoverage,
): RequestRegions {
  const regions: Region[] = [];
  const extraHaystack: string[] = [];

  canonical.messages.forEach((message, mi) => {
    const content = message.content;
    const isSystem = message.role === "system" || message.role === "developer";
    const textChannel = isSystem ? "system" : "message_text";
    const textAction = isSystem ? coverage.system : coverage.message_text;
    let i = 0;
    while (i < content.length) {
      const part = content[i];
      const path = `messages[${mi}].content[${i}]`;
      if (part.type === "text") {
        let j = i;
        while (j < content.length && content[j].type === "text") j++;
        const indices: number[] = [];
        for (let k = i; k < j; k++) indices.push(k);
        pushTextRegion(
          content,
          indices,
          textChannel,
          `messages[${mi}].content`,
          textAction,
          regions,
        );
        i = j;
        continue;
      }
      if (part.type === "tool_result") {
        pushTextRuns(
          part.content,
          "tool_result",
          `${path}.content`,
          coverage.tool_result,
          regions,
        );
      } else if (part.type === "tool_call") {
        // The tool call id is a structural protocol identifier: it cannot be
        // escaped, so a shape literal there is rejected (E4).
        regions.push({
          channel: "tool_arguments",
          path: `${path}.id`,
          segments: [{ get: () => part.id, set: () => undefined }],
          detectOnly: true,
          rejectCode: "privacy_uncovered_channel",
          escapable: false,
        });
        addJsonRegion(
          part.argumentsText,
          "tool_arguments",
          `${path}.arguments`,
          coverage.tool_arguments,
          regions,
          (text) => {
            part.argumentsText = text;
          },
        );
      } else if (part.type === "reasoning") {
        const action = coverage.reasoning;
        const segments: TextSegment[] = [];
        if (typeof part.text === "string") {
          const target = part;
          segments.push({
            get: () => target.text ?? "",
            set: (v: string) => {
              target.text = v;
            },
          });
        }
        if (typeof part.summary === "string") {
          const target = part;
          segments.push({
            get: () => target.summary ?? "",
            set: (v: string) => {
              target.summary = v;
            },
          });
        }
        if (segments.length) {
          regions.push(
            setRegionAction(
              {
                channel: "reasoning",
                path,
                segments,
                detectOnly: action === "reject",
                rejectCode: "privacy_signature_guard",
                // Model-generated, signature-protected and never restored: an
                // exact token match here is a legitimate reference, not a
                // provenance collision.
                collisionScan: false,
              },
              action,
            ),
          );
        }
      } else if (part.type === "opaque_native") {
        // Unknown protocol block: its dynamic shape cannot be safely rewritten,
        // so it is detection-gated (fail-closed) rather than silently forwarded
        // (docs/07 §4.4 / §8.2.4).
        regions.push({
          channel: "native",
          path: `${path}.raw`,
          segments: [{ get: () => stringifyShallow(part.raw), set: () => undefined }],
          detectOnly: true,
          rejectCode: "privacy_uncovered_channel",
        });
      }
      i++;
    }
  });

  const extensions = canonical.extensions ?? {};
  const extensionsCoverage: { path: string; action: "redact" | "reject" }[] = [];

  canonical.tools?.forEach((tool, ti) => {
    if (tool.description !== undefined) {
      const path = `tools[${ti}].description`;
      const action = coverage.tool_description;
      regions.push(
        setRegionAction(
          {
            channel: "tool_description",
            path,
            segments: [
              {
                get: () => tool.description ?? "",
                set: (v: string) => {
                  tool.description = v;
                },
              },
            ],
            detectOnly: action === "reject",
            rejectCode: "privacy_uncovered_channel",
          },
          action,
        ),
      );
    }
    walkSchema(tool.inputSchema, `tools[${ti}].inputSchema`, coverage, regions);
    // Server-tool definitions carry native residue (type-specific parameters)
    // that must be covered like any other native partition (§8.2.4).
    collectNative(
      tool.native,
      coverage,
      regions,
      extraHaystack,
      extensionsCoverage,
      `tools[${ti}].native`,
    );
  });

  for (const [key, value] of Object.entries(extensions)) {
    const action = extensionAction(coverage, key);
    const path = `extensions.${key}`;
    if (action === "allow") {
      collectStrings(value, extraHaystack);
      continue;
    }
    extensionsCoverage.push({ path, action });
    if (action === "reject") {
      regions.push({
        channel: "extensions",
        path,
        segments: [{ get: () => stringifyShallow(value), set: () => undefined }],
        detectOnly: true,
        rejectCode: "privacy_uncovered_channel",
      });
      continue;
    }
    // redact: operate on the extension's string values (Value-only).
    if (typeof value === "string") {
      const holder = { value };
      regions.push(
        setRegionAction(
          {
            channel: "extensions",
            path,
            segments: [
              {
                get: () => holder.value,
                set: (v: string) => {
                  holder.value = v;
                },
              },
            ],
            serialize: () => holder.value,
            write: (text: string) => {
              extensions[key] = text;
            },
          },
          "redact",
        ),
      );
    } else {
      const slots = collectJsonSlots(value);
      if (slots.values.length) {
        regions.push(
          setRegionAction(
            {
              channel: "extensions",
              path,
              segments: slots.values,
            },
            "redact",
          ),
        );
      }
    }
  }

  collectNative(canonical.native, coverage, regions, extraHaystack, extensionsCoverage);
  return { regions, extraHaystack, extensionsCoverage };
}

/**
 * Walk native protocol partitions (docs/07 §8.2.4/§8.5). Native fields must be
 * covered like extensions: `allow` feeds the collision/egress haystack,
 * `redact` rewrites in place, `reject` is detection-gated. Non-allow paths join
 * the covered set so the double-evidence check applies once codecs report them.
 */
function collectNative(
  native: unknown,
  coverage: NormalizedCoverage,
  regions: Region[],
  extraHaystack: string[],
  coveredPaths: { path: string; action: "redact" | "reject" }[],
  pathPrefix = "native",
): void {
  if (!native || typeof native !== "object") return;
  for (const [proto, partition] of Object.entries(native as Record<string, unknown>)) {
    if (!partition || typeof partition !== "object") continue;
    for (const [key, value] of Object.entries(partition as Record<string, unknown>)) {
      if (value === undefined) continue;
      const path = `${pathPrefix}.${proto}.${key}`;
      const action = nativeAction(coverage, `${proto}.${key}`);
      if (action === "allow") {
        collectStrings(value, extraHaystack);
        continue;
      }
      coveredPaths.push({ path, action });
      if (action === "reject") {
        regions.push({
          channel: "native",
          path,
          segments: [{ get: () => stringifyShallow(value), set: () => undefined }],
          detectOnly: true,
          rejectCode: "privacy_uncovered_channel",
        });
        continue;
      }
      if (typeof value === "string") {
        const target = partition as Record<string, unknown>;
        const holder = { value };
        regions.push(
          setRegionAction(
            {
              channel: "native",
              path,
              segments: [
                {
                  get: () => holder.value,
                  set: (v: string) => {
                    holder.value = v;
                  },
                },
              ],
              serialize: () => holder.value,
              write: (text: string) => {
                target[key] = text;
              },
            },
            "redact",
          ),
        );
      } else {
        const slots = collectJsonSlots(value);
        if (slots.values.length) {
          regions.push(
            setRegionAction({ channel: "native", path, segments: slots.values }, "redact"),
          );
        }
      }
    }
  }
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function stringifyShallow(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}
