-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "image_attempted_digest" VARCHAR(100),
ADD COLUMN     "image_auto_update" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "image_check_error" VARCHAR(100),
ADD COLUMN     "image_checked_at" TIMESTAMP(6),
ADD COLUMN     "image_checked_ref" VARCHAR(500),
ADD COLUMN     "image_latest_digest" VARCHAR(100),
ADD COLUMN     "image_running_digest" VARCHAR(100),
ADD COLUMN     "image_updated_at" TIMESTAMP(6);
