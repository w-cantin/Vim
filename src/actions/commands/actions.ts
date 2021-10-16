import * as vscode from 'vscode';

import { RecordedState } from '../../state/recordedState';
import { ReplaceState } from '../../state/replaceState';
import { VimState } from '../../state/vimState';
import { getCursorsAfterSync, clamp } from '../../util/util';
import { Clipboard } from '../../util/clipboard';
import { FileCommand } from './../../cmd_line/commands/file';
import { OnlyCommand } from './../../cmd_line/commands/only';
import { QuitCommand } from './../../cmd_line/commands/quit';
import { Tab, TabCommand } from './../../cmd_line/commands/tab';
import { PositionDiff, earlierOf, laterOf, sorted } from './../../common/motion/position';
import { Cursor } from '../../common/motion/cursor';
import { NumericString } from './../../common/number/numericString';
import { configuration } from './../../configuration/configuration';
import {
  Mode,
  visualBlockGetTopLeftPosition,
  isVisualMode,
  visualBlockGetBottomRightPosition,
} from './../../mode/mode';
import { Register, RegisterMode } from './../../register/register';
import { SearchDirection } from './../../state/searchState';
import { EditorScrollByUnit, EditorScrollDirection, TextEditor } from './../../textEditor';
import { isTextTransformation, Transformation } from './../../transformations/transformations';
import { RegisterAction, BaseCommand } from './../base';
import { commandLine } from './../../cmd_line/commandLine';
import * as operator from './../operator';
import { Jump } from '../../jumps/jump';
import { StatusBar } from '../../statusBar';
import { reportFileInfo } from '../../util/statusBarTextUtils';
import { globalState } from '../../state/globalState';
import { SpecialKeys } from '../../util/specialKeys';
import { WordType } from '../../textobject/word';
import { Position } from 'vscode';
import { WriteQuitCommand } from '../../cmd_line/commands/writequit';
import { shouldWrapKey } from '../wrapping';
import { ErrorCode, VimError } from '../../error';

/**
 * A very special snowflake.
 *
 * Each keystroke when typing in Insert mode is its own Action, which means naively replaying a
 * realistic insertion (via `.` or a macro) does many small insertions, which is very slow.
 * So instead, we fold all those actions after the fact into a single DocumentContentChangeAction,
 * which compresses the changes, generally into a single document edit per cursor.
 */
export class DocumentContentChangeAction extends BaseCommand {
  modes = [];
  keys = [];

  private contentChanges: vscode.TextDocumentContentChangeEvent[] = [];

  public addChanges(changes: vscode.TextDocumentContentChangeEvent[]) {
    this.contentChanges = [...this.contentChanges, ...changes];
    this.compressChanges();
  }

  public getTransformation(positionDiff: PositionDiff): Transformation {
    return {
      type: 'contentChange',
      changes: this.contentChanges,
      diff: positionDiff,
    };
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (this.contentChanges.length === 0) {
      return;
    }

    const firstTextDiff = this.contentChanges[0];
    let originalLeftBoundary =
      firstTextDiff.text === '' && firstTextDiff.rangeLength === 1
        ? firstTextDiff.range.end
        : firstTextDiff.range.start;

    let rightBoundary: Position = position;
    for (const change of this.contentChanges) {
      if (change.range.start.line < originalLeftBoundary.line) {
        // This change should be ignored
        const linesAffected = change.range.end.line - change.range.start.line + 1;
        const resultLines = change.text.split('\n').length;
        originalLeftBoundary = originalLeftBoundary.with(
          originalLeftBoundary.line + resultLines - linesAffected
        );
        continue;
      }

      // Translates diffPos from a position relative to originalLeftBoundary to one relative to position
      const translate = (diffPos: Position): Position => {
        const lineOffset = diffPos.line - originalLeftBoundary.line;
        const char =
          lineOffset === 0
            ? position.character + diffPos.character - originalLeftBoundary.character
            : diffPos.character;
        // TODO: Should we document.validate() this position?
        return new Position(Math.max(position.line + lineOffset, 0), Math.max(char, 0));
      };

      const replaceRange = new vscode.Range(
        translate(change.range.start),
        translate(change.range.end)
      );

      if (replaceRange.start.isAfter(rightBoundary)) {
        // This change should be ignored as it's out of boundary
        continue;
      }

      // Calculate new right boundary
      const textDiffLines = change.text.split('\n');
      const numLinesAdded = textDiffLines.length - 1;
      const newRightBoundary =
        numLinesAdded === 0
          ? new Position(replaceRange.start.line, replaceRange.start.character + change.text.length)
          : new Position(replaceRange.start.line + numLinesAdded, textDiffLines.pop()!.length);

      rightBoundary = laterOf(rightBoundary, newRightBoundary);

      if (replaceRange.start.isEqual(replaceRange.end)) {
        vimState.recordedState.transformer.addTransformation({
          type: 'insertText',
          position: replaceRange.start,
          text: change.text,
        });
      } else {
        vimState.recordedState.transformer.addTransformation({
          type: 'replaceText',
          range: replaceRange,
          text: change.text,
        });
      }
    }
  }

  private compressChanges(): void {
    function merge(
      first: vscode.TextDocumentContentChangeEvent,
      second: vscode.TextDocumentContentChangeEvent
    ): vscode.TextDocumentContentChangeEvent | undefined {
      if (
        first.rangeOffset + first.text.length === second.rangeOffset ||
        second.rangeLength === 0
      ) {
        // Simple concatenation
        return {
          text: first.text + second.text,
          range: first.range,
          rangeOffset: first.rangeOffset,
          rangeLength: first.rangeLength,
        };
      } else if (
        first.rangeOffset <= second.rangeOffset &&
        first.text.length >= second.rangeLength
      ) {
        const start = second.rangeOffset - first.rangeOffset;
        const end = start + second.rangeLength;
        const text = first.text.slice(0, start) + second.text + first.text.slice(end);
        // `second` replaces part of `first`
        // Most often, this is the result of confirming an auto-completion
        return {
          text,
          range: first.range,
          rangeOffset: first.rangeOffset,
          rangeLength: first.rangeLength,
        };
      } else {
        // TODO: Do any of the cases falling into this `else` matter?
        return undefined;
      }
    }

    const compressed: vscode.TextDocumentContentChangeEvent[] = [];
    let prev: vscode.TextDocumentContentChangeEvent | undefined;
    for (const change of this.contentChanges) {
      if (prev === undefined) {
        prev = change;
      } else {
        const merged = merge(prev, change);
        if (merged) {
          prev = merged;
        } else {
          compressed.push(prev);
          prev = change;
        }
      }
    }
    if (prev !== undefined) {
      compressed.push(prev);
    }
    this.contentChanges = compressed;
  }
}

@RegisterAction
class DisableExtension extends BaseCommand {
  modes = [
    Mode.Normal,
    Mode.Insert,
    Mode.Visual,
    Mode.VisualBlock,
    Mode.VisualLine,
    Mode.SearchInProgressMode,
    Mode.CommandlineInProgress,
    Mode.Replace,
    Mode.EasyMotionMode,
    Mode.EasyMotionInputMode,
    Mode.SneakLabelInputMode,
    Mode.SurroundInputMode,
  ];
  keys = [SpecialKeys.ExtensionDisable];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Disabled);
  }
}

@RegisterAction
class EnableExtension extends BaseCommand {
  modes = [Mode.Disabled];
  keys = [SpecialKeys.ExtensionEnable];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
export class CommandNumber extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['<number>'];
  isCompleteAction = false;
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const num = parseInt(this.keysPressed[0], 10);
    const operatorCount = vimState.recordedState.operatorCount;

    if (operatorCount > 0) {
      const lastAction =
        vimState.recordedState.actionsRun[vimState.recordedState.actionsRun.length - 2];
      if (!(lastAction instanceof CommandNumber)) {
        // We have set an operatorCount !== 0 after an operator, but now we got another count
        // number so we need to multiply them.
        vimState.recordedState.count = operatorCount * num;
      } else {
        // We are now getting another digit which means we need to multiply by 10 and add
        // the new digit multiplied by operatorCount.
        //
        // Example: user presses '2d31w':
        // - After '2' the number 2 is stored in 'count'
        // - After 'd' the count (2) is stored in 'operatorCount'
        // - After '3' the number 3 multiplied by 'operatorCount' (3 x 2 = 6) is stored in 'count'
        // - After '1' the count is multiplied by 10 and added by number 1 multiplied by 'operatorCount'
        //   (6 * 10 + 1 * 2 = 62)
        // The final result will be the deletion of 62 words.
        vimState.recordedState.count = vimState.recordedState.count * 10 + num * operatorCount;
      }
    } else {
      vimState.recordedState.count = vimState.recordedState.count * 10 + num;
    }
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    const isZero = keysPressed[0] === '0';

    return (
      super.doesActionApply(vimState, keysPressed) &&
      ((isZero && vimState.recordedState.count > 0) || !isZero)
    );
  }

  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    const isZero = keysPressed[0] === '0';

    return (
      super.couldActionApply(vimState, keysPressed) &&
      ((isZero && vimState.recordedState.count > 0) || !isZero)
    );
  }
}

@RegisterAction
export class CommandRegister extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['"', '<character>'];
  isCompleteAction = false;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const register = this.keysPressed[1];

    if (Register.isValidRegister(register)) {
      vimState.recordedState.registerName = register;
    } else {
      // TODO: Changing isCompleteAction here is maybe a bit janky - should it be a function?
      this.isCompleteAction = true;
    }
  }
}

@RegisterAction
class CommandRecordMacro extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [
    ['q', '<alpha>'],
    ['q', '<number>'],
    ['q', '"'],
  ];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const registerKey = this.keysPressed[1];
    const register = registerKey.toLocaleLowerCase();
    vimState.macro = new RecordedState();
    vimState.macro.registerName = register;

    if (!/^[A-Z]+$/.test(registerKey) || !Register.has(register)) {
      // If register name is upper case, it means we are appending commands to existing register instead of overriding.
      // TODO: this seems suspect - why are we not putting `vimState.macro` in the register? Why are we setting `registerName`?
      const newRegister = new RecordedState();
      newRegister.registerName = register;

      vimState.recordedState.registerName = register;
      Register.put(vimState, newRegister);
    }
  }
}

