# Wonderland (Buranchi Compass) — Collaborator Setup

Read this first if you just cloned this repo and this is your first time
touching the project from a new machine / new Claude Code session. It
covers the parts that are **not** in the repo (secrets, access) and the
git workflow two people share this project with.

## 0. What this project is

**Wonderland**, internally also called **Buranchi Compass**, is a
content-planning web app for Buranchi café. Full details, local run
instructions, and architecture are in [`app/HANDOFF.md`](app/HANDOFF.md)
— read that after this file.

## 1. You already have

- Been added as a **collaborator** on the private GitHub repo
  `github.com/chunandika90/wonderland`.
- Cloned it, or are about to.

## 2. Set up your own GitHub SSH key (if you haven't push/pulled yet)

Don't reuse anyone else's key. Generate your own on the machine your
Claude Code runs on:

```bash
ssh-keygen -t ed25519 -C "your-name-wonderland-github" -f ~/.ssh/wonderland_github -N ""
cat ~/.ssh/wonderland_github.pub
```

Add the printed public key at **github.com/settings/ssh/new** (on your
own GitHub account), then point git at it for this repo:

```bash
git config core.sshCommand "ssh -i ~/.ssh/wonderland_github -o IdentitiesOnly=yes"
```

## 3. Files that are NOT in git (and why)

The repo is source code only. These are all gitignored — you will not
have them after cloning, and you need to get them separately:

| Path | What it is | How to get it |
|---|---|---|
| `app/deploy-keys/compass_deploy` | SSH private key for the live cPanel server | Generate your **own** key (see §4 below) — do not ask for this one, it isn't shared between people |
| `app/service-accounts/wonderland-drive-reader.json` | Google service account for Directory A (Drive) access | Ask Juan to send it directly (not via chat/git) |
| `app/data/orgs.json` | Per-org config incl. Gemini API keys | Ask Juan, or run `node scripts/set-gemini-key.js` locally once you have your own key |
| `app/data/internal-users.json` | Login username/password for the app itself | Ask Juan |
| `app/data/orgs/` | Per-client runtime data (posts, Directory A cache) | Ask Juan for a copy, or start empty and let the app populate it |

Never commit any of these, even if you regenerate or receive a copy —
they're gitignored on purpose. If `git status` ever shows one of them as
untracked-and-about-to-be-added, stop and check the `.gitignore` first.

## 4. Get your own SSH access to the live server (cPanel)

Only needed if you'll be deploying to `wccn.co.id/compass` yourself, not
just editing code.

```bash
ssh-keygen -t ed25519 -C "your-name-wonderland-cpanel" -f ~/.ssh/wonderland_cpanel -N ""
cat ~/.ssh/wonderland_cpanel.pub
```

Send the printed public key (the `.pub` one — never the private half) to
Juan. He'll import it in cPanel → Security → SSH Access → Manage SSH
Keys → Import Key, then Authorize it. Once that's done:

```bash
ssh -i ~/.ssh/wonderland_cpanel ulhlmfei@210.16.64.86
```

Full deploy details (paths, restart command, gotchas) are in
[`app/DEPLOY-CONFIG.md`](app/DEPLOY-CONFIG.md).

## 5. Working together without stepping on each other

There's no CI/CD — deploys are manual (tar + scp + ssh + restart, see
`app/DEPLOY-CONFIG.md`). Two people can deploy independently, so:

- **Always `git pull` before you start working**, and again right before
  you deploy anything.
- **Commit and push your changes** before or right after you deploy them
  — don't let local-only changes sit uncommitted, they're invisible to
  the other person.
- If you're about to deploy and it's been a while since your last pull:
  diff the live server's files against your local copy first (`ssh` in
  and `cat` the file, or `scp` it down and `diff`) to make sure the other
  person didn't push something live that you'd otherwise silently
  overwrite.
- `data/` (per-org runtime data — posts, Directory A cache) is **not**
  version-controlled and **not** kept in sync between local and live, or
  between machines. Don't assume your local `data/` matches anyone
  else's or the live server's.

## 6. Quick reference

```bash
# run locally
cd app && node server.js   # http://localhost:4200, login buranchi/compass2026

# deploy code only (server.js + static/) to live
cd app
tar -czf /tmp/deploy.tar.gz server.js static/*
scp -i ~/.ssh/wonderland_cpanel /tmp/deploy.tar.gz ulhlmfei@210.16.64.86:/home/ulhlmfei/public_html/compass/
ssh -i ~/.ssh/wonderland_cpanel ulhlmfei@210.16.64.86 \
  "cd /home/ulhlmfei/public_html/compass && tar -xzf deploy.tar.gz && rm deploy.tar.gz && \
   cloudlinux-selector restart --interpreter nodejs --app-root /home/ulhlmfei/public_html/compass --json"
```
