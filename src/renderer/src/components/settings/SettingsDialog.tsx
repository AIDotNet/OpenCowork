import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { Slider } from '@renderer/components/ui/slider'
import { Textarea } from '@renderer/components/ui/textarea'
import { useTheme } from 'next-themes'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import type { ProviderType } from '@renderer/lib/api/types'
import { Button } from '@renderer/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { toast } from 'sonner'
import { Loader2, Eye, EyeOff } from 'lucide-react'

const providerOptions: { value: ProviderType; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
]

const modelPresets: Record<ProviderType, string[]> = {
  anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
  'openai-chat': ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  'openai-responses': ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
}

const defaultModels: Record<ProviderType, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  'openai-chat': 'gpt-4o',
  'openai-responses': 'gpt-4o',
}

export function SettingsDialog(): React.JSX.Element {
  const open = useUIStore((s) => s.settingsOpen)
  const setOpen = useUIStore((s) => s.setSettingsOpen)
  const settings = useSettingsStore()
  const { setTheme } = useTheme()
  const [testing, setTesting] = useState(false)
  const [showKey, setShowKey] = useState(false)

  const handleTestConnection = async (): Promise<void> => {
    if (!settings.apiKey) { toast.error('No API key set'); return }
    setTesting(true)
    try {
      const baseUrl = (settings.baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
      const isAnthropic = settings.provider === 'anthropic'
      const url = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (isAnthropic) {
        headers['x-api-key'] = settings.apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        headers['Authorization'] = `Bearer ${settings.apiKey}`
      }
      const body = isAnthropic
        ? JSON.stringify({ model: settings.model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
        : JSON.stringify({ model: settings.model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })

      const result = await window.electron.ipcRenderer.invoke('api:request', { url, method: 'POST', headers, body })
      if (result?.error) {
        toast.error('Connection failed', { description: result.error })
      } else {
        const status = result?.statusCode ?? 0
        if (status >= 200 && status < 300) {
          toast.success('Connection successful!')
        } else if (status === 401 || status === 403) {
          toast.error('Invalid API key', { description: `HTTP ${status}` })
        } else {
          toast.warning(`Unexpected status: ${status}`, { description: result?.body?.slice(0, 200) })
        }
      }
    } catch (err) {
      toast.error('Connection failed', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure API providers and preferences</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* Provider Selection */}
          <section className="space-y-2">
            <label className="text-sm font-medium">API Provider</label>
            <Select
              value={settings.provider}
              onValueChange={(v: ProviderType) => settings.updateSettings({ provider: v, model: defaultModels[v] })}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((p) => (
                  <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          <Separator />

          {/* API Key */}
          <section className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                placeholder="Enter your API key..."
                value={settings.apiKey}
                onChange={(e) => {
                  settings.updateSettings({ apiKey: e.target.value })
                  window.electron.ipcRenderer.invoke('settings:set', {
                    key: 'apiKey',
                    value: e.target.value,
                  })
                }}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-muted-foreground">
                Stored securely in the main process, not in browser storage
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-6 shrink-0 gap-1 text-[10px]"
                disabled={!settings.apiKey || testing}
                onClick={handleTestConnection}
              >
                {testing && <Loader2 className="size-3 animate-spin" />}
                {testing ? 'Testing...' : 'Test'}
              </Button>
            </div>
          </section>

          {/* Base URL */}
          <section className="space-y-2">
            <label className="text-sm font-medium">Base URL (optional)</label>
            <Input
              placeholder={settings.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'}
              value={settings.baseUrl}
              onChange={(e) => settings.updateSettings({ baseUrl: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Custom endpoint for proxies or third-party compatible services
            </p>
          </section>

          {/* Model */}
          <section className="space-y-2">
            <label className="text-sm font-medium">Model</label>
            <Select
              value={modelPresets[settings.provider]?.includes(settings.model) ? settings.model : '__custom__'}
              onValueChange={(v) => {
                if (v !== '__custom__') settings.updateSettings({ model: v })
              }}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {modelPresets[settings.provider]?.map((m) => (
                  <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>
                ))}
                <SelectItem value="__custom__" className="text-xs">Custom...</SelectItem>
              </SelectContent>
            </Select>
            {!modelPresets[settings.provider]?.includes(settings.model) && (
              <Input
                placeholder="Enter custom model name"
                value={settings.model}
                onChange={(e) => settings.updateSettings({ model: e.target.value })}
                className="text-xs"
              />
            )}
          </section>

          <Separator />

          {/* Temperature */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Temperature</label>
              <span className="text-xs text-muted-foreground">{settings.temperature}</span>
            </div>
            <Slider
              value={[settings.temperature]}
              onValueChange={([v]) => settings.updateSettings({ temperature: v })}
              min={0}
              max={1}
              step={0.1}
            />
            <div className="flex items-center justify-between">
              {[
                { v: 0, label: 'Precise' },
                { v: 0.3, label: 'Balanced' },
                { v: 0.7, label: 'Creative' },
                { v: 1, label: 'Random' },
              ].map(({ v, label }) => (
                <button
                  key={v}
                  onClick={() => settings.updateSettings({ temperature: v })}
                  className={`text-[9px] transition-colors ${settings.temperature === v ? 'text-foreground font-medium' : 'text-muted-foreground/50 hover:text-muted-foreground'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          {/* Max Tokens */}
          <section className="space-y-2">
            <label className="text-sm font-medium">Max Tokens</label>
            <Input
              type="number"
              value={settings.maxTokens}
              onChange={(e) =>
                settings.updateSettings({ maxTokens: parseInt(e.target.value) || 32000 })
              }
            />
            <div className="flex items-center gap-1">
              {[8192, 16384, 32000, 64000, 128000].map((v) => (
                <button
                  key={v}
                  onClick={() => settings.updateSettings({ maxTokens: v })}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${settings.maxTokens === v ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                >
                  {v >= 1000 ? `${Math.round(v / 1024)}K` : v}
                </button>
              ))}
            </div>
          </section>

          <Separator />

          {/* System Prompt */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">System Prompt (optional)</label>
              {settings.systemPrompt && (
                <span className="text-[10px] text-muted-foreground/50">{settings.systemPrompt.length} chars</span>
              )}
            </div>
            <Textarea
              placeholder="Add custom instructions for the assistant..."
              value={settings.systemPrompt}
              onChange={(e) => settings.updateSettings({ systemPrompt: e.target.value })}
              rows={3}
            />
            <p className="text-[10px] text-muted-foreground/40">
              Appended to the built-in system prompt in cowork/code modes.
            </p>
          </section>

          {/* Theme */}
          <section className="space-y-2">
            <label className="text-sm font-medium">Theme</label>
            <Select
              value={settings.theme}
              onValueChange={(v: 'light' | 'dark' | 'system') => { settings.updateSettings({ theme: v }); setTheme(v) }}
            >
              <SelectTrigger className="w-full text-xs capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['light', 'dark', 'system'] as const).map((t) => (
                  <SelectItem key={t} value={t} className="text-xs capitalize">{t}</SelectItem>
              ))}
              </SelectContent>
            </Select>
          </section>

          {/* Auto Approve */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Auto-Approve Tools</label>
                <p className="text-xs text-muted-foreground">
                  Skip permission dialogs for all tool calls
                </p>
              </div>
              <Button
                variant={settings.autoApprove ? 'destructive' : 'outline'}
                size="sm"
                className="text-xs"
                onClick={() => {
                  if (!settings.autoApprove && !window.confirm('Enable auto-approve? All tool calls will execute without confirmation.')) return
                  settings.updateSettings({ autoApprove: !settings.autoApprove })
                }}
              >
                {settings.autoApprove ? 'ON (Dangerous)' : 'OFF'}
              </Button>
            </div>
          </section>

          <Separator />

          {/* Reset */}
          <section>
            <Button
              variant="outline"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => {
                if (!window.confirm('Reset all settings to defaults? Your API key will be preserved.')) return
                const currentKey = settings.apiKey
                settings.updateSettings({
                  provider: 'anthropic',
                  baseUrl: '',
                  model: 'claude-sonnet-4-20250514',
                  maxTokens: 32000,
                  temperature: 0.7,
                  systemPrompt: '',
                  theme: 'system',
                  apiKey: currentKey,
                })
                setTheme('system')
              }}
            >
              Reset to Defaults
            </Button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
