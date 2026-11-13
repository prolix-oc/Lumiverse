import React, { type ReactNode } from 'react'
import styles from './ErrorBoundary.module.css'

interface Props {
  label?: string
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      `[Lumiverse ErrorBoundary${this.props.label ? ` — ${this.props.label}` : ''}]`,
      error,
      errorInfo?.componentStack
    )
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.fallback}>
          <span className={styles.message}>
            Something went wrong
            {this.props.label ? ` in ${this.props.label}` : ''}
          </span>
          <button onClick={this.handleRetry} type="button" className={styles.retryBtn}>
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
