/**
 * Load data for a component. Keeps the previous data visible while a reload
 * is in flight (no flashing skeletons), and ignores responses from stale requests.
 *
 *   const { data, error, loading, reload, setData } = useAsync(() => api.getPortal(code), [code]);
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useAsync(fn, deps) {
  const [reloads, setReloads] = useState(0);
  const key = `${JSON.stringify(deps)}#${reloads}`;
  const [state, setState] = useState({ key: null, data: undefined, error: null });
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => fnRef.current())
      .then(
        (data) => live && setState({ key, data, error: null }),
        (error) => live && setState((s) => ({ key, data: s.data, error })),
      );
    return () => {
      live = false;
    };
  }, [key]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const setData = useCallback((update) => {
    setState((s) => ({ ...s, data: typeof update === 'function' ? update(s.data) : update }));
  }, []);

  return { data: state.data, error: state.key === key ? state.error : null, loading: state.key !== key, reload, setData };
}
