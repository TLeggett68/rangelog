# Range Log

A simple website for our church shooting group:

- **Day View**: everyone's times for a given day, the fastest shooter on each drill and stage, and who won the most.
- **Drills**: a silhouette target where you mark shot placement with X's, plus instructions and a par time. Shooters record their times and see how they compare to par.
- **Stages**: an overhead range bay where you drag in targets, steel, no-shoots, barrels, walls and shooting boxes, and draw arrows to show the route to move. Each target can have a note on where to shoot and how many shots. Shooters record their stage times.
- **Shooter history**: each shooter's progress on every drill and stage: personal best, average, group rank, improvement since their first day, a chart of their best time each range day, and their penalty habits.
- **Members**: the group roster. Members appear in a dropdown when recording times, with a "Guest" option for visitors.
- **Penalties**: C-zone hits, D-zone hits and misses (plus no-shoots and procedurals on stages) are added to the raw time automatically. You set how many seconds each one costs on the **Settings** page.

It's built for phones first: a bottom tab bar, a quick **Record** screen for entering times at the range, and the option to add it to your home screen like an app.

It's plain HTML, CSS and JavaScript with no build step and nothing to install. Everything used is **free**:

| Piece | Service | Cost |
|---|---|---|
| Website hosting | GitHub Pages (or Netlify / Cloudflare Pages) | Free |
| Shared database | Google Firebase Firestore, "Spark" plan | Free, no credit card |

---

## 1. Try it out (demo mode)

Open `index.html` in a browser. Until you connect Firebase, the site runs in **demo mode**: it loads sample data and saves changes only in that one browser. The green banner at the bottom tells you which mode you're in.

## 2. Set up the shared database (Firebase, free)

This lets everyone see the same drills, stages and times.

1. Go to <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Create a project** and give it a name (for example `nhcsg-range-log`). You can turn Google Analytics off.
3. In the left menu open **Build → Firestore Database → Create database**.
   - Pick a location near you (for example `us-east1`).
   - Choose **Start in production mode**.
4. Open the **Rules** tab, replace everything there with the contents of [`firestore.rules`](firestore.rules), and click **Publish**.
5. Go to **Project settings** (the gear icon) → **General** → **Your apps** → click the **`</>`** (Web) icon.
   - Give the app a nickname and click **Register app**. You don't need Firebase Hosting.
   - Firebase shows a `firebaseConfig = { ... }` block. Copy just the `{ ... }` part.
6. Open [`js/config.js`](js/config.js) and replace `window.FIREBASE_CONFIG = null;` with your config, like this:

   ```js
   window.FIREBASE_CONFIG = {
     apiKey: "AIza...",
     authDomain: "nhcsg-range-log.firebaseapp.com",
     projectId: "nhcsg-range-log",
     storageBucket: "nhcsg-range-log.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abc123"
   };
   ```

   You can also change `GROUP_NAME` and `GROUP_TAGLINE` in the same file.

> **Already set up Firebase with an earlier version?** Paste the latest `firestore.rules` into the Rules tab again and click **Publish**. The newer rules add the members list and shared settings.

Reload the page. The footer should now say **"Synced with the group"**. In cloud mode the site starts empty (no demo data), so create your first drill.

> The Firebase `apiKey` is designed to be public in web pages. It only identifies the project; what people can do is controlled by the rules you published in step 4.

## 3. Put the site online (GitHub Pages, free)

1. Create a free account at <https://github.com>.
2. Click **New repository**, name it (for example `range-log`), make it **Public**, and create it.
3. Click **uploading an existing file** and drag in everything from this folder: `index.html`, `manifest.webmanifest`, `sw.js`, `README.md`, `firestore.rules`, and the `css`, `js` and `icons` folders. Then click **Commit changes**.
4. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick the `main` branch and `/ (root)` folder, then click **Save**.
5. After a minute or two the site is live at `https://YOUR-USERNAME.github.io/range-log/`. Share that link with the group.

To update the site later, upload the changed files to the repository again.

