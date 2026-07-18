// Reports a successful login to the server so it can be recorded with the
// real client IP (see POST /api/logs/login in server/app.ts) — the browser
// has no reliable way to know its own public IP, so this can't be written
// straight to Firestore like the rest of the app's data. Best-effort: a
// failure here must never block or surface as an error to the user.
export async function reportLogin(idToken: string, userName: string, userEmail: string): Promise<void> {
  try {
    await fetch("/api/logs/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ userName, userEmail }),
    });
  } catch (e) {
    console.warn("Falha ao registrar log de login:", e);
  }
}
