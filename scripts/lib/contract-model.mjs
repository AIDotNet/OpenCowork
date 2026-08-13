#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import ts from 'typescript'

export class ContractModelError extends Error {}

const MAP_INTERFACE_NAMES = new Set([
  'WorkerMethods',
  'RuntimeCommands',
  'RuntimeQueries',
  'RuntimeEvents',
  'UiCapabilities'
])

const SPECIAL_TYPE_NAMES = new Set(['JsonValue', 'JsonObject'])

/**
 * @param {string} sourceText
 * @param {string} fileName
 */
export function parseContractModel(sourceText, fileName) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true)

  /** @type {{ name: string, value: number, doc: string | null }[]} */
  const constants = []
  /** @type {{ name: string, values: string[], doc: string | null }[]} */
  const enums = []
  /** @type {{ name: string, members: string[], doc: string | null }[]} */
  const unions = []
  /** @type {{ name: string, doc: string | null, fields: object[] }[]} */
  const dtos = []
  /** @type {{ name: string, tsName: string, entries: object[] }[]} */
  const maps = []
  const specialTypes = new Set()

  function fail(message, node) {
    const pos = node ? source.getLineAndCharacterOfPosition(node.getStart()) : null
    const where = pos ? ` (${fileName}:${pos.line + 1}:${pos.character + 1})` : ` (${fileName})`
    throw new ContractModelError(`${message}${where}`)
  }

  function jsDocText(node) {
    const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
    if (docs.length === 0) return null
    const text = docs
      .map((doc) => (typeof doc.comment === 'string' ? doc.comment : ''))
      .join(' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
    return text || null
  }

  function csTagOf(node) {
    for (const tag of ts.getJSDocTags(node)) {
      if (tag.tagName.text !== 'cs') continue
      const value = typeof tag.comment === 'string' ? tag.comment.trim() : ''
      if (value !== 'int' && value !== 'long') {
        fail(`@cs tag must be "int" or "long", got "${value}"`, node)
      }
      return value
    }
    return null
  }

  const enumNames = new Set()
  const dtoNames = new Set()
  const unionNames = new Set()

  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      const name = statement.name.text
      if (SPECIAL_TYPE_NAMES.has(name)) {
        specialTypes.add(name)
        continue
      }
      const type = statement.type
      if (!ts.isUnionTypeNode(type)) {
        fail(`type alias ${name} must be a string-literal enum or a DTO union`, statement)
      }
      const stringLits = []
      const typeRefs = []
      let other = false
      for (const part of type.types) {
        if (ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal)) {
          stringLits.push(part.literal.text)
        } else if (
          ts.isTypeReferenceNode(part) &&
          !part.typeArguments &&
          ts.isIdentifier(part.typeName)
        ) {
          typeRefs.push(part.typeName.text)
        } else {
          other = true
        }
      }
      if (stringLits.length > 0 && typeRefs.length === 0 && !other) {
        enums.push({ name, values: stringLits, doc: jsDocText(statement) })
        enumNames.add(name)
        continue
      }
      if (typeRefs.length > 0 && stringLits.length === 0 && !other) {
        unions.push({ name, members: typeRefs, doc: jsDocText(statement) })
        unionNames.add(name)
        continue
      }
      fail(`unsupported type alias ${name}`, statement)
    }
  }

  /**
   * @param {ts.TypeNode | undefined} typeNode
   * @param {'int' | 'long' | null} csNumber
   */
  function mapType(typeNode, csNumber) {
    if (!typeNode) fail('field is missing a type', typeNode)
    switch (typeNode.kind) {
      case ts.SyntaxKind.BooleanKeyword:
        return { ts: 'boolean', cs: 'bool', kind: 'boolean', nullable: false }
      case ts.SyntaxKind.NumberKeyword:
        return {
          ts: 'number',
          cs: csNumber ?? 'double',
          kind: 'number',
          nullable: false,
          csNumber: csNumber ?? 'double'
        }
      case ts.SyntaxKind.StringKeyword:
        return { ts: 'string', cs: 'string', kind: 'string', nullable: false }
      default:
        break
    }
    if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) {
      const value = typeNode.literal.text
      return {
        ts: `'${value}'`,
        cs: 'string',
        kind: 'literal',
        literal: value,
        nullable: false
      }
    }
    if (ts.isArrayTypeNode(typeNode)) {
      const element = mapType(typeNode.elementType, csNumber)
      return {
        ts: `${element.ts}[]`,
        cs: `${element.cs}[]`,
        kind: 'array',
        element,
        nullable: false
      }
    }
    if (ts.isUnionTypeNode(typeNode)) {
      const parts = typeNode.types
      const nullParts = parts.filter(
        (part) => ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword
      )
      const valueParts = parts.filter((part) => !nullParts.includes(part))
      if (nullParts.length !== 1) {
        fail('unions must be `T | null` or a string-literal enum', typeNode)
      }
      if (valueParts.length === 1) {
        const inner = mapType(valueParts[0], csNumber)
        return {
          ...inner,
          ts: `${inner.ts} | null`,
          cs: `${inner.cs}?`,
          nullable: true
        }
      }
      const literals = []
      for (const part of valueParts) {
        if (!ts.isLiteralTypeNode(part) || !ts.isStringLiteral(part.literal)) {
          fail('unions must have exactly the form `T | null`', typeNode)
        }
        literals.push(part.literal.text)
      }
      return {
        ts: `${literals.map((value) => `'${value}'`).join(' | ')} | null`,
        cs: 'string?',
        kind: 'enum',
        enumValues: literals,
        nullable: true
      }
    }
    if (ts.isTypeReferenceNode(typeNode)) {
      const name = typeNode.typeName.getText(source)
      if (name === 'Record' && typeNode.typeArguments?.length === 2) {
        const keyText = typeNode.typeArguments[0].getText(source)
        if (keyText !== 'string') fail('Record keys must be string', typeNode)
        const value = mapType(typeNode.typeArguments[1], csNumber)
        return {
          ts: `Record<string, ${value.ts}>`,
          cs: `Dictionary<string, ${value.cs}>`,
          kind: 'record',
          value,
          nullable: false
        }
      }
      if (name === 'JsonValue') {
        return { ts: 'JsonValue', cs: 'JsonElement', kind: 'json', nullable: false }
      }
      if (name === 'JsonObject') {
        return {
          ts: 'JsonObject',
          cs: 'Dictionary<string, JsonElement>',
          kind: 'json-object',
          nullable: false
        }
      }
      if (enumNames.has(name)) {
        const entry = enums.find((item) => item.name === name)
        return {
          ts: name,
          cs: 'string',
          kind: 'enum',
          enumName: name,
          enumValues: entry?.values ?? [],
          nullable: false
        }
      }
      if (unionNames.has(name)) {
        return { ts: name, cs: 'JsonElement', kind: 'union', ref: name, nullable: false }
      }
      if (dtoNames.has(name) || MAP_INTERFACE_NAMES.has(name) === false) {
        return { ts: name, cs: name, kind: 'dto', ref: name, nullable: false }
      }
      return { ts: name, cs: name, kind: 'dto', ref: name, nullable: false }
    }
    fail(`unsupported field type: ${typeNode.getText(source)}`, typeNode)
    return { ts: '', cs: '', kind: 'string', nullable: false }
  }

  function parseMap(decl) {
    const entries = []
    for (const member of decl.members) {
      if (
        !ts.isPropertySignature(member) ||
        !member.name ||
        !(ts.isStringLiteral(member.name) || ts.isIdentifier(member.name))
      ) {
        fail(`${decl.name.text} entries must be string-literal or identifier keys`, member)
      }
      const key = ts.isStringLiteral(member.name) ? member.name.text : member.name.text
      const type = member.type
      if (!type || !ts.isTypeLiteralNode(type)) {
        fail(`${decl.name.text} values must be object literals`, member)
      }
      /** @type {Record<string, string>} */
      const slots = {}
      for (const prop of type.members) {
        if (!ts.isPropertySignature(prop) || !prop.name) continue
        slots[prop.name.getText(source)] = prop.type?.getText(source) ?? ''
      }
      entries.push({ key, slots, doc: jsDocText(member) })
    }
    return entries
  }

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const decl = statement.declarationList.declarations[0]
      if (decl?.name.getText(source) !== 'constants') continue
      let objectLiteral = decl.initializer
      if (objectLiteral && ts.isAsExpression(objectLiteral))
        objectLiteral = objectLiteral.expression
      if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
        fail('constants must be an object literal', decl)
      }
      for (const prop of objectLiteral.properties) {
        if (!ts.isPropertyAssignment(prop))
          fail('constants entries must be plain assignments', prop)
        if (!ts.isNumericLiteral(prop.initializer)) {
          fail('constants values must be integer literals', prop)
        }
        constants.push({
          name: prop.name.getText(source),
          value: Number(prop.initializer.text),
          doc: jsDocText(prop)
        })
      }
      continue
    }
    if (!ts.isInterfaceDeclaration(statement)) continue
    const name = statement.name.text
    if (MAP_INTERFACE_NAMES.has(name)) {
      maps.push({
        name,
        tsName: mapInterfaceTsName(name),
        entries: parseMap(statement)
      })
      continue
    }
    dtoNames.add(name)
  }

  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue
    const name = statement.name.text
    if (MAP_INTERFACE_NAMES.has(name)) continue
    const fields = []
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.name) {
        fail('DTO members must be property signatures', member)
      }
      if (member.questionToken) fail('optional fields are not allowed; use `T | null`', member)
      const mapped = mapType(member.type, csTagOf(member))
      fields.push({
        name: member.name.getText(source),
        tsType: mapped.ts,
        csType: mapped.cs,
        mapped,
        doc: jsDocText(member)
      })
    }
    dtos.push({ name, doc: jsDocText(statement), fields })
  }

  for (const union of unions) {
    for (const member of union.members) {
      if (!dtoNames.has(member)) {
        fail(`union ${union.name} references unknown DTO ${member}`)
      }
    }
  }

  return { fileName, constants, enums, unions, dtos, maps, specialTypes }
}

