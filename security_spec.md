# Security Specification for HoraCertaAI

## 1. Data Invariants

- **Ownership and Isolation**: All records (Medicados, Receitas, Medicamentos, Consultas, Farmácias) must belong to the logged-in user. This is guaranteed by matching the `userId` in the document path and properties with the `request.auth.uid`.
- **Role-Based Access**: The `role` field on a user document defines privileges. Users cannot modify their own `role` or `status` (only admins can). Admins must be verified against `/admins/$(request.auth.uid)` or explicitly via custom auth logic.
- **Verification Integrity**: Only verified email accounts (`request.auth.token.email_verified == true`) are allowed write operations to prevent spam and ghost accounts.
- **Immutability**: Once a document is created, its identity/ownership fields (`userId`, `createdAt`, `medicadoId`, etc.) cannot be changed.
- **Temporal Integrity**: All date/time fields like `createdAt` and `updatedAt` must be set to `request.time`.
- **Relational Integrity**: A child document (e.g., `Receita` or `Medicamento`) can only be created if its corresponding parent document exists and the creator owns the parent document.

---

## 2. The "Dirty Dozen" Malicious Payloads

Here are the 12 payloads designed to break our security invariants, all of which must return `PERMISSION_DENIED`.

### Payload 1: Privilege Escalation (Self-Assigned Admin Role)
* **Goal**: A user tries to create their user profile setting `role` to `admin` to gain access to admin panels.
* **Payload**: `setDoc(/users/attacker_uid, { userId: "attacker_uid", name: "Attacker", email: "attack@hack.com", role: "admin", status: "active", createdAt: request.time })`
* **Check**: Must fail because users are restricted to role `user` during self-registration, or role updates must be forbidden.

### Payload 2: Account Status Hijack (Self-Unban)
* **Goal**: A suspended user tries to change their status to `active`.
* **Payload**: `updateDoc(/users/suspended_uid, { status: "active" })`
* **Check**: Only admins can write/update users, and users cannot modify their own status field.

### Payload 3: Identity Spoofing (Creating Patient for Another User)
* **Goal**: Attacker tries to inject a patient (`Medicado`) into another user's path.
* **Payload**: `setDoc(/users/victim_uid/medicados/patient_123, { medicadoId: "patient_123", userId: "victim_uid", name: "Fake Patient", relationship: "son", createdAt: request.time })`
* **Check**: Path variable `{userId}` must strictly match `request.auth.uid`.

### Payload 4: PII Blanket Read (Data Scraping)
* **Goal**: An authenticated user tries to list all user accounts or retrieve private info of another user.
* **Payload**: `getDoc(/users/victim_uid)`
* **Check**: Access must be strictly restricted to `request.auth.uid == userId` or `isAdmin()`.

### Payload 5: Immutability Breach (Re-assigning Prescription Owner)
* **Goal**: Attacker tries to transfer an existing prescription to another user by changing `userId`.
* **Payload**: `updateDoc(/users/attacker_uid/medicados/pat_1/receitas/rec_1, { userId: "other_uid" })`
* **Check**: `incoming().userId == existing().userId` check must enforce immutable owners.

### Payload 6: Value Poisoning (Negative Interval Hours)
* **Goal**: User tries to break the scheduling engine by inserting negative values for dosage intervals.
* **Payload**: `setDoc(/users/attacker_uid/medicados/pat_1/medicamentos/med_1, { name: "Aspirin", intervalHours: -8, durationDays: 5, dosage: "1 tablet", status: "active", createdAt: request.time })`
* **Check**: Validation helper must enforce `intervalHours > 0` and `durationDays > 0`.

### Payload 7: Resource Poisoning (Denial of Wallet payload)
* **Goal**: Attacker tries to inflate document size with a massive string in patient names to blow up Firebase storage/pricing.
* **Payload**: `setDoc(/users/attacker_uid/medicados/pat_1, { name: "A".repeat(5000), relationship: "self", createdAt: request.time })`
* **Check**: Enforce `.size() <= 128` on patient/drug strings.

### Payload 8: Relational Hijack (Prescription for Unregistered Patient)
* **Goal**: Attacker tries to create a prescription for a patient path they do not own or doesn't exist.
* **Payload**: `setDoc(/users/attacker_uid/medicados/unowned_patient/receitas/rec_1, { date: "2026-07-09", extracted: false, createdAt: request.time })`
* **Check**: Request fails because `{medicadoId}` path checks require the parent `medicado` document to exist under that user.

