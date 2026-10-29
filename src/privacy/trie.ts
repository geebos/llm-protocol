/**
 * Registered-placeholder trie with Maximal Munch matching (PR-019, §9.2).
 *
 * Two registered placeholders can share a prefix (`PII-phone-1` vs
 * `PII-phone-10`), so a match is only committed once it can no longer be
 * extended into a longer registered placeholder.
 */
import { parsePlaceholder, type CompiledTemplate } from "./template.js";

interface TrieNode {
  children: Map<string, TrieNode>;
  value?: string;
}

function newNode(): TrieNode {
  return { children: new Map() };
}

export interface PlaceholderMatcher {
  root: TrieNode;
  /**
   * Entity types this matcher holds registered tokens for. Used to tell a
   * mangled token of ours (`{..._phone-ab3kf}` typo'd by the model) from
   * unrelated external literal text: only the former is worth a warning.
   */
  knownTypes: Set<string>;
  matchAt(buffer: string, start: number, final: boolean): MatchResult;
}

export type MatchResult =
  | { kind: "match"; end: number; value: string }
  | { kind: "need_more" }
  | { kind: "no_match" };

export function createPlaceholderMatcher(
  compiled: CompiledTemplate,
  entries: { placeholder: string; original: string }[],
): PlaceholderMatcher {
  const root = newNode();
  const knownTypes = new Set<string>();
  for (const entry of entries) {
    const parsed = parsePlaceholder(compiled, entry.placeholder);
    if (parsed) knownTypes.add(parsed.type);
    let node = root;
    for (const ch of entry.placeholder) {
      let next = node.children.get(ch);
      if (!next) {
        next = newNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    node.value = entry.original;
  }

  function matchAt(buffer: string, start: number, final: boolean): MatchResult {
    let node = root;
    let cursor = start;
    let accepted: MatchResult | undefined;
    while (cursor < buffer.length) {
      const next = node.children.get(buffer[cursor]);
      if (!next) break;
      node = next;
      cursor++;
      if (node.value !== undefined) {
        accepted = { kind: "match", end: cursor, value: node.value };
      }
    }
    if (!final && cursor === buffer.length && node.children.size > 0) {
      return { kind: "need_more" };
    }
    return accepted ?? { kind: "no_match" };
  }

  return { root, knownTypes, matchAt };
}
