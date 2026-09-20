# Terraform

Optional, but more worthwhile here than in [nikednep](https://github.com/davidasync/nikednep):
it provisions the B2 bucket **and** the lifecycle rule that stops storage growing
without bound. The Worker itself stays with wrangler.

## Scope

| Managed here | Managed by wrangler | Managed in the B2 console |
| --- | --- | --- |
| B2 bucket (private) | Worker script and its bundle | **The daily spend cap** |
| **Expiry lifecycle rule** | Bindings, including the rate limiter | Application keys |
|  | `B2_KEY_ID` / `B2_APP_KEY` secrets | |

Wrangler keeps the Worker for nikednep's reasons, unchanged: `wrangler deploy` runs the
esbuild bundle a script resource would need pre-built, and the rate limiter is still an
experimental `unsafe` binding with no stable Terraform support.

> [!NOTE]
> The lifecycle rule living in code is a real gain over the R2 design this replaced. The
> Cloudflare provider had no `r2_bucket_lifecycle` resource before v5, so that backstop
> had to be a Makefile target somebody might forget to run. `Backblaze/b2` has supported
> `lifecycle_rules` from the start, so the thing that bounds the bill is now reviewed in
> a diff like everything else.

> [!IMPORTANT]
> **The daily cap is not in here, and it is the only hard stop on spending.** B2 caps are
> an account-level billing control with no Terraform resource, so set them in the console:
> *Account → Caps & Alerts*. Everything Terraform manages limits how fast storage grows;
> only the cap limits what you can be charged. See "Free tier" in the main README.

## Usage

```bash
export B2_APPLICATION_KEY_ID='...'     # a master or account-level key
export B2_APPLICATION_KEY='...'        # 'export' is required

make tf-init
make tf-plan
make tf-apply
```

`make check-b2-env` guards the `tf-*` targets and explains what is missing before
Terraform produces a less helpful error.

## Two keys, on purpose

The key Terraform uses and the key the Worker uses are not the same key.

| | Scope | Lives in |
| --- | --- | --- |
| Terraform | master / account-level — it creates buckets | your shell, exported |
| Worker | **this bucket only**, read+write | `wrangler secret` |

A bucket-scoped key cannot create buckets, and the Worker has no business being able to.
If the Worker's key ever leaks, the blast radius is one bucket of expiring objects.

## State

State is local and gitignored (`terraform/*.tfstate*`). Fine for one operator and one
bucket. If more than one person will run this, move to a remote backend first — two people
applying against divergent local state is how `prevent_destroy` ends up being the only
thing between you and an empty store.

## Free tier

Terraform creates nothing billable by itself. The bucket's cost is the objects in it —
see "Free tier" in the main README, and note that B2, unlike the Workers Free plan, does
charge overage rather than refusing writes once you are past 10 GB.
