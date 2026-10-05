/**
 * Zotero 10 undo/redo integration for MCP write tools.
 *
 * Zotero 10 records modifications of existing objects on an in-memory undo
 * stack (Edit > Undo, Cmd/Ctrl+Z) when a save carries an action label. The
 * labels are Zotero's own Fluent message IDs, so they read the same as
 * Zotero's built-in commands. Creating or permanently deleting objects is not
 * undoable; trashing is, and Zotero.Items.trash() labels itself.
 *
 * On Zotero 7–9 (no Zotero.UndoHistory) these helpers are no-ops, so saves
 * behave exactly as before.
 */

export type UndoAction =
  | "undo-action-edit-metadata"
  | "undo-action-edit-note"
  | "undo-action-add-tag"
  | "undo-action-remove-tag"
  | "undo-action-add-to-collection"
  | "undo-action-remove-from-collection"
  | "undo-action-move-to-collection"
  | "undo-action-rename-collection"
  | "undo-action-move-collection"
  | "undo-action-restore-items"
  | "undo-action-trash"
  | "undo-action-add-related"
  | "undo-action-remove-related";

// Messages that take a { $count } plural argument in Zotero's zotero.ftl.
const COUNTED: ReadonlySet<UndoAction> = new Set<UndoAction>([
  "undo-action-edit-metadata",
  "undo-action-add-tag",
  "undo-action-remove-tag",
  "undo-action-add-to-collection",
  "undo-action-remove-from-collection",
  "undo-action-move-to-collection",
  "undo-action-restore-items",
  "undo-action-trash",
]);

function undoHistory(): any {
  return (Zotero as any).UndoHistory;
}

export function isUndoAvailable(): boolean {
  const history = undoHistory();
  return !!history && history.isEnabled?.() !== false;
}

function actionArgs(action: UndoAction, count: number) {
  return COUNTED.has(action) ? { count: Math.max(1, count) } : undefined;
}

/**
 * Options to merge into a saveTx()/save() call so the change lands on the
 * undo stack as one step. Empty on runtimes without undo support.
 */
export function undoOptions(
  action: UndoAction,
  count = 1,
): { undoAction?: UndoAction; undoActionArgs?: { count: number } } {
  if (!isUndoAvailable()) return {};
  const args = actionArgs(action, count);
  return args
    ? { undoAction: action, undoActionArgs: args }
    : { undoAction: action };
}

/**
 * Label the current transaction's changes as a single undo step. Call inside
 * Zotero.DB.executeTransaction() for multi-object saves.
 */
export function stageUndo(action: UndoAction, count = 1): void {
  if (!isUndoAvailable()) return;
  undoHistory().stageAction(action, actionArgs(action, count));
}