@RegisterAction
export class CommandQuitRecordMacro extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = ['q'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const macro = vimState.macro!;

    const existingMacro = (await Register.get(macro.registerName))?.text;
    if (existingMacro instanceof RecordedState) {
      existingMacro.actionsRun = existingMacro.actionsRun.concat(macro.actionsRun);
    }

    vimState.macro = undefined;
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return super.doesActionApply(vimState, keysPressed) && vimState.macro !== undefined;
  }

  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return super.couldActionApply(vimState, keysPressed) && vimState.macro !== undefined;
  }
}

@RegisterAction
class CommandExecuteLastMacro extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = ['@', '@'];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const { lastInvokedMacro } = vimState;

    if (lastInvokedMacro) {
      vimState.recordedState.transformer.addTransformation({
        type: 'macro',
        register: lastInvokedMacro.registerName,
        replay: 'contentChange',
      });
    }
  }
}

@RegisterAction
class CommandExecuteMacro extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = ['@', '<character>'];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const register = this.keysPressed[1].toLocaleLowerCase();

    if (!Register.isValidRegister(register)) {
      StatusBar.displayError(
        vimState,
        VimError.fromCode(ErrorCode.InvalidRegisterName, `'${register}'`)
      );
    }

    if (Register.has(register)) {
      vimState.recordedState.transformer.addTransformation({
        type: 'macro',
        register,
        replay: 'contentChange',
      });
    }
  }
}

@RegisterAction
class CommandEsc extends BaseCommand {
  modes = [
    Mode.Visual,
    Mode.VisualLine,
    Mode.VisualBlock,
    Mode.Normal,
    Mode.SurroundInputMode,
    Mode.EasyMotionMode,
    Mode.EasyMotionInputMode,
    Mode.SneakLabelInputMode,
  ];
  keys = [['<Esc>'], ['<C-c>'], ['<C-[>']];

  runsOnceForEveryCursor() {
    return false;
  }

  preservesDesiredColumn() {
    return true;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (vimState.currentMode === Mode.Normal) {
      vimState.surround = undefined;

      if (!vimState.isMultiCursor) {
        // If there's nothing to do on the vim side, we might as well call some
        // of vscode's default "close notification" actions. I think we should
        // just add to this list as needed.
        await Promise.allSettled([
          vscode.commands.executeCommand('closeReferenceSearchEditor'),
          vscode.commands.executeCommand('closeMarkersNavigation'),
          vscode.commands.executeCommand('closeDirtyDiff'),
        ]);

        return;
      }
    }

    if (vimState.currentMode === Mode.EasyMotionMode) {
      vimState.easyMotion.clearDecorations(vimState.editor);
    }

    // Abort surround operation
    if (vimState.currentMode === Mode.SurroundInputMode) {
      vimState.surround = undefined;
    }

    await vimState.setCurrentMode(Mode.Normal);

    if (!vimState.isMultiCursor) {
      vimState.cursors = [vimState.cursors[0]];
    }
  }
}

abstract class CommandEditorScroll extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  runsOnceForEachCountPrefix = false;
  abstract to: EditorScrollDirection;
  abstract by: EditorScrollByUnit;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const timesToRepeat = vimState.recordedState.count || 1;
    const visibleRange = vimState.editor.visibleRanges[0];
    const scrolloff = configuration
      .getConfiguration('editor')
      .get<number>('cursorSurroundingLines', 0);

    const linesAboveCursor =
      visibleRange.end.line - vimState.cursorStopPosition.line - timesToRepeat;
    const linesBelowCursor =
      vimState.cursorStopPosition.line - visibleRange.start.line - timesToRepeat;
    if (this.to === 'up' && scrolloff > linesAboveCursor) {
      vimState.cursorStopPosition = vimState.cursorStopPosition
        .getUp(scrolloff - linesAboveCursor)
        .withColumn(vimState.desiredColumn);
    } else if (this.to === 'down' && scrolloff > linesBelowCursor) {
      vimState.cursorStopPosition = vimState.cursorStopPosition
        .getDown(scrolloff - linesBelowCursor)
        .withColumn(vimState.desiredColumn);
    }

    vimState.postponedCodeViewChanges.push({
      command: 'editorScroll',
      args: {
        to: this.to,
        by: this.by,
        value: timesToRepeat,
        revealCursor: true,
        select: isVisualMode(vimState.currentMode),
      },
    });
  }
}

@RegisterAction
class CommandCtrlE extends CommandEditorScroll {
  keys = ['<C-e>'];
  preservesDesiredColumn() {
    return true;
  }
  to: EditorScrollDirection = 'down';
  by: EditorScrollByUnit = 'line';
}

@RegisterAction
class CommandCtrlY extends CommandEditorScroll {
  keys = ['<C-y>'];
  preservesDesiredColumn() {
    return true;
  }
  to: EditorScrollDirection = 'up';
  by: EditorScrollByUnit = 'line';
}

/**
 * Commands like `<C-d>` and `<C-f>` act *sort* of like `<count><C-e>`, but they move
 * your cursor down and put it on the first non-whitespace character of the line.
 */
abstract class CommandScrollAndMoveCursor extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  runsOnceForEachCountPrefix = false;
  abstract to: EditorScrollDirection;

  /**
   * @returns the number of lines this command should move the cursor
   */
  protected abstract getNumLines(vimState: VimState): number;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const { visibleRanges } = vimState.editor;
    const smoothScrolling = configuration
      .getConfiguration('editor')
      .get<boolean>('smoothScrolling', false);
    const moveLines = (vimState.actionCount || 1) * this.getNumLines(vimState);

    let scrollLines = moveLines;
    if (this.to === 'down') {
      // This makes <C-d> less wonky when `editor.scrollBeyondLastLine` is enabled
      scrollLines = Math.min(
        moveLines,
        vimState.document.lineCount - 1 - visibleRanges[visibleRanges.length - 1].end.line
      );
    }

    if (scrollLines > 0) {
      const args = {
        to: this.to,
        by: 'line',
        value: scrollLines,
        revealCursor: smoothScrolling,
        select: isVisualMode(vimState.currentMode),
      };
      if (smoothScrolling) {
        await vscode.commands.executeCommand('editorScroll', args);
      } else {
        vimState.postponedCodeViewChanges.push({
          command: 'editorScroll',
          args,
        });
      }
    }

    const newPositionLine = clamp(
      position.line + (this.to === 'down' ? moveLines : -moveLines),
      0,
      vimState.document.lineCount - 1
    );
    vimState.cursorStopPosition = new Position(
      newPositionLine,
      vimState.desiredColumn
    ).obeyStartOfLine(vimState.document);
  }
}

@RegisterAction
class CommandMoveFullPageUp extends CommandScrollAndMoveCursor {
  keys = ['<C-b>'];
  to: EditorScrollDirection = 'up';

  protected getNumLines(vimState: VimState) {
    const visible = vimState.editor.visibleRanges[0];
    return visible.end.line - visible.start.line;
  }
}

@RegisterAction
class CommandMoveFullPageDown extends CommandScrollAndMoveCursor {
  keys = ['<C-f>'];
  to: EditorScrollDirection = 'down';

  protected getNumLines(vimState: VimState) {
    const visible = vimState.editor.visibleRanges[0];
    return visible.end.line - visible.start.line;
  }
}

@RegisterAction
class CommandMoveHalfPageDown extends CommandScrollAndMoveCursor {
  keys = ['<C-d>'];
  to: EditorScrollDirection = 'down';

  protected getNumLines(vimState: VimState) {
    return configuration.getScrollLines(vimState.editor.visibleRanges);
  }
}

@RegisterAction
class CommandMoveHalfPageUp extends CommandScrollAndMoveCursor {
  keys = ['<C-u>'];
  to: EditorScrollDirection = 'up';

  protected getNumLines(vimState: VimState) {
    return configuration.getScrollLines(vimState.editor.visibleRanges);
  }
}

@RegisterAction
export class CommandInsertAtCursor extends BaseCommand {
  modes = [Mode.Normal];
  keys = [['i'], ['<Insert>']];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Only allow this command to be prefixed with a count or nothing, no other
    // actions or operators before
    let previousActionsNumbers = true;
    for (const prevAction of vimState.recordedState.actionsRun) {
      if (!(prevAction instanceof CommandNumber)) {
        previousActionsNumbers = false;
        break;
      }
    }

    if (vimState.recordedState.actionsRun.length === 0 || previousActionsNumbers) {
      return super.couldActionApply(vimState, keysPressed);
    }
    return false;
  }
}

@RegisterAction
export class CommandReplaceAtCursorFromNormalMode extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['R'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const timesToRepeat = vimState.recordedState.count || 1;

    await vimState.setCurrentMode(Mode.Replace);
    vimState.replaceState = new ReplaceState(vimState, position, timesToRepeat);
  }
}

/**
 * Our Vim implementation selects up to but not including the final character
 * of a visual selection, instead opting to render a block cursor on the final
 * character. This works for everything except VSCode's native copy command,
 * which loses the final character because it's not selected. We override that
 * copy command here by default to include the final character.
 */