function mapInterfaceTsName(name) {
  switch (name) {
    case 'WorkerMethods':
      return 'WorkerMethodMap'
    case 'RuntimeCommands':
      return 'RuntimeCommandMap'
    case 'RuntimeQueries':
      return 'RuntimeQueryMap'
    case 'RuntimeEvents':
      return 'RuntimeEventMap'
    case 'UiCapabilities':
      return 'UiCapabilityMap'
    default:
      return `${name}Map`
  }
}

export function pascalCase(name) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function pascalConstName(name) {
  return name
    .toLowerCase()
    .split('_')
    .map((part) => pascalCase(part))
    .join('')
}

export function channelToMethodName(channel) {
  const parts = channel.split(/[:/]/g).filter(Boolean)
  const leaf = parts.slice(1).join('-') || parts[0]
  return leaf.replace(/-([a-z0-9])/gi, (_, char) => char.toUpperCase())
}

function emitHeader(header) {
  return `// ${header}`
}

function emitTsPrelude(model, header) {
  const lines = [emitHeader(header), '']
  if (model.specialTypes.has('JsonValue') || model.specialTypes.has('JsonObject')) {
    lines.push('export type JsonValue =')
    lines.push('  | string')
    lines.push('  | number')
    lines.push('  | boolean')
    lines.push('  | null')
    lines.push('  | JsonValue[]')
    lines.push('  | { readonly [key: string]: JsonValue }')
    lines.push('export type JsonObject = { readonly [key: string]: JsonValue }')
    lines.push('')
  }
  return lines
}

