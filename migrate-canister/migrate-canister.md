# migrate-canister

*Last updated: Tuesday, 24 June 2026*

Automates moving a canister to a different subnet using the icp-cli snapshot workflow. Two modes: **snapshot transfer** (new canister ID, simpler) and **full migration** (preserves the existing canister ID).

IC docs: [Canister migration](https://docs.internetcomputer.org/guides/canister-management/canister-migration/)

## Contents

- [Prerequisites](#prerequisites)
- [Flags](#flags)
- [Snapshot transfer](#snapshot-transfer-new-canister-id--simpler)
- [Full migration](#full-migration-preserve-canister-id)
- [Caveats](#caveats)
- [Cleaning up source canisters](#cleaning-up-source-canisters)
- [Funding your identity with cycles](#funding-your-identity-with-cycles)
- [NNS naming prerequisites](#nns-naming-prerequisites)

## Prerequisites

- `icp` CLI installed and authenticated (`icp identity default` shows your identity)
- Your identity has enough cycles to create the target canister
- The target subnet ID (full principal, e.g. `4zbus-z2bmt-...`)

> **Raw canister ID vs canister name:** Pass a raw principal ID (e.g. `abcde-fghij-klmno-pqrst-cai`) to run the script from any directory. Pass a project canister name (e.g. `logs`) only when running from its `icp.yaml` project root — the script automatically uses `-n ic` vs `-e ic` accordingly.

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--canister` | ✅ | — | Canister name (as in `icp.yaml`) or raw canister ID |
| `--target-subnet` | ✅ | — | Full subnet principal ID |
| `--preserve-id` | — | `false` | Full migration — preserves the canister ID |
| `--yes` | — | `false` | Skip `migrate-id` confirmation prompt |
| `--target-id` | — | auto-created | Reuse an already-created target canister |
| `--snapshot-dir` | — | `./migration-snapshot` | Local directory for the snapshot files |
| `--nns-name` | — | — | Name to attach to the (new) canister in NNS dapp after migration |
| `--nns-identity` | — | — | Identity linked to your NNS account (required when `--nns-name` is set) |

---

## Snapshot transfer (new canister ID — simpler)

```sh
node migrate-canister.mjs \
  --canister my-canister \
  --target-subnet <subnet-id>
```

To also register the new canister name in NNS after the transfer:

```sh
node migrate-canister.mjs \
  --canister my-canister \
  --target-subnet <subnet-id> \
  --nns-name "My Canister" \
  --nns-identity my-nns-identity
```

See [NNS naming prerequisites](#nns-naming-prerequisites) below if you haven't set up the NNS identity yet.

## Example

Paste your own command here before running — replace the canister ID and subnet ID with your actual values:

```sh

```

**What the script does (7 steps, or 8 with `--nns-name`):**
1. Creates a new canister on the target subnet
2. Tops up the target with **1T cycles** (snapshot upload/restore cost)
3. Stops the source canister and creates a snapshot
4. Downloads the snapshot locally to `--snapshot-dir`
5. Uploads and restores the snapshot on the target
6. Copies non-default settings to the target
7. Copies controllers to the target, then starts it
8. *(optional)* Attaches the canister name in NNS (`--nns-name` + `--nns-identity`)

**After completion:** the source canister is still stopped. Delete it when ready:
```sh
icp canister delete <canister> -e ic
```
Then update `.icp/data/mappings/<env>.ids.json` to point the name at the new ID.

**Cycles:**

| Step | Paid by | Notes |
|------|---------|-------|
| `canister create` (target) | Your principal | Funded from your cycles ledger at creation |
| Snapshot operations | Source / target canister | Each pays from its own balance |
| Source canister | Source canister | Must stay above its freezing threshold while stopped |

Source cycles are **not burned** — the source is retained until you delete it.

**If the script fails mid-run:** the target canister already exists and the source is stopped. The script prints exact recovery commands. In general:
```sh
icp canister start <source-id> -e ic
# If IC0207 (out of cycles) — top up the target first:
icp canister top-up <target-id> --amount <XT> -n ic
node migrate-canister.mjs --canister <name> --target-subnet <id> --target-id <target-id>
```
On IC0207, the script calculates the suggested top-up amount automatically (rounds up to nearest T + 1T buffer).

---

## Full migration (preserve canister ID)

Use this when the canister holds **tECDSA / tSchnorr / vetKeys** — a new ID means losing access to those signing keys and any assets tied to them.

```sh
node migrate-canister.mjs \
  --canister my-canister \
  --target-subnet <subnet-id> \
  --preserve-id \
  --yes
```

**What the script does:**
1. Creates a new canister on the target subnet
2. Tops up the target with **5 T cycles** (source cycles will be burned)
3. Stops the source canister and creates a snapshot
4. Downloads the snapshot locally
5. Uploads and restores the snapshot on the target
6. Copies non-default settings (controllers are restored automatically by `migrate-id`)
7. Skips controller copy — `migrate-id` restores them
8. Deletes the snapshot on the target (required by `migrate-id`), stops the target, then runs `icp canister migrate-id`

**Cycles:**

| Step | Paid by | Notes |
|------|---------|-------|
| `canister create` (target) | Your principal | Funded from your cycles ledger |
| `canister top-up` (target, 5 T) | Your principal | Script does this automatically |
| Source canister | Source canister | Must meet a minimum balance or `migrate-id` refuses |
| Source remaining cycles | Burned | All remaining cycles on the source are burned on deletion |

---

## Cleaning up source canisters

After a successful migration the source canister is stopped and still holds cycles. Recover them before deleting.

**Option A — icp-cli (2 steps)**
```sh
# Cycles return to your CLI identity's cycles ledger on delete
icp canister delete <source-id> -n ic

# Then top up any canister you want with the recovered cycles
icp canister top-up <target-id> --amount <XT> -n ic
```

**Option B — dfx (1 step, sends cycles directly to a canister)**
```sh
dfx canister delete <source-id> \
  --withdraw-cycles-to-canister <target-id> \
  --network ic
```

> `icp canister delete` has no `--withdraw-cycles-to-canister` equivalent yet — hence the 2-step workaround. Both CLIs are compatible; use whichever is more convenient.

---

## Caveats

- **Settings regex is best-effort** — the script parses `icp canister settings show` output with a regex. Always verify the target settings after migration: `icp canister settings show <target-id> -n ic`
- **Snapshots do not transfer settings** — compute allocation, freezing threshold, and Wasm memory limit must be copied manually. The script handles this in step 6. [Docs](https://docs.internetcomputer.org/guides/canister-management/canister-migration/#migrating-without-preserving-the-canister-id)
- **Controllers (snapshot path)** — copied one by one via `--add-controller`. For full migration, `migrate-id` restores them automatically. [Docs](https://docs.internetcomputer.org/guides/canister-management/canister-migration/#3-copy-settings-1)
- **Large snapshots (≥100 MiB) may hit the heap-delta rate limit** (`IC0210`) during upload. The IC allows ~75 MiB of heap writes per round (~2s). The script handles this automatically: on a rate-limit error it waits 12s and resumes the upload with `--resume` (up to 6 attempts). No action needed.

---

## Funding your identity with cycles

Your CLI identity needs cycles to create canisters and top them up. Here's the full flow.

**1. Check what you have**
```sh
icp identity principal              # your principal
icp identity account-id             # your ICP ledger account ID
icp token balance -n ic             # ICP balance
icp cycles balance -n ic            # cycles balance
```

**2. Get ICP onto your identity**

Send ICP to the address returned by `icp identity account-id` from an exchange or another wallet.

**3. Convert ICP → cycles**
```sh
# Convert a specific ICP amount (check the rate first)
icp cycles mint --icp 10 -n ic

# Or target a specific cycles amount (icp-cli calculates the ICP needed)
icp cycles mint --cycles 10T -n ic
```

**4. Verify**
```sh
icp cycles balance -n ic
```

> For reference: creating a canister costs ~0.1T cycles. Snapshot path tops up the target with **1T** (upload/restore cost). Full migration tops up with **5T** (source cycles are burned). On IC0207 errors during restore, the script prints the exact top-up command needed.

---

## NNS naming prerequisites

See [`migrate-canister-addon.md`](./migrate-canister-addon.md) for the one-time setup steps.
