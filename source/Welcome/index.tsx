import { createRoot } from 'react-dom/client';
import Welcome from './Welcome';
import '../styles/_theme.scss';

const root = document.getElementById('welcome-root');
if (root) {
  createRoot(root).render(<Welcome />);
}
