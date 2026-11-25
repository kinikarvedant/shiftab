import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { App } from './app.tsx';
import { boot } from './lib/session.ts';
import { applyDisplay } from './lib/display.ts';
import { toast } from './ui/toast.ts';

applyDisplay();
const updateSW = registerSW({
  onNeedRefresh() { toast('A new version of p0rtal is ready.', 'info', { label: 'Update', run: () => void updateSW(true) }); },
  onOfflineReady() { toast('p0rtal can now work offline on this device.', 'success'); },
});
void navigator.storage?.persist?.(); // ask the browser not to evict offline data

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
void boot();
