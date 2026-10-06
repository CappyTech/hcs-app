# Deployment

Every push to `master` that passes CI is deployed to server2 automatically, the same way cairn's `release.yml` deploys its edge server. This is the `deploy` job in `.github/workflows/ci.yml`.

1. The **build** job runs `npm test`, then builds and pushes `ghcr.io/cappytech/hcs-app:latest` (and `:sha-<commit>`).
2. The **deploy** job runs only after that succeeds, on `master` only:
   1. It joins the tailnet (server2 is behind the FRP tunnel; on Tailscale it's `server2-host`).
   2. It connects to server2 over **Tailscale SSH**, which server2 keeps switched on. The tailnet policy decides who gets in, so there's no SSH key. In the hcs-app compose folder it runs `docker compose pull hcs-app`, `docker compose up -d --force-recreate hcs-app`, then `docker image prune -f`.
   3. It polls `https://app.heroncs.co.uk/user/login` until the footer shows the commit just built. If that doesn't happen within 5 minutes, the run fails, so a deploy that silently kept the old image can't pass.

It refuses to deploy if the compose service doesn't use a `ghcr.io/…` image, because then `pull` would do nothing.

Deploys never overlap (`concurrency: deploy-production`), and one in progress is never cancelled.

## One-time setup

1. **Tailscale OAuth client.** The runner joins the tailnet as `tag:dev-ci`:
   - In Access controls, `tagOwners` must include `"tag:dev-ci": ["autogroup:admin"]`.
   - In Settings → Trust credentials, create an OAuth client with scope **Keys → Auth Keys: Write** and tag `tag:dev-ci`.
   - Put its ID and secret in the repo secrets `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_CLIENT_SECRET`.

   A missing scope, or a deleted or mismatched client, makes `tailscale up` fail with `Status: 404, Message: "not found"`, and the deploy stops at "Check the runner is on the tailnet".

2. **Let CI in over Tailscale SSH.** server2 runs Tailscale SSH, which answers port 22 for every tailnet connection and ignores SSH keys. Tailscale SSH rules can only target *tagged* machines, so:
   1. **Add a tag owner for servers** in Access controls: `"tag:server": ["autogroup:admin"]`.
   2. **Add `ssh` rules**, before tagging, so your own access keeps working. Use whatever user runs Docker on server2:
      ```json
      "ssh": [
        { "action": "accept", "src": ["tag:dev-ci"],         "dst": ["tag:server"], "users": ["jack"] },
        { "action": "check",  "src": ["autogroup:member"],   "dst": ["tag:server"], "users": ["autogroup:nonroot", "root"] }
      ]
      ```
      The first rule lets the deploy in. The second keeps your own Tailscale SSH access, with the usual browser check. A tagged machine is no longer covered by the default `autogroup:self` rule, so without it you'd lose access.
   3. **Tag server2:** Machines → server2-host → ⋯ → Edit ACL tags → `tag:server`.

   The network rule is the default **allow all** today, so nothing else is needed. With a stricter policy, `tag:dev-ci` must also be allowed to reach `tag:server` on `tcp:22`.

3. **Deploy user** (optional). The deploy logs in as the Actions variable `DEPLOY_USER`. Failing that, it uses the secret `DEPLOY_SSH_USER`, and otherwise `jack`. That user must be in the `docker` group on server2.

4. **The compose file on server2** must reference the GHCR image, `image: ghcr.io/cappytech/hcs-app:latest`, and server2 must be able to pull it. That's already the case if a manual `docker compose pull` gets new builds.

5. **Optional settings** (Actions *variables*, not secrets). The defaults match today's server:

   | Variable | Default |
   |---|---|
   | `DEPLOY_HOST` | `server2-host` |
   | `DEPLOY_USER` | the `DEPLOY_SSH_USER` secret, else `jack` |
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
