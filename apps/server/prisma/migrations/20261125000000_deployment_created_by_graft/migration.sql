-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "created_by_graft" VARCHAR(48);

-- CreateIndex
CREATE INDEX "idx_deployments_created_by_graft" ON "deployments"("created_by_graft");
