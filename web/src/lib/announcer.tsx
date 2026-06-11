import { useEffect, useState } from 'react';

/**
 * Screen-reader announcements for async state changes. Components dispatch
 * `announce(message)`; the live region re-renders politely.
 */
let listeners: Array<(msg: string) => void> = [];

export function announce(message: string): void {
  for (const l of listeners) l(message);
}

export function Announcer(): JSX.Element {
  const [message, setMessage] = useState('');
  useEffect(() => {
    const handler = (msg: string) => {
      setMessage('');
      requestAnimationFrame(() => setMessage(msg));
    };
    listeners.push(handler);
    return () => {
      listeners = listeners.filter((l) => l !== handler);
    };
  }, []);
  return (
    <div aria-live="polite" aria-atomic="true" className="visually-hidden" role="status">
      {message}
    </div>
  );
}
