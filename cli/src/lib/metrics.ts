export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) {
    const thousands = value / 1_000
    const formatted =
      thousands < 100 ? thousands.toFixed(1).replace(/\.0$/u, '') : thousands.toFixed(0)
    return `${formatted}k`
  }
  const millions = value / 1_000_000
  return `${millions < 10 ? millions.toFixed(2) : millions.toFixed(1)}M`
}

export function formatUsdCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value > 0 && value < 0.0001) return '<$0.0001'
  return `$${value.toFixed(4)}`
}