@RegisterAction
class CommandOverrideCopy extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine, Mode.VisualBlock, Mode.Insert, Mode.Normal];
  keys = ['<copy>']; // A special key - see ModeHandler

  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    let text = '';

    if (vimState.currentMode === Mode.Visual) {
      text = vimState.cursors
        .map((range) => {
          const [start, stop] = sorted(range.start, range.stop);
          return vimState.document.getText(new vscode.Range(start, stop.getRight()));
        })
        .join('\n');
    } else if (vimState.currentMode === Mode.VisualLine) {
      text = vimState.cursors
        .map((range) => {
          return vimState.document.getText(
            new vscode.Range(
              earlierOf(range.start.getLineBegin(), range.stop.getLineBegin()),
              laterOf(range.start.getLineEnd(), range.stop.getLineEnd())
            )
          );
        })
        .join('\n');
    } else if (vimState.currentMode === Mode.VisualBlock) {
      for (const { line } of TextEditor.iterateLinesInBlock(vimState)) {
        text += line + '\n';
      }
    } else if (vimState.currentMode === Mode.Insert || vimState.currentMode === Mode.Normal) {
      text = vimState.editor.selections
        .map((selection) => {
          return vimState.document.getText(new vscode.Range(selection.start, selection.end));
        })
        .join('\n');
    }

    await Clipboard.Copy(text);
    // all vim yank operations return to normal mode.
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class CommandCmdA extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['<D-a>'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.cursorStartPosition = new Position(0, vimState.desiredColumn);
    vimState.cursorStopPosition = new Position(
      vimState.document.lineCount - 1,
      vimState.desiredColumn
    );
    await vimState.setCurrentMode(Mode.VisualLine);
  }
}

@RegisterAction
class MarkCommand extends BaseCommand {
  keys = ['m', '<character>'];
  modes = [Mode.Normal];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const markName = this.keysPressed[1];

    vimState.historyTracker.addMark(position, markName);
  }
}

@RegisterAction
class CommandShowCommandLine extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = [':'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (vimState.currentMode === Mode.Normal) {
      if (vimState.recordedState.count) {
        vimState.currentCommandlineText = `.,.+${vimState.recordedState.count - 1}`;
      } else {
        vimState.currentCommandlineText = '';
      }
    } else {
      vimState.currentCommandlineText = "'<,'>";
    }

    // Initialize the cursor position
    vimState.statusBarCursorCharacterPos = vimState.currentCommandlineText.length;

    // Store the current mode for use in retaining selection
    commandLine.previousMode = vimState.currentMode;

    // Change to the new mode
    await vimState.setCurrentMode(Mode.CommandlineInProgress);

    // Reset history navigation index
    commandLine.commandLineHistoryIndex = commandLine.historyEntries.length;
  }
}

@RegisterAction
export class CommandShowCommandHistory extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['q', ':'];

  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.recordedState.transformer.addTransformation({
      type: 'showCommandHistory',
    });

    if (vimState.currentMode === Mode.Normal) {
      vimState.currentCommandlineText = '';
    } else {
      vimState.currentCommandlineText = "'<,'>";
    }
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
export class CommandShowSearchHistory extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = [
    ['q', '/'],
    ['q', '?'],
  ];

  private direction = SearchDirection.Forward;

  runsOnceForEveryCursor() {
    return false;
  }

  public constructor(direction = SearchDirection.Forward) {
    super();
    this.direction = direction;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (this.keysPressed.includes('?')) {
      this.direction = SearchDirection.Backward;
    }
    vimState.recordedState.transformer.addTransformation({
      type: 'showSearchHistory',
      direction: this.direction,
    });

    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class CommandDot extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['.'];

  public async execCount(position: Position, vimState: VimState): Promise<void> {
    if (globalState.previousFullAction) {
      const count = vimState.recordedState.count || 1;

      for (let i = 0; i < count; i++) {
        vimState.recordedState.transformer.addTransformation({
          type: 'replayRecordedState',
          recordedState: globalState.previousFullAction,
        });
      }
    }
  }
}

@RegisterAction
class CommandRepeatSubstitution extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['&'];
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // Parsing the command from a string, while not ideal, is currently
    // necessary to make this work with and without neovim integration
    await commandLine.Run('s', vimState);
  }
}

type FoldDirection = 'up' | 'down' | undefined;
abstract class CommandFold extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  abstract commandName: string;
  direction: FoldDirection | undefined;

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Don't run if there's an operator because the Sneak plugin uses <operator>z
    return (
      super.doesActionApply(vimState, keysPressed) && vimState.recordedState.operator === undefined
    );
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const timesToRepeat = vimState.recordedState.count || 1;
    const args =
      this.direction !== undefined
        ? { levels: timesToRepeat, direction: this.direction }
        : undefined;
    await vscode.commands.executeCommand(this.commandName, args);
    vimState.cursors = getCursorsAfterSync();
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class CommandToggleFold extends CommandFold {
  keys = ['z', 'a'];
  commandName = 'editor.toggleFold';
}

@RegisterAction
class CommandCloseFold extends CommandFold {
  keys = ['z', 'c'];
  commandName = 'editor.fold';
  direction: FoldDirection = 'up';
}

@RegisterAction
class CommandCloseAllFolds extends CommandFold {
  keys = ['z', 'M'];
  commandName = 'editor.foldAll';
}

@RegisterAction
class CommandOpenFold extends CommandFold {
  keys = ['z', 'o'];
  commandName = 'editor.unfold';
  direction: FoldDirection = 'down';
}

@RegisterAction
class CommandOpenAllFolds extends CommandFold {
  keys = ['z', 'R'];
  commandName = 'editor.unfoldAll';
}

@RegisterAction
class CommandCloseAllFoldsRecursively extends CommandFold {
  modes = [Mode.Normal];
  keys = ['z', 'C'];
  commandName = 'editor.foldRecursively';
}

@RegisterAction
class CommandOpenAllFoldsRecursively extends CommandFold {
  modes = [Mode.Normal];
  keys = ['z', 'O'];
  commandName = 'editor.unfoldRecursively';
}

@RegisterAction
class CommandCenterScroll extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['z', 'z'];

  preservesDesiredColumn() {
    return true;
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Don't run if there's an operator because the Sneak plugin uses <operator>z
    return (
      super.doesActionApply(vimState, keysPressed) && vimState.recordedState.operator === undefined
    );
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // In these modes you want to center on the cursor position
    vimState.editor.revealRange(
      new vscode.Range(vimState.cursorStopPosition, vimState.cursorStopPosition),
      vscode.TextEditorRevealType.InCenter
    );
  }
}

@RegisterAction
class CommandCenterScrollFirstChar extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['z', '.'];

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Don't run if there's an operator because the Sneak plugin uses <operator>z
    return (
      super.doesActionApply(vimState, keysPressed) && vimState.recordedState.operator === undefined
    );
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // In these modes you want to center on the cursor position
    // This particular one moves cursor to first non blank char though
    vimState.editor.revealRange(
      new vscode.Range(vimState.cursorStopPosition, vimState.cursorStopPosition),
      vscode.TextEditorRevealType.InCenter
    );

    // Move cursor to first char of line
    vimState.cursorStopPosition = TextEditor.getFirstNonWhitespaceCharOnLine(
      vimState.document,
      vimState.cursorStopPosition.line
    );
  }
}

@RegisterAction
class CommandTopScroll extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['z', 't'];

  preservesDesiredColumn() {
    return true;
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Don't run if there's an operator because the Sneak plugin uses <operator>z
    return (
      super.doesActionApply(vimState, keysPressed) && vimState.recordedState.operator === undefined
    );
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'revealLine',
      args: {
        lineNumber: position.line,
        at: 'top',
      },
    });
  }
}

@RegisterAction
class CommandTopScrollFirstChar extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['z', '\n'];

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Don't run if there's an operator because the Sneak plugin uses <operator>z
    return (
      super.doesActionApply(vimState, keysPressed) && vimState.recordedState.operator === undefined
    );
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // In these modes you want to center on the cursor position
    // This particular one moves cursor to first non blank char though
    vimState.postponedCodeViewChanges.push({
      command: 'revealLine',
      args: {
        lineNumber: position.line,
        at: 'top',
      },
    });

    // Move cursor to first char of line
    vimState.cursorStopPosition = TextEditor.getFirstNonWhitespaceCharOnLine(
      vimState.document,
      vimState.cursorStopPosition.line
    );
  }
}

@RegisterAction
class CommandBottomScroll extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['z', 'b'];

  preservesDesiredColumn() {
    return true;
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Don't run if there's an operator because the Sneak plugin uses <operator>z
    return (
      super.doesActionApply(vimState, keysPressed) && vimState.recordedState.operator === undefined
    );
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'revealLine',
      args: {
        lineNumber: position.line,
        at: 'bottom',
      },
    });
  }
}

@RegisterAction
class CommandBottomScrollFirstChar extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['z', '-'];

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Don't run if there's an operator because the Sneak plugin uses <operator>z
    return (
      super.doesActionApply(vimState, keysPressed) && vimState.recordedState.operator === undefined
    );
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // In these modes you want to center on the cursor position
    // This particular one moves cursor to first non blank char though
    vimState.postponedCodeViewChanges.push({
      command: 'revealLine',
      args: {
        lineNumber: position.line,
        at: 'bottom',
      },
    });

    // Move cursor to first char of line
    vimState.cursorStopPosition = TextEditor.getFirstNonWhitespaceCharOnLine(
      vimState.document,
      vimState.cursorStopPosition.line
    );
  }
}

@RegisterAction
class CommandGoToOtherEndOfHighlightedText extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['o'];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    [vimState.cursorStartPosition, vimState.cursorStopPosition] = [
      vimState.cursorStopPosition,
      vimState.cursorStartPosition,
    ];
  }
}

@RegisterAction
class CommandGoToOtherSideOfHighlightedText extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['O'];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (vimState.currentMode === Mode.VisualBlock) {
      [vimState.cursorStartPosition, vimState.cursorStopPosition] = [
        new vscode.Position(
          vimState.cursorStartPosition.line,
          vimState.cursorStopPosition.character
        ),
        new vscode.Position(
          vimState.cursorStopPosition.line,
          vimState.cursorStartPosition.character
        ),
      ];
    } else {
      return new CommandGoToOtherEndOfHighlightedText().exec(position, vimState);
    }
  }
}

@RegisterAction
export class CommandUndo extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['u'];
  // we support a count to undo by this setting
  runsOnceForEachCountPrefix = true;
  runsOnceForEveryCursor() {
    return false;
  }
  // to prevent undo for accidental key chords like: cu, du...
  mustBeFirstKey = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const newPosition = await vimState.historyTracker.goBackHistoryStep();

    if (newPosition === undefined) {
      StatusBar.setText(vimState, 'Already at oldest change');
    } else {
      vimState.cursors = [new Cursor(newPosition, newPosition)];
    }

    vimState.alteredHistory = true;
  }
}

