# Deploying Bus Student Tracker to GitHub & Mobile

Follow these steps to push the app to GitHub and install it on mobile devices for testing.

---

## 1. Generate PWA Icons (required for install)

The app needs `icon-192.png` and `icon-512.png` for “Add to Home Screen” and the app splash screen.

1. Open **create_icons.html** in your browser (double-click or open from a local server).
2. Click **Generate 192x192 Icon**, then right-click the canvas → **Save image as…** → save as `icon-192.png` in the project folder.
3. Click **Generate 512x512 Icon**, then save as `icon-512.png` in the same folder.
4. Confirm both files are in the same directory as `index.html`.

Without these files the app still runs; the manifest and apple-touch-icon links will fail quietly (they use `onerror="this.remove()"`).

---

## 2. Push to GitHub

From the project folder in a terminal:

```bash
cd "C:\Users\bridgesc\.cursor\Custom Programs Local\Bus Student Tracker"

# If this is not already a git repo:
git init
git add .
git commit -m "Initial commit: Bus Student Tracker PWA"

# Create a new repository on GitHub (github.com → New repository), then:
git remote add origin https://github.com/YOUR_USERNAME/bus-student-tracker.git
git branch -M main
git push -u origin main
```

If the folder is already a git repo, just add, commit, and push:

```bash
git add .
git commit -m "Your message"
git push
```

**Before pushing:**  
- Do **not** commit real secrets. `firebase-config.js` contains your Firebase client config (API key, etc.). Client keys are meant to be public; security is enforced by Firebase Security Rules. You can optionally restrict the API key by HTTP referrer in [Firebase Console → Project Settings → API key](https://console.firebase.google.com/).

---

## 3. Host the App (HTTPS required)

PWAs and service workers require **HTTPS**. You cannot install from `file://` or `http://`.

**Option A – GitHub Pages**

1. GitHub repo → **Settings** → **Pages**.
2. Source: **Deploy from a branch**.
3. Branch: **main** (or your default), folder: **/ (root)**.
4. Save. Your app will be at:  
   `https://YOUR_USERNAME.github.io/bus-student-tracker/`  
   (or `https://YOUR_USERNAME.github.io/REPO_NAME/` if the repo name differs.)

**Option B – Netlify / Vercel / other**

- Connect the GitHub repo and deploy the project root as a static site.
- Use the URL they give you (e.g. `https://your-app.netlify.app`).

---

## 4. Install on Mobile

**Android (Chrome)**

1. Open the **HTTPS** URL of your app (e.g. GitHub Pages or Netlify).
2. Menu (⋮) → **Install app** or **Add to Home screen**.
3. Confirm. The app opens in standalone mode (no browser UI).

**iPhone / iPad (Safari)**

1. Open the **HTTPS** URL in **Safari** (Chrome on iOS does not support “Add to Home Screen” for PWAs the same way).
2. Tap the **Share** button → **Add to Home Screen**.
3. Name it and tap **Add**. Open from the home screen for full-screen app experience.

---

## 5. Mobile Testing Checklist

Use this to confirm the app looks and runs well on devices:

- [ ] **Install** – Add to Home Screen works and opens in standalone (no address bar).
- [ ] **Icons** – App icon and splash use your generated icons (if you added `icon-192.png` / `icon-512.png`).
- [ ] **Orientation** – Manifest is set to `landscape`; test both portrait and landscape if you use it in both.
- [ ] **Main screen** – Bus list and “Create Bus” / “Students” buttons are tappable and readable.
- [ ] **Bus diagram** – Seats and driver area fit the screen; tapping seats assigns/opens student.
- [ ] **Route (EDIT)** – Route table scrolls horizontally if needed; +↑ / +↓ / ✕ buttons work.
- [ ] **Modals** – Student search, check-in, settings, etc. open and close; content scrolls on small screens.
- [ ] **Offline** – After first load, turn off Wi‑Fi; app shell and cached pages still open (IndexedDB data is local).
- [ ] **Sync** – With Wi‑Fi on, changes sync to Firebase; test on two devices with the same Sync ID.
- [ ] **Safe area** – On notched devices, content is not hidden behind the notch (padding uses `env(safe-area-inset-*)`).
- [ ] **Updates** – After deploying a new version, “Update Now” in the app (or a refresh) loads the new build.

---

## 6. Optional: Restrict Firebase API Key

To limit where your Firebase API key can be used:

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → your project → **APIs & Services** → **Credentials**.
2. Open the **Browser key** used by Firebase.
3. Under **Application restrictions**, choose **HTTP referrers** and add your deployment URLs, e.g.  
   `https://YOUR_USERNAME.github.io/*`  
   `https://your-app.netlify.app/*`

This does not replace Firestore Security Rules; use both for security.

---

## Quick Reference

| Step              | Action |
|------------------|--------|
| Icons            | Run `create_icons.html` → save `icon-192.png`, `icon-512.png` in project folder. |
| GitHub           | `git init` (if needed), `git add .`, `git commit`, `git remote add origin ...`, `git push`. |
| Hosting          | Use GitHub Pages or Netlify/Vercel with **HTTPS**. |
| Android install  | Chrome → open app URL → Menu → Install app / Add to Home screen. |
| iOS install      | Safari → open app URL → Share → Add to Home Screen. |
| Firebase         | Restrict API key by HTTP referrer (optional). Rely on Firestore rules for data security. |

Once the app is hosted at an HTTPS URL and icons are in place, you can push updates to GitHub and re-test on mobile after the site redeploys.
