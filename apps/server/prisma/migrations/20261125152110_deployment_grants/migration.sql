-- CreateTable
CREATE TABLE "deployment_grants" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'member',
    "created_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_deployment_grants_user" ON "deployment_grants"("user_id");

-- CreateIndex
CREATE INDEX "idx_deployment_grants_project" ON "deployment_grants"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_grants_deployment_id_user_id_key" ON "deployment_grants"("deployment_id", "user_id");

-- AddForeignKey
ALTER TABLE "deployment_grants" ADD CONSTRAINT "deployment_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_grants" ADD CONSTRAINT "deployment_grants_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_grants" ADD CONSTRAINT "deployment_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_grants" ADD CONSTRAINT "deployment_grants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
