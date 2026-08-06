import { useState } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import Library from './components/Library';
import Viewer from './components/Viewer';

export default function App() {
  const [docId, setDocId] = useState<string | null>(null);

  return (
    <div className="h-full">
      <ErrorBoundary key={docId ?? 'library'}>
        {docId ? (
          <Viewer docId={docId} onBack={() => setDocId(null)} />
        ) : (
          <Library onOpen={setDocId} />
        )}
      </ErrorBoundary>
    </div>
  );
}
