output "bucket_name" {
  description = "Set this as B2_BUCKET in wrangler.toml."
  value       = b2_bucket.objects.bucket_name
}

output "bucket_id" {
  value = b2_bucket.objects.bucket_id
}

output "next_steps" {
  description = "What to run after apply."
  value       = <<-EOT
    1. Set B2_BUCKET = "${b2_bucket.objects.bucket_name}" in wrangler.toml, and
       B2_REGION to your account's region (the s3.<region>.backblazeb2.com host
       shown against the bucket in the B2 console).
    2. Create an application key in the B2 console scoped to this bucket only,
       read+write, then: make secrets
    3. Set a DAILY CAP in the B2 console. Terraform cannot express it and it is
       the only hard stop on the bill. See README "Free tier".
    4. make deploy
  EOT
}
