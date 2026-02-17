# Security Guide: Protecting Student Data in Bus Student Tracker

This app handles **confidential PII** (names, addresses, phone numbers). Below is how data flows and how to protect it from attackers.

---

## Where Your Data Lives

1. **On the device (IndexedDB)**  
   All data is stored locally in the browser’s IndexedDB. It never leaves the device unless you use sync.

2. **In the cloud (Firebase Firestore)**  
   When the app is opened over the **internet** (e.g. `https://yoursite.com/...`), it can sync to Firebase. Data is then stored in Google’s cloud under a shared sync ID.

---

## 1. Use the App Over HTTPS Only

- **Never** host the app on plain `http://` when using real student data.  
- Use **HTTPS** so data in transit is encrypted and can’t be read or altered by someone on the network.  
- If you only open the app as a **local file** (`file:///...`), it does **not** use Firebase; data stays only on that device.

---

## 2. Lock Down Firebase (When You Use Sync)

If the app is hosted on the web and Firebase sync is enabled:

### A. Firestore Security Rules

In [Firebase Console](https://console.firebase.google.com) → your project → **Firestore Database** → **Rules**, ensure only **authenticated** users can access your bus tracker data, and only for your sync ID. Example pattern:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Restrict busTracker to authenticated users only.
    // Optionally restrict to your known sync document ID.
    match /busTracker/{syncId}/{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

- **Do not** use rules that allow `allow read, write: if true` or unauthenticated access.  
- Tighten further if you move to real logins (e.g. only allow a list of known UIDs or your organization’s users).

### B. Restrict Your Firebase API Key

In [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services** → **Credentials**:

- Open the API key used by this app.  
- Add **Application restrictions** (e.g. “HTTP referrers” and list only your app’s URLs, e.g. `https://yourdomain.com/*`).  
- Add **API restrictions** so the key can only call the APIs this app needs (e.g. Firestore).

This limits abuse of the key even if someone finds it in your source code.

### C. Sync ID and Access

The app uses a **shared sync ID** so all devices using that ID see the same data. Anyone who can open your deployed app and sync can see that data if Firestore rules allow it. So:

- Strong Firestore rules (above) are essential.  
- Only share the app URL with authorized staff.  
- If you need separate datasets (e.g. per school), consider using different sync IDs and controlling who gets which version of the app or config.

---

## 3. Protect the Device (Local Data)

- **Lock devices** that run the app (PIN, password, or biometric).  
- Use **device encryption** (standard on modern iOS/Android; enable BitLocker or equivalent on Windows).  
- **Don’t** leave the app open on an unattended, unlocked device.  
- Prefer **managed devices** (e.g. school-owned) with policies that enforce lock screens and encryption.

IndexedDB is tied to the browser and device; if someone has full access to the device, they can usually access that data.

---

## 4. Encrypt Data Before Syncing (Built-in)

The app can **encrypt** all synced data in the browser before it is sent to Firebase. When encryption is enabled:

- **In the cloud:** Firestore only stores encrypted blobs. Names, addresses, and phone numbers are unreadable without the password.
- **The password** is never sent to Firebase. It is used only in the browser to derive an encryption key (PBKDF2 + AES-GCM). The key stays in memory for the session.
- **How to turn it on:** Settings → **Data encryption** → check “Encrypt data before syncing” → set a strong shared password (and confirm). All devices that sync must use the same password.
- **On each new session:** When you open the app and encryption is on, you’ll see an “Encryption password” screen. Enter the shared password to unlock; data is then decrypted and the app runs as usual.
- **Backward compatibility:** Existing plaintext documents in Firebase are still read. New or updated documents are written encrypted. Over time, as you edit data, more of it becomes encrypted.

---

## 5. Good Practices

- **Minimize data**: Only store what you need (e.g. avoid keeping full addresses if a shorter description is enough).  
- **Access control**: Only give the app URL and sync access to staff who need it.  
- **Updates**: Keep the app and any hosting (e.g. server, CDN) updated so you get security fixes.  
- **Logout / clear data**: If a device is lost or no longer used, use browser/device options to clear site data (and revoke Firebase auth if you add real logins later).  
- **Backups**: If you backup IndexedDB or Firebase, store backups in a secure, access-controlled location (encrypted and only for authorized people).

---

## 6. Compliance and Policy (e.g. FERPA)

In the US, student records may be subject to **FERPA** and state laws. Best approach:

- Treat this app as handling **education records**.  
- Work with your **school or district IT and legal** to ensure:  
  - Who is allowed to use the app and access the data.  
  - Where the app is hosted and where Firebase is used.  
  - That your practices (access, encryption, device security, backups) match policy.

---

## Summary

| Risk | Mitigation |
|------|-------------|
| Data stolen over the network | Use **HTTPS** only when the app is on the web. |
| Unauthorized access to cloud data | Use strict **Firestore rules** and **API key restrictions**. |
| Someone else’s app using your Firebase | Restrict API key by **HTTP referrer** and limit APIs. |
| Lost or stolen device | **Device lock**, **encryption**, and **clear data** when retiring the device. |
| Over‑sharing | Share app/sync only with **authorized staff**; consider **encryption at rest** in Firebase. |

If you tell me your deployment setup (e.g. “only local file” vs “hosted with Firebase”), I can narrow this to a short checklist for your case and, if you want, add optional client-side encryption steps in code.
