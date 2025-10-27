import * as vscode from 'vscode';
import { VimState } from '../state/vimState';
import { Mode } from '../mode/mode';
import { IKeyRemapping } from '../configuration/iconfiguration';
import { configuration } from '../configuration/configuration';

/**
 * Represents an item that can be selected from the which-key popup
 */
interface WhichKeyItem extends vscode.QuickPickItem {
  /** The remaining keys after the current prefix */
  remainingKeys: string[];
}

/**
 * Callback function to send keys back to the mode handler
 */
export type KeySender = (keys: string[]) => Promise<void>;

/**
 * Service responsible for displaying available key bindings after a partial key sequence.
 * Inspired by which-key.nvim, this provides a discoverable interface for Vim commands.
 *
 * MVP Version: Focuses on user-defined remappings first, as these are the most valuable
 * for discoverability.
 */
export class WhichKeyService implements vscode.Disposable {
  private timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  private keySender: KeySender;
  private isVisible = false;
  private outputChannel: vscode.OutputChannel;

  constructor(keySender: KeySender) {
    try {
      this.keySender = keySender;
      // Create a dedicated output channel for which-key
      this.outputChannel = vscode.window.createOutputChannel('Which-Key');
    } catch (error) {
      console.error('[WhichKey] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Shows the which-key popup immediately, displaying available
   * key completions for the current partial key sequence.
   *
   * @param vimState The current Vim state
   * @param currentKeys The keys pressed so far
   */
  public async show(vimState: VimState, currentKeys: string[]): Promise<void> {
    try {
      // Check if feature is enabled - return immediately if not
      if (!configuration.whichkey?.enable) {
        return;
      }

      // Clear any existing timeout
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = undefined;
      }

      // Use configured delay (default to 200ms if not set)
      const delay = configuration.whichkey.delay ?? 200;

      // Wait for configured delay before showing
      this.timeoutHandle = setTimeout(() => {
        // Double-check it's still enabled
        if (!configuration.whichkey?.enable) {
          return;
        }
        this.displayPopup(vimState, currentKeys);
      }, delay);
    } catch (error) {
      console.error('[WhichKey] Error in show():', error);
    }
  }

  /**
   * Hides the which-key display and clears any pending timeouts
   */
  public hide(): void {
    try {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = undefined;
      }

      if (this.isVisible) {
        // Clear the output channel but keep it open
        this.outputChannel.clear();
        // Optionally hide it
        this.outputChannel.hide();
      }

      this.isVisible = false;
    } catch (error) {
      console.error('[WhichKey] Error in hide():', error);
    }
  }

  /**
   * Checks if there are any remappings that match the current key sequence
   * This is used to determine if we should keep waiting for more keys even when
   * getRelevantAction returns NoPossibleMatch (which only checks built-in actions)
   */
  public hasMatches(vimState: VimState, currentKeys: string[]): boolean {
    try {
      const items = this.buildItems(vimState, currentKeys);
      return items.length > 0;
    } catch (error) {
      console.error('[WhichKey] Error in hasMatches():', error);
      return false;
    }
  }

  /**
   * Displays available key completions in the Output channel.
   * This is similar to how which-key.nvim shows in the command area at the bottom.
   */
  private displayPopup(vimState: VimState, currentKeys: string[]): void {
    try {
      const items = this.buildItems(vimState, currentKeys);

      // Don't show if there are no available completions
      if (items.length === 0) {
        return;
      }

      const prefix = currentKeys.join('');

      // Clear and prepare output channel
      this.outputChannel.clear();

      // Build a nice formatted display with wider columns
      const boxWidth = 120;
      const headerText = `  Which-key: After "${prefix}"`;
      this.outputChannel.appendLine('╔' + '═'.repeat(boxWidth - 2) + '╗');
      this.outputChannel.appendLine(`║${headerText.padEnd(boxWidth - 2)}║`);
      this.outputChannel.appendLine('╠' + '═'.repeat(boxWidth - 2) + '╣');

      // Format items in a table-like display (2 columns for better readability)
      const itemsPerRow = 2;
      for (let i = 0; i < items.length; i += itemsPerRow) {
        const rowItems = items.slice(i, i + itemsPerRow);
        const formatted = rowItems
          .map((item) => {
            const key = item.label.padEnd(6);
            const desc = (item.description || '').substring(0, 45).padEnd(45);
            return `${key} → ${desc}`;
          })
          .join(' │ ');
        this.outputChannel.appendLine(`║  ${formatted.padEnd(boxWidth - 4)}║`);
      }

      this.outputChannel.appendLine('╚' + '═'.repeat(boxWidth - 2) + '╝');
      this.outputChannel.appendLine('');
      this.outputChannel.appendLine(
        '💡 Continue typing your key sequence... (Vim timeout applies)',
      );

      // Only show the channel if it's not already visible - this is less intrusive
      // Users can manually open it from the bottom panel if they want to see it
      if (!this.isVisible) {
        this.outputChannel.show(true); // true = preserveFocus, so cursor stays in editor
      }

      this.isVisible = true;
    } catch (error) {
      console.error('[WhichKey] Error in displayPopup():', error);
    }
  }

  /**
   * Builds the list of available key completions from user-defined remappings.
   * MVP: Start with remappings only, as these are most valuable for discovery.
   */
  private buildItems(vimState: VimState, currentKeys: string[]): WhichKeyItem[] {
    try {
      const items: WhichKeyItem[] = [];
      const seenKeys = new Set<string>();

      // Get user-defined remappings for current mode
      const remappings = this.getRemappingsForMode(vimState.currentMode);
      const currentKeyString = currentKeys.join('');

      for (const [keySeq, remap] of remappings) {
        // Check if this remapping starts with the current key sequence
        if (keySeq.startsWith(currentKeyString) && keySeq.length > currentKeyString.length) {
          const fullKeyString = remap.before.join('');

          // Prevent duplicates
          if (seenKeys.has(fullKeyString)) {
            continue;
          }
          seenKeys.add(fullKeyString);

          const remainingKeys = remap.before.slice(currentKeys.length);
          const group = this.getRemappingGroup(remap.before);

          const item: WhichKeyItem = {
            label: remainingKeys.join(''),
            description: this.getRemappingDescription(remap),
            detail: group ? `[${group}]` : undefined,
            remainingKeys,
          };
          items.push(item);
        }
      }

      // Sort alphabetically
      items.sort((a, b) => a.label.localeCompare(b.label));

      return items;
    } catch (error) {
      console.error('[WhichKey] Error in buildItems():', error);
      return [];
    }
  }

  /**
   * Gets the remapping map for the current mode
   */
  private getRemappingsForMode(mode: Mode): Map<string, IKeyRemapping> {
    switch (mode) {
      case Mode.Normal:
        return configuration.normalModeKeyBindingsMap;
      case Mode.Insert:
        return configuration.insertModeKeyBindingsMap;
      case Mode.Visual:
      case Mode.VisualLine:
      case Mode.VisualBlock:
        return configuration.visualModeKeyBindingsMap;
      case Mode.OperatorPendingMode:
        return configuration.operatorPendingModeKeyBindingsMap;
      default:
        return new Map();
    }
  }

  /**
   * Gets a human-readable description for a remapping
   */
  private getRemappingDescription(remap: IKeyRemapping): string {
    // If remapping has commands, show the first command
    if (remap.commands && remap.commands.length > 0) {
      const cmd = remap.commands[0];
      return typeof cmd === 'string' ? cmd : cmd.command;
    }

    // If remapping maps to other keys, show them
    if (remap.after) {
      return `→ ${remap.after.join('')}`;
    }

    return 'Custom mapping';
  }

  /**
   * Gets the group label for a remapping based on its key sequence
   */
  private getRemappingGroup(keys: string[]): string | undefined {
    const keyString = keys.join('');
    const groups = configuration.whichkey?.groups || {};

    // Check user-defined groups
    for (const [prefix, groupName] of Object.entries(groups)) {
      if (keyString.startsWith(prefix) && typeof groupName === 'string') {
        return groupName;
      }
    }

    return undefined;
  }

  /**
   * Disposes of resources
   */
  public dispose(): void {
    this.hide();
    this.outputChannel.dispose();
  }
}
