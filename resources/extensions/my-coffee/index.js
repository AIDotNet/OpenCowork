/* eslint-disable @typescript-eslint/explicit-function-return-type */

const MCP_URL = 'https://gwmcp.lkcoffee.com/order/user/mcp'
const TOKEN_GUIDE =
  '请先访问 MCP 开放平台 https://open.lkcoffee.com/mcp 点击“登录”创建 token，并在 OpenCowork 设置 -> 扩展 -> My Coffee 中填写 Luckin MCP Token；随后在输入框 + 菜单的自定义插件里选择 My Coffee。'

let rpcId = 0

const MCP_TOOL_NAMES = {
  queryShopList: ['queryShopList', 'query_shop_list'],
  searchProduct: ['searchProductForMcp', 'search_product'],
  switchProduct: ['switchProduct', 'switch_product'],
  queryProductDetail: ['queryProductDetailInfo', 'query_product_detail'],
  previewOrder: ['previewOrder', 'preview_order'],
  createOrder: ['createOrder', 'create_order'],
  queryOrderDetail: ['queryOrderDetailInfo', 'query_order_detail'],
  cancelOrder: ['cancelOrder', 'cancel_order']
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function compactRecord(value) {
  const result = {}
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined && item !== null && item !== '') result[key] = item
  }
  return result
}

function parseJsonMaybe(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseSsePayloads(text) {
  if (typeof text !== 'string') return []
  const payloads = []
  let dataLines = []
  const flush = () => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data || data === '[DONE]') return
    const parsed = parseJsonMaybe(data)
    if (parsed) payloads.push(parsed)
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  flush()
  return payloads
}

function contentText(result) {
  if (!isRecord(result) || !Array.isArray(result.content)) return ''
  return result.content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
}

function unwrapToolPayload(result) {
  if (!isRecord(result)) return result
  if (result.structuredContent !== undefined) return result.structuredContent

  const text = contentText(result)
  const parsed = parseJsonMaybe(text)
  if (parsed) return parsed
  if (text) return { text }
  return result
}

function unwrapRpcResponse(response) {
  const responseText = response && typeof response.text === 'string' ? response.text : ''
  const payloads = []
  if (response && response.json) payloads.push(response.json)
  payloads.push(...parseSsePayloads(responseText))
  const envelope =
    payloads.find((payload) => payload && (payload.result || payload.error)) || payloads[0]

  if (!response || response.ok !== true) {
    const status = response ? `${response.status || ''} ${response.statusText || ''}`.trim() : ''
    const errorText = describeRpcFailure(envelope)
    throw new Error(
      `Luckin MCP request failed${status ? `: ${status}` : ''}${errorText ? ` - ${errorText}` : ''}`
    )
  }

  if (!envelope) {
    const parsed = parseJsonMaybe(responseText)
    if (parsed) return parsed
    return { text: responseText }
  }
  if (envelope.error) {
    const message =
      envelope.error && envelope.error.message
        ? envelope.error.message
        : JSON.stringify(envelope.error)
    throw new Error(message)
  }
  return envelope.result !== undefined ? envelope.result : envelope
}

function describeRpcFailure(envelope) {
  if (!isRecord(envelope)) return ''
  if (envelope.error) {
    return envelope.error && envelope.error.message
      ? asString(envelope.error.message)
      : JSON.stringify(envelope.error)
  }
  const result = envelope.result
  if (isRecord(result) && result.isError === true) {
    const text = contentText(result).trim()
    return text || JSON.stringify(result)
  }
  return ''
}

function getToken(ctx) {
  const token = asString(ctx.config && ctx.config.luckinToken).trim()
  if (!token) throw new Error(TOKEN_GUIDE)
  return token
}