function emitTsConstantsAndTypes(model, lines) {
  for (const constant of model.constants) {
    if (constant.doc) lines.push(`/** ${constant.doc} */`)
    lines.push(`export const ${constant.name} = ${constant.value} as const`)
  }
  if (model.constants.length > 0) lines.push('')
  for (const item of model.enums) {
    if (item.doc) lines.push(`/** ${item.doc} */`)
    lines.push(`export type ${item.name} = ${item.values.map((value) => `'${value}'`).join(' | ')}`)
    lines.push(
      `export const ${item.name}Values = [${item.values
        .map((value) => `'${value}'`)
        .join(', ')}] as const`
    )
    lines.push('')
  }
  for (const dto of model.dtos) {
    if (dto.doc) lines.push(`/** ${dto.doc} */`)
    lines.push(`export interface ${dto.name} {`)
    for (const field of dto.fields) {
      if (field.doc) lines.push(`  /** ${field.doc} */`)
      lines.push(`  ${field.name}: ${field.tsType}`)
    }
    lines.push('}', '')
  }
  for (const union of model.unions) {
    if (union.doc) lines.push(`/** ${union.doc} */`)
    lines.push(`export type ${union.name} = ${union.members.join(' | ')}`)
    lines.push('')
  }
  for (const map of model.maps) {
    lines.push(`export interface ${map.tsName} {`)
    for (const entry of map.entries) {
      const inner = Object.entries(entry.slots)
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ')
      lines.push(`  '${entry.key}': { ${inner} }`)
    }
    lines.push('}', '')
    lines.push(`export type ${map.tsName.replace(/Map$/, 'Name')} = keyof ${map.tsName}`)
    lines.push('')
  }
}

