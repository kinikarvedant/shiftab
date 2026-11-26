import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { App } from './app.tsx';
import { boot, getApp, updateWhenIdle } from './lib/session.ts';
import { applyDisplay } from './lib/display.ts';
import { toast } from './ui/toast.ts';

applyDisplay();
const updateSW = registerSW({
  onNeedRefresh() {
    updateWhenIdle(() => void updateSW(true)); // installs itself the next time this screen locks
    if (getApp().session) toast('A new version of Shiftab is ready. It installs the next time this screen locks.', 'info', { label: 'Update now', run: () => void updateSW(true) });
  },
  onOfflineReady() { toast('Shiftab can now work offline on this device.', 'success'); },
});
void navigator.storage?.persist?.(); // ask the browser not to evict offline data

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
void boot();