@RegisterAction
class CommandUndoOnLine extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['U'];
  runsOnceForEveryCursor() {
    return false;
  }
  mustBeFirstKey = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const newPosition = await vimState.historyTracker.goBackHistoryStepsOnLine();

    if (newPosition !== undefined) {
      vimState.cursors = [new Cursor(newPosition, newPosition)];
    }

    vimState.alteredHistory = true;
  }
}

@RegisterAction
class CommandRedo extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['<C-r>'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const newPosition = await vimState.historyTracker.goForwardHistoryStep();

    if (newPosition === undefined) {
      StatusBar.setText(vimState, 'Already at newest change');
    } else {
      vimState.cursors = [new Cursor(newPosition, newPosition)];
    }

    vimState.alteredHistory = true;
  }
}

@RegisterAction
class CommandDeleteToLineEnd extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['D'];
  canBeRepeatedWithDot = true;
  runsOnceForEveryCursor() {
    return true;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (position.isLineEnd()) {
      return;
    }

    const linesDown = (vimState.recordedState.count || 1) - 1;
    const start = position;
    const end = position.getDown(linesDown).getLineEnd().getLeftThroughLineBreaks();

    await new operator.DeleteOperator(this.multicursorIndex).run(vimState, start, end);
  }
}

@RegisterAction
export class CommandYankFullLine extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['Y'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const linesDown = (vimState.recordedState.count || 1) - 1;
    const start = position.getLineBegin();
    const end = position.getDown(linesDown).getLeft();

    vimState.currentRegisterMode = RegisterMode.LineWise;

    await new operator.YankOperator(this.multicursorIndex).run(vimState, start, end);
  }
}

@RegisterAction
class CommandChangeToLineEnd extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['C'];
  runsOnceForEachCountPrefix = false;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const count = vimState.recordedState.count || 1;

    await new operator.ChangeOperator(this.multicursorIndex).run(
      vimState,
      position,
      position
        .getDown(Math.max(0, count - 1))
        .getLineEnd()
        .getLeft()
    );
  }
}

@RegisterAction
class CommandClearLine extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['S'];
  runsOnceForEachCountPrefix = false;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new operator.ChangeOperator(this.multicursorIndex).runRepeat(
      vimState,
      position,
      vimState.recordedState.count || 1
    );
  }

  // Don't clash with sneak
  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return super.doesActionApply(vimState, keysPressed) && !configuration.sneak;
  }

  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return super.couldActionApply(vimState, keysPressed) && !configuration.sneak;
  }
}

@RegisterAction
class CommandExitVisualMode extends BaseCommand {
  modes = [Mode.Visual];
  keys = ['v'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class CommandVisualMode extends BaseCommand {
  modes = [Mode.Normal, Mode.VisualLine, Mode.VisualBlock];
  keys = ['v'];
  isCompleteAction = false;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (vimState.currentMode === Mode.Normal && vimState.recordedState.count > 1) {
      vimState.cursorStopPosition = position.getRight(vimState.recordedState.count - 1);
    }
    await vimState.setCurrentMode(Mode.Visual);
  }
}

@RegisterAction
class CommandReselectVisual extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['g', 'v'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // Try to restore selection only if valid
    if (vimState.lastVisualSelection !== undefined) {
      if (vimState.lastVisualSelection.end.line <= vimState.document.lineCount - 1) {
        await vimState.setCurrentMode(vimState.lastVisualSelection.mode);
        vimState.cursorStartPosition = vimState.lastVisualSelection.start;
        vimState.cursorStopPosition = vimState.lastVisualSelection.end.getLeft();
      }
    }
  }
}

@RegisterAction
class CommandVisualBlockMode extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [['<C-v>'], ['<C-q>']];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (vimState.currentMode === Mode.Normal && vimState.recordedState.count > 1) {
      vimState.cursorStopPosition = position.getRight(vimState.recordedState.count - 1);
    }
    await vimState.setCurrentMode(Mode.VisualBlock);
  }
}

@RegisterAction
class CommandExitVisualBlockMode extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = [['<C-v>'], ['<C-q>']];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class CommandVisualLineMode extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualBlock];
  keys = ['V'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (vimState.currentMode === Mode.Normal && vimState.recordedState.count > 1) {
      vimState.cursorStopPosition = position.getDown(vimState.recordedState.count - 1);
    }
    await vimState.setCurrentMode(Mode.VisualLine);
  }
}

@RegisterAction
class CommandExitVisualLineMode extends BaseCommand {
  modes = [Mode.VisualLine];
  keys = ['V'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class CommandOpenFile extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual];
  keys = ['g', 'f'];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    let fullFilePath: string;
    if (vimState.currentMode === Mode.Visual) {
      fullFilePath = vimState.document.getText(vimState.editor.selection);
    } else {
      const range = new vscode.Range(
        position.prevWordStart(vimState.document, { wordType: WordType.FileName, inclusive: true }),
        position.nextWordStart(vimState.document, { wordType: WordType.FileName })
      );

      fullFilePath = vimState.document.getText(range).trim();
    }

    const fileInfo = fullFilePath.match(/(.*?(?=:[0-9]+)|.*):?([0-9]*)$/);
    if (fileInfo) {
      const filePath = fileInfo[1];
      const lineNumber = parseInt(fileInfo[2], 10);
      const fileCommand = new FileCommand({
        name: filePath,
        lineNumber,
        createFileIfNotExists: false,
      });
      fileCommand.execute(vimState);
    }
  }
}

@RegisterAction
class CommandGoToDefinition extends BaseCommand {
  modes = [Mode.Normal];
  keys = [['g', 'd'], ['<C-]>']];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vscode.commands.executeCommand('editor.action.goToDeclaration');

    if (vimState.editor === vscode.window.activeTextEditor) {
      // We didn't switch to a different editor
      vimState.cursorStopPosition = vimState.editor.selection.start;
    }
  }
}

@RegisterAction
class CommandOpenLink extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['g', 'x'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vscode.commands.executeCommand('editor.action.openLink');
  }
}

@RegisterAction
class CommandGoBackInChangelist extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['g', ';'];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const prevPos = vimState.historyTracker.prevChangeInChangeList();

    if (prevPos instanceof VimError) {
      StatusBar.displayError(vimState, prevPos);
    } else {
      vimState.cursorStopPosition = prevPos;
    }
  }
}

@RegisterAction
class CommandGoForwardInChangelist extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['g', ','];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const nextPos = vimState.historyTracker.nextChangeInChangeList();

    if (nextPos instanceof VimError) {
      StatusBar.displayError(vimState, nextPos);
    } else {
      vimState.cursorStopPosition = nextPos;
    }
  }
}

@RegisterAction
class CommandGoStartPrevOperatedText extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = [
    ['`', '['],
    ["'", '['],
  ];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const lastPos = vimState.historyTracker.getLastChangeStartPosition();
    if (lastPos !== undefined) {
      vimState.cursorStopPosition = lastPos;
    }
  }
}

@RegisterAction
class CommandGoEndPrevOperatedText extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = [
    ['`', ']'],
    ["'", ']'],
  ];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const lastPos = vimState.historyTracker.getLastChangeEndPosition();
    if (lastPos !== undefined) {
      vimState.cursorStopPosition = lastPos;
    }
  }
}

@RegisterAction
class CommandGoLastChange extends BaseCommand {
  modes = [Mode.Normal];
  keys = [
    ['`', '.'],
    ["'", '.'],
  ];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const lastPos = vimState.historyTracker.getLastHistoryStartPosition();
    if (lastPos !== undefined) {
      vimState.cursorStopPosition = lastPos;
    }
  }
}

@RegisterAction
export class CommandInsertAtLastChange extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['g', 'i'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.cursorStopPosition = vimState.cursorStartPosition =
      vimState.historyTracker.getLastChangeEndPosition() ?? new Position(0, 0);

    await vimState.setCurrentMode(Mode.Insert);
  }
}

@RegisterAction
export class CommandInsertAtFirstCharacter extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['I'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
    vimState.cursorStopPosition = vimState.cursorStartPosition =
      TextEditor.getFirstNonWhitespaceCharOnLine(vimState.document, position.line);
  }
}

@RegisterAction
export class CommandInsertAtLineBegin extends BaseCommand {
  modes = [Mode.Normal];
  mustBeFirstKey = true;
  keys = ['g', 'I'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
    vimState.cursorStopPosition = vimState.cursorStartPosition = position.getLineBegin();
  }
}

@RegisterAction
export class CommandInsertAfterCursor extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['a'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
    vimState.cursorStopPosition = vimState.cursorStartPosition = position.getRight();
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    // Only allow this command to be prefixed with a count or nothing, no other actions or operators before
    if (!vimState.recordedState.actionsRun.every((action) => action instanceof CommandNumber)) {
      return false;
    }

    return super.couldActionApply(vimState, keysPressed);
  }
}

@RegisterAction
export class CommandInsertAtLineEnd extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['A'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
    vimState.cursorStopPosition = vimState.cursorStartPosition = position.getLineEnd();
  }
}

@RegisterAction
class CommandInsertNewLineAbove extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['O'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async execCount(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
    const count = vimState.recordedState.count || 1;

    for (let i = 0; i < count; i++) {
      await vscode.commands.executeCommand('editor.action.insertLineBefore');
    }

    vimState.cursors = getCursorsAfterSync();
    for (let i = 0; i < count; i++) {
      const newPos = new Position(
        vimState.cursors[0].start.line + i,
        vimState.cursors[0].start.character
      );
      vimState.cursors.push(new Cursor(newPos, newPos));
    }
    vimState.cursors = vimState.cursors.reverse();
    vimState.isFakeMultiCursor = true;
  }
}

