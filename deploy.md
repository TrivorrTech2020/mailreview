# deploy.md — Auto-deploy Apps Script from this Git repo

**Goal:** wire this repository so that every push to `main` automatically deploys the
Google Apps Script project. After setup, the workflow is: edit code in the repo →
commit → push → it's live. No manual `clasp push`, no editing in the online editor.

**How to run this in Antigravity:** open this repo, then tell the agent
*"Follow deploy.md to set up auto-deploy. Pause at every [YOU] step and wait for me."*
Steps are tagged **[AGENT]** (the agent can do it) or **[YOU]** (human-only —
browser auth or repo settings). Do them in order.

---

## Prerequisites
- Node.js 18+ installed (`node -v` to check; **[AGENT]** may install if missing).
- A Google account that owns (or can edit) the target Apps Script project.
- This folder is a Git repo with a GitHub remote (or create one in Step 5).
- The Apps Script `scriptId` (find it in the Apps Script editor →
  ⚙ Project Settings → "IDs"). If creating a brand-new script, skip — Step 2 creates it.

---

## Step 0 — [YOU] Enable the Apps Script API
Open https://script.google.com/home/usersettings and turn **Google Apps Script API ON**.
clasp cannot push without this. (One-time, per Google account.)

## Step 1 — [YOU] Authenticate clasp locally
This opens a browser for Google OAuth, which an agent cannot complete. Run:
```bash
npm install -g @google/clasp
clasp login
```
This creates `~/.clasprc.json` in your home directory. **Keep this file secret** —
it contains a refresh token that grants access to your Google account. You'll copy
its contents into a GitHub secret in Step 4. Do not commit it anywhere.

## Step 2 — [AGENT] Link the repo to the Apps Script project
- If an existing script: run `clasp clone "<SCRIPT_ID>"` in the repo root
  (ask [YOU] for the SCRIPT_ID if not provided).
- If a new script: run `clasp create --title "Email Notice Auditor" --rootDir ./src`
  and choose the appropriate type.
- Confirm a `.clasp.json` now exists containing the `scriptId`. Move source files
  under the `rootDir` referenced there (e.g. `./src`) if not already.

## Step 3 — [AGENT] Add the ignore rules and the deploy workflow
Create or update `.gitignore` to include:
```
.clasprc.json
node_modules/
```
> Note: `.clasprc.json` is the credential and must NEVER be committed. `.clasp.json`
> holds only the non-secret `scriptId` and may be committed (keeping it in the repo is fine).

Create `.github/workflows/deploy.yml` with exactly this content:
```yaml
name: Deploy to Apps Script
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install clasp
        run: npm install -g @google/clasp
      - name: Write clasp credentials
        run: printf '%s' "$CLASPRC_JSON" > ~/.clasprc.json
        env:
          CLASPRC_JSON: ${{ secrets.CLASPRC_JSON }}
      - name: Push to Apps Script
        run: clasp push -f
```

## Step 4 — [YOU] Store the clasp credentials as a GitHub secret
The CI runner can't log in via browser, so it reuses your refresh token.

Option A (GitHub CLI, if `gh` is installed and authenticated):
```bash
gh secret set CLASPRC_JSON < ~/.clasprc.json
```
Option B (web UI): copy the **entire contents** of `~/.clasprc.json`, then go to
GitHub repo → Settings → Secrets and variables → Actions → New repository secret →
Name it `CLASPRC_JSON`, paste the contents, Save.

## Step 5 — [AGENT] Commit and push
```bash
git add .
git commit -m "Set up clasp + GitHub Actions auto-deploy"
git push -u origin main
```
(If no remote exists yet, [YOU] create the GitHub repo first and add the remote.)

## Step 6 — [AGENT] + [YOU] Verify
- Watch the run under the repo's **Actions** tab; it should finish green.
- Confirm the code now appears in the Apps Script editor (refresh it).
- Smoke test: make a trivial edit (e.g. a comment), commit, push, and confirm the
  Action runs and the change shows up in Apps Script.

---

## Guardrails (read before and after setup)
- **Repo is the single source of truth.** Do NOT edit code in the online Apps Script
  editor — `clasp push -f` is a *force* push and will overwrite online changes on the
  next deploy. If you ever must edit online, run `clasp pull`, commit, then resume.
- **`appsscript.json` is authoritative.** Because the push is forced, the manifest in
  the repo overwrites the remote. Keep it correct in the repo.
- **Credential hygiene.** `~/.clasprc.json` / the `CLASPRC_JSON` secret hold a live
  refresh token. Never commit it; rotate it periodically by re-running `clasp login`
  and updating the secret.
- **Token refresh.** The access token inside expires but clasp refreshes it using the
  refresh token, so the secret normally keeps working. If deploys start failing with an
  auth error, re-run `clasp login` and update the `CLASPRC_JSON` secret.
- **Branch scope.** This deploys only on push to `main`. Use feature branches + PRs to
  avoid deploying half-finished work.