**Easier alternative:** go to <https://app.netlify.com/drop> and drag this whole folder onto the page. You get a free link right away (sign up for a free account to keep it).

---

## Using the site

### On a phone

- **Add it to your home screen** so it opens like an app, full screen with its own icon:
  - **iPhone (Safari):** tap the Share button, then **Add to Home Screen**.
  - **Android (Chrome):** tap the ⋮ menu, then **Add to Home screen** (or **Install app**).
- The **tab bar** at the bottom has Today, Drills, **Record** (the big green button), Stages and Members. Settings is the sliders icon in the top-right corner.
- **Record screen (fastest way to log times at the range):** pick the drill or stage once (the site remembers it), then for each run pick the shooter, type the raw time, tap **+** for any penalties, and tap **Save time**. Today's results and the latest entries appear below the form, so a mistyped time is easy to spot and delete with the **×**.
- On a drill or stage page, the **⏱ Record time** button jumps straight to the form.
- **Weak signal at the range:** once a phone has opened the site, it can open it again with no signal. Times entered offline are saved on the phone and upload when it reconnects.

### Everything else

- **Members:** add everyone on the **Members** page. If people recorded times before you set up members, the page lists those names so you can add them with one click.
- **Recording a time:** open a drill or stage, pick the shooter, enter the raw time from the timer, and tap **+** for any C-zone hits, D-zone hits or misses. The form shows the final time (raw time + penalties) before you save. The site remembers the last shooter picked on that device. The date defaults to today, so you can also enter times after the fact.
- **History & progress:** on the **Members** page, tap a name (or **📈 View history**) to see that shooter's progress. Shooter names in results tables also link to their history. Tap a point on a chart to see that day's details.
- **Penalty values (Settings, the sliders icon):** the defaults are C = 1 s, D = 3 s, miss = 5 s, no-shoot = 5 s, procedural = 3 s. Set any of them to 0 to turn it off; it then disappears from the record form. Changes apply to new times only. Saved times keep the penalties they were scored with, so old results don't shift.
- **Drills:** tap the target to place X's and tap an X to remove it. The round count fills in from the number of X's unless you type your own.
- **Stages:** use the **Add** toolbar, then drag objects into place. Tap an object to edit its label, shot count, notes, rotation (any angle from 0–359°, using the slider, the ±15° buttons or by typing the degrees) or size. To show the shooter's route, tap **Draw route** and press and drag on the map. When you let go, the line becomes an arrow pointing where you finished. Draw as many as you need, then tap **Done drawing**. Tap an arrow to change its color, make it dashed, flip its direction or add a note (e.g. "reload on the move"). With a keyboard, arrow keys nudge the selected object (Shift moves farther) and Delete removes it. The bay is drawn 30 yd wide × 20 yd deep, with downrange at the top.
- **Day View:** this is the home page. Use the arrows, the date picker or the "Range days" chips to look at other days. Rankings use each shooter's best run of the day.

## Trying things out safely

Add `?demo` to the address (for example `https://tleggett68.github.io/rangelog/?demo`) to use the site on sample data saved only in your own browser. Nothing you do there touches the group's real data.

## Good to know

- **There are no logins.** Anyone who has the link can add or delete drills, stages, members and times, and change the penalty settings. That works fine for a small, trusted group. If it ever becomes a problem, Firebase Authentication (also free) can be added.
- **Free plan limits:** Firestore's free plan allows 50,000 reads and 20,000 writes per day. Times are stored as one record per range day, so even years of history cost very few reads per visit.
- **Backups:** in the Firebase console you can view every record under Firestore Database → Data.

## Files

```
index.html        page shell
manifest.webmanifest, icons/   home-screen app name and icons
sw.js             offline support (lets the site open with no signal)
css/style.css     styling (green theme)
js/config.js      group name + Firebase settings  ← the only file you need to edit
js/store.js       data storage (Firebase or browser-only demo mode)
js/target.js      silhouette target drawing
js/stage.js       range bay / stage drawing
js/app.js         pages: day view, drills, stages
firestore.rules   database security rules to paste into Firebase
```
