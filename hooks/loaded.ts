// Recognizes skills and rules a loop loads without a Skill call: skills a subagent
// type preloads (`skills:` in its definition), skill and rule files read by hand,
// and rules the engine attaches when a file under their paths is touched.

const SKILL_HEADER = /Base directory for this skill: \S*\/skills\/([^/\s]+)/g
const SKILL_FILE = /\/skills\/([^/\s"'`]+)\/SKILL\.md/g
const RULE_FILE = /\.claude\/rules\/([^\s"'`)]+?)\.md/g

const matches = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map(m => m[1] ?? '').filter(name => name !== '')

/** The text blocks of a row's content; tool results are left out, so grep output naming a path does not count. */
export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: unknown; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('\n')
}

/** Skills whose instructions a row carries, one per header. */
export const skillsInText = (text: string): string[] => matches(text, SKILL_HEADER)

/** Rules a row carries or a command names, each once. */
export const rulesInText = (text: string): string[] => [...new Set(matches(text, RULE_FILE))]

/** Skills and rules a Read or Bash call opens by path. */
export const loadedByTool = (tool: string, input: Record<string, unknown>): { skills: string[]; rules: string[] } => {
  const target =
    tool === 'Read' && typeof input.file_path === 'string'
      ? input.file_path
      : tool === 'Bash' && typeof input.command === 'string'
        ? input.command
        : ''
  return { skills: [...new Set(matches(target, SKILL_FILE))], rules: rulesInText(target) }
}

const SKILL_DIR = /(\S*\/skills\/([^/\s"'`]+))/g
const RULE_PATH = /((?:[^\s"'`()]*\/)?\.claude\/rules\/([^\s"'`)]+?)\.md)/g

const pathsBy = (text: string, pattern: RegExp): Record<string, string> =>
  Object.fromEntries([...text.matchAll(pattern)].flatMap(m => (m[1] && m[2] ? [[m[2], m[1]]] : [])))

/** Where the skills and rules a text names live: name to skill folder, and name to rule file. */
export const pathsInText = (text: string): { skills: Record<string, string>; rules: Record<string, string> } => ({
  skills: pathsBy(text, SKILL_DIR),
  rules: pathsBy(text, RULE_PATH),
})

/** Adds names to a list that holds each once, in first-use order. */
export const addUnique = (list: string[] | undefined, names: string[]): string[] =>
  [...new Set([...(list ?? []), ...names])]