async function callMcp(ctx, method, params) {
  const response = await ctx.fetch({
    method: 'POST',
    url: MCP_URL,
    headers: {
      Authorization: `Bearer ${getToken(ctx)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: {
      jsonrpc: '2.0',
      method,
      params,
      id: ++rpcId
    }
  })
  return unwrapRpcResponse(response)
}

async function callMcpTool(ctx, name, args) {
  const names = Array.isArray(name) ? name : [name]
  let lastError
  for (const item of names) {
    try {
      const result = await callMcp(ctx, 'tools/call', {
        name: item,
        arguments: args || {}
      })
      if (isRecord(result) && result.isError === true) {
        throw new Error(describeRpcFailure({ result }) || `Luckin MCP tool failed: ${item}`)
      }
      return unwrapToolPayload(result)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!/tool not found/i.test(message)) throw error
    }
  }
  throw lastError
}

function deepOmit(value, omittedKeys) {
  if (Array.isArray(value)) return value.map((item) => deepOmit(item, omittedKeys))
  if (!isRecord(value)) return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (omittedKeys.includes(key)) continue
    result[key] = deepOmit(item, omittedKeys)
  }
  return result
}

function normalizeProductList(productList) {
  if (!Array.isArray(productList)) return []
  return productList.map((item) => ({
    amount: Number(item && item.amount),
    productId: Number(item && item.productId),
    skuCode: asString(item && item.skuCode)
  }))
}

function productSignature(deptId, productList) {
  return JSON.stringify({
    deptId: Number(deptId),
    productList: normalizeProductList(productList)
  })
}

function findFirstValue(value, keys, depth = 0) {
  if (depth > 6) return ''
  if (isRecord(value)) {
    for (const key of keys) {
      const found = asString(value[key]).trim()
      if (found) return found
    }
    for (const item of Object.values(value)) {
      const found = findFirstValue(item, keys, depth + 1)
      if (found) return found
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstValue(item, keys, depth + 1)
      if (found) return found
    }
  }
  return ''
}

function findFirstArrayValue(value, keys, depth = 0) {
  if (depth > 6) return []
  if (isRecord(value)) {
    for (const key of keys) {
      if (Array.isArray(value[key])) return value[key]
    }
    for (const item of Object.values(value)) {
      const found = findFirstArrayValue(item, keys, depth + 1)
      if (found.length > 0) return found
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstArrayValue(item, keys, depth + 1)
      if (found.length > 0) return found
    }
  }
  return []
}

function luckinData(value) {
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'data')) return value.data
  return value
}

function money(value) {
  const text = asString(value).trim()
  if (!text) return ''
  return text.startsWith('¥') ? text : `¥${text}`
}

function safeHttpUrl(value) {
  const text = asString(value).trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

function joinText(items, separator = ' / ') {
  return items
    .map((item) => asString(item).trim())
    .filter(Boolean)
    .join(separator)
}

function formatDecimal(value, digits = 2) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return number.toFixed(digits).replace(/\.?0+$/, '')
}

function formatDistance(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  if (number < 1) return `${Math.round(number * 1000)}m`
  return `${formatDecimal(number)}km`
}

function formatTimeRange(start, end) {
  const left = asString(start).trim()
  const right = asString(end).trim()
  if (!left && !right) return ''
  return [left, right].filter(Boolean).join('-')
}

function padNumber(value) {
  return String(value).padStart(2, '0')
}

function formatDateTime(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  const date = new Date(number)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`
}

function field(label, value) {
  const text = asString(value).trim()
  if (!text) return null
  return { label, value: text }
}

function compactList(items) {
  return items.filter(Boolean)
}

function section(title, items) {
  const rows = compactList(items)
  if (rows.length === 0) return null
  return { title, items: rows }
}

function detailLine(label, value) {
  const text = asString(value).trim()
  if (!text) return ''
  return `${label}: ${text}`
}

function summarizeProductAttrs(productAttrs) {
  if (!Array.isArray(productAttrs)) return ''
  return productAttrs
    .map((attribute) => {
      if (!isRecord(attribute)) return ''
      const name = asString(attribute.attributeName || attribute.name).trim()
      const options = Array.isArray(attribute.productSubAttrs)
        ? attribute.productSubAttrs
            .map((item) => asString(item && (item.attributeName || item.name)).trim())
            .filter(Boolean)
            .join(' / ')
        : ''
      if (!name && !options) return ''
      if (!name) return options
      if (!options) return name
      return `${name}: ${options}`
    })
    .filter(Boolean)
    .join(' | ')
}

function normalizeShopRow(shop) {
  if (!isRecord(shop)) return {}
  return {
    ...shop,
    deptId: Number(shop.deptId) || shop.deptId,
    deptName: asString(shop.deptName || shop.name).trim(),
    address: asString(shop.address).trim(),
    businessTime: formatTimeRange(shop.workTimeStart, shop.workTimeEnd),
    distanceText: formatDistance(shop.distance),
    number: asString(shop.number).trim(),
    workStatus: asString(shop.workStatus).trim()
  }
}

function normalizeProductRow(product) {
  if (!isRecord(product)) return {}
  const attributeSummary =
    asString(product.additionDesc).trim() || summarizeProductAttrs(product.productAttrs)
  const imageUrl = safeHttpUrl(
    findFirstValue(product, ['pictureUrl', 'breviaryPicUrl', 'bigPicUrl', 'picture'])
  )
  const price =
    money(
      findFirstValue(product, [
        'estimatePrice',
        'estimateTotalPrice',
        'discountPrice',
        'price',
        'payMoney'
      ])
    ) || money(findFirstValue(product, ['initialPrice', 'initPrice', 'payableMoney']))
  const initialPrice = money(findFirstValue(product, ['initialPrice', 'initPrice', 'payableMoney']))
  const tags = Array.isArray(product.tags)
    ? product.tags
        .map((item) => asString(item).trim())
        .filter(Boolean)
        .join(' / ')
    : ''
  const amount = Number(product.amount)
  return {
    ...product,
    productId:
      Number(product.productId || product.commodityId) || product.productId || product.commodityId,
    productName: asString(
      product.productName || product.name || product.commodityName || product.title
    ).trim(),
    skuCode: asString(product.skuCode || product.commodityCode).trim(),
    skuName: attributeSummary || tags,
    attributeSummary,
    tagsText: tags,
    estimatePrice: price,
    initialPriceText: initialPrice,
    imageUrl,
    amountText: Number.isFinite(amount) && amount > 0 ? `x${amount}` : '',
    badgeText: price || initialPrice
  }
}

function productSummaryItem(product, index) {
  const normalized = normalizeProductRow(product)
  if (!isRecord(normalized)) return null
  const labelParts = [
    asString(normalized.productName).trim() || `商品 ${index + 1}`,
    asString(normalized.amountText).trim()
  ].filter(Boolean)
  const value = joinText(
    [normalized.attributeSummary, normalized.tagsText, normalized.estimatePrice],
    ' | '
  )
  const details = compactList([
    detailLine('SKU', normalized.skuCode),
    detailLine('商品 ID', normalized.productId),
    detailLine('标签', normalized.tagsText),
    normalized.initialPriceText && normalized.initialPriceText !== normalized.estimatePrice
      ? detailLine('原价', normalized.initialPriceText)
      : '',
    normalized.estimatePrice ? detailLine('价格', normalized.estimatePrice) : '',
    !normalized.estimatePrice && normalized.initialPriceText
      ? detailLine('价格', normalized.initialPriceText)
      : ''
  ])
  if (labelParts.length === 0 && !value && details.length === 0) return null
  return {
    label: labelParts.join(' '),
    value,
    imageUrl: normalized.imageUrl,
    badge: normalized.badgeText,
    details
  }
}

function optionSummaryItem(attribute, index) {
  if (!isRecord(attribute)) return null
  const options = Array.isArray(attribute.productSubAttrs)
    ? attribute.productSubAttrs
        .map((item) => asString(item && (item.attributeName || item.name)).trim())
        .filter(Boolean)
        .join(' / ')
    : ''
  return {
    label: asString(attribute.attributeName || attribute.name).trim() || `选项 ${index + 1}`,
    value: options || '以接口返回为准'
  }
}

function shopSection(shop) {
  if (!isRecord(shop)) return null
  const normalized = normalizeShopRow(shop)
  return section('门店信息', [
    field('门店', normalized.deptName),
    field('地址', normalized.address),
    field('营业时间', normalized.businessTime),
    field('门店编号', normalized.number),
    field('门店状态', normalized.workStatus),
    field('距离', normalized.distanceText)
  ])
}

function productSection(products, title = '商品信息') {
  if (!Array.isArray(products) || products.length === 0) return null
  return section(
    title,
    products.slice(0, 8).map((item, index) => productSummaryItem(item, index))
  )
}

function couponSection(couponCodes) {
  if (!Array.isArray(couponCodes) || couponCodes.length === 0) return null
  return section(
    '优惠券',
    couponCodes.slice(0, 5).map((code, index) => field(`券码 ${index + 1}`, code))
  )
}

function buildPreviewSections(payload) {
  const data = luckinData(payload)
  const shop = isRecord(data) && isRecord(data.shopInfo) ? data.shopInfo : null
  const products = findFirstArrayValue(data, ['productInfoList', 'productList'])
  const couponCodes = findFirstArrayValue(data, ['couponCodeList', 'couponCodes'])
  return compactList([shopSection(shop), productSection(products), couponSection(couponCodes)])
}

function buildOrderSections(payload) {
  const data = luckinData(payload)
  const shop =
    isRecord(data) && isRecord(data.shopInfo)
      ? data.shopInfo
      : isRecord(data) && isRecord(data.deptInfo)
        ? data.deptInfo
        : null
  const products = findFirstArrayValue(data, [
    'productInfoList',
    'orderProductList',
    'productList',
    'orderGranularCommodityList'
  ])
  return compactList([shopSection(shop), productSection(products)])
}

function componentResult(toolName, text, data, ui) {
  return {
    text,
    data,
    ui
  }
}

function listRows(payload, keys) {
  const data = luckinData(payload)
  if (Array.isArray(data)) return data
  return findFirstArrayValue(data, keys)
}

async function checkToken(_input, ctx) {
  getToken(ctx)
  return {
    text: 'Luckin MCP token 已配置。',
    data: { configured: true }
  }
}

async function listTools(_input, ctx) {
  const result = await callMcp(ctx, 'tools/list', {})
  return {
    text: 'Luckin MCP tools 已读取。',
    data: result
  }
}

async function queryShopList(input, ctx) {
  const payload = await callMcpTool(
    ctx,
    MCP_TOOL_NAMES.queryShopList,
    compactRecord({
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      deptName: input.deptName,
      locationIsPrecise: input.locationIsPrecise === true
    })
  )
  const shops = listRows(payload, ['deptId', 'deptName', 'address']).map(normalizeShopRow)
  return componentResult(
    'query_shop_list',
    `门店查询完成，共找到 ${shops.length} 家门店。`,
    payload,
    {
      kind: 'component',
      component: 'luckin_shop_list',
      props: {
        title: 'Luckin stores',
        subtitle: '请选择要自提的门店',
        shops
      }
    }
  )
}

async function searchProduct(input, ctx) {
  const payload = await callMcpTool(ctx, MCP_TOOL_NAMES.searchProduct, {
    deptId: Number(input.deptId),
    query: asString(input.query)
  })
  const products = listRows(payload, ['productId', 'productName', 'skuCode']).map(
    normalizeProductRow
  )
  return componentResult(
    'search_product',
    `商品查询完成，共找到 ${products.length} 个商品。`,
    payload,
    {
      kind: 'component',
      component: 'luckin_product_list',
      props: {
        title: 'Luckin products',
        subtitle: asString(input.query),
        products
      }
    }
  )
}

async function queryProductDetail(input, ctx) {
  const payload = await callMcpTool(
    ctx,
    MCP_TOOL_NAMES.queryProductDetail,
    compactRecord({
      deptId: Number(input.deptId),
      productId: Number(input.productId)
    })
  )
  const data = luckinData(payload)
  const attrs = findFirstArrayValue(data, ['productAttrs', 'attrs', 'attributes'])
  const normalizedProduct = normalizeProductRow(data)
  const fields = compactList([
    field('商品', normalizedProduct.productName),
    field('商品 ID', normalizedProduct.productId),
    field('SKU', normalizedProduct.skuCode),
    field(
      '价格',
      money(findFirstValue(data, ['estimatePrice', 'discountPrice', 'price', 'initPrice']))
    )
  ])
  const sections = compactList([
    section('商品信息', [productSummaryItem(data, 0)]),
    section(
      '可选属性',
      attrs.slice(0, 12).map((attribute, index) => optionSummaryItem(attribute, index))
    )
  ])
  return componentResult('query_product_detail', '商品详情已读取。', payload, {
    kind: 'component',
    component: 'luckin_order_summary',
    props: {
      title: 'Luckin product detail',
      subtitle: '可选属性以返回数据为准',
      fields,
      sections
    }
  })
}

async function switchProduct(input, ctx) {
  const payload = await callMcpTool(ctx, MCP_TOOL_NAMES.switchProduct, {
    deptId: Number(input.deptId),
    productId: Number(input.productId),
    skuCode: asString(input.skuCode),
    attrOperationParam: input.attrOperationParam || {},
    amount: Number(input.amount)
  })
  return {
    text: '商品属性已切换。',
    data: payload
  }
}

async function previewOrder(input, ctx) {
  const productList = normalizeProductList(input.productList)
  const payload = await callMcpTool(ctx, MCP_TOOL_NAMES.previewOrder, {
    deptId: Number(input.deptId),
    productList
  })
  const couponCodeList = findFirstArrayValue(luckinData(payload), ['couponCodeList', 'couponCodes'])
  await ctx.storage.set('last_preview_order', {
    signature: productSignature(input.deptId, productList),
    couponCodeList,
    payload
  })
  const payPrice = money(findFirstValue(payload, ['discountPrice', 'payPrice']))
  const fields = [
    { label: '原价', value: money(findFirstValue(payload, ['totalInitialPrice', 'initialPrice'])) },
    { label: '优惠', value: money(findFirstValue(payload, ['privilegeMoney', 'discountMoney'])) },
    { label: '应付', value: payPrice },
    {
      label: '预计取餐',
      value: formatDateTime(findFirstValue(payload, ['aboutTime', 'pickupTime']))
    }
  ].filter((item) => item.value)
  return componentResult(
    'preview_order',
    payPrice ? `订单预览完成，应付 ${payPrice}。` : '订单预览完成。',
    payload,
    {
      kind: 'component',
      component: 'luckin_order_summary',
      props: {
        title: 'Luckin order preview',
        subtitle: '请核对应付金额和优惠',
        fields,
        sections: buildPreviewSections(payload)
      }
    }
  )
}

async function createOrder(input, ctx) {
  const productList = normalizeProductList(input.productList)
  const signature = productSignature(input.deptId, productList)
  const preview = await ctx.storage.get('last_preview_order')
  if (!isRecord(preview) || preview.signature !== signature) {
    throw new Error('创建订单前必须先用相同门店和商品调用 preview_order。')
  }

  const payload = await callMcpTool(
    ctx,
    MCP_TOOL_NAMES.createOrder,
    compactRecord({
      deptId: Number(input.deptId),
      productList,
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      couponCodeList: preview.couponCodeList
    })
  )
  const safePayload = deepOmit(payload, ['payOrderUrl'])
  const orderId = findFirstValue(safePayload, ['orderId', 'orderNo'])
  const qrCodeUrl = findFirstValue(safePayload, ['payOrderQrCodeUrl', 'qrCodeUrl'])
  if (orderId) await ctx.storage.set('last_order_id', orderId)
  const fields = [
    { label: '订单号', value: orderId },
    { label: '应付', value: money(findFirstValue(safePayload, ['discountPrice', 'payPrice'])) }
  ].filter((item) => item.value)
  return componentResult(
    'create_order',
    orderId ? `订单已创建，订单号 ${orderId}。` : '订单已创建。',
    safePayload,
    {
      kind: 'component',
      component: 'luckin_payment',
      props: {
        title: 'Luckin payment',
        subtitle: '支付完成后可继续查询取餐码',
        fields,
        qrCodeUrl,
        openUrl: qrCodeUrl
      }
    }
  )
}

async function queryOrderDetail(input, ctx) {
  const orderId =
    asString(input.orderId).trim() || asString(await ctx.storage.get('last_order_id')).trim()
  if (!orderId) throw new Error('请提供订单号。')
  const payload = await callMcpTool(ctx, MCP_TOOL_NAMES.queryOrderDetail, { orderId })
  await ctx.storage.set('last_order_id', orderId)
  const fields = [
    { label: '订单号', value: orderId },
    { label: '状态', value: findFirstValue(payload, ['orderStatus', 'status', 'statusText']) },
    { label: '取餐码', value: findFirstValue(payload, ['takeCode', 'pickupCode', 'mealCode']) },
    { label: '应付', value: money(findFirstValue(payload, ['discountPrice', 'payPrice'])) }
  ].filter((item) => item.value)
  return componentResult('query_order_detail', '订单状态已查询。', payload, {
    kind: 'component',
    component: 'luckin_status',
    props: {
      title: 'Luckin order status',
      subtitle: '仅在已支付且接口返回时展示取餐信息',
      fields,
      sections: buildOrderSections(payload)
    }
  })
}

async function cancelOrder(input, ctx) {
  const orderId =
    asString(input.orderId).trim() || asString(await ctx.storage.get('last_order_id')).trim()
  if (!orderId) throw new Error('请提供订单号。')
  const payload = await callMcpTool(ctx, MCP_TOOL_NAMES.cancelOrder, { orderId })
  return componentResult('cancel_order', '取消订单请求已提交。', payload, {
    kind: 'component',
    component: 'luckin_order_summary',
    props: {
      title: 'Luckin cancellation',
      subtitle: orderId,
      fields: [{ label: '订单号', value: orderId }]
    }
  })
}

globalThis.openCoworkExtension = {
  handlers: {
    checkToken,
    listTools,
    queryShopList,
    searchProduct,
    queryProductDetail,
    switchProduct,
    previewOrder,
    createOrder,
    queryOrderDetail,
    cancelOrder
  }
}
