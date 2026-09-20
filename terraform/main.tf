# The only store. Deleting this bucket deletes every object in it, which is why
# it is the one resource worth expressing as code — and why it is protected.
#
# Private, always. The Worker is the only door: it is what enforces expiry, the
# size cap, the rate limit and every security header. A public bucket, or a
# bucket fronted by its own CDN URL, bypasses all of that. See README
# "Serving untrusted bytes".
resource "b2_bucket" "objects" {
  bucket_name = var.bucket_name
  bucket_type = "allPrivate"

  # B2 has no per-object TTL, so this is the backstop that stops objects nobody
  # reads again from being stored — and billed — forever. Unlike the Cloudflare
  # provider, which could not express an R2 lifecycle rule until v5, B2's
  # provider has had this from the start, so the rule lives in code where it
  # belongs rather than in a Makefile target someone might forget to run.
  lifecycle_rules {
    file_name_prefix = ""
    # Hide, then delete the next day. B2 models expiry in two steps and a
    # hidden file is already unreadable through the API, so the object stops
    # being retrievable at expire_days and stops being billed a day later.
    days_from_uploading_to_hiding = var.expire_days
    days_from_hiding_to_deleting  = 1
  }

  lifecycle {
    prevent_destroy = true
  }
}
