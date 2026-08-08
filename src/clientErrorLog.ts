import { auth } from "./firebase";

export interface ClientSyncErrorReport {
  action: string; // which dbLocal method failed, e.g. "addMedicado"
  entityType?: string; // e.g. "Medicado"
  entityId?: string;
  code?: string; // Firestore error code, e.g. "permission-denied"
  message: string;
}

// Reports a fire-and-forget Firestore write failure the user never saw —
// dbLocalFallback.ts's add*/update*/delete* methods are optimistic/offline-first
// by design and only console.warn on rejection, which is invisible on a real
// user's device. The client can't write straight to `errorLogs`
// (firestore.rules: allow write: if false), so — same as loginLog.ts's
// reportLogin — this goes through a server endpoint. Must never throw in a way
// that reaches the caller: logging a failure must never cascade into visible
// breakage.
export async function reportClientSyncError(report: ClientSyncErrorReport): Promise<void> {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return;
    await fetch("/api/logs/client-error", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(report),
    });
  } catch (e) {
    console.warn("Falha ao registrar log de erro de sincronização:", e);
  }
}
