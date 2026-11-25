// Hash router: #/order/<id> -> ['order', '<id>']. Works offline with no server rewrites.
// Route changes are React transitions: the old screen stays up while a lazy module loads
// (no skeleton flash) and <ViewTransition> in app.tsx animates the swap.
import { startTransition, useEffect, useState } from 'react';

const read = () => location.hash.replace(/^#\/?/, '');

export function useRoute() {
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const f = () => startTransition(() => setHash(read()));
    addEventListener('hashchange', f);
    f();
    return () => removeEventListener('hashchange', f);
  }, []);
  return hash.split('/').filter(Boolean);
}

export const go = (path: string) => { location.hash = `#/${path}`; };
