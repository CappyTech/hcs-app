# Deployment

Every push to `master` that passes CI is deployed to server2 automatically, the same way cairn's `release.yml` deploys its edge server. This is the `deploy` job in `.github/workflows/ci.yml`.

1. The **build** job runs `npm test`, then builds and pushes `ghcr.io/cappytech/hcs-app:latest` (and `:sha-<commit>`).
2. The **deploy** job runs only after that succeeds, on `master` only:
   1. It joins the tailnet (server2 is behind the FRP tunnel; on Tailscale it's `server2-host`).
   2. It SSHes to server2 and, in the hcs-app compose folder, runs `docker compose pull hcs-app`, `docker compose up -d --force-recreate hcs-app`, then `docker image prune -f`.
   3. It polls `https://app.heroncs.co.uk/user/login` until the footer shows the commit just built. If that doesn't happen within 5 minutes, the run fails, so a deploy that silently kept the old image can't pass.

It refuses to deploy if the compose service doesn't use a `ghcr.io/…` image, because then `pull` would do nothing.

Deploys never overlap (`concurrency: deploy-production`), and one in progress is never cancelled.

## One-time setup

1. **SSH key for the deploy.** On server2, as the user that runs Docker (must be in the `docker` group):

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/hcs-app-deploy -N "" -C "github-actions hcs-app deploy"
   cat ~/.ssh/hcs-app-deploy.pub >> ~/.ssh/authorized_keys
   ```

2. **Repository secrets** (GitHub → hcs-app → Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `DEPLOY_SSH_USER` | that user, e.g. `jack` |
   | `DEPLOY_SSH_KEY` | the whole private key: the contents of `~/.ssh/hcs-app-deploy` |

   `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_CLIENT_SECRET` are already set.

3. **Tailscale access.** The runner joins the tailnet as `tag:dev-ci`, using the OAuth client in `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET`.
   - **The tag must exist.** In Access controls, `tagOwners` must include `"tag:dev-ci": ["autogroup:admin"]`.
   - **The OAuth client:** in Settings → OAuth clients → Generate OAuth client, give it the scope **Keys → Auth Keys: Write** with tag `tag:dev-ci`. Put its client ID and secret in the two GitHub secrets. A deleted or mismatched client makes `tailscale up` fail with `Status: 404, Message: "not found"`, and the deploy stops at "Check the runner is on the tailnet".
   - With the default **allow all** policy (`src *`, `dst *`, `ip *`), nothing more is needed. This is the case today.
   - With a stricter policy, first name server2 in `hosts` (`"server2-host": "100.x.y.z"`, from `tailscale ip -4`), then allow the tag to reach it:
     `{ "src": ["tag:dev-ci"], "dst": ["server2-host"], "ip": ["tcp:22"] }` (grants), or
     `{ "action": "accept", "src": ["tag:dev-ci"], "dst": ["server2-host:22"] }` (acls).
   - If Tailscale SSH is on for server2 (`tailscale debug prefs` shows `"RunSSH": true`), it takes over port 22 and ignores the deploy key. Either turn it off with `tailscale set --ssh=false`, or tag server2 and add an `ssh` rule that lets `tag:dev-ci` in as the deploy user.

4. **The compose file on server2** must reference the GHCR image, `image: ghcr.io/cappytech/hcs-app:latest`, and server2 must be able to pull it. That's already the case if a manual `docker compose pull` gets new builds.

5. **Optional settings** (Actions *variables*, not secrets). The defaults match today's server:

   | Variable | Default |
   |---|---|
   | `DEPLOY_HOST` | `server2-host` |
   | `DEPLOY_PATH` | `~/docker/app` |
   | `DEPLOY_SERVICE` | `hcs-app` |
   | `APP_URL` | `https://app.heroncs.co.uk` |

## Approving deploys

The deploy job runs in the GitHub **`production`** environment, which GitHub creates on the first deploy.

- With no protection rules, every master merge deploys straight away.
- To approve each deploy by hand, go to Settings → Environments → production → **Required reviewers** and add yourself. Each run then waits on the Actions page for **Review deployments → Approve**.

## Deploying by hand

On server2:

```bash
cd ~/docker/app
docker compose pull hcs-app
docker compose up -d --force-recreate hcs-app
```

Before recreating, wait for the master CI run to finish. Recreating while it's still building just restarts the old image.
