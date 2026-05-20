/**
 * View placement helpers — move AIML's chat view into the auxiliary
 * (right-side) sidebar by default.
 *
 * VS Code does not expose `auxiliarybar` as a valid `contributes.viewsContainers`
 * target, so we register normally in the activity bar and then call
 * private workbench commands at runtime to relocate the view. The exact
 * command name has shifted between VS Code versions, so we try several
 * candidates and silently fall through if none work — at worst the view
 * stays in its registered location and the user drags it.
 */

import * as vscode from 'vscode';

const FIRST_RUN_FLAG = 'aiml.placedInAuxiliarySidebar.v1';

const VIEW_IDS = ['aiml.chatView', 'aiml.chatPanelView'] as const;

export async function placeInAuxiliarySidebarIfFirstRun(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(FIRST_RUN_FLAG)) return;
  const ok = await tryMoveToAuxiliary();
  if (ok) {
    await context.globalState.update(FIRST_RUN_FLAG, true);
    void vscode.commands.executeCommand('aiml.chatView.focus').then(undefined, () => {});
  }
  // If it failed, we'll retry next activation. Eventually the user drags it
  // somewhere, or the explicit "Move to right side bar" command does it.
}

/** Public — wired to `aiml.moveToRightSidebar` for explicit user action. */
export async function moveToAuxiliarySidebar(): Promise<void> {
  // Make sure the auxiliary side bar is visible so the user sees the result.
  try {
    await vscode.commands.executeCommand('workbench.action.openAuxiliaryBar');
  } catch {
    // Older VS Code uses a toggle command — only call it if the bar is hidden.
    // Since we can't check, skip and rely on the move command itself.
  }
  const ok = await tryMoveToAuxiliary();
  if (!ok) {
    const pick = await vscode.window.showInformationMessage(
      "AIML couldn't be moved automatically on this VS Code build. Drag the AIML tab into the right-side bar to position it there.",
      'Show how',
    );
    if (pick === 'Show how') {
      void vscode.env.openExternal(
        vscode.Uri.parse(
          'https://code.visualstudio.com/docs/getstarted/userinterface#_side-bar',
        ),
      );
    }
  } else {
    void vscode.window.showInformationMessage('AIML is now on the right side bar.');
  }
}

/**
 * Best-effort: try every command variant we know of. Returns true on the
 * first one that doesn't throw.
 */
async function tryMoveToAuxiliary(): Promise<boolean> {
  const attempts: Array<() => Thenable<unknown>> = [];

  for (const viewId of VIEW_IDS) {
    // Modern (1.85+) public-ish command
    attempts.push(() =>
      vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: [viewId],
        destinationId: 'workbench.parts.auxiliarybar',
      }),
    );
    // Internal command used by some extensions
    attempts.push(() =>
      vscode.commands.executeCommand('_workbench.action.moveView', {
        viewId,
        destinationId: 'workbench.parts.auxiliarybar',
      }),
    );
    // Older variants
    attempts.push(() =>
      vscode.commands.executeCommand('workbench.action.moveViewToLocation', viewId, 'auxiliarybar'),
    );
    attempts.push(() =>
      vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: [viewId],
        destinationId: 'auxiliarybar',
      }),
    );
  }

  for (const fn of attempts) {
    try {
      await fn();
      return true;
    } catch {
      // Try next variant.
    }
  }
  return false;
}
