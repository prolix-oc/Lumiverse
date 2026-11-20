import i18n from '@/i18n'
import type { Command, CommandGroup } from '@/lib/commands'

/** Resolve a command's display label and description for the current locale. */
export function localizeCommand(cmd: Command): Command {
  const base = `items.${cmd.id}`
  return {
    ...cmd,
    label: i18n.t(`${base}.label`, { ns: 'commands', defaultValue: cmd.label }),
    description: i18n.t(`${base}.description`, { ns: 'commands', defaultValue: cmd.description }),
  }
}

export function localizeCommands(commands: Command[]): Command[] {
  return commands.map(localizeCommand)
}

/** Resolve a command group header for the command palette. */
export function localizeCommandGroup(group: CommandGroup): string {
  return i18n.t(`groups.${group}`, { ns: 'commands' })
}
