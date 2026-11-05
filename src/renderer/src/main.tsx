import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App(): React.JSX.Element {
  return <h1>Facet BI</h1>;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