@RegisterAction
class CommandInsertNewLineBefore extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['o'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async execCount(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
    const count = vimState.recordedState.count || 1;

    for (let i = 0; i < count; i++) {
      await vscode.commands.executeCommand('editor.action.insertLineAfter');
    }
    vimState.cursors = getCursorsAfterSync();
    for (let i = 1; i < count; i++) {
      const newPos = new Position(
        vimState.cursorStartPosition.line - i,
        vimState.cursorStartPosition.character
      );
      vimState.cursors.push(new Cursor(newPos, newPos));

      // Ahhhhhh. We have to manually set cursor position here as we need text
      // transformations AND to set multiple cursors.
      vimState.recordedState.transformer.addTransformation({
        type: 'insertText',
        text: TextEditor.setIndentationLevel('', newPos.character),
        position: newPos,
        cursorIndex: i,
        manuallySetCursorPositions: true,
      });
    }
    vimState.cursors = vimState.cursors.reverse();
    vimState.isFakeMultiCursor = true;
  }
}

@RegisterAction
class CommandNavigateBack extends BaseCommand {
  modes = [Mode.Normal];
  keys = [['<C-o>'], ['<C-t>']];

  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await globalState.jumpTracker.jumpBack(position, vimState);
  }
}

@RegisterAction
class CommandNavigateForward extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['<C-i>'];

  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await globalState.jumpTracker.jumpForward(position, vimState);
  }
}

@RegisterAction
class CommandNavigateLast extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['`', '`'];
  runsOnceForEveryCursor() {
    return false;
  }
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await globalState.jumpTracker.jumpBack(position, vimState);
  }
}

@RegisterAction
class CommandNavigateLastBOL extends BaseCommand {
  modes = [Mode.Normal];
  keys = ["'", "'"];
  runsOnceForEveryCursor() {
    return false;
  }
  isJump = true;
  public async exec(position: Position, vimState: VimState): Promise<void> {
    const lastJump = globalState.jumpTracker.end;
    if (lastJump == null) {
      // This command goes to the last jump, and there is no previous jump, so there's nothing to do.
      return;
    }
    const jump = new Jump({
      document: vimState.document,
      position: lastJump.position.getLineBegin(),
    });
    globalState.jumpTracker.recordJump(Jump.fromStateNow(vimState), jump);
    vimState.cursorStopPosition = jump.position;
  }
}

@RegisterAction
class CommandQuit extends BaseCommand {
  modes = [Mode.Normal];
  keys = [
    ['<C-w>', 'q'],
    ['<C-w>', '<C-q>'],
    ['<C-w>', 'c'],
    ['<C-w>', '<C-c>'],
  ];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    new QuitCommand({}).execute(vimState);
  }
}

@RegisterAction
class CommandOnly extends BaseCommand {
  modes = [Mode.Normal];
  keys = [
    ['<C-w>', 'o'],
    ['<C-w>', '<C-o>'],
  ];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    new OnlyCommand().execute(vimState);
  }
}

@RegisterAction
class MoveToRightPane extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [
    ['<C-w>', 'l'],
    ['<C-w>', '<right>'],
    ['<C-w>', '<C-l>'],
  ];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'workbench.action.navigateRight',
      args: {},
    });
  }
}

@RegisterAction
class MoveToLowerPane extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [
    ['<C-w>', 'j'],
    ['<C-w>', '<down>'],
    ['<C-w>', '<C-j>'],
  ];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'workbench.action.navigateDown',
      args: {},
    });
  }
}

@RegisterAction
class MoveToUpperPane extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [
    ['<C-w>', 'k'],
    ['<C-w>', '<up>'],
    ['<C-w>', '<C-k>'],
  ];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'workbench.action.navigateUp',
      args: {},
    });
  }
}

@RegisterAction
class MoveToLeftPane extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [
    ['<C-w>', 'h'],
    ['<C-w>', '<left>'],
    ['<C-w>', '<C-h>'],
  ];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'workbench.action.navigateLeft',
      args: {},
    });
  }
}

@RegisterAction
class CycleThroughPanes extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [
    ['<C-w>', '<C-w>'],
    ['<C-w>', 'w'],
  ];
  isJump = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'workbench.action.navigateEditorGroups',
      args: {},
    });
  }
}

@RegisterAction
class VerticalSplit extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [
    ['<C-w>', 'v'],
    ['<C-w>', '<C-v>'],
  ];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'workbench.action.splitEditor',
      args: {},
    });
  }
}

@RegisterAction
class OrthogonalSplit extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [
    ['<C-w>', 's'],
    ['<C-w>', '<C-s>'],
  ];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'workbench.action.splitEditorOrthogonal',
      args: {},
    });
  }
}

@RegisterAction
class EvenPaneWidths extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = ['<C-w>', '='];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.postponedCodeViewChanges.push({
      command: 'workbench.action.evenEditorWidths',
      args: {},
    });
  }
}

@RegisterAction
class CommandTabNext extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [['g', 't'], ['<C-pagedown>']];
  runsOnceForEachCountPrefix = false;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // gt behaves differently than gT and goes to an absolute index tab
    // (1-based), it does NOT iterate over next tabs
    if (vimState.recordedState.count > 0) {
      new TabCommand({
        tab: Tab.Absolute,
        count: vimState.recordedState.count - 1,
      }).execute(vimState);
    } else {
      new TabCommand({
        tab: Tab.Next,
        count: 1,
      }).execute(vimState);
    }
  }
}

@RegisterAction
class CommandTabPrevious extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = [['g', 'T'], ['<C-pageup>']];
  runsOnceForEachCountPrefix = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    new TabCommand({
      tab: Tab.Previous,
      count: 1,
    }).execute(vimState);
  }
}

@RegisterAction
export class ActionDeleteChar extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['x'];
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // If line is empty, do nothing
    if (vimState.document.lineAt(position).text.length === 0) {
      return;
    }

    const timesToRepeat = vimState.recordedState.count || 1;

    await new operator.DeleteOperator(this.multicursorIndex).run(
      vimState,
      position,
      position.getRight(timesToRepeat - 1).getLeftIfEOL()
    );

    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
export class ActionDeleteCharWithDeleteKey extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['<Del>'];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  public async execCount(position: Position, vimState: VimState): Promise<void> {
    // If <del> has a count in front of it, then <del> deletes a character
    // off the count. Therefore, 100<del>x, would apply 'x' 10 times.
    // http://vimdoc.sourceforge.net/htmldoc/change.html#<Del>
    if (vimState.recordedState.count !== 0) {
      vimState.recordedState.count = Math.floor(vimState.recordedState.count / 10);

      // Change actionsRunPressedKeys so that showCmd updates correctly
      vimState.recordedState.actionsRunPressedKeys =
        vimState.recordedState.count > 0 ? vimState.recordedState.count.toString().split('') : [];
      this.isCompleteAction = false;
    } else {
      await new ActionDeleteChar().execCount(position, vimState);
    }
  }
}

@RegisterAction
export class ActionDeleteLastChar extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['X'];
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (position.character === 0) {
      return;
    }

    const timesToRepeat = vimState.recordedState.count || 1;

    await new operator.DeleteOperator(this.multicursorIndex).run(
      vimState,
      position.getLeft(timesToRepeat),
      position.getLeft()
    );
  }
}

@RegisterAction
class ActionJoin extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['J'];
  canBeRepeatedWithDot = true;
  runsOnceForEachCountPrefix = false;

  private firstNonWhitespaceIndex(str: string): number {
    for (let i = 0, len = str.length; i < len; i++) {
      const chCode = str.charCodeAt(i);
      if (chCode !== 32 /** space */ && chCode !== 9 /** tab */) {
        return i;
      }
    }
    return -1;
  }

  public async execJoinLines(
    startPosition: Position,
    position: Position,
    vimState: VimState,
    count: number
  ): Promise<void> {
    count = count - 1 || 1;

    const joinspaces = configuration.joinspaces;

    let startLineNumber: number;
    let startColumn: number;
    let endLineNumber: number;
    let endColumn: number;
    let columnDeltaOffset: number = 0;

    if (startPosition.isEqual(position) || startPosition.line === position.line) {
      if (position.line + 1 < vimState.document.lineCount) {
        startLineNumber = position.line;
        startColumn = 0;
        endLineNumber = position.getDown(count).line;
        endColumn = TextEditor.getLineLength(endLineNumber);
      } else {
        startLineNumber = position.line;
        startColumn = 0;
        endLineNumber = position.line;
        endColumn = TextEditor.getLineLength(endLineNumber);
      }
    } else {
      startLineNumber = startPosition.line;
      startColumn = 0;
      endLineNumber = position.line;
      endColumn = TextEditor.getLineLength(endLineNumber);
    }

    let trimmedLinesContent = vimState.document.lineAt(startPosition).text;

    for (let i = startLineNumber + 1; i <= endLineNumber; i++) {
      const lineText = vimState.document.lineAt(i).text;

      const firstNonWhitespaceIdx = this.firstNonWhitespaceIndex(lineText);

      if (firstNonWhitespaceIdx >= 0) {
        // Compute number of spaces to separate the lines
        let insertSpace = ' ';

        if (trimmedLinesContent === '' || trimmedLinesContent.endsWith('\t')) {
          insertSpace = '';
        } else if (
          joinspaces &&
          (trimmedLinesContent.endsWith('.') ||
            trimmedLinesContent.endsWith('!') ||
            trimmedLinesContent.endsWith('?'))
        ) {
          insertSpace = '  ';
        } else if (
          joinspaces &&
          (trimmedLinesContent.endsWith('. ') ||
            trimmedLinesContent.endsWith('! ') ||
            trimmedLinesContent.endsWith('? '))
        ) {
          insertSpace = ' ';
        } else if (trimmedLinesContent.endsWith(' ')) {
          insertSpace = '';
        }

        const lineTextWithoutIndent = lineText.substr(firstNonWhitespaceIdx);

        if (lineTextWithoutIndent.charAt(0) === ')') {
          insertSpace = '';
        }

        trimmedLinesContent += insertSpace + lineTextWithoutIndent;
        columnDeltaOffset = lineTextWithoutIndent.length + insertSpace.length;
      }
    }

    const deleteStartPosition = new Position(startLineNumber, startColumn);
    const deleteEndPosition = new Position(endLineNumber, endColumn);

    if (!deleteStartPosition.isEqual(deleteEndPosition)) {
      if (startPosition.isEqual(position)) {
        vimState.recordedState.transformer.addTransformation({
          type: 'replaceText',
          text: trimmedLinesContent,
          range: new vscode.Range(deleteStartPosition, deleteEndPosition),
          diff: PositionDiff.offset({
            character: trimmedLinesContent.length - columnDeltaOffset - position.character,
          }),
        });
      } else {
        vimState.recordedState.transformer.addTransformation({
          type: 'replaceText',
          text: trimmedLinesContent,
          range: new vscode.Range(deleteStartPosition, deleteEndPosition),
          manuallySetCursorPositions: true,
        });

        vimState.cursorStartPosition = vimState.cursorStopPosition = new Position(
          startPosition.line,
          trimmedLinesContent.length - columnDeltaOffset
        );
        await vimState.setCurrentMode(Mode.Normal);
      }
    }
  }

  public async execCount(position: Position, vimState: VimState): Promise<void> {
    const cursorsToIterateOver = vimState.cursors
      .map((x) => new Cursor(x.start, x.stop))
      .sort((a, b) =>
        a.start.line > b.start.line ||
        (a.start.line === b.start.line && a.start.character > b.start.character)
          ? 1
          : -1
      );

    const resultingCursors: Cursor[] = [];
    for (const [idx, { start, stop }] of cursorsToIterateOver.entries()) {
      this.multicursorIndex = idx;

      vimState.cursorStopPosition = stop;
      vimState.cursorStartPosition = start;

      await this.execJoinLines(start, stop, vimState, vimState.recordedState.count || 1);

      resultingCursors.push(new Cursor(vimState.cursorStartPosition, vimState.cursorStopPosition));

      for (const transformation of vimState.recordedState.transformer.transformations) {
        if (isTextTransformation(transformation) && transformation.cursorIndex === undefined) {
          transformation.cursorIndex = this.multicursorIndex;
        }
      }
    }

    vimState.cursors = resultingCursors;
  }
}

