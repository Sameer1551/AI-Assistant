# Terraform configuration for May Platform Infrastructure
# Satisfies Requirement 15.3, 15.4

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "tenant_id" {
  type    = string
  default = "default-tenant"
}

# KMS Key for Multi-Tenant Cryptographic Isolation (Property 8, Req 13.3)
resource "aws_kms_key" "tenant_key" {
  description             = "KMS Key for Tenant ${var.tenant_id} Isolation"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = {
    Environment = "Production"
    Tenant      = var.tenant_id
  }
}

# Isolated S3 Bucket for Tenant Backups with KMS encryption (Req 32.2)
resource "aws_s3_bucket" "tenant_backups" {
  bucket        = "may-tenant-${var.tenant_id}-backups"
  force_destroy = false

  tags = {
    Tenant = var.tenant_id
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup_encryption" {
  bucket = aws_s3_bucket.tenant_backups.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.tenant_key.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

# PostgreSQL Database for identity and governance store
resource "aws_db_instance" "may_postgres" {
  allocated_storage      = 20
  db_name                = "may_platform"
  engine                 = "postgres"
  engine_version         = "15"
  instance_class         = "db.t3.micro"
  username               = "may_operator"
  password               = "securepassword123!"
  skip_final_snapshot    = true
  storage_encrypted      = true
  kms_key_id             = aws_kms_key.tenant_key.arn
}
