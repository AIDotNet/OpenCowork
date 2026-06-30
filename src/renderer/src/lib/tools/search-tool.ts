import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type { ToolHandler } from './tool-types'

function nativeOnlyResult(toolName: string): string {
  return encodeStructuredToolResult({
    error: `${toolName} execution has migrated to .NET Native Worker.`
  })
}

const globHandler: ToolHandler = {
  definition: {
    name: 'Glob',
    description:
      'Find files by glob pattern. Returns bounded results sorted by modification time and respects .gitignore/common generated directories by default.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files' },
        path: {
          type: 'string',
          description: 'Optional search directory (absolute or relative to the working folder)'
        },
        hidden: { type: 'boolean', description: 'Include hidden files and directories' },
        respectGitignore: {
          type: 'boolean',
          description: 'Respect .gitignore files. Defaults to true.'
        },
        followSymlinks: { type: 'boolean', description: 'Follow symbolic links' },
        maxDepth: { type: 'number', description: 'Maximum directory depth to search' }
      },
      required: ['pattern']
    }
  },
  execute: async () => nativeOnlyResult('Glob'),
  requiresApproval: () => false
}

const grepHandler: ToolHandler = {
  definition: {
    name: 'Grep',
    description:
      'Search file contents using ripgrep-style regex. Defaults to compact files_with_matches output, skips common generated directories, respects .gitignore unless respectGitignore=false, and caps prompt output around 4k tokens. Use output_mode="content" for file:line:text output.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        glob: {
          type: 'string',
          description: 'Code-agent-style file glob filter, e.g. **/*.tsx'
        },
        type: {
          type: 'string',
          description: 'Ripgrep file type filter, e.g. py, rust, ts'
        },
        patterns: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  pattern: { type: 'string' },
                  not: { type: 'boolean' }
                },
                required: ['pattern']
              }
            ]
          },
          description: 'Multiple patterns. Strings are positive patterns; objects may set not=true.'
        },
        path: {
          type: 'string',
          description: 'Directory to search in (absolute or relative to the working folder)'
        },
        pathspecs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Git pathspecs to include or exclude, e.g. :(glob)src/**/*.ts'
        },
        include: {
          type: 'string',
          description: 'Comma-separated file globs to include, e.g. *.ts,*.tsx'
        },
        exclude: { type: 'string', description: 'Comma-separated file globs to exclude' },
        patternMode: {
          type: 'string',
          enum: ['fixed', 'basic', 'extended', 'perl'],
          description: 'Pattern dialect. Default uses ripgrep/Rust regex syntax.'
        },
        patternOperator: {
          type: 'string',
          enum: ['or', 'and'],
          description: 'How multiple positive patterns are combined. Default or.'
        },
        notPatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Negative patterns, like git grep --not -e pattern'
        },
        allMatch: {
          type: 'boolean',
          description:
            'Only return files that match every positive pattern, like git grep --all-match'
        },
        caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching' },
        ignoreCase: { type: 'boolean', description: 'Use case-insensitive matching' },
        smartCase: {
          type: 'boolean',
          description: 'Case-sensitive only when the pattern has uppercase'
        },
        literal: { type: 'boolean', description: 'Treat pattern as a literal string' },
        fixedStrings: { type: 'boolean', description: 'Alias for patternMode=fixed' },
        extendedRegexp: { type: 'boolean', description: 'Alias for patternMode=extended' },
        basicRegexp: { type: 'boolean', description: 'Alias for patternMode=basic' },
        perlRegexp: { type: 'boolean', description: 'Alias for patternMode=perl' },
        word: { type: 'boolean', description: 'Match whole words only' },
        line: { type: 'boolean', description: 'Match whole lines only' },
        invertMatch: { type: 'boolean', description: 'Return non-matching lines' },
        onlyMatching: { type: 'boolean', description: 'Return only the matching text spans' },
        column: { type: 'boolean', description: 'Include first-match column numbers' },
        context: {
          type: 'number',
          description: 'Number of context lines before and after each match'
        },
        beforeContext: { type: 'number', description: 'Number of context lines before each match' },
        afterContext: { type: 'number', description: 'Number of context lines after each match' },
        maxCount: { type: 'number', description: 'Maximum matches per file, like git grep -m' },
        head_limit: {
          type: 'number',
          description: 'Code-agent-style maximum output rows to return'
        },
        maxResults: { type: 'number', description: 'Maximum result rows to return' },
        maxOutputBytes: {
          type: 'number',
          description: 'Maximum encoded result size; native execution enforces a compact hard cap'
        },
        maxLineLength: { type: 'number', description: 'Maximum text length per result line' },
        maxScanLineLength: {
          type: 'number',
          description:
            'Maximum characters scanned from any single local file line before matching; native execution caps this to avoid very long-line blowups'
        },
        maxDepth: { type: 'number', description: 'Maximum directory depth to search' },
        hidden: { type: 'boolean', description: 'Include hidden files and directories' },
        respectGitignore: {
          type: 'boolean',
          description: 'Respect .gitignore files. Defaults to true.'
        },
        excludeStandard: { type: 'boolean', description: 'Use git grep --exclude-standard' },
        followSymlinks: { type: 'boolean', description: 'Follow symbolic links' },
        untracked: { type: 'boolean', description: 'Search untracked files in Git worktrees' },
        cached: { type: 'boolean', description: 'Search the Git index instead of the worktree' },
        noIndex: { type: 'boolean', description: 'Use git grep --no-index style directory search' },
        text: { type: 'boolean', description: 'Process binary files as text' },
        textconv: { type: 'boolean', description: 'Use Git textconv filters when available' },
        threads: { type: 'number', description: 'Worker threads for git grep' },
        multiline: { type: 'boolean', description: 'Allow matches across line boundaries' },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count'],
          description: 'Code-agent output mode. Default files_with_matches.'
        },
        outputMode: {
          type: 'string',
          enum: ['matches', 'content', 'files_with_matches', 'files_without_matches', 'count'],
          description: 'Legacy output mode. matches/content returns file:line:text.'
        },
        pathStyle: {
          type: 'string',
          enum: ['relative', 'absolute'],
          description: 'Return relative or absolute paths'
        }
      },
      required: ['pattern']
    }
  },
  execute: async () => nativeOnlyResult('Grep'),
  requiresApproval: () => false
}

export function registerSearchTools(): void {
  toolRegistry.register(globHandler)
  toolRegistry.register(grepHandler)
}
