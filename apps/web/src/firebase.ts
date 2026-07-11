import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyABUFY4cilmwTuZQJBNDIEfP2Utxu8ZfN8",
  authDomain: "collab-code-editor-121c6.firebaseapp.com",
  projectId: "collab-code-editor-121c6",
  storageBucket: "collab-code-editor-121c6.firebasestorage.app",
  messagingSenderId: "1063772198176",
  appId: "1:1063772198176:web:446ae122a0d959f78bf345",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();