function emitDecodeHelpers(lines) {
  lines.push('function isObject(value: unknown): value is Record<string, unknown> {')
  lines.push("  return !!value && typeof value === 'object' && !Array.isArray(value)")
  lines.push('}')
  lines.push('')
  lines.push('function isJsonValue(value: unknown): value is JsonValue {')
  lines.push('  if (value === null) return true')
  lines.push('  const valueType = typeof value')
  lines.push("  if (valueType === 'string' || valueType === 'boolean') return true")
  lines.push("  if (valueType === 'number') return Number.isFinite(value)")
  lines.push('  if (Array.isArray(value)) return value.every(isJsonValue)')
  lines.push('  if (isObject(value)) return Object.values(value).every(isJsonValue)')
  lines.push('  return false')
  lines.push('}')
  lines.push('')
  lines.push('function isJsonObject(value: unknown): value is JsonObject {')
  lines.push('  return isObject(value) && Object.values(value).every(isJsonValue)')
  lines.push('}')
  lines.push('')
  lines.push('function failDecode(label: string, detail: string): never {')
  lines.push('  throw new Error(`${label}: ${detail}`)')
  lines.push('}')
  lines.push('')
}

function emitFieldDecode(lines, mapped, valueExpr, resultName, labelExpr, indent) {
  const pad = ' '.repeat(indent)
  if (mapped.nullable) {
    lines.push(`${pad}let ${resultName}: ${mapped.ts}`)
    lines.push(`${pad}if (${valueExpr} === null) {`)
    lines.push(`${pad}  ${resultName} = null`)
    lines.push(`${pad}} else {`)
    emitFieldDecode(
      lines,
      { ...mapped, nullable: false, ts: mapped.ts.replace(/ \| null$/u, '') },
      valueExpr,
      `${resultName}Value`,
      labelExpr,
      indent + 2
    )
    lines.push(`${pad}  ${resultName} = ${resultName}Value`)
    lines.push(`${pad}}`)
    return
  }
  switch (mapped.kind) {
    case 'boolean':
      lines.push(
        `${pad}if (typeof ${valueExpr} !== 'boolean') failDecode(${labelExpr}, 'expected boolean')`
      )
      lines.push(`${pad}const ${resultName} = ${valueExpr}`)
      return
    case 'number':
      lines.push(
        `${pad}if (typeof ${valueExpr} !== 'number' || !Number.isFinite(${valueExpr})) failDecode(${labelExpr}, 'expected number')`
      )
      lines.push(`${pad}const ${resultName} = ${valueExpr}`)
      return
    case 'string':
      lines.push(
        `${pad}if (typeof ${valueExpr} !== 'string') failDecode(${labelExpr}, 'expected string')`
      )
      lines.push(`${pad}const ${resultName} = ${valueExpr}`)
      return
    case 'literal':
      lines.push(
        `${pad}if (${valueExpr} !== '${mapped.literal}') failDecode(${labelExpr}, 'expected ${mapped.literal}')`
      )
      lines.push(`${pad}const ${resultName} = ${valueExpr} as '${mapped.literal}'`)
      return
    case 'enum': {
      const values = (mapped.enumValues ?? []).map((value) => `'${value}'`).join(', ')
      const typeName = mapped.enumName ?? mapped.ts
      lines.push(
        `${pad}if (typeof ${valueExpr} !== 'string' || !([${values}] as readonly string[]).includes(${valueExpr})) {`
      )
      lines.push(`${pad}  failDecode(${labelExpr}, 'expected enum value')`)
      lines.push(`${pad}}`)
      lines.push(`${pad}const ${resultName} = ${valueExpr} as ${typeName}`)
      return
    }
    case 'json':
      lines.push(
        `${pad}if (!isJsonValue(${valueExpr})) failDecode(${labelExpr}, 'expected JSON value')`
      )
      lines.push(`${pad}const ${resultName} = ${valueExpr}`)
      return
    case 'json-object':
      lines.push(
        `${pad}if (!isJsonObject(${valueExpr})) failDecode(${labelExpr}, 'expected JSON object')`
      )
      lines.push(`${pad}const ${resultName} = ${valueExpr}`)
      return
    case 'dto':
    case 'union':
      lines.push(`${pad}const ${resultName} = decode${mapped.ref}(${valueExpr})`)
      return
    case 'array': {
      lines.push(
        `${pad}if (!Array.isArray(${valueExpr})) failDecode(${labelExpr}, 'expected array')`
      )
      lines.push(`${pad}const ${resultName}: ${mapped.ts} = []`)
      lines.push(`${pad}for (let index = 0; index < ${valueExpr}.length; index += 1) {`)
      lines.push(`${pad}  const item = ${valueExpr}[index]`)
      emitFieldDecode(
        lines,
        mapped.element,
        'item',
        'decoded',
        `${labelExpr} + '[' + String(index) + ']'`,
        indent + 2
      )
      lines.push(`${pad}  ${resultName}.push(decoded)`)
      lines.push(`${pad}}`)
      return
    }
    case 'record': {
      lines.push(`${pad}if (!isObject(${valueExpr})) failDecode(${labelExpr}, 'expected object')`)
      lines.push(`${pad}const ${resultName}Entries: Record<string, ${mapped.value.ts}> = {}`)
      lines.push(`${pad}for (const [key, item] of Object.entries(${valueExpr})) {`)
      emitFieldDecode(
        lines,
        mapped.value,
        'item',
        'decoded',
        `${labelExpr} + '.' + key`,
        indent + 2
      )
      lines.push(`${pad}  ${resultName}Entries[key] = decoded`)
      lines.push(`${pad}}`)
      lines.push(`${pad}const ${resultName} = ${resultName}Entries as ${mapped.ts}`)
      return
    }
    default:
      lines.push(`${pad}failDecode(${labelExpr}, 'unsupported')`)
      lines.push(`${pad}const ${resultName} = ${valueExpr} as never`)
  }
}