@RegisterAction
class ActionJoinVisualMode extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = ['J'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const [start, end] = sorted(vimState.editor.selection.start, vimState.editor.selection.end);

    /**
     * For joining lines, Visual Line behaves the same as Visual so we align the register mode here.
     */
    vimState.currentRegisterMode = RegisterMode.CharacterWise;
    await new ActionJoin().execJoinLines(start, end, vimState, 1);
  }
}

@RegisterAction
class ActionJoinVisualBlockMode extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = ['J'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const [start, end] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);

    vimState.currentRegisterMode = RegisterMode.CharacterWise;
    await new ActionJoin().execJoinLines(start, end, vimState, 1);
  }
}

@RegisterAction
class ActionJoinNoWhitespace extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['g', 'J'];
  canBeRepeatedWithDot = true;

  // gJ is essentially J without the edge cases. ;-)

  public async exec(position: Position, vimState: VimState): Promise<void> {
    if (position.line === vimState.document.lineCount - 1) {
      return; // TODO: bell
    }

    const count = vimState.recordedState.count > 2 ? vimState.recordedState.count - 1 : 1;
    await this.execJoin(count, position, vimState);
  }

  public async execJoin(count: number, position: Position, vimState: VimState): Promise<void> {
    const replaceRange = new vscode.Range(
      new Position(position.line, 0),
      new Position(Math.min(position.line + count, vimState.document.lineCount - 1), 0).getLineEnd()
    );

    const joinedText = vimState.document.getText(replaceRange).replace(/\r?\n/g, '');

    // Put the cursor at the start of the last joined line's text
    const newCursorColumn =
      joinedText.length - vimState.document.lineAt(replaceRange.end).text.length;

    vimState.recordedState.transformer.addTransformation({
      type: 'replaceText',
      range: replaceRange,
      text: joinedText,
      diff: PositionDiff.exactCharacter({
        character: newCursorColumn,
      }),
    });
  }
}

@RegisterAction
class ActionJoinNoWhitespaceVisualMode extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['g', 'J'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const [start, end] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);
    const count = start.line === end.line ? 1 : end.line - start.line;
    await new ActionJoinNoWhitespace().execJoin(count, start, vimState);
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class ActionReplaceCharacter extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['r', '<character>'];
  canBeRepeatedWithDot = true;
  runsOnceForEachCountPrefix = false;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const timesToRepeat = vimState.recordedState.count || 1;
    const toReplace = this.keysPressed[1];

    /**
     * <character> includes <BS>, <S-BS> and <TAB> but not any control keys,
     * so we ignore the former two keys and have a special handle for <tab>.
     */

    if (['<BS>', '<S-BS>'].includes(toReplace.toUpperCase())) {
      return;
    }

    if (position.character + timesToRepeat > position.getLineEnd().character) {
      return;
    }

    let endPos = new Position(position.line, position.character + timesToRepeat);

    // Return if tried to repeat longer than linelength
    if (endPos.character > vimState.document.lineAt(endPos).text.length) {
      return;
    }

    // If last char (not EOL char), add 1 so that replace selection is complete
    if (endPos.character > vimState.document.lineAt(endPos).text.length) {
      endPos = new Position(endPos.line, endPos.character + 1);
    }

    if (toReplace === '<tab>') {
      vimState.recordedState.transformer.addTransformation({
        type: 'deleteRange',
        range: new vscode.Range(position, endPos),
      });
      vimState.recordedState.transformer.addTransformation({
        type: 'tab',
        cursorIndex: this.multicursorIndex,
        diff: PositionDiff.offset({ character: -1 }),
      });
    } else if (toReplace === '\n') {
      // A newline replacement always inserts exactly one newline (regardless
      // of count prefix) and puts the cursor on the next line.
      // We use `insertTextVSCode` so we get the right indentation
      vimState.recordedState.transformer.addTransformation({
        type: 'deleteRange',
        range: new vscode.Range(position, endPos),
      });
      vimState.recordedState.transformer.addTransformation({
        type: 'insertTextVSCode',
        text: '\n',
      });
    } else {
      vimState.recordedState.transformer.addTransformation({
        type: 'replaceText',
        text: toReplace.repeat(timesToRepeat),
        range: new vscode.Range(position, endPos),
        diff: PositionDiff.offset({ character: timesToRepeat - 1 }),
      });
    }
  }
}

@RegisterAction
class ActionReplaceCharacterVisual extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = ['r', '<character>'];
  runsOnceForEveryCursor() {
    return false;
  }
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    let toInsert = this.keysPressed[1];

    if (toInsert === '<tab>') {
      toInsert = TextEditor.getTabCharacter(vimState.editor);
    }

    let visualSelectionOffset = 1;

    // If selection is reversed, reorganize it so that the text replace logic always works
    let [start, end] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);
    if (vimState.currentMode === Mode.VisualLine) {
      [start, end] = [start.getLineBegin(), end.getLineEnd()];
    }

    // Limit to not replace EOL
    const textLength = vimState.document.lineAt(end).text.length;
    if (textLength <= 0) {
      visualSelectionOffset = 0;
    }
    end = new Position(end.line, Math.min(end.character, textLength > 0 ? textLength - 1 : 0));

    // Iterate over every line in the current selection
    for (let lineNum = start.line; lineNum <= end.line; lineNum++) {
      // Get line of text
      const lineText = vimState.document.lineAt(lineNum).text;

      if (start.line === end.line) {
        // This is a visual section all on one line, only replace the part within the selection
        vimState.recordedState.transformer.addTransformation({
          type: 'replaceText',
          text: Array(end.character - start.character + 2).join(toInsert),
          range: new vscode.Range(start, new Position(end.line, end.character + 1)),
          manuallySetCursorPositions: true,
        });
      } else if (lineNum === start.line) {
        // This is the first line of the selection so only replace after the cursor
        vimState.recordedState.transformer.addTransformation({
          type: 'replaceText',
          text: Array(lineText.length - start.character + 1).join(toInsert),
          range: new vscode.Range(start, new Position(start.line, lineText.length)),
          manuallySetCursorPositions: true,
        });
      } else if (lineNum === end.line) {
        // This is the last line of the selection so only replace before the cursor
        vimState.recordedState.transformer.addTransformation({
          type: 'replaceText',
          text: Array(end.character + 1 + visualSelectionOffset).join(toInsert),
          range: new vscode.Range(
            new Position(end.line, 0),
            new Position(end.line, end.character + visualSelectionOffset)
          ),
          manuallySetCursorPositions: true,
        });
      } else {
        // Replace the entire line length since it is in the middle of the selection
        vimState.recordedState.transformer.addTransformation({
          type: 'replaceText',
          text: Array(lineText.length + 1).join(toInsert),
          range: new vscode.Range(new Position(lineNum, 0), new Position(lineNum, lineText.length)),
          manuallySetCursorPositions: true,
        });
      }
    }

    vimState.cursorStopPosition = start;
    vimState.cursorStartPosition = start;
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class ActionReplaceCharacterVisualBlock extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = ['r', '<character>'];
  runsOnceForEveryCursor() {
    return false;
  }
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    let toInsert = this.keysPressed[1];

    if (toInsert === '<tab>') {
      toInsert = TextEditor.getTabCharacter(vimState.editor);
    }

    for (const { start, end } of TextEditor.iterateLinesInBlock(vimState)) {
      if (end.isBeforeOrEqual(start)) {
        continue;
      }

      vimState.recordedState.transformer.addTransformation({
        type: 'replaceText',
        text: Array(end.character - start.character + 1).join(toInsert),
        range: new vscode.Range(start, end),
        manuallySetCursorPositions: true,
      });
    }

    const topLeft = visualBlockGetTopLeftPosition(
      vimState.cursorStopPosition,
      vimState.cursorStartPosition
    );
    vimState.cursors = [new Cursor(topLeft, topLeft)];
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class ActionDeleteVisualBlock extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = [['d'], ['x'], ['X']];
  canBeRepeatedWithDot = true;
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const lines: string[] = [];

    for (const { line, start, end } of TextEditor.iterateLinesInBlock(vimState)) {
      lines.push(line);
      vimState.recordedState.transformer.addTransformation({
        type: 'deleteRange',
        range: new vscode.Range(start, end),
        manuallySetCursorPositions: true,
      });
    }

    const text = lines.length === 1 ? lines[0] : lines.join('\n');
    vimState.currentRegisterMode = RegisterMode.BlockWise;
    Register.put(vimState, text, this.multicursorIndex, true);

    const topLeft = visualBlockGetTopLeftPosition(
      vimState.cursorStopPosition,
      vimState.cursorStartPosition
    );

    vimState.cursors = [new Cursor(topLeft, topLeft)];
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class ActionShiftDVisualBlock extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = ['D'];
  canBeRepeatedWithDot = true;
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    for (const { start } of TextEditor.iterateLinesInBlock(vimState)) {
      vimState.recordedState.transformer.addTransformation({
        type: 'deleteRange',
        range: new vscode.Range(start, start.getLineEnd()),
        manuallySetCursorPositions: true,
      });
    }

    const topLeft = visualBlockGetTopLeftPosition(
      vimState.cursorStopPosition,
      vimState.cursorStartPosition
    );

    vimState.cursors = [new Cursor(topLeft, topLeft)];
    await vimState.setCurrentMode(Mode.Normal);
  }
}

