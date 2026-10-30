const MAX_HINT = 60

export const truncate = (text: string, max: number): string =>
  max > 0 && text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const unquote = (word: string) => word.replace(/^['"]|['"]$/g, '')

// `VAR=value` assignments and `cd dir` steps say nothing about what a command does.
const isSetup = (step: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(step) || /^cd(\s|$)/.test(step)

/** A short label from a raw shell command: its first real command and one argument (a file if there is one), as a basename. */
export const summarizeCommand = (command: string): string => {
  const steps = command.split(/&&|;|\n|\|/).map(step => step.trim()).filter(Boolean)
  const step = steps.find(one => !isSetup(one)) ?? steps[0] ?? ''
  const words = step.split(/\s+/).map(unquote).filter(Boolean)
  // Leading `VAR=value` words of the step itself (`FOO=1 npm test`) are setup too.
  const start = words.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  const [name, ...args] = start < 0 ? words : words.slice(start)
  if (!name) return 'Bash'
  // A path or file name says more than a pattern or a script, so it wins over the first plain argument.
  const plain = args.filter(word => !word.startsWith('-'))
  const arg = plain.find(word => /[/.]/.test(word)) ?? plain[0]
  return arg ? `${name} ${basename(arg)}` : name
}

/** A readable one-line label for a tool call, from the tool's input fields. */
export const describeTool = (tool: string, call: Record<string, unknown>): string => {
  // The arguments sit beside `tool`; an `input` object, where a call has one, holds them too.
  const nested = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {}
  const input = { ...nested, ...call }
  const hint = (value: string | undefined) => (value ? `${tool}: ${truncate(value, MAX_HINT)}` : tool)
  switch (tool) {
    case 'Bash':
      return truncate(text(input.description) ?? summarizeCommand(text(input.command) ?? ''), MAX_HINT)
    case 'Read':
    case 'Edit':
    case 'Write': {
      const path = text(input.file_path)
      return path ? `${tool} ${basename(path)}` : tool
    }
    case 'Agent':
      return truncate(text(input.description) ?? 'Agent', MAX_HINT)
    case 'Grep':
    case 'Glob':
      return hint(text(input.pattern))
    case 'Skill':
      return hint(text(input.skill))
    case 'Artifact':
      return hint(text(input.action) ?? text(input.file_path))
    case 'WebFetch':
      return hint(text(input.url))
    case 'WebSearch':
      return hint(text(input.query))
    default:
      return tool
  }
}
