// Renders each markdown sample from test/markdown-samples.mjs between sentinel rows so a
// PTY test can count the rows Ink actually produced and compare them against
// lib/markdown-layout.ts. Not a test itself; spawned by markdown-layout.test.mjs.
//
//   node test/markdown-probe.mjs <width>

import React from 'react'
import { Box, Text, render } from 'ink'
import { TerminalMarkdown } from '../dist/components/markdown.js'
import { MARKDOWN_SAMPLES } from './markdown-samples.mjs'

const width = Number(process.argv[2] ?? 80)

function frame(name, text) {
  return React.createElement(
    Box,
    { flexDirection: 'column', key: name, width },
    React.createElement(Text, null, `<<<${name}`),
    React.createElement(TerminalMarkdown, { text, width }),
    React.createElement(Text, null, `>>>${name}`)
  )
}

const instance = render(
  React.createElement(
    Box,
    { flexDirection: 'column', width },
    ...MARKDOWN_SAMPLES.map((sample) => frame(sample.name, sample.text))
  ),
  { patchConsole: false }
)

setTimeout(() => {
  instance.unmount()
  process.exit(0)
}, 400)
