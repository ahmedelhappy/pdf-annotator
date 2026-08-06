import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Without this, one thrown error during render leaves a white screen with no
 * way back to the library.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[crash]', error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-lg w-full bg-neutral-900 rounded-lg p-6 text-neutral-200">
          <h2 className="text-lg mb-2">The viewer stopped</h2>
          <p className="text-sm text-neutral-400 mb-4">
            Something in the page failed to render. The document and its annotations are
            safe on disk. The full stack trace is in the browser console.
          </p>
          <pre className="text-xs bg-neutral-950 rounded p-3 overflow-x-auto text-rose-300 mb-4">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 rounded text-sm text-white"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
              onClick={() => window.location.reload()}
            >
              Reload the app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
