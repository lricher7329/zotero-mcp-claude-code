/**
 * Structured search conditions for search_library.
 *
 * Callers pass a tree of conditions; this module validates it and flattens it
 * into Zotero.Search addCondition() calls. Zotero 10 adds condition groups
 * (groupStart/groupEnd with a per-group joinMode), resultLevel, and the
 * isEmpty/isNotEmpty operators. On Zotero 7–9 only a flat list of conditions
 * joined with "all" can be expressed; anything else is rejected with a clear
 * error rather than silently changing the query's meaning.
 */

export type ResultLevel = "item" | "attachment" | "note" | "annotation";
export type JoinMode = "all" | "any";

export interface ConditionLeaf {
  field: string;
  operator: string;
  value?: string | number | boolean;
}

export interface ConditionGroup {
  joinMode?: JoinMode;
  resultLevel?: ResultLevel;
  conditions: ConditionNode[];
}

export type ConditionNode = ConditionLeaf | ConditionGroup;

/** One Zotero.Search#addCondition(name, operator, value) call. */
export type SearchCondition = [string, string, string];

export const RESULT_LEVELS: readonly ResultLevel[] = [
  "item",
  "attachment",
  "note",
  "annotation",
];

const OPERATORS = new Set([
  "is",
  "isNot",
  "contains",
  "doesNotContain",
  "beginsWith",
  "isLessThan",
  "isGreaterThan",
  "isBefore",
  "isAfter",
  "isInTheLast",
  "isEmpty",
  "isNotEmpty",
  "true",
  "false",
]);
const ZOTERO10_OPERATORS = new Set(["isEmpty", "isNotEmpty"]);

// Structural markers are generated from the tree, never accepted as fields.
const RESERVED_FIELDS = new Set([
  "groupStart",
  "groupEnd",
  "joinMode",
  "resultLevel",
  "tempTable",
]);

const MAX_DEPTH = 4;
const MAX_LEAVES = 50;

export class SearchConditionError extends Error {
  // Read by apiHandlers.handleSearch to answer 400 instead of 500
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "SearchConditionError";
  }
}

/** True when the running Zotero supports condition groups (Zotero 10+). */
export function supportsConditionGroups(): boolean {
  const conditions = (globalThis as any).Zotero?.SearchConditions;
  try {
    return !!conditions?.get?.("groupStart");
  } catch {
    return false;
  }
}

/** Accept the conditions tree as an array or a JSON string. */
export function parseConditions(raw: unknown): ConditionNode[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new SearchConditionError("conditions must be a JSON array");
    }
  }
  if (!Array.isArray(value)) {
    throw new SearchConditionError("conditions must be an array");
  }
  return value as ConditionNode[];
}

function isGroup(node: ConditionNode): node is ConditionGroup {
  return Array.isArray((node as ConditionGroup).conditions);
}

/**
 * Flatten a condition tree into addCondition() calls.
 *
 * On Zotero 10 the whole tree is wrapped in one group so its joinMode never
 * changes how the rest of search_library's filters combine.
 */
export function buildConditionList(
  nodes: ConditionNode[],
  options: { joinMode?: JoinMode; supportsGroups: boolean },
): SearchCondition[] {
  const joinMode = options.joinMode ?? "all";
  if (joinMode !== "all" && joinMode !== "any") {
    throw new SearchConditionError(`Invalid joinMode "${joinMode}"`);
  }
  if (nodes.length === 0) return [];

  const out: SearchCondition[] = [];
  let leaves = 0;

  const requireGroups = (what: string) => {
    if (!options.supportsGroups) {
      throw new SearchConditionError(`${what} requires Zotero 10`);
    }
  };

  const visit = (node: ConditionNode, depth: number) => {
    if (!node || typeof node !== "object") {
      throw new SearchConditionError("Each condition must be an object");
    }

    if (isGroup(node)) {
      requireGroups("A condition group");
      if (depth >= MAX_DEPTH) {
        throw new SearchConditionError(
          `Condition groups can be nested at most ${MAX_DEPTH} deep`,
        );
      }
      const groupJoin = node.joinMode ?? "all";
      if (groupJoin !== "all" && groupJoin !== "any") {
        throw new SearchConditionError(`Invalid joinMode "${groupJoin}"`);
      }
      if (node.conditions.length === 0) {
        throw new SearchConditionError("A condition group cannot be empty");
      }
      out.push(["groupStart", "true", ""]);
      out.push(["joinMode", groupJoin, ""]);
      if (node.resultLevel !== undefined) {
        if (!RESULT_LEVELS.includes(node.resultLevel)) {
          throw new SearchConditionError(
            `Invalid resultLevel "${node.resultLevel}"`,
          );
        }
        out.push(["resultLevel", node.resultLevel, ""]);
      }
      for (const child of node.conditions) visit(child, depth + 1);
      out.push(["groupEnd", "true", ""]);
      return;
    }

    const { field, operator, value } = node as ConditionLeaf;
    if (typeof field !== "string" || field.trim() === "") {
      throw new SearchConditionError("Each condition needs a field");
    }
    if (RESERVED_FIELDS.has(field)) {
      throw new SearchConditionError(
        `"${field}" is not allowed as a field; use groups, joinMode and resultLevel instead`,
      );
    }
    if (typeof operator !== "string" || !OPERATORS.has(operator)) {
      throw new SearchConditionError(
        `Invalid operator "${operator}" for field "${field}"`,
      );
    }
    if (ZOTERO10_OPERATORS.has(operator)) requireGroups(`"${operator}"`);
    if (++leaves > MAX_LEAVES) {
      throw new SearchConditionError(
        `At most ${MAX_LEAVES} conditions are allowed`,
      );
    }
    const text =
      operator === "isEmpty" || operator === "isNotEmpty"
        ? ""
        : value === undefined || value === null
          ? ""
          : String(value);
    out.push([field, operator, text]);
  };

  if (options.supportsGroups) {
    visit({ joinMode, conditions: nodes }, 0);
  } else {
    if (joinMode !== "all") requireGroups('conditionJoinMode "any"');
    for (const node of nodes) visit(node, 1);
  }
  return out;
}
