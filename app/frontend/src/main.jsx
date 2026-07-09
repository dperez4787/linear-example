import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

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