@RegisterAction
class ActionGoToInsertVisualBlockMode extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = ['I'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
    vimState.isFakeMultiCursor = true;

    for (const { line, start } of TextEditor.iterateLinesInBlock(vimState)) {
      if (line === '' && start.character !== 0) {
        continue;
      }
      vimState.cursors.push(new Cursor(start, start));
    }
    vimState.cursors = vimState.cursors.slice(1);
  }
}

@RegisterAction
class ActionChangeInVisualBlockMode extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = [['c'], ['s']];
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    for (const { start, end } of TextEditor.iterateLinesInBlock(vimState)) {
      vimState.recordedState.transformer.addTransformation({
        type: 'deleteRange',
        range: new vscode.Range(start, end),
        manuallySetCursorPositions: true,
      });
    }

    await vimState.setCurrentMode(Mode.Insert);
    vimState.isFakeMultiCursor = true;

    for (const { start } of TextEditor.iterateLinesInBlock(vimState)) {
      vimState.cursors.push(new Cursor(start, start));
    }
    vimState.cursors = vimState.cursors.slice(1);
  }
}

@RegisterAction
class ActionChangeToEOLInVisualBlockMode extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = ['C'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const cursors: Cursor[] = [];
    for (const cursor of vimState.cursors) {
      for (const { start, end } of TextEditor.iterateLinesInBlock(vimState, cursor)) {
        vimState.recordedState.transformer.addTransformation({
          type: 'deleteRange',
          range: new vscode.Range(start, start.getLineEnd()),
          collapseRange: true,
        });
        cursors.push(new Cursor(end, end));
      }
    }
    vimState.cursors = cursors;

    await vimState.setCurrentMode(Mode.Insert);
    vimState.isFakeMultiCursor = true;
  }
}

abstract class ActionGoToInsertVisualLineModeCommand extends BaseCommand {
  runsOnceForEveryCursor() {
    return false;
  }

  abstract getCursorRangeForLine(
    line: vscode.TextLine,
    selectionStart: Position,
    selectionEnd: Position
  ): Cursor;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vimState.setCurrentMode(Mode.Insert);
    vimState.isFakeMultiCursor = true;

    const resultingCursors: Cursor[] = [];
    const cursorsOnBlankLines: Cursor[] = [];
    for (const selection of vimState.editor.selections) {
      const { start, end } = selection;

      for (let i = start.line; i <= end.line; i++) {
        const line = vimState.document.lineAt(i);

        const cursorRange = this.getCursorRangeForLine(line, start, end);
        if (!line.isEmptyOrWhitespace) {
          resultingCursors.push(cursorRange);
        } else {
          cursorsOnBlankLines.push(cursorRange);
        }
      }
    }

    if (resultingCursors.length > 0) {
      vimState.cursors = resultingCursors;
    } else {
      vimState.cursors = cursorsOnBlankLines;
    }
  }
}

@RegisterAction
class ActionGoToInsertVisualLineMode extends ActionGoToInsertVisualLineModeCommand {
  modes = [Mode.VisualLine];
  keys = ['I'];

  getCursorRangeForLine(line: vscode.TextLine): Cursor {
    const startCharacterPosition = new Position(
      line.lineNumber,
      line.firstNonWhitespaceCharacterIndex
    );
    return new Cursor(startCharacterPosition, startCharacterPosition);
  }
}

@RegisterAction
class ActionGoToInsertVisualLineModeAppend extends ActionGoToInsertVisualLineModeCommand {
  modes = [Mode.VisualLine];
  keys = ['A'];

  getCursorRangeForLine(line: vscode.TextLine): Cursor {
    const endCharacterPosition = new Position(line.lineNumber, line.range.end.character);
    return new Cursor(endCharacterPosition, endCharacterPosition);
  }
}

@RegisterAction
class ActionGoToInsertVisualMode extends ActionGoToInsertVisualLineModeCommand {
  modes = [Mode.Visual];
  keys = ['I'];

  getCursorRangeForLine(
    line: vscode.TextLine,
    selectionStart: Position,
    selectionEnd: Position
  ): Cursor {
    const startCharacterPosition =
      line.lineNumber === selectionStart.line
        ? selectionStart
        : new Position(line.lineNumber, line.firstNonWhitespaceCharacterIndex);
    return new Cursor(startCharacterPosition, startCharacterPosition);
  }
}

@RegisterAction
class ActionGoToInsertVisualModeAppend extends ActionGoToInsertVisualLineModeCommand {
  modes = [Mode.Visual];
  keys = ['A'];

  getCursorRangeForLine(
    line: vscode.TextLine,
    selectionStart: Position,
    selectionEnd: Position
  ): Cursor {
    const endCharacterPosition =
      line.lineNumber === selectionEnd.line
        ? selectionEnd
        : new Position(line.lineNumber, line.range.end.character);
    return new Cursor(endCharacterPosition, endCharacterPosition);
  }
}

@RegisterAction
class ActionGoToInsertVisualBlockModeAppend extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = ['A'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const newCursors: Cursor[] = [];
    for (const cursor of vimState.cursors) {
      const [start, end] = sorted(cursor.start, cursor.stop);
      for (let lineNum = start.line; lineNum <= end.line; lineNum++) {
        const line = vimState.document.lineAt(lineNum);
        const insertionColumn =
          vimState.desiredColumn === Number.POSITIVE_INFINITY
            ? line.text.length
            : Math.max(cursor.start.character, cursor.stop.character) + 1;
        if (line.text.length < insertionColumn) {
          await TextEditor.insert(
            vimState.editor,
            ' '.repeat(insertionColumn - line.text.length),
            line.range.end,
            false
          );
        }
        const newCursor = new Position(lineNum, insertionColumn);
        newCursors.push(new Cursor(newCursor, newCursor));
      }
    }

    vimState.cursors = newCursors;
    await vimState.setCurrentMode(Mode.Insert);
    vimState.isFakeMultiCursor = true;
  }
}

@RegisterAction
class ActionDeleteLineVisualMode extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = ['X'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const [start, end] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);
    await new operator.DeleteOperator(this.multicursorIndex).run(
      vimState,
      start.getLineBegin(),
      end.getLineEnd()
    );
  }
}

@RegisterAction
class ActionChangeLineVisualModeS extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = ['S'];

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return !configuration.surround && super.doesActionApply(vimState, keysPressed);
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    return new ActionChangeLineVisualMode().exec(position, vimState);
  }
}

@RegisterAction
class ActionChangeLineVisualMode extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = [['C'], ['R']];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const [start, end] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);
    await new operator.ChangeOperator(this.multicursorIndex).run(
      vimState,
      start.getLineBegin(),
      end.getLineEndIncludingEOL()
    );
  }
}

@RegisterAction
class ActionChangeLineVisualBlockMode extends BaseCommand {
  modes = [Mode.VisualBlock];
  keys = [['R'], ['S']];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    return new ActionChangeLineVisualMode().exec(position, vimState);
  }
}

@RegisterAction
class ActionChangeChar extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['s'];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new operator.ChangeOperator(this.multicursorIndex).run(
      vimState,
      position,
      position.getRight((vimState.recordedState.count || 1) - 1)
    );
  }

  // Don't clash with surround or sneak modes!
  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return (
      super.doesActionApply(vimState, keysPressed) &&
      !configuration.sneak &&
      !vimState.recordedState.operator
    );
  }

  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return (
      super.couldActionApply(vimState, keysPressed) &&
      !configuration.sneak &&
      !vimState.recordedState.operator
    );
  }
}

@RegisterAction
class ToggleCaseAndMoveForward extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['~'];
  mustBeFirstKey = true;
  canBeRepeatedWithDot = true;

  private toggleCase(text: string): string {
    let newText = '';
    for (const char of text) {
      let toggled = char.toLocaleLowerCase();
      if (toggled === char) {
        toggled = char.toLocaleUpperCase();
      }
      newText += toggled;
    }
    return newText;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const count = vimState.recordedState.count || 1;
    const range = new vscode.Range(
      position,
      shouldWrapKey(vimState.currentMode, '~')
        ? position.getOffsetThroughLineBreaks(count)
        : position.getRight(count)
    );

    vimState.recordedState.transformer.addTransformation({
      type: 'replaceText',
      range,
      text: this.toggleCase(vimState.document.getText(range)),
      diff: PositionDiff.exactPosition(range.end),
    });
  }
}

