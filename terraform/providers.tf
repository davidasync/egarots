# Credentials come from the environment, never from a .tf or .tfvars file:
#   export B2_APPLICATION_KEY_ID='...'
#   export B2_APPLICATION_KEY='...'
#
# Use a master or account-level key here — creating buckets and lifecycle rules
# is outside what the bucket-scoped key the Worker uses is allowed to do. The
# Worker's own key should stay scoped to the single bucket, read+write.
provider "b2" {}
