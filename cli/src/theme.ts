export const theme = {
  primary: '#D97757',
  accent: '#7AA2F7',
  success: '#73C991',
  warning: '#E5C07B',
  error: '#E06C75',
  text: '#E7E2DC',
  muted: '#9A948E',
  dim: '#6F6A66',
  border: '#77706A',
  selectedText: '#171412',
  selectedBackground: '#D7BA7D',
  code: '#C3E88D',
  added: '#73C991',
  removed: '#E06C75'
} as const

export const permissionModeLabels: Record<string, string> = {
  manual: 'manual',
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto'
}
