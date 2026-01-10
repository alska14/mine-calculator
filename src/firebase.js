import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCMFr0crRbOtAwMr3r3EQzBn4Lhr64GEJU",
  authDomain: "mine-calculator-8e3e2.firebaseapp.com",
  projectId: "mine-calculator-8e3e2",
  storageBucket: "mine-calculator-8e3e2.firebasestorage.app",
  messagingSenderId: "94279539790",
  appId: "1:94279539790:web:3d8fbbe309c64de717b71f",
  measurementId: "G-LCKQM6BTTP",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