abstract class IncrementDecrementNumberAction extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  canBeRepeatedWithDot = true;
  abstract offset: number;
  abstract staircase: boolean;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const ranges = this.getSearchRanges(vimState);

    let stepNum = 1;

    for (const [idx, range] of ranges.entries()) {
      position = range.start;

      const text = vimState.document.lineAt(position).text;

      // Make sure position within the text is possible and return if not
      if (text.length <= position.character) {
        continue;
      }

      // Start looking to the right for the next word to increment, unless we're
      // already on a word to increment, in which case start at the beginning of
      // that word.
      const whereToStart = text[position.character].match(/\s/)
        ? position
        : position.prevWordStart(vimState.document, { inclusive: true });

      wordLoop: for (let { start, end, word } of TextEditor.iterateWords(
        vimState.document,
        whereToStart
      )) {
        if (start.isAfter(range.stop)) {
          break;
        }

        // '-' doesn't count as a word, but is important to include in parsing
        // the number, as long as it is not just part of the word (-foo2 for example)
        if (text[start.character - 1] === '-' && /\d/.test(text[start.character])) {
          start = start.getLeft();
          word = text[start.character] + word;
        }
        // Strict number parsing so "1a" doesn't silently get converted to "1"
        do {
          const result = NumericString.parse(word);
          if (result === undefined) {
            break;
          }
          const { num, suffixOffset } = result;

          // Use suffix offset to check if current cursor is in or before detected number.
          if (position.character < start.character + suffixOffset) {
            const pos = await this.replaceNum(
              vimState,
              num,
              this.offset * stepNum * (vimState.recordedState.count || 1),
              start,
              end
            );

            if (this.staircase) {
              stepNum++;
            }

            if (vimState.currentMode === Mode.Normal) {
              vimState.recordedState.transformer.addTransformation({
                type: 'moveCursor',
                diff: PositionDiff.exactPosition(pos.getLeft(num.suffix.length)),
              });
            }
            break wordLoop;
          } else {
            // For situation like this: xyz1999em199[cursor]9m
            word = word.slice(suffixOffset);
            start = new Position(start.line, start.character + suffixOffset);
          }
        } while (true);
      }
    }

    if (isVisualMode(vimState.currentMode)) {
      vimState.recordedState.transformer.addTransformation({
        type: 'moveCursor',
        diff: PositionDiff.exactPosition(ranges[0].start),
      });
    }

    vimState.setCurrentMode(Mode.Normal);
  }

  private async replaceNum(
    vimState: VimState,
    start: NumericString,
    offset: number,
    startPos: Position,
    endPos: Position
  ): Promise<Position> {
    const oldLength = endPos.character + 1 - startPos.character;
    start.value += offset;
    const newNum = start.toString();

    const range = new vscode.Range(startPos, endPos.getRight());

    vimState.recordedState.transformer.addTransformation({
      type: 'replaceText',
      range,
      text: newNum,
    });
    if (oldLength !== newNum.length) {
      // Adjust end position according to difference in width of number-string
      endPos = new Position(endPos.line, startPos.character + newNum.length - 1);
    }

    return endPos;
  }

  /**
   * @returns a list of Ranges in which to search for numbers
   */
  private getSearchRanges(vimState: VimState): Cursor[] {
    const ranges: Cursor[] = [];
    const [start, stop] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);
    switch (vimState.currentMode) {
      case Mode.Normal: {
        ranges.push(
          new Cursor(vimState.cursorStopPosition, vimState.cursorStopPosition.getLineEnd())
        );
        break;
      }

      case Mode.Visual: {
        ranges.push(new Cursor(start, start.getLineEnd()));
        for (let line = start.line + 1; line < stop.line; line++) {
          const lineStart = new Position(line, 0);
          ranges.push(new Cursor(lineStart, lineStart.getLineEnd()));
        }
        ranges.push(new Cursor(stop.getLineBegin(), stop));
        break;
      }

      case Mode.VisualLine: {
        for (let line = start.line; line <= stop.line; line++) {
          const lineStart = new Position(line, 0);
          ranges.push(new Cursor(lineStart, lineStart.getLineEnd()));
        }
        break;
      }

      case Mode.VisualBlock: {
        const topLeft = visualBlockGetTopLeftPosition(start, stop);
        const bottomRight = visualBlockGetBottomRightPosition(start, stop);
        for (let line = topLeft.line; line <= bottomRight.line; line++) {
          ranges.push(
            new Cursor(
              new Position(line, topLeft.character),
              new Position(line, bottomRight.character)
            )
          );
        }
        break;
      }

      default:
        throw new Error(
          `Unexpected mode ${vimState.currentMode} in IncrementDecrementNumberAction.getPositions()`
        );
    }
    return ranges;
  }
}

@RegisterAction
class IncrementNumberAction extends IncrementDecrementNumberAction {
  keys = ['<C-a>'];
  offset = +1;
  staircase = false;
}

@RegisterAction
class DecrementNumberAction extends IncrementDecrementNumberAction {
  keys = ['<C-x>'];
  offset = -1;
  staircase = false;
}

@RegisterAction
class IncrementNumberStaircaseAction extends IncrementDecrementNumberAction {
  keys = ['g', '<C-a>'];
  offset = +1;
  staircase = true;
}

@RegisterAction
class DecrementNumberStaircaseAction extends IncrementDecrementNumberAction {
  keys = ['g', '<C-x>'];
  offset = -1;
  staircase = true;
}

@RegisterAction
class CommandUnicodeName extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['g', 'a'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const char = vimState.document.getText(new vscode.Range(position, position.getRight()));
    const charCode = char.charCodeAt(0);
    // TODO: Handle charCode > 127 by also including <M-x>
    StatusBar.setText(
      vimState,
      `<${char}>  ${charCode},  Hex ${charCode.toString(16)},  Octal ${charCode.toString(8)}`
    );
  }
}

@RegisterAction
class ActionTriggerHover extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['g', 'h'];
  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vscode.commands.executeCommand('editor.action.showHover');
  }
}

/**
 * Multi-Cursor Command Overrides
 *
 * We currently have to override the VSCode key commands that get us into multi-cursor mode.
 *
 * Normally, we'd just listen for another cursor to be added in order to go into multi-cursor
 * mode rather than rewriting each keybinding one-by-one. We can't currently do that because
 * Visual Block Mode also creates additional cursors, but will get confused if you're in
 * multi-cursor mode.
 */

@RegisterAction
export class ActionOverrideCmdD extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual];
  keys = [['<D-d>'], ['g', 'b']];
  runsOnceForEveryCursor() {
    return false;
  }
  runsOnceForEachCountPrefix = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vscode.commands.executeCommand('editor.action.addSelectionToNextFindMatch');
    vimState.cursors = getCursorsAfterSync();

    // If this is the first cursor, select 1 character less
    // so that only the word is selected, no extra character
    vimState.cursors = vimState.cursors.map((x) => x.withNewStop(x.stop.getLeft()));

    await vimState.setCurrentMode(Mode.Visual);
  }
}

@RegisterAction
class ActionOverrideCmdDInsert extends BaseCommand {
  modes = [Mode.Insert];
  keys = ['<D-d>'];
  runsOnceForEveryCursor() {
    return false;
  }
  runsOnceForEachCountPrefix = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    // Since editor.action.addSelectionToNextFindMatch uses the selection to
    // determine where to add a word, we need to do a hack and manually set the
    // selections to the word boundaries before we make the api call.
    vimState.editor.selections = vimState.editor.selections.map((x, idx) => {
      const curPos = x.active;
      if (idx === 0) {
        return new vscode.Selection(
          curPos.prevWordStart(vimState.document),
          curPos.getLeft().nextWordEnd(vimState.document, { inclusive: true }).getRight()
        );
      } else {
        // Since we're adding the selections ourselves, we need to make sure
        // that our selection is actually over what our original word is
        const matchWordPos = vimState.editor.selections[0].active;
        const matchWordLength =
          matchWordPos.getLeft().nextWordEnd(vimState.document, { inclusive: true }).getRight()
            .character - matchWordPos.prevWordStart(vimState.document).character;
        const wordBegin = curPos.getLeft(matchWordLength);
        return new vscode.Selection(wordBegin, curPos);
      }
    });
    await vscode.commands.executeCommand('editor.action.addSelectionToNextFindMatch');
    vimState.cursors = getCursorsAfterSync();
  }
}

@RegisterAction
class ActionOverrideCmdAltDown extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual];
  keys = [
    ['<D-alt+down>'], // OSX
    ['<C-alt+down>'], // Windows
  ];
  runsOnceForEveryCursor() {
    return false;
  }
  runsOnceForEachCountPrefix = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vscode.commands.executeCommand('editor.action.insertCursorBelow');
    vimState.cursors = getCursorsAfterSync();
  }
}

@RegisterAction
class ActionOverrideCmdAltUp extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual];
  keys = [
    ['<D-alt+up>'], // OSX
    ['<C-alt+up>'], // Windows
  ];
  runsOnceForEveryCursor() {
    return false;
  }
  runsOnceForEachCountPrefix = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await vscode.commands.executeCommand('editor.action.insertCursorAbove');
    vimState.cursors = getCursorsAfterSync();
  }
}

@RegisterAction
class ActionShowFileInfo extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['<C-g>'];

  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    reportFileInfo(position, vimState);
  }
}

@RegisterAction
class WriteQuit extends BaseCommand {
  modes = [Mode.Normal];
  keys = [['Z', 'Z']];

  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new WriteQuitCommand({}).execute(vimState);
  }
}

@RegisterAction
class Quit extends BaseCommand {
  modes = [Mode.Normal];
  keys = [['Z', 'Q']];

  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new QuitCommand({ bang: true }).execute(vimState);
  }
}

@RegisterAction
class ActionGoToAlternateFile extends BaseCommand {
  modes = [Mode.Normal];
  keys = [['<C-6>'], ['<C-^>']];

  runsOnceForEveryCursor() {
    return false;
  }

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const altFile = await Register.get('#');
    if (altFile === undefined || altFile.text === '') {
      StatusBar.displayError(vimState, VimError.fromCode(ErrorCode.NoAlternateFile));
    } else {
      const files = await vscode.workspace.findFiles(altFile.text as string);
      // TODO: if the path matches a file from multiple workspace roots, we may not choose the right one
      if (files.length > 0) {
        const document = await vscode.workspace.openTextDocument(files[0]);
        await vscode.window.showTextDocument(document);
      }
    }
  }
}
