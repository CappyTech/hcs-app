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

3. **Tailscale access.** The runner joins as `tag:dev-ci`. The tailnet policy must let that tag reach server2 on port 22, for example:

   ```json
   { "action": "accept", "src": ["tag:dev-ci"], "dst": ["server2-host:22"] }
   ```

   The OAuth client must also be allowed to create devices with `tag:dev-ci`; it already is if the CI Tailscale option works.

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
