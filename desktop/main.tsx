import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Home from '../app/page';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '../app/globals.css';
import { mobileWorkbench } from '../app/platform';

if (mobileWorkbench) {
  void import('../mobile/workbench/phone.css');
  void import('../mobile/workbench/native').then(({ installNativeSaving }) => installNativeSaving());
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
