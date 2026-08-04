import ExcelJS from 'exceljs'
import {
  parseWorkbook,
  serializeWorkbook
} from '../src/renderer/src/lib/preview/viewers/spreadsheet/workbook-io'
import { cellKey } from '../src/renderer/src/lib/preview/viewers/spreadsheet/types'

function toBase64(buffer: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buffer)).toString('base64')
}

async function buildFixture(): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('工时导入')

  ws.getCell('A1').value = '工时补录'
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFC00000' } }
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' }
  ws.mergeCells('A1:D1')

  ws.getCell('A2').value = '姓名'
  ws.getCell('B2').value = '工时'
  ws.getCell('C2').value = '单价'
  ws.getCell('D2').value = '金额'
  for (const ref of ['A2', 'B2', 'C2', 'D2']) {
    ws.getCell(ref).font = { bold: true }
    ws.getCell(ref).border = {
      top: { style: 'thin' },
      bottom: { style: 'double', color: { argb: 'FF217346' } }
    }
  }

  ws.getCell('A3').value = '贺家乐'
  ws.getCell('B3').value = 7.5
  ws.getCell('C3').value = 300
  ws.getCell('C3').numFmt = '¥#,##0.00'
  ws.getCell('D3').value = { formula: 'B3*C3', result: 2250 }
  ws.getCell('D3').numFmt = '¥#,##0.00'

  ws.getColumn(1).width = 18
  ws.getRow(1).height = 30
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }]

  ws.getCell('A4').dataValidation = {
    type: 'list',
    allowBlank: false,
    formulae: ['"项目A,项目B,项目C"']
  }

  wb.addWorksheet('metedata').getCell('A1').value = 'v1'

  return toBase64(await wb.xlsx.writeBuffer())
}

function check(label: string, ok: boolean, detail = ''): boolean {
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

async function main(): Promise<void> {
  const original = await buildFixture()
  let pass = true

  console.log('\n【读取阶段】样式是否被解析出来')
  const model = await parseWorkbook(original)
  const sheet = model.sheets[0]
  const styleOf = (r: number, c: number) =>
    model.styles[sheet.cells.get(cellKey(r, c))?.styleId ?? 0]
  const cellOf = (r: number, c: number) => sheet.cells.get(cellKey(r, c))

  pass = check('工作表名与数量', model.sheets.length === 2 && sheet.name === '工时导入') && pass
  pass = check('标题加粗', styleOf(0, 0)?.bold === true) && pass
  pass = check('标题字号 14', styleOf(0, 0)?.fontSize === 14) && pass
  pass =
    check(
      '标题字色 #FFC00000 → #C00000',
      styleOf(0, 0)?.color === '#C00000',
      styleOf(0, 0)?.color
    ) && pass
  pass = check('标题填充色', styleOf(0, 0)?.fill === '#FFF2CC', styleOf(0, 0)?.fill) && pass
  pass = check('标题居中', styleOf(0, 0)?.hAlign === 'center') && pass
  pass =
    check(
      '合并单元格 A1:D1',
      sheet.merges.some((m) => m.r0 === 0 && m.c0 === 0 && m.c1 === 3)
    ) && pass
  pass =
    check(
      '表头下边框（双线）',
      Boolean(styleOf(1, 0)?.border?.bottom),
      styleOf(1, 0)?.border?.bottom
    ) && pass
  pass = check('公式 D3 = B3*C3', cellOf(2, 3)?.formula === 'B3*C3', cellOf(2, 3)?.formula) && pass
  pass = check('货币格式渲染', cellOf(2, 3)?.text === '¥2,250.00', cellOf(2, 3)?.text) && pass
  pass = check('数值类型保留（非字符串）', typeof cellOf(2, 1)?.value === 'number') && pass
  pass =
    check('列宽 18 字符 → 131px', sheet.colWidths[0] === 131, String(sheet.colWidths[0])) && pass
  pass = check('行高 30pt → 40px', sheet.rowHeights[0] === 40, String(sheet.rowHeights[0])) && pass
  pass = check('冻结窗格 2行1列', sheet.frozen.rows === 2 && sheet.frozen.cols === 1) && pass

  console.log('\n【编辑 + 保存阶段】改一个单元格后其余内容是否幸存')
  const target = sheet.cells.get(cellKey(2, 1))!
  target.value = 8
  target.text = '8'
  target.dirty = true

  const saved = await serializeWorkbook(original, model)
  const verify = new ExcelJS.Workbook()
  await verify.xlsx.load(Buffer.from(saved, 'base64'))
  const vs = verify.getWorksheet('工时导入')!

  pass =
    check('编辑生效 B3 = 8', vs.getCell('B3').value === 8, String(vs.getCell('B3').value)) && pass
  pass =
    check(
      '公式幸存 D3',
      typeof vs.getCell('D3').value === 'object' && 'formula' in (vs.getCell('D3').value as object)
    ) && pass
  pass = check('加粗幸存', vs.getCell('A1').font?.bold === true) && pass
  pass = check('字色幸存', vs.getCell('A1').font?.color?.argb === 'FFC00000') && pass
  pass =
    check(
      '填充色幸存',
      (vs.getCell('A1').fill as ExcelJS.FillPattern)?.fgColor?.argb === 'FFFFF2CC'
    ) && pass
  pass = check('边框幸存', vs.getCell('A2').border?.bottom?.style === 'double') && pass
  pass =
    check('数字格式幸存', vs.getCell('C3').numFmt === '¥#,##0.00', vs.getCell('C3').numFmt) && pass
  pass =
    check('合并幸存', (vs.model.merges ?? []).includes('A1:D1'), JSON.stringify(vs.model.merges)) &&
    pass
  pass = check('列宽幸存', vs.getColumn(1).width === 18, String(vs.getColumn(1).width)) && pass
  pass = check('行高幸存', vs.getRow(1).height === 30, String(vs.getRow(1).height)) && pass
  pass = check('冻结窗格幸存', vs.views?.[0]?.state === 'frozen') && pass
  pass =
    check(
      '数据验证幸存',
      Boolean(vs.getCell('A4').dataValidation),
      JSON.stringify(vs.getCell('A4').dataValidation)
    ) && pass
  pass = check('第二个工作表幸存', Boolean(verify.getWorksheet('metedata'))) && pass

  console.log(`\n${pass ? '全部通过' : '存在失败项'}\n`)
  process.exit(pass ? 0 : 1)
}

void main()