function emitTsValidators(model, lines) {
  if (model.dtos.length === 0) return
  emitDecodeHelpers(lines)

  const dtoByName = new Map(model.dtos.map((dto) => [dto.name, dto]))
  for (const dto of model.dtos) {
    lines.push(`export function decode${dto.name}(value: unknown): ${dto.name} {`)
    lines.push(`  if (!isObject(value)) failDecode('${dto.name}', 'expected object')`)
    for (const field of dto.fields) {
      emitFieldDecode(
        lines,
        field.mapped,
        `value.${field.name}`,
        field.name,
        `'${dto.name}.${field.name}'`,
        2
      )
    }
    lines.push(`  return { ${dto.fields.map((field) => field.name).join(', ')} }`)
    lines.push('}', '')
  }

  for (const union of model.unions) {
    const members = union.members.map((name) => dtoByName.get(name)).filter(Boolean)
    lines.push(`export function decode${union.name}(value: unknown): ${union.name} {`)
    lines.push(`  if (!isObject(value) || typeof value.type !== 'string') {`)
    lines.push(`    failDecode('${union.name}', 'expected object with type')`)
    lines.push('  }')
    lines.push('  switch (value.type) {')
    for (const member of members) {
      const typeField = member.fields.find((field) => field.name === 'type')
      const literal = typeField?.mapped.literal
      if (!literal) {
        throw new ContractModelError(
          `union member ${member.name} must have a string-literal type field`
        )
      }
      lines.push(`    case '${literal}':`)
      lines.push(`      return decode${member.name}(value)`)
    }
    lines.push('    default:')
    lines.push(`      failDecode('${union.name}', \`unknown type \${String(value.type)}\`)`)
    lines.push('  }')
    lines.push('}', '')
  }
}

export function emitWorkerTypeScript(model, header) {
  const lines = [emitHeader(header), '']
  emitTsConstantsAndTypes(model, lines)
  return lines.join('\n')
}