### Payload 9: Temporal Integrity Bypass (Backdating Records)
* **Goal**: User tries to set custom `createdAt` values to mock history.
* **Payload**: `setDoc(/users/attacker_uid/medicados/pat_1/medicamentos/med_1, { name: "Amoxicillin", status: "active", intervalHours: 8, durationDays: 10, dosage: "1 tab", createdAt: timestamp("2010-01-01T00:00:00Z") })`
* **Check**: Rule enforces `incoming().createdAt == request.time`.

### Payload 10: Suspended User Access Bypass
* **Goal**: A user whose user profile is marked as `suspended` tries to write new medical data.
* **Payload**: `setDoc(/users/suspended_uid/medicados/pat_1, { name: "John Doe", relationship: "self", createdAt: request.time })`
* **Check**: Rules verify user status by loading `/users/$(request.auth.uid)` and asserting `status == 'active'`.

### Payload 11: Ghost Field Injection (Shadow Field Update)
* **Goal**: Attempt to bypass exact keys check by injecting secret tracking parameters into a medicine document.
* **Payload**: `updateDoc(/users/attacker_uid/medicados/pat_1/medicamentos/med_1, { name: "Aspirin", isVerifiedByAdmin: true })`
* **Check**: Update fails because `affectedKeys()` doesn't allow `isVerifiedByAdmin`.

### Payload 12: Cross-User DoseLog Tampering
* **Goal**: Attacker tries to modify a dose log belonging to another user.
* **Payload**: `updateDoc(/users/victim_uid/medicados/pat_1/medicamentos/med_1/doseLogs/log_1, { status: "taken" })`
* **Check**: Fails because the path-matching ensures only `request.auth.uid == userId` is authorized.

### Payload 13: Resurrected Account Write (Hard-Delete Bypass)
* **Goal**: A client holding a still-valid ID token for a uid whose `users/{uid}` profile doc no longer exists (hard-deleted via `DELETE /api/admin/users/:uid`, which `recursiveDelete`s the whole tree) tries to create a new document under that uid's tree. ID tokens remain cryptographically valid for up to ~1h after `deleteUser()`, and Firestore rules never check live revocation — only signature/expiry — so this is a real, deterministic window, not just a client-side timing race.
* **Payload**: `setDoc(/users/deleted_uid/medicados/pat_new, { medicadoId: "pat_new", userId: "deleted_uid", name: "New Patient", relationship: "self", createdAt: request.time })`
* **Check**: `isUserActive()` must fail closed when `users/$(userId)` does not exist — not just when `status == 'suspended'`. (Incident: 2026-07-31, an admin-deleted user's still-logged-in phone was able to register a new patient this way.)

---

## 3. Test Cases (TDD Rules Validation Runner Schema)

```typescript
// firestore.rules.test.ts placeholder
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

describe("HoraCertaAI Zero-Trust Rules", () => {
  it("should reject Payload 1 (Self-Assigned Admin Role)", async () => {
    const db = getFirestore({ uid: 'attacker_uid', email_verified: true });
    await assertFails(db.doc('users/attacker_uid').set({
      userId: "attacker_uid",
      name: "Attacker",
      email: "attack@hack.com",
      role: "admin",
      status: "active",
      createdAt: serverTimestamp()
    }));
  });

  it("should reject Payload 2 (Self-Unban)", async () => {
    const db = getFirestore({ uid: 'suspended_uid', email_verified: true });
    await assertFails(db.doc('users/suspended_uid').update({
      status: "active"
    }));
  });

  it("should reject Payload 6 (Negative Interval Hours)", async () => {
    const db = getFirestore({ uid: 'attacker_uid', email_verified: true });
    await assertFails(db.doc('users/attacker_uid/medicados/pat_1/medicamentos/med_1').set({
      medicamentoId: "med_1",
      medicadoId: "pat_1",
      userId: "attacker_uid",
      name: "Aspirin",
      dosage: "1 tab",
      intervalHours: -8,
      durationDays: 5,
      status: "active",
      createdAt: serverTimestamp()
    }));
  });

  it("should reject Payload 7 (Patient Name Resource Poisoning)", async () => {
    const db = getFirestore({ uid: 'attacker_uid', email_verified: true });
    await assertFails(db.doc('users/attacker_uid/medicados/pat_1').set({
      medicadoId: "pat_1",
      userId: "attacker_uid",
      name: "A".repeat(500),
      relationship: "self",
      createdAt: serverTimestamp()
    }));
  });
});
```
