import { createRoot } from 'react-dom/client';
import browser from 'webextension-polyfill';
import Welcome from './Welcome';
import '../../styles/_theme.scss';

document.title = browser.i18n.getMessage('title') || 'Welcome';

const root = document.getElementById('welcome-root');
if (root) {
  createRoot(root).render(<Welcome />);
}
