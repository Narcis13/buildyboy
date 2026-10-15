# Global skills

Claude Code skills that live in this repo but are meant for every project on this machine.

| Skill | What it does |
|---|---|
| [contzo-deploy](contzo-deploy/SKILL.md) | Deploys any project to `<sub>.contzo.lol` on this PC's WSL host: generates `deploy/contzo/` (no-sudo deploy engine + per-project `app.conf`), Caddy site with HTTPS, Postgres, backups, DNS and hosts-file guidance. |

## Install (once)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File skills\install.ps1
```

This links each skill into `%USERPROFILE%\.claude\skills\` (directory junction) and into WSL's
`~/.claude/skills/` (symlink), so Claude Code finds it in any project, on Windows or in WSL.
They are links, so `git pull` here updates the installed skill. `-Uninstall` removes the links.

## Changing a skill

Edit the files here and commit. For contzo-deploy, projects keep their own copy of the engine
(`deploy/contzo/deploy.sh`); after improving `templates/deploy.sh`, copy it over a project's copy
to upgrade that project (its `app.conf` stays as it is).