export function emitRuntimeTypeScript(model, header) {
  const lines = emitTsPrelude(model, header)
  emitTsConstantsAndTypes(model, lines)
  emitTsValidators(model, lines)
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`
}

function invokeEntries(model) {
  const commands = model.maps.find((map) => map.name === 'RuntimeCommands')
  const queries = model.maps.find((map) => map.name === 'RuntimeQueries')
  return [...(commands?.entries ?? []), ...(queries?.entries ?? [])]
}

export function emitRuntimeIpc(model, header) {
  const commands = model.maps.find((map) => map.name === 'RuntimeCommands')
  const queries = model.maps.find((map) => map.name === 'RuntimeQueries')
  const invoke = invokeEntries(model)
  const commandNames = (commands?.entries ?? []).map((entry) => entry.key)
  const queryNames = (queries?.entries ?? []).map((entry) => entry.key)
  const allowlist = [...commandNames, ...queryNames, 'runtime:patch']
  const resultTypes = [...new Set(invoke.map((entry) => entry.slots.result).filter(Boolean))]
  const paramTypes = [...new Set(invoke.map((entry) => entry.slots.params).filter(Boolean))]
  const typeImports = [...new Set([...paramTypes, ...resultTypes, 'RuntimeEventEnvelope'])].sort()

  const lines = [
    emitHeader(header),
    '',
    'import {',
    '  decodeRuntimeEventEnvelope,',
    ...resultTypes.sort().map((name) => `  decode${name},`),
    '  type RuntimeCommandMap,',
    '  type RuntimeQueryMap,',
    ...typeImports.map((name) => `  type ${name},`),
    "} from './contracts'",
    '',
    `export const RUNTIME_PATCH_CHANNEL = 'runtime:patch' as const`,
    `export const RUNTIME_COMMAND_CHANNELS = [${commandNames.map((name) => `'${name}'`).join(', ')}] as const`,
    `export const RUNTIME_QUERY_CHANNELS = [${queryNames.map((name) => `'${name}'`).join(', ')}] as const`,
    `export const RUNTIME_CHANNEL_ALLOWLIST = [${allowlist.map((name) => `'${name}'`).join(', ')}] as const`,
    '',
    'export type RuntimeCommandChannel = (typeof RUNTIME_COMMAND_CHANNELS)[number]',
    'export type RuntimeQueryChannel = (typeof RUNTIME_QUERY_CHANNELS)[number]',
    'export type RuntimeInvokeChannel = RuntimeCommandChannel | RuntimeQueryChannel',
    'export type RuntimeInvokeMap = RuntimeCommandMap & RuntimeQueryMap',
    '',
    'export type RuntimeBridge = {',
    '  invoke: (channel: string, payload: unknown) => Promise<unknown>',
    '  subscribe: (channel: string, listener: (payload: unknown) => void) => () => void',
    '}',
    '',
    'const resultDecoders: Record<string, (value: unknown) => unknown> = {'
  ]
  for (const entry of invoke) {
    lines.push(`  '${entry.key}': decode${entry.slots.result},`)
  }
  lines.push('}', '')
  lines.push('export interface OpenCoworkRuntimeAPI {')
  for (const entry of invoke) {
    const method = channelToMethodName(entry.key)
    lines.push(`  ${method}: (params: ${entry.slots.params}) => Promise<${entry.slots.result}>`)
  }
  lines.push(
    "  invoke: <K extends RuntimeInvokeChannel>(channel: K, params: RuntimeInvokeMap[K]['params']) => Promise<RuntimeInvokeMap[K]['result']>"
  )
  lines.push(
    '  subscribePatches: (listener: (envelopes: RuntimeEventEnvelope[]) => void) => () => void'
  )
  lines.push('}', '')
  lines.push(
    'export function createOpenCoworkRuntimeAPI(bridge: RuntimeBridge): OpenCoworkRuntimeAPI {'
  )
  lines.push(
    "  const invoke = async <K extends RuntimeInvokeChannel>(channel: K, params: RuntimeInvokeMap[K]['params']): Promise<RuntimeInvokeMap[K]['result']> => {"
  )
  lines.push('    if (!(RUNTIME_CHANNEL_ALLOWLIST as readonly string[]).includes(channel)) {')
  lines.push('      throw new Error(`Blocked non-runtime channel: ${channel}`)')
  lines.push('    }')
  lines.push('    const decoder = resultDecoders[channel]')
  lines.push('    const result = await bridge.invoke(channel, params)')
  lines.push("    return (decoder ? decoder(result) : result) as RuntimeInvokeMap[K]['result']")
  lines.push('  }')
  lines.push('  return {')
  for (const entry of invoke) {
    const method = channelToMethodName(entry.key)
    lines.push(`    ${method}: (params) => invoke('${entry.key}', params),`)
  }
  lines.push('    invoke,')
  lines.push('    subscribePatches: (listener) =>')
  lines.push('      bridge.subscribe(RUNTIME_PATCH_CHANNEL, (payload) => {')
  lines.push('        const envelopes = Array.isArray(payload) ? payload : [payload]')
  lines.push('        listener(envelopes.map((item) => decodeRuntimeEventEnvelope(item)))')
  lines.push('      })')
  lines.push('  }')
  lines.push('}', '')
  return lines.join('\n')
}

function csNeedsJson(model) {
  return model.dtos.some((dto) =>
    dto.fields.some(
      (field) =>
        field.mapped.kind === 'json' ||
        field.mapped.kind === 'json-object' ||
        field.mapped.kind === 'union' ||
        field.mapped.kind === 'record' ||
        field.csType.includes('JsonElement') ||
        field.csType.includes('Dictionary')
    )
  )
}

export function emitWorkerCSharp(model, header) {
  const lines = [
    `// ${header}`,
    '#nullable enable',
    'using System.Text.Json.Serialization;',
    '',
    'namespace OpenCowork.Contracts.Generated;',
    ''
  ]
  lines.push('public static class WorkerContractConstants', '{')
  for (const constant of model.constants) {
    if (constant.doc) lines.push(`    /// <summary>${constant.doc}</summary>`)
    lines.push(`    public const int ${pascalConstName(constant.name)} = ${constant.value};`)
  }
  lines.push('}', '')
  for (const dto of model.dtos) {
    if (dto.doc) lines.push(`/// <summary>${dto.doc}</summary>`)
    const args = dto.fields.map((field) => `${field.csType} ${pascalCase(field.name)}`).join(', ')
    lines.push(`public sealed record ${dto.name}(${args});`, '')
  }
  lines.push(
    '// AOT-safe serializer context for the generated DTOs (mirrors WorkerJsonContext options).',
    '[JsonSourceGenerationOptions(',
    '    GenerationMode = JsonSourceGenerationMode.Metadata,',
    '    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,',
    '    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]'
  )
  for (const dto of model.dtos) {
    lines.push(`[JsonSerializable(typeof(${dto.name}))]`)
  }
  lines.push('public sealed partial class GeneratedContractsJsonContext : JsonSerializerContext;')
  lines.push('')
  return lines.join('\n')
}

