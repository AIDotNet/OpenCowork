import { QRCodeCanvas } from 'qrcode.react'

export function QrCanvas({ value, size = 192 }: { value: string; size?: number }) {
  return (
    <div className="rounded-lg bg-white p-3">
      <QRCodeCanvas value={value} size={size} marginSize={3} />
    </div>
  )
}
