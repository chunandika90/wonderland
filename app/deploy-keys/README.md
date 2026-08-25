# Deploy keys — sensitive, do not share or commit

`compass_deploy` / `compass_deploy.pub` is the SSH keypair used to manage the live cPanel server (see `../HANDOFF.md`). The public half is authorized in cPanel → Security → SSH Access → Manage SSH Keys on the `ulhlmfei` account.

If this project folder is ever put under git, add this folder to `.gitignore` first. Never paste the private key's contents into chat, a ticket, or a public repo.

If the key is ever lost or possibly exposed: generate a new keypair, authorize the new public key in cPanel (same menu), and revoke/delete the old one from that same list.