function emitCsWriteValue(mapped, expr, indent) {
  const pad = ' '.repeat(indent)
  if (mapped.nullable) {
    const valueType = mapped.cs.replace(/\?$/u, '')
    const needsValue =
      valueType === 'bool' ||
      valueType === 'int' ||
      valueType === 'long' ||
      valueType === 'double' ||
      valueType === 'JsonElement'
    const unwrap = needsValue ? `${expr}.Value` : expr
    return [
      `${pad}if (${expr} is null) writer.WriteNull();`,
      `${pad}else`,
      `${pad}{`,
      ...emitCsWriteValue({ ...mapped, nullable: false, cs: valueType }, unwrap, indent + 4),
      `${pad}}`
    ]
  }
  switch (mapped.kind) {
    case 'boolean':
      return [`${pad}writer.WriteBoolean(${expr});`]
    case 'number':
      if (mapped.csNumber === 'long' || mapped.cs === 'long') {
        return [`${pad}writer.WriteInt64(${expr});`]
      }
      if (mapped.csNumber === 'int' || mapped.cs === 'int') {
        return [`${pad}writer.WriteInt32(${expr});`]
      }
      return [`${pad}writer.WriteDouble(${expr});`]
    case 'string':
    case 'literal':
    case 'enum':
      return [`${pad}writer.WriteString(${expr});`]
    case 'json':
    case 'union':
      return [`${pad}writer.WriteJsonElement(${expr});`]
    case 'json-object':
      return [
        `${pad}writer.WriteMapHeader(${expr}.Count);`,
        `${pad}foreach (var pair in ${expr})`,
        `${pad}{`,
        `${pad}    writer.WriteString(pair.Key);`,
        `${pad}    writer.WriteJsonElement(pair.Value);`,
        `${pad}}`
      ]
    case 'record':
      return [
        `${pad}writer.WriteMapHeader(${expr}.Count);`,
        `${pad}foreach (var pair in ${expr})`,
        `${pad}{`,
        `${pad}    writer.WriteString(pair.Key);`,
        ...emitCsWriteValue(mapped.value, 'pair.Value', indent + 4),
        `${pad}}`
      ]
    case 'array':
      return [
        `${pad}writer.WriteArrayHeader(${expr}.Length);`,
        `${pad}foreach (var item in ${expr})`,
        `${pad}{`,
        ...emitCsWriteValue(mapped.element, 'item', indent + 4),
        `${pad}}`
      ]
    case 'dto':
      return [`${pad}Write${mapped.ref}(writer, ${expr});`]
    default:
      return [`${pad}writer.WriteNull();`]
  }
}

