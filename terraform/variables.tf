variable "bucket_name" {
  description = "B2 bucket name. Globally unique across all of Backblaze, so prefix it."
  type        = string
  default     = "egarots-objects"
}

variable "expire_days" {
  description = <<-EOT
    Days from upload until the object is deleted outright. Must stay at or above
    MAX_TTL_SECONDS in src/core/storage/entity.ts (7 days) plus a day of slack,
    because B2 lifecycle granularity is whole days counted from upload.
  EOT
  type        = number
  default     = 8

  validation {
    condition     = var.expire_days >= 8
    error_message = "expire_days must be at least 8 — MAX_TTL_SECONDS is 7 days plus a day of slack."
  }
}
