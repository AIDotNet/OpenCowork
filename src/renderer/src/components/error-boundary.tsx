import { Component } from 'react'

interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
    this.setState({ errorInfo: info })
  }

  private handleCopyError = (): void => {
    const { error, errorInfo } = this.state
    const text = [
      `Error: ${error?.message}`,
      `Stack: ${error?.stack}`,
      errorInfo?.componentStack ? `Component Stack: ${errorInfo.componentStack}` : '',
    ].filter(Boolean).join('\n\n')
    navigator.clipboard.writeText(text)
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex h-screen flex-col items-center justify-center gap-6 p-8 text-center bg-background">
          <div className="flex size-16 items-center justify-center rounded-full bg-destructive/10">
            <svg className="size-8 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {this.state.error?.message || 'An unexpected error occurred in the application.'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
            >
              Try Again
            </button>
            <button
              className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              onClick={() => window.location.reload()}
            >
              Reload App
            </button>
            <button
              className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              onClick={this.handleCopyError}
            >
              Copy Error
            </button>
          </div>

          {this.state.error?.stack && (
            <details className="w-full max-w-lg text-left">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
                Error details
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground">
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      )
    }

    return this.props.children
  }
}
