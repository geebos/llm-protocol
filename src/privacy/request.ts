/**
 * IR channel walk (§7.1): build privacy regions from the canonical request.
 *
 * Consecutive text parts are grouped into a single detection region so the
 * detection boundary matches the target codec's semantic join boundary
 * (PR-020, §7.2). Tool argument strings use JSON Value-only replacement and a
 * detection on a JSON key is a rejection (§7.3).
 */
import type { CanonicalRequest, ContentPart } from "../ir/types.js";
import type { NormalizedCoverage } from "./coverage.js";
import { extensionAction } from "./coverage.js";
import { Region, setRegionAction, TextSegment } from "./redact.js";

type Action = "redact" | "allow" | "reject";

export interface RequestRegions {
  regions: Region[];
  /** Model-visible strings in default-allow extensions (collision / egress). */
  extraHaystack: string[];
}

function textSegments(parts: ContentPart[], indices: number[]): TextSegment[] {
  return indices.map((i) => {
    const part = parts[i] as Extract<ContentPart, { type: "text" }>;
    return {
      get: () => part.text,
      set: (v: string) => {
        part.text = v;
      },
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

/** Region covering every text part in `parts` (used for tool_result content). */
function pushAllText(
  parts: ContentPart[],
  channel: Region["channel"],
  path: string,
  action: Action,
  regions: Region[],
): void {
  const indices: number[] = [];
  parts.forEach((part, i) => {
    if (part.type === "text") indices.push(i);
  });
  pushTextRegion(parts, indices, channel, path, action, regions);
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

  if (canonical.system?.length) {
    pushAllText(canonical.system, "system", "system.content", coverage.system, regions);
  }

  canonical.messages.forEach((message, mi) => {
    const content = message.content;
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
          "message_text",
          `messages[${mi}].content`,
          coverage.message_text,
          regions,
        );
        i = j;
        continue;
      }
      if (part.type === "tool_result") {
        pushAllText(
          part.content,
          "tool_result",
          `${path}.content`,
          coverage.tool_result,
          regions,
        );
      } else if (part.type === "tool_call") {
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
              },
              action,
            ),
          );
        }
      }
      i++;
    }
  });

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
  });

  const extensions = canonical.extensions ?? {};
  for (const [key, value] of Object.entries(extensions)) {
    const action = extensionAction(coverage, key);
    if (action === "allow") {
      collectStrings(value, extraHaystack);
    } else if (action === "reject") {
      regions.push({
        channel: "extensions",
        path: `extensions.${key}`,
        segments: [{ get: () => stringifyShallow(value), set: () => undefined }],
        detectOnly: true,
        rejectCode: "privacy_uncovered_channel",
      });
    }
  }

  return { regions, extraHaystack };
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
