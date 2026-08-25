// Markdown fixtures shared by the layout tests and the PTY probe. Each sample targets a
// block type whose rendered height is not simply "one row per source line".
//
// Fenced blocks deliberately omit a language: highlighting is loaded lazily from
// highlight.js, and pulling in 191 language modules inside a test adds nothing to what is
// being measured here (rows, not colors).

export const MARKDOWN_SAMPLES = [
  {
    name: 'paragraph',
    text: 'A single paragraph that is long enough to wrap at least once on a narrow terminal, and twice on a very narrow one.'
  },
  {
    name: 'headings',
    text: '# Title\n\n## Section\n\nBody text under the section.'
  },
  {
    name: 'table',
    text: [
      '| Provider | Model | Context |',
      '| --- | --- | ---: |',
      '| Anthropic | claude-opus | 200000 |',
      '| OpenAI | gpt-5.6-sol | 400000 |',
      '| Google | gemini-3.7-flash | 1000000 |'
    ].join('\n')
  },
  {
    name: 'table-aligned',
    text: ['| a | b | c |', '| :--- | :---: | ---: |', '| 1 | 2 | 3 |'].join('\n')
  },
  {
    name: 'table-many-columns',
    text: [
      '| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |'
    ].join('\n')
  },
  {
    name: 'code',
    text: '```\nconst x = 1\nconst y = 2\n```'
  },
  {
    name: 'code-wrapping',
    text: '```\nconst aVeryLongIdentifier = someFunctionCall(withArguments, andMoreArguments, andEvenMore)\n```'
  },
  {
    name: 'list',
    text: '- first item\n- second item that is long enough to wrap on a narrow terminal for sure\n- third'
  },
  {
    name: 'ordered-list',
    text: '1. first\n2. second\n3. third'
  },
  {
    name: 'nested-list',
    text: '- outer one\n  - inner a\n  - inner b\n- outer two'
  },
  {
    name: 'task-list',
    text: '- [x] done item\n- [ ] pending item'
  },
  {
    name: 'blockquote',
    text: '> A quoted line that is long enough to wrap on narrower terminals.\n>\n> Second quoted paragraph.'
  },
  {
    name: 'inline',
    text: 'Some **bold**, some *italic*, some `code`, a [link](https://example.com), and ~~struck~~ text.'
  },
  {
    name: 'rule',
    text: 'Above the rule.\n\n---\n\nBelow the rule.'
  },
  {
    name: 'mixed',
    text: [
      '## Result',
      '',
      'Here is the summary:',
      '',
      '| key | value |',
      '| --- | --- |',
      '| rows | 3 |',
      '',
      '1. step one',
      '2. step two',
      '',
      '```',
      'done()',
      '```'
    ].join('\n')
  },
  {
    // Hard-wrapped prose: marked keeps the newlines, so these must not reflow into one row.
    name: 'hard-wrapped-paragraph',
    text: 'first source line\nsecond source line\nthird source line\nfourth source line'
  },
  {
    // Runs of blank lines collapse into a single margin row, so markdown renders shorter
    // than its source here. Height estimates must not assume the opposite.
    name: 'blank-line-runs',
    text: 'first block\n\n\n\n\nsecond block\n\n\n\n\nthird block'
  },
  {
    name: 'cjk',
    text: '中文段落测试，这一段需要在窄终端里换行，用来验证东亚字符宽度计算是否正确。\n\n| 名称 | 说明 |\n| --- | --- |\n| 表格 | 支持 |'
  }
]