export function emitRuntimeCSharp(model, header) {
  const lines = [
    `// ${header}`,
    '#nullable enable',
    'using System.Collections.Generic;',
    'using System.Text.Json;',
    'using System.Text.Json.Serialization;',
    '',
    'namespace OpenCowork.Contracts.Generated;',
    ''
  ]
  lines.push('public static class AgentRuntimeContractConstants', '{')
  for (const constant of model.constants) {
    if (constant.doc) lines.push(`    /// <summary>${constant.doc}</summary>`)
    lines.push(`    public const int ${pascalConstName(constant.name)} = ${constant.value};`)
  }
  const commands = model.maps.find((map) => map.name === 'RuntimeCommands')
  const queries = model.maps.find((map) => map.name === 'RuntimeQueries')
  const events = model.maps.find((map) => map.name === 'RuntimeEvents')
  for (const entry of [...(commands?.entries ?? []), ...(queries?.entries ?? [])]) {
    lines.push(
      `    public const string ${pascalCase(channelToMethodName(entry.key))}Channel = "${entry.key}";`
    )
  }
  lines.push('    public const string PatchChannel = "runtime:patch";')
  lines.push('}', '')

  for (const item of model.enums) {
    if (item.doc) lines.push(`/// <summary>${item.doc}</summary>`)
    lines.push(`public static class ${item.name}Values`, '{')
    for (const value of item.values) {
      lines.push(
        `    public const string ${pascalCase(
          value
            .replace(/[^a-zA-Z0-9]+/g, ' ')
            .split(' ')
            .filter(Boolean)
            .map(pascalCase)
            .join('')
        )} = "${value}";`
      )
    }
    lines.push('}', '')
  }

  for (const dto of model.dtos) {
    if (dto.doc) lines.push(`/// <summary>${dto.doc}</summary>`)
    const args = dto.fields.map((field) => `${field.csType} ${pascalCase(field.name)}`).join(', ')
    lines.push(`public sealed record ${dto.name}(${args});`, '')
  }

  lines.push(
    '[JsonSourceGenerationOptions(',
    '    GenerationMode = JsonSourceGenerationMode.Metadata,',
    '    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,',
    '    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]'
  )
  for (const dto of model.dtos) {
    lines.push(`[JsonSerializable(typeof(${dto.name}))]`)
  }
  if (csNeedsJson(model)) {
    lines.push('[JsonSerializable(typeof(JsonElement))]')
    lines.push('[JsonSerializable(typeof(Dictionary<string, JsonElement>))]')
  }
  lines.push(
    'public sealed partial class AgentRuntimeContractsJsonContext : JsonSerializerContext;'
  )
  lines.push('')

  lines.push('public static class RuntimeEventMessagePack', '{')
  for (const dto of model.dtos) {
    lines.push(
      `    internal static void Write${dto.name}(MessagePackWriter writer, ${dto.name} value)`
    )
    lines.push('    {')
    lines.push(`        writer.WriteMapHeader(${dto.fields.length});`)
    for (const field of dto.fields) {
      lines.push(`        writer.WriteString("${field.name}");`)
      lines.push(...emitCsWriteValue(field.mapped, `value.${pascalCase(field.name)}`, 8))
    }
    lines.push('    }')
    lines.push('')
  }
  const envelope = model.dtos.find((dto) => dto.name === 'RuntimeEventEnvelope')
  if (envelope) {
    lines.push('    public static byte[] Encode(RuntimeEventEnvelope envelope)')
    lines.push('    {')
    lines.push('        var writer = new MessagePackWriter();')
    lines.push('        WriteRuntimeEventEnvelope(writer, envelope);')
    lines.push('        return writer.ToArray();')
    lines.push('    }')
  }
  lines.push('}', '')
  void events
  return lines.join('\n')
}
