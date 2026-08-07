import React from 'react'
import { Box, Text } from 'ink'
import { fitText } from '../lib/text.js'
import { theme } from '../theme.js'
import type { TaskItem } from '../types.js'
import { Spinner } from './spinner.js'

export function TaskList({
  tasks,
  width
}: {
  tasks: TaskItem[]
  width: number
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2} width={width}>
      <Text bold>Tasks</Text>
      {tasks.length === 0 ? <Text color={theme.dim}> No tasks in this session</Text> : null}
      {tasks.map((task) => (
        <Box key={task.id}>
          {task.status === 'completed' ? <Text color={theme.success}>✔</Text> : null}
          {task.status === 'in_progress' ? <Spinner /> : null}
          {task.status === 'pending' ? <Text color={theme.dim}>○</Text> : null}
          <Text color={task.status === 'pending' ? theme.muted : theme.text}>
            {' '}
            {fitText(task.label, Math.max(8, width - 5))}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
