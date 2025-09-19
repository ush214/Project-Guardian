import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { app } from "./firebase-app.js"; // make sure this exports your initialized app

const auth = getAuth(app);
const db = getFirestore(app);

// Call this early after auth state resolves on your main pages
export function watchApprovalGate({ onApproved, onPending }) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Not signed in; let your existing routing handle this
      return;
    }

    const ref = doc(db, "system", "approvals", "users", user.uid);
    let snap = await getDoc(ref);

    if (!snap.exists()) {
      await setDoc(ref, {
        status: "pending",
        role: "user",
        email: user.email || "",
        displayName: user.displayName || "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });

      // After creating, treat as pending
      if (onPending) onPending();
      return;
    }

    const data = snap.data();
    if (data.status === "approved") {
      if (onApproved) onApproved(data);
    } else {
      if (onPending) onPending(data);
    }
  });
}