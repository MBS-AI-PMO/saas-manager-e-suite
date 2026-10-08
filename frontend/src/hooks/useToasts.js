/**
 * Minimal toast state. useToasts() returns { toasts, notify, dismiss };
 * render <Toasts> (components/Toasts.jsx) once near the root.
 */
import { useCallback, useRef, useState } from 'react';

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    ({ tone = 'info', text }) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, tone, text }]);
      // Errors stay longer so they can be read.
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );

  return { toasts, notify, dismiss };
}
