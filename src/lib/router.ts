// Hash router: #/order/<id> -> ['order', '<id>']. Works offline with no server rewrites.
import { useSyncExternalStore } from 'react';

const read = () => location.hash.replace(/^#\/?/, '');
const subscribe = (f: () => void) => { addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); };

export const useRoute = () => useSyncExternalStore(subscribe, read).split('/').filter(Boolean);
export const go = (path: string) => { location.hash = `#/${path}`; };
