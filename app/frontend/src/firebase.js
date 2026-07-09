// Firebase Web App configuration and lazy SDK initialization.
//
// These values are PUBLIC by design and ship in the client bundle. `apiKey` is a
// Firebase Web API key: it identifies the project to Google's auth endpoints and
// grants no privileges on its own — access is controlled by Firebase Auth and by
// the backend's ID-token verification (DAN-22), never by keeping this string
// secret. So this config is committed here: NOT in Secret Manager, NOT a GitHub
// Secret, NOT handled like MONGODB_URI. Values come from the Web App registered
// in DAN-21. `measurementId` (Analytics) and `storageBucket` (unused) are
// deliberately omitted — the app uses neither, and pulling in `measurementId`
// would load the Analytics SDK for nothing.
//
// Each value can be overridden by a VITE_-prefixed env var (to point the SPA at a
// different Firebase project without a code change), but the committed defaults
// make the app work out of the box.
export const firebaseConfig = {
  apiKey:
    import.meta.env.VITE_FIREBASE_API_KEY ??
    'AIzaSyCS45zSWu-tNrTN4FOrH5jIgo9z_8mfy8g',
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ??
    'project-d60a83c1-2c60-4d51-ad0.firebaseapp.com',
  projectId:
    import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'project-d60a83c1-2c60-4d51-ad0',
  appId:
    import.meta.env.VITE_FIREBASE_APP_ID ??
    '1:756865700041:web:b44f4c2282dea916863d18',
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '756865700041',
}
