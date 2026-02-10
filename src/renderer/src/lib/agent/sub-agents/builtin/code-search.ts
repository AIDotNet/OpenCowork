import type { SubAgentDefinition } from '../types'

export const codeSearchAgent: SubAgentDefinition = {
  name: 'CodeSearch',
  description:
    'A specialized search agent that explores the codebase to find relevant files, code patterns, and project structure. Use this when you need to understand a codebase or find specific code before making changes.',
  icon: 'Search',
  allowedTools: ['Read', 'Glob', 'Grep', 'LS'],
  maxIterations: 8,
  temperature: 0.2,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural language description of what to search for, e.g. "Find where user authentication is handled" or "Locate all React components that use the useAuth hook"',
      },
      scope: {
        type: 'string',
        description: 'Optional path to narrow the search scope, e.g. "src/components" or "lib/api"',
      },
    },
    required: ['query'],
  },
  systemPrompt: `You are CodeSearch, a specialized codebase exploration agent. Your job is to thoroughly search and understand code to answer the user's query.

## Strategy
1. Start with \`LS\` or \`Glob\` to understand the project structure
2. Use \`Grep\` to find relevant code patterns, function names, imports
3. Use \`Read\` to examine the most relevant files in detail
4. Synthesize your findings into a clear, structured summary

## Guidelines
- Be thorough: explore multiple angles (imports, exports, function definitions, usages)
- Use Grep with targeted regex patterns — avoid overly broad searches
- Read files selectively — focus on the most relevant sections
- If the scope parameter is provided, limit your search to that directory
- Always report file paths relative to the working folder

## Output Format
Provide a structured summary with:
- **Overview**: Brief summary of what you found
- **Key Files**: List of relevant files with their roles
- **Code Snippets**: Important code sections (with file paths and line context)
- **Connections**: How the pieces relate to each other
- **Recommendations**: Suggestions for the parent agent based on findings

Be concise but comprehensive. The parent agent will use your findings to make decisions.`,
}
