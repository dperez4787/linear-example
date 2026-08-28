import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'
// DAN-95: importing the i18n module initializes the single i18next instance
// (and restores the stored language) before the tree renders. Components reach
// it through the useTranslation re-export in src/i18n.js, so there is no
// provider here — the import is the wiring.
import './i18n.js'
import './styles.css'

// AuthGate wraps App so record data only mounts for a signed-in user; App itself
// stays a pure records component (see AuthGate for why the gate lives here, not
// inside App).
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  </StrictMode>,
)
