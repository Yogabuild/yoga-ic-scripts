# NNS identity setup (one-time)

Required to use `--nns-name` in `migrate-canister.mjs`.

**1. Link a CLI identity to your NNS account** (opens a browser flow)
```sh
icp identity link web my-nns-identity --app nns.ic0.app
```
If it's your first time, you'll be asked to grant permission — re-run the command after approving.

**2. Verify the principal matches what you see on nns.ic0.app**
```sh
icp identity list
```

That's it. Pass `--nns-identity my-nns-identity` to the script and it handles the rest.