/*
 * Site settings.
 *
 * GROUP_NAME / GROUP_TAGLINE show in the header.
 *
 * FIREBASE_CONFIG: leave as null to run in "local mode" (data is saved only in
 * the browser you're using — good for trying things out). To share data with
 * the whole group, paste the config object from your Firebase project here.
 * See README.md for step-by-step instructions.
 */
window.GROUP_NAME = 'NHCSG Range Log';
window.GROUP_TAGLINE = 'Church Shooting Group';

// Public project identifiers (not secrets). Access is controlled by firestore.rules.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDiRlDa3zV5j32XA14UgedrIpuOa7uHyE8",
  authDomain: "nhcsc-4bb1a.firebaseapp.com",
  projectId: "nhcsc-4bb1a",
  storageBucket: "nhcsc-4bb1a.firebasestorage.app",
  messagingSenderId: "1066473411608",
  appId: "1:1066473411608:web:022a2b89559afface15f6d"
};